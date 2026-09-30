import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Anchor,
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Crown,
  Crosshair,
  Flag,
  Gamepad2,
  History,
  Info,
  Loader2,
  LogOut,
  Radio,
  RotateCw,
  ShieldCheck,
  Ship as ShipIcon,
  Sparkles,
  Target,
  Trash2,
  Trophy,
  UserRound,
  Users,
  Waves,
  X,
} from "lucide-react";
import type {
  AccountState,
  Difficulty,
  Fleet,
  MatchRecord,
  Orientation,
  RoomView,
  Shot,
  SoloGame,
  User,
} from "./shared/contracts";
import {
  analyzeGame,
  canPlaceShip,
  chooseBotShot,
  coordinate,
  fireAt,
  FLEET_SIZES,
  randomFleet,
  shipCells,
  validateFleet,
} from "./game/engine";
import * as api from "./lib/client";

type Page = "play" | "history" | "pro";
type ModalName = "account" | "rules" | null;
type BoardTheme = "mint" | "blue" | "night";
const DIFFICULTIES: Record<Difficulty, { label: string; description: string }> =
  {
    easy: {
      label: "Юнга",
      description: "Случайные выстрелы. Для первого знакомства.",
    },
    medium: {
      label: "Капитан",
      description: "Ищет корабли и добивает после попадания.",
    },
    hard: {
      label: "Адмирал",
      description: "Просчитывает вероятности. Приготовься к дуэли.",
    },
  };
const STORAGE = {
  game: "salvo.solo.v1",
  history: "salvo.history.v1",
  pro: "salvo.pro.v1",
  theme: "salvo.theme.v1",
  owner: "salvo.owner.v1",
};
function readLocal<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function mergeHistory(first: MatchRecord[], second: MatchRecord[]) {
  return Array.from(
    new Map([...second, ...first].map((item) => [item.id, item])).values(),
  )
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, 100);
}
function formatTime(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function outcomeText(shot: Shot) {
  return shot.result === "miss"
    ? "Мимо"
    : shot.result === "sunk"
      ? "Потоплен!"
      : "Есть попадание";
}
function percent(hits: number, shots: number) {
  return shots ? `${Math.round((hits / shots) * 100)}%` : "—";
}
function countHits(shots: Shot[]) {
  return shots.filter((shot) => shot.result !== "miss").length;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isCell = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value < 100;
const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value > 0 &&
  value < 8_640_000_000_000_000;
function validShots(value: unknown): value is Shot[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (shot) =>
        isRecord(shot) &&
        isCell(shot.cell) &&
        ["miss", "hit", "sunk"].includes(String(shot.result)) &&
        (shot.shipId === undefined || typeof shot.shipId === "string") &&
        (shot.sunkCells === undefined ||
          (Array.isArray(shot.sunkCells) &&
            shot.sunkCells.length <= 4 &&
            shot.sunkCells.every(isCell))),
    ) &&
    new Set(value.map((shot) => shot.cell)).size === value.length
  );
}
function safeGame(value: unknown): SoloGame | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 200 ||
    !["easy", "medium", "hard"].includes(String(value.difficulty)) ||
    !["battle", "finished"].includes(String(value.phase)) ||
    !["player", "bot"].includes(String(value.turn)) ||
    ![null, "player", "bot"].includes(value.winner as null | string) ||
    !isTimestamp(value.startedAt) ||
    !validateFleet(value.playerFleet).valid ||
    !validateFleet(value.botFleet).valid ||
    !validShots(value.playerShots) ||
    !validShots(value.botShots)
  )
    return null;
  const saved = value as unknown as SoloGame;
  try {
    for (const [target, original] of [
      [saved.botFleet, saved.playerShots],
      [saved.playerFleet, saved.botShots],
    ] as [Fleet, Shot[]][]) {
      let replayed: Shot[] = [];
      for (const shot of original) {
        const next = fireAt(target, replayed, shot.cell);
        if (
          next.shot.result !== shot.result ||
          next.shot.shipId !== shot.shipId ||
          JSON.stringify(next.shot.sunkCells ?? []) !==
            JSON.stringify(shot.sunkCells ?? [])
        )
          return null;
        replayed = next.shots;
      }
    }
    const playerWon = countHits(saved.playerShots) === 20;
    const botWon = countHits(saved.botShots) === 20;
    if (playerWon && botWon) return null;
    if (
      saved.phase === "finished" &&
      (!isTimestamp(saved.finishedAt) ||
        saved.finishedAt < saved.startedAt ||
        saved.winner !== (playerWon ? "player" : botWon ? "bot" : null) ||
        saved.winner === null)
    )
      return null;
    if (
      saved.phase === "battle" &&
      (playerWon ||
        botWon ||
        saved.winner !== null ||
        saved.finishedAt !== undefined)
    )
      return null;
    const missDifference =
      saved.playerShots.filter((shot) => shot.result === "miss").length -
      saved.botShots.filter((shot) => shot.result === "miss").length;
    if (missDifference !== (saved.turn === "player" ? 0 : 1)) return null;
    return saved;
  } catch {
    return null;
  }
}
function safeHistory(value: unknown): MatchRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (record): record is MatchRecord =>
        isRecord(record) &&
        typeof record.id === "string" &&
        record.id.length > 0 &&
        record.id.length <= 200 &&
        ["solo", "friend"].includes(String(record.mode)) &&
        ["win", "loss"].includes(String(record.outcome)) &&
        (record.difficulty === undefined ||
          ["easy", "medium", "hard"].includes(String(record.difficulty))) &&
        isTimestamp(record.finishedAt) &&
        typeof record.durationMs === "number" &&
        Number.isFinite(record.durationMs) &&
        record.durationMs >= 0 &&
        validShots(record.shotHistory) &&
        record.shots === record.shotHistory.length &&
        record.hits === countHits(record.shotHistory),
    )
    .slice(0, 100);
}
type LocalProfile = Pick<AccountState, "history" | "savedGame" | "proDemo">;
const emptyProfile = (): LocalProfile => ({
  history: [],
  savedGame: null,
  proDemo: false,
});
const profileKey = (owner: string | null) =>
  `salvo.profile.${owner ?? "guest"}.v1`;
function readProfile(owner: string | null): LocalProfile {
  const raw = readLocal<unknown>(profileKey(owner), null);
  return isRecord(raw)
    ? {
        history: safeHistory(raw.history),
        savedGame: safeGame(raw.savedGame),
        proDemo: raw.proDemo === true,
      }
    : initialOwner() === owner
      ? {
          history: safeHistory(readLocal<unknown>(STORAGE.history, [])),
          savedGame: safeGame(readLocal<unknown>(STORAGE.game, null)),
          proDemo: readLocal<unknown>(STORAGE.pro, false) === true,
        }
      : emptyProfile();
}
function initialOwner() {
  const owner = readLocal<unknown>(STORAGE.owner, null);
  return typeof owner === "string" && owner.length < 200 ? owner : null;
}
function readInitialProfiles() {
  const owner = initialOwner();
  return { owner, previous: readProfile(owner), guest: readProfile(null) };
}
function mergeProfiles(
  local: LocalProfile,
  remote: LocalProfile,
): LocalProfile {
  let savedGame = local.savedGame;
  if (
    remote.savedGame &&
    (!savedGame ||
      (savedGame.id === remote.savedGame.id
        ? savedGame.playerShots.length + savedGame.botShots.length <
          remote.savedGame.playerShots.length + remote.savedGame.botShots.length
        : savedGame.startedAt < remote.savedGame.startedAt))
  )
    savedGame = remote.savedGame;
  return {
    history: mergeHistory(local.history, remote.history),
    savedGame,
    proDemo: local.proDemo || remote.proDemo,
  };
}

function SeaDrawing({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      className={compact ? "sea-drawing compact" : "sea-drawing"}
      viewBox="0 0 240 180"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="126" cy="90" r="73" fill="#e1ece5" />
      <path
        d="M34 54H218M34 90H218M34 126H218M72 18V162M108 18V162M144 18V162M180 18V162"
        stroke="#c9dbd0"
        strokeWidth="1"
        strokeDasharray="2 5"
      />
      <path d="M55 110H194L176 135H81L55 110Z" fill="#203c37" />
      <path d="M79 97H171L181 110H69L79 97Z" fill="#3e645b" />
      <path
        d="M97 77H140V97H97V77Z"
        fill="#f8faf6"
        stroke="#203c37"
        strokeWidth="3"
      />
      <path
        d="M119 47V77M119 49H151L142 58H119"
        stroke="#203c37"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M122 50H150L142 58H122" fill="#fa623b" />
      <path
        d="M88 109L104 89H151L163 109"
        stroke="#203c37"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <rect x="108" y="81" width="6" height="7" rx="1" fill="#9bbdb0" />
      <rect x="123" y="81" width="6" height="7" rx="1" fill="#9bbdb0" />
      <path
        d="M41 145C52 136 61 152 72 144C83 136 92 152 103 144C114 136 123 152 134 144C145 136 154 152 165 144C176 136 185 152 196 144"
        stroke="#203c37"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="195" cy="45" r="13" fill="#fa623b" />
      <path d="M189 45H201M195 39V51" stroke="#fff" strokeWidth="2" />
      <path d="M45 85H53M49 81V89" stroke="#fa623b" strokeWidth="2" />
      <circle cx="185" cy="79" r="3" fill="#203c37" />
    </svg>
  );
}

function Board({
  fleet,
  shots,
  label,
  interactive = false,
  onCell,
  placement = false,
  selectedSize = 1,
  orientation = "horizontal",
  theme = "mint",
  enemy = false,
}: {
  fleet: Fleet;
  shots: Shot[];
  label: string;
  interactive?: boolean;
  onCell?: (cell: number) => void;
  placement?: boolean;
  selectedSize?: number;
  orientation?: Orientation;
  theme?: BoardTheme;
  enemy?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const preview =
    placement &&
    hover !== null &&
    !fleet.some((ship) => ship.cells.includes(hover))
      ? (shipCells(hover, selectedSize, orientation) ?? [])
      : [];
  const previewValid =
    hover !== null && canPlaceShip(fleet, hover, selectedSize, orientation);
  const sunkCells = new Set(shots.flatMap((shot) => shot.sunkCells ?? []));
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, cell: number) {
    const offset =
      event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowLeft"
          ? -1
          : event.key === "ArrowDown"
            ? 10
            : event.key === "ArrowUp"
              ? -10
              : 0;
    if (!offset) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(99, cell + offset));
    setFocused(next);
    refs.current[next]?.focus();
  }
  return (
    <div
      className={`board ${enemy ? "enemy-board" : ""}`}
      data-board-theme={theme}
    >
      <div className="board-top-labels">
        <span />
        <div>
          {"ABCDEFGHIJ".split("").map((letter) => (
            <span key={letter}>{letter}</span>
          ))}
        </div>
      </div>
      <div className="board-middle">
        <div className="board-side-labels">
          {Array.from({ length: 10 }, (_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
        <div
          className={`board-cells ${interactive ? "is-interactive" : ""}`}
          role="group"
          aria-label={label}
          onMouseLeave={() => setHover(null)}
        >
          {Array.from({ length: 100 }, (_, cell) => {
            const ship = fleet.find((item) => item.cells.includes(cell));
            const shot = shots.find((item) => item.cell === cell);
            const shipIndex = ship?.cells.indexOf(cell) ?? -1;
            const vertical =
              ship && ship.size > 1 && ship.cells[1] - ship.cells[0] === 10;
            const classes = [
              "board-cell",
              ship ? "occupied" : "",
              ship ? (vertical ? "vertical" : "horizontal") : "",
              ship && shipIndex === 0 ? "ship-first" : "",
              ship && shipIndex === ship.size - 1 ? "ship-last" : "",
              shot?.result ?? "",
              sunkCells.has(cell) ? "is-sunk" : "",
              preview.includes(cell)
                ? previewValid
                  ? "preview-valid"
                  : "preview-invalid"
                : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={cell}
                ref={(element) => {
                  refs.current[cell] = element;
                }}
                type="button"
                className={classes}
                disabled={!interactive || (!placement && !!shot)}
                tabIndex={interactive && focused === cell ? 0 : -1}
                aria-label={`${coordinate(cell)}${shot ? `, ${outcomeText(shot)}` : ship ? ", корабль" : ", пусто"}${placement && ship ? ", нажми, чтобы убрать" : ""}`}
                onFocus={() => {
                  setFocused(cell);
                  setHover(cell);
                }}
                onMouseEnter={() => setHover(cell)}
                onKeyDown={(event) => moveFocus(event, cell)}
                onClick={() => onCell?.(cell)}
              >
                {ship && (
                  <span className="ship-segment">
                    <span />
                  </span>
                )}
                {shot && (
                  <span
                    className={`shot-marker ${shot.result === "miss" ? "dot" : "cross"}`}
                  />
                )}
                {sunkCells.has(cell) && !shot && (
                  <span className="shot-marker cross" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const first = element.current?.querySelector<HTMLElement>(
      "[autofocus], input, button",
    );
    first?.focus();
    function key(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const focusable = Array.from(
          element.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ) ?? [],
        );
        const start = focusable[0];
        const end = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === start) {
          event.preventDefault();
          end?.focus();
        } else if (!event.shiftKey && document.activeElement === end) {
          event.preventDefault();
          start?.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={element}
      >
        <div className="modal-title">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Закрыть окно"
          >
            <X size={21} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function App() {
  const invitation =
    new URLSearchParams(window.location.search).get("room")?.toUpperCase() ??
    "";
  const [page, setPage] = useState<Page>("play");
  const [mode, setMode] = useState<"solo" | "friend">(
    invitation ? "friend" : "solo",
  );
  const [fleet, setFleet] = useState<Fleet>(() => randomFleet());
  const [selectedSize, setSelectedSize] = useState(4);
  const [orientation, setOrientation] = useState<Orientation>("horizontal");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  // An account's cached data is loaded only after the server confirms its identity.
  const [initialProfiles] = useState(readInitialProfiles);
  const [game, setGame] = useState<SoloGame | null>(
    initialProfiles.guest.savedGame,
  );
  const [history, setHistory] = useState<MatchRecord[]>(
    initialProfiles.guest.history,
  );
  const [proDemo, setProDemo] = useState(initialProfiles.guest.proDemo);
  const [storageFailed, setStorageFailed] = useState(false);
  const [theme, setTheme] = useState<BoardTheme>(() => {
    const saved = readLocal<unknown>(STORAGE.theme, "mint");
    return saved === "blue" || saved === "night" ? saved : "mint";
  });
  const [user, setUser] = useState<User | null>(null);
  const [cloud, setCloud] = useState<"local" | "syncing" | "synced" | "error">(
    "local",
  );
  const [modal, setModal] = useState<ModalName>(null);
  const [accountMode, setAccountMode] = useState<"login" | "register">(
    "register",
  );
  const [accountError, setAccountError] = useState("");
  const [room, setRoom] = useState<RoomView | null>(null);
  const [roomName, setRoomName] = useState("Капитан");
  const [joinCode, setJoinCode] = useState(invitation);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [report, setReport] = useState<MatchRecord | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const accountReady = useRef(false);
  const accountRevision = useRef(0);
  const localOwner = useRef<string | null>(null);
  const cachedProfiles = useRef(
    new Map<string | null, LocalProfile>([
      [initialProfiles.owner, initialProfiles.previous],
      [null, initialProfiles.guest],
    ]),
  );
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  const syncVersion = useRef(0);
  const pendingClearId = useRef<string | undefined>(undefined);
  const currentProfile = useRef<LocalProfile>({
    history,
    savedGame: game,
    proDemo,
  });
  currentProfile.current = { history, savedGame: game, proDemo };
  const closeModal = useCallback(() => setModal(null), []);
  const closeReport = useCallback(() => setReport(null), []);

  const mergeAccount = useCallback((account: AccountState) => {
    accountRevision.current += 1;
    const previousOwner = localOwner.current;
    const nextOwner = account.user?.id ?? null;
    let local = currentProfile.current;
    if (previousOwner !== nextOwner) {
      pendingClearId.current = undefined;
      cachedProfiles.current.set(previousOwner, local);
      if (!saveLocal(profileKey(previousOwner), local)) setStorageFailed(true);
      const target =
        cachedProfiles.current.get(nextOwner) ?? readProfile(nextOwner);
      local =
        previousOwner === null && nextOwner !== null
          ? mergeProfiles(local, target)
          : target;
      // A guest can take their own games into an account once. After sign-out,
      // the guest profile is empty instead of inheriting another user's games.
      if (previousOwner === null && nextOwner !== null) {
        cachedProfiles.current.set(null, emptyProfile());
        if (!saveLocal(profileKey(null), emptyProfile()))
          setStorageFailed(true);
      }
      if (previousOwner !== null) {
        setRoom(null);
        setFleet(randomFleet());
      }
    }
    const next = mergeProfiles(local, {
      history: safeHistory(account.history),
      savedGame: safeGame(account.savedGame),
      proDemo: account.proDemo === true,
    });
    localOwner.current = nextOwner;
    currentProfile.current = next;
    cachedProfiles.current.set(nextOwner, next);
    setUser(account.user);
    setHistory(next.history);
    setGame(next.savedGame);
    setProDemo(next.proDemo);
    setReport(null);
    setCloud(account.user ? "synced" : "local");
    accountReady.current = true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const revision = accountRevision.current;
    api
      .getAccount()
      .then((account) => {
        if (!cancelled && revision === accountRevision.current)
          mergeAccount(account);
      })
      .catch(() => {
        accountReady.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [mergeAccount]);
  useEffect(() => {
    // Preserve the old version's account cache before updating legacy mirrors.
    let saved = true;
    for (const [owner, profile] of cachedProfiles.current) {
      if (owner !== localOwner.current)
        saved = saveLocal(profileKey(owner), profile) && saved;
    }
    const profile = { history, savedGame: game, proDemo };
    cachedProfiles.current.set(localOwner.current, profile);
    saved = saveLocal(profileKey(localOwner.current), profile) && saved;
    saved = saveLocal(STORAGE.owner, localOwner.current) && saved;
    saved = saveLocal(STORAGE.theme, theme) && saved;
    // Keep the original keys readable for existing installations.
    saveLocal(STORAGE.game, game);
    saveLocal(STORAGE.history, history);
    saveLocal(STORAGE.pro, proDemo);
    setStorageFailed(!saved);
  }, [game, history, proDemo, theme, user, initialProfiles]);
  useEffect(() => {
    if (!user || !accountReady.current || pending === "account") return;
    const revision = accountRevision.current;
    const version = ++syncVersion.current;
    setCloud("syncing");
    const timer = window.setTimeout(() => {
      // Serialize writes and discard superseded queued snapshots.
      syncQueue.current = syncQueue.current.then(async () => {
        if (
          revision !== accountRevision.current ||
          version !== syncVersion.current
        )
          return;
        try {
          const clearSavedGameId = pendingClearId.current;
          await api.syncAccount({
            history,
            savedGame: game,
            proDemo,
            clearSavedGameId,
          });
          if (
            revision === accountRevision.current &&
            pendingClearId.current === clearSavedGameId
          )
            pendingClearId.current = undefined;
          if (
            revision === accountRevision.current &&
            version === syncVersion.current
          )
            setCloud("synced");
        } catch (cause) {
          if (revision !== accountRevision.current) return;
          if (cause instanceof api.ApiError && cause.status === 401) {
            mergeAccount({ user: null, ...emptyProfile() });
            setNotice(
              "Сессия завершилась. Войди снова, чтобы открыть свой прогресс.",
            );
          } else if (version === syncVersion.current) setCloud("error");
        }
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [game, history, proDemo, user, pending, mergeAccount]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3800);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!invitation) return;
    let cancelled = false;
    api
      .getRoom(invitation)
      .then((next) => {
        if (!cancelled) {
          setRoom(next);
          if (next.ownFleet.length) setFleet(next.ownFleet);
        }
      })
      .catch(() => {
        /* Joining is offered explicitly to a new invitee. */
      });
    return () => {
      cancelled = true;
    };
    // Only restore the invitation present when the app opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!room || room.phase === "finished") return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await api.getRoom(room.code);
        if (!cancelled)
          setRoom((current) =>
            !current || next.revision >= current.revision ? next : current,
          );
      } catch {
        /* Keep the last known position; explicit actions surface errors. */
      }
      if (!cancelled)
        timer = window.setTimeout(poll, document.hidden ? 8000 : 2000);
    };
    timer = window.setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [room?.code, room?.phase]);
  useEffect(() => {
    if (!game || game.phase !== "battle" || game.turn !== "bot") return;
    const timer = window.setTimeout(
      () =>
        setGame((current) => {
          if (
            !current ||
            current.id !== game.id ||
            current.phase !== "battle" ||
            current.turn !== "bot"
          )
            return current;
          try {
            const cell = chooseBotShot(current.botShots, current.difficulty);
            const result = fireAt(current.playerFleet, current.botShots, cell);
            return {
              ...current,
              botShots: result.shots,
              turn: result.shot.result === "miss" ? "player" : "bot",
              phase: result.finished ? "finished" : "battle",
              winner: result.finished ? "bot" : null,
              ...(result.finished ? { finishedAt: Date.now() } : {}),
            };
          } catch {
            return current;
          }
        }),
      600,
    );
    return () => window.clearTimeout(timer);
  }, [game]);
  useEffect(() => {
    if (!game || game.phase !== "finished") return;
    const record: MatchRecord = {
      id: game.id,
      mode: "solo",
      difficulty: game.difficulty,
      outcome: game.winner === "player" ? "win" : "loss",
      shots: game.playerShots.length,
      hits: countHits(game.playerShots),
      durationMs: (game.finishedAt ?? Date.now()) - game.startedAt,
      finishedAt: game.finishedAt ?? Date.now(),
      shotHistory: game.playerShots,
    };
    setHistory((current) =>
      current.some((item) => item.id === record.id)
        ? current
        : mergeHistory([record], current),
    );
  }, [game]);
  useEffect(() => {
    if (!room || room.phase !== "finished") return;
    const record: MatchRecord = {
      id: `room-${room.code}-${room.createdAt}`,
      mode: "friend",
      outcome: room.winner === "you" ? "win" : "loss",
      shots: room.shots.length,
      hits: countHits(room.shots),
      durationMs: (room.finishedAt ?? Date.now()) - room.createdAt,
      finishedAt: room.finishedAt ?? Date.now(),
      shotHistory: room.shots,
    };
    setHistory((current) =>
      current.some((item) => item.id === record.id)
        ? current
        : mergeHistory([record], current),
    );
  }, [room]);
  const activeStartedAt = mode === "solo" ? game?.startedAt : room?.createdAt;
  const activeFinishedAt =
    mode === "solo" ? game?.finishedAt : room?.finishedAt;
  useEffect(() => {
    if (!activeStartedAt) {
      setElapsed(0);
      return;
    }
    const update = () =>
      setElapsed((activeFinishedAt ?? Date.now()) - activeStartedAt);
    update();
    if (activeFinishedAt) return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [activeStartedAt, activeFinishedAt]);

  const isBattle =
    mode === "solo"
      ? !!game
      : !!room && ["battle", "finished"].includes(room.phase);
  const finished =
    mode === "solo" ? game?.phase === "finished" : room?.phase === "finished";
  const yourTurn = mode === "solo" ? game?.turn === "player" : room?.yourTurn;
  const won =
    mode === "solo" ? game?.winner === "player" : room?.winner === "you";
  const ownFleet = isBattle
    ? mode === "solo"
      ? game!.playerFleet
      : room!.ownFleet
    : mode === "friend" && room?.ready
      ? room.ownFleet
      : fleet;
  const ownShots =
    mode === "solo" ? (game?.playerShots ?? []) : (room?.shots ?? []);
  const incoming =
    mode === "solo" ? (game?.botShots ?? []) : (room?.incoming ?? []);
  const enemyFleet = finished
    ? mode === "solo"
      ? game!.botFleet
      : (room?.opponentFleet ?? [])
    : [];
  const validFleet = validateFleet(fleet).valid;
  const fleetLocked = mode === "friend" && !!room?.ready;
  const totalWins = history.filter((item) => item.outcome === "win").length;
  const totalShots = history.reduce((sum, item) => sum + item.shots, 0);
  const totalHits = history.reduce((sum, item) => sum + item.hits, 0);
  const boardTheme = proDemo ? theme : "mint";
  const lastOwn = ownShots[ownShots.length - 1];
  const lastIncoming = incoming[incoming.length - 1];
  const destroyed = ownShots.filter((shot) => shot.result === "sunk").length;
  const currentRecord =
    mode === "solo"
      ? history.find((item) => item.id === game?.id)
      : history.find(
          (item) => item.id === `room-${room?.code}-${room?.createdAt}`,
        );

  function manualPlace(cell: number) {
    if (fleetLocked) return;
    const existing = fleet.find((ship) => ship.cells.includes(cell));
    if (existing) {
      setFleet((current) => current.filter((ship) => ship.id !== existing.id));
      setSelectedSize(existing.size);
      return;
    }
    const remaining =
      FLEET_SIZES.filter((size) => size === selectedSize).length -
      fleet.filter((ship) => ship.size === selectedSize).length;
    if (remaining <= 0) {
      setNotice("Все корабли этого размера уже на поле. Выбери другой размер.");
      return;
    }
    if (!canPlaceShip(fleet, cell, selectedSize, orientation)) {
      setNotice("Корабли должны помещаться на поле и не касаться друг друга.");
      return;
    }
    const cells = shipCells(cell, selectedSize, orientation)!;
    const next = [
      ...fleet,
      { id: `ship-${selectedSize}-${Date.now()}`, size: selectedSize, cells },
    ];
    setFleet(next);
    if (remaining === 1) {
      const nextSize = FLEET_SIZES.find(
        (size) =>
          next.filter((ship) => ship.size === size).length <
          FLEET_SIZES.filter((value) => value === size).length,
      );
      if (nextSize) setSelectedSize(nextSize);
    }
  }
  function startSolo() {
    if (!validFleet) {
      setError("Расставь все 10 кораблей перед началом.");
      return;
    }
    setGame({
      id: crypto.randomUUID(),
      difficulty,
      phase: "battle",
      playerFleet: fleet,
      botFleet: randomFleet(),
      playerShots: [],
      botShots: [],
      turn: "player",
      winner: null,
      startedAt: Date.now(),
    });
    setError("");
  }
  function fireSolo(cell: number) {
    if (
      !game ||
      game.phase !== "battle" ||
      game.turn !== "player" ||
      game.playerShots.some((shot) => shot.cell === cell)
    )
      return;
    try {
      const result = fireAt(game.botFleet, game.playerShots, cell);
      setGame({
        ...game,
        playerShots: result.shots,
        turn: result.shot.result === "miss" ? "bot" : "player",
        phase: result.finished ? "finished" : "battle",
        winner: result.finished ? "player" : null,
        ...(result.finished ? { finishedAt: Date.now() } : {}),
      });
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  async function roomAction(
    action: "create" | "join" | "ready" | "fire",
    cell?: number,
  ) {
    if (pending) return;
    setPending(action);
    setError("");
    try {
      const next =
        action === "create"
          ? await api.createRoom(roomName.trim() || "Капитан")
          : action === "join"
            ? await api.joinRoom(
                joinCode.trim().toUpperCase(),
                roomName.trim() || "Капитан",
              )
            : action === "ready"
              ? await api.placeFleet(room!.code, fleet)
              : await api.fireRoom(room!.code, cell!);
      setRoom((current) =>
        !current ||
        next.revision >= current.revision ||
        next.code !== current.code
          ? next
          : current,
      );
      setJoinCode(next.code);
      const url = new URL(window.location.href);
      url.searchParams.set("room", next.code);
      window.history.replaceState({}, "", url);
      if (next.ownFleet.length) setFleet(next.ownFleet);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending("");
    }
  }
  function leaveRoom() {
    setRoom(null);
    setJoinCode("");
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState({}, "", url);
    setFleet(randomFleet());
  }
  function replay() {
    if (mode === "friend") leaveRoom();
    else {
      pendingClearId.current = game?.id;
      setGame(null);
      setFleet(randomFleet());
    }
  }
  async function copyRoom() {
    if (!room) return;
    const url = new URL(window.location.href);
    url.searchParams.set("room", room.code);
    try {
      await navigator.clipboard.writeText(url.href);
      setCopied(true);
      setNotice("Ссылка скопирована. Отправь её другу.");
      window.setTimeout(() => setCopied(false), 3000);
    } catch {
      setNotice(
        `Код комнаты: ${room.code}. Ссылка находится в адресной строке.`,
      );
    }
  }
  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = new FormData(event.currentTarget);
    accountRevision.current += 1;
    syncVersion.current += 1;
    setPending("account");
    setAccountError("");
    try {
      // Finish existing writes before the login request changes the session cookie.
      await syncQueue.current;
      const username = String(values.get("username"));
      const password = String(values.get("password"));
      const account =
        accountMode === "login"
          ? await api.login(username, password)
          : await api.register(
              username,
              password,
              String(values.get("displayName") || username),
            );
      mergeAccount(account);
      setModal(null);
      setNotice("Ты на борту. История и партия синхронизируются.");
    } catch (cause) {
      setAccountError((cause as Error).message);
    } finally {
      setPending("");
    }
  }
  async function signOut() {
    if (pending) return;
    accountRevision.current += 1;
    syncVersion.current += 1;
    setPending("account");
    try {
      await syncQueue.current;
      let cloudSaved = false;
      try {
        await api.syncAccount({
          ...currentProfile.current,
          clearSavedGameId: pendingClearId.current,
        });
        cloudSaved = true;
      } catch {
        /* The account-specific local copy remains available after login. */
      }
      const account = await api.logout();
      mergeAccount(account);
      setModal(null);
      setNotice(
        cloudSaved
          ? "Выход выполнен. История остаётся в твоём аккаунте."
          : "Выход выполнен. Облачное сохранение не подтверждено — локальный прогресс вернётся после входа.",
      );
    } catch (cause) {
      setAccountError((cause as Error).message);
    } finally {
      setPending("");
    }
  }

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        К основному содержимому
      </a>
      <aside className="rail" aria-label="Основная навигация">
        <button
          className="brand-mark"
          aria-label="SALVO — играть"
          onClick={() => setPage("play")}
        >
          <Anchor size={28} strokeWidth={2.1} />
        </button>
        <div className="rail-nav">
          <button
            className={`rail-button ${page === "play" ? "active" : ""}`}
            aria-label="Играть"
            aria-current={page === "play" ? "page" : undefined}
            title="Играть"
            onClick={() => setPage("play")}
          >
            <Gamepad2 size={23} />
            <span>Играть</span>
          </button>
          <button
            className={`rail-button ${page === "history" ? "active" : ""}`}
            aria-label="История матчей"
            aria-current={page === "history" ? "page" : undefined}
            title="История матчей"
            onClick={() => setPage("history")}
          >
            <History size={23} />
            <span>История</span>
          </button>
          <button
            className={`rail-button ${page === "pro" ? "active" : ""}`}
            aria-label="SALVO Pro"
            aria-current={page === "pro" ? "page" : undefined}
            title="SALVO Pro"
            onClick={() => setPage("pro")}
          >
            <Crown size={23} />
            <span>Pro</span>
            {proDemo && <i className="rail-indicator" />}
          </button>
        </div>
        <button
          className="rail-help"
          aria-label="Правила игры"
          title="Правила игры"
          onClick={() => setModal("rules")}
        >
          <Info size={23} />
        </button>
        <div className="rail-foot">S / 26</div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="wordmark"
            onClick={() => setPage("play")}
            aria-label="SALVO — на главную"
          >
            SALVO
          </button>
          <span className="topbar-tagline">
            Маленький перерыв. Большая битва.
          </span>
          <div className="topbar-actions">
            <span
              className={`save-status ${cloud === "error" || storageFailed ? "offline" : ""}`}
              title={
                storageFailed
                  ? "Браузер не смог сохранить локальную копию. Освободи место или разреши хранение данных."
                  : cloud === "error"
                    ? "Нет связи с сервером. Прогресс сохранён на этом устройстве."
                    : cloud === "synced"
                      ? "Сохранено в аккаунте"
                      : "Прогресс сохраняется на этом устройстве"
              }
            >
              <span />
              {storageFailed && cloud !== "synced" && cloud !== "syncing"
                ? "Не сохранено"
                : cloud === "syncing"
                  ? "Сохраняем…"
                  : cloud === "synced"
                    ? "В облаке"
                    : "На устройстве"}
            </span>
            <button
              className="account-button"
              onClick={() => {
                setAccountError("");
                setModal("account");
              }}
            >
              <UserRound size={17} />
              {user?.displayName ?? "Войти"}
              <ChevronRight size={14} />
            </button>
          </div>
        </header>
        {storageFailed && (
          <div className="storage-warning" role="status">
            <Info size={18} />
            <p>
              Локальная копия не сохранена. Разреши хранение данных или освободи
              место в браузере.
              {cloud !== "synced" &&
                " Не закрывай вкладку, чтобы не потерять текущую партию."}
            </p>
          </div>
        )}
        <div className="content-layout">
          <main id="main-content" className="main-content">
            {page === "play" && (
              <>
                <section className={`hero ${isBattle ? "hero-battle" : ""}`}>
                  <div>
                    <div className="eyebrow">
                      <span className="tiny-cross">+</span>
                      {isBattle
                        ? finished
                          ? "МИССИЯ ЗАВЕРШЕНА"
                          : "ОПЕРАЦИЯ НАЧАЛАСЬ"
                        : "КЛАССИКА. НА НОВОЙ ВОЛНЕ."}
                    </div>
                    <h1>
                      {isBattle ? (
                        finished ? (
                          won ? (
                            <>
                              Чистая победа<span>.</span>
                            </>
                          ) : (
                            <>
                              Море ещё позовёт<span>.</span>
                            </>
                          )
                        ) : (
                          <>
                            Держи курс<span>.</span>
                          </>
                        )
                      ) : (
                        <>
                          Морской бой.
                          <br />
                          На твоей волне<span>.</span>
                        </>
                      )}
                    </h1>
                    <p>
                      {isBattle
                        ? finished
                          ? "У каждой партии есть чему тебя научить."
                          : "Один точный выстрел может изменить всё."
                        : "Расставь флот. Выбери соперника. Забери победу."}
                    </p>
                  </div>
                  {!isBattle && (
                    <div className="hero-art">
                      <SeaDrawing />
                      <span className="art-caption">
                        ДВА ФЛОТА · ОДИН ОКЕАН
                      </span>
                    </div>
                  )}
                  {isBattle && (
                    <div className="match-clock">
                      <span>ВРЕМЯ В МОРЕ</span>
                      <strong>{formatTime(elapsed)}</strong>
                      <span>
                        {mode === "solo"
                          ? DIFFICULTIES[game!.difficulty].label
                          : room?.opponentName}
                      </span>
                    </div>
                  )}
                </section>
                <div className="game-toolbar">
                  <div className="mode-switch" aria-label="Режим игры">
                    <button
                      className={mode === "solo" ? "selected" : ""}
                      onClick={() => setMode("solo")}
                      aria-pressed={mode === "solo"}
                    >
                      <Gamepad2 size={17} />С ботом
                    </button>
                    <button
                      className={mode === "friend" ? "selected" : ""}
                      onClick={() => setMode("friend")}
                      aria-pressed={mode === "friend"}
                    >
                      <Users size={17} />С другом
                      {room && <span className="mode-dot" />}
                    </button>
                  </div>
                  <button
                    className="text-button rules-button"
                    onClick={() => setModal("rules")}
                  >
                    <Info size={15} />
                    Как играть
                  </button>
                </div>
                <section
                  className={`game-panel ${isBattle ? "battle-panel" : ""}`}
                >
                  <div className="panel-heading">
                    <div className="section-label">
                      <span className="step-number">
                        {isBattle ? "02" : "01"}
                      </span>
                      <h2>{isBattle ? "Морская дуэль" : "Флот на старт"}</h2>
                    </div>
                    <span
                      className={`status-pill ${isBattle ? (finished ? "neutral" : yourTurn ? "coral" : "neutral") : validFleet || fleetLocked ? "mint" : "neutral"}`}
                    >
                      <span />
                      {isBattle
                        ? finished
                          ? "Бой окончен"
                          : yourTurn
                            ? "Твой ход"
                            : mode === "solo"
                              ? "Бот думает"
                              : "Ход соперника"
                        : fleetLocked
                          ? "Флот зафиксирован"
                          : validFleet
                            ? "Готов к выходу"
                            : `${fleet.length} из 10 кораблей`}
                    </span>
                  </div>
                  {!isBattle ? (
                    <>
                      <div className="setup-layout">
                        <div className="setup-board">
                          <div className="board-heading">
                            <h3>Твоя акватория</h3>
                            <span>10 × 10</span>
                          </div>
                          <Board
                            fleet={ownFleet}
                            shots={[]}
                            label="Расстановка своего флота"
                            interactive={!fleetLocked}
                            placement
                            onCell={manualPlace}
                            selectedSize={selectedSize}
                            orientation={orientation}
                            theme={boardTheme}
                          />
                          <div className="board-caption">
                            <span>
                              <i className="legend-ship" />
                              Твой корабль
                            </span>
                            <span>Нажми на корабль, чтобы убрать</span>
                          </div>
                        </div>
                        <div className="setup-controls">
                          <div className="control-title">
                            <ShipIcon size={17} />
                            <h3>Твой флот</h3>
                            <span>20 палуб</span>
                          </div>
                          <p className="control-hint">
                            Расставь сам или доверься случаю.
                          </p>
                          <div className="fleet-picker">
                            {[4, 3, 2, 1].map((size) => {
                              const expected = FLEET_SIZES.filter(
                                (item) => item === size,
                              ).length;
                              const placed = fleet.filter(
                                (ship) => ship.size === size,
                              ).length;
                              return (
                                <button
                                  key={size}
                                  disabled={fleetLocked}
                                  onClick={() => setSelectedSize(size)}
                                  className={`fleet-option ${selectedSize === size ? "selected" : ""}`}
                                  aria-label={`Выбрать ${size}-палубный корабль, расставлено ${placed} из ${expected}`}
                                  aria-pressed={selectedSize === size}
                                >
                                  <span className="mini-ship">
                                    {Array.from(
                                      { length: size },
                                      (_, index) => (
                                        <i key={index} />
                                      ),
                                    )}
                                  </span>
                                  <span>
                                    {size === 4
                                      ? "Линкор"
                                      : size === 3
                                        ? "Крейсер"
                                        : size === 2
                                          ? "Эсминец"
                                          : "Катер"}
                                  </span>
                                  <span className="fleet-count">
                                    {placed === expected ? (
                                      <Check size={14} />
                                    ) : (
                                      `${placed}/${expected}`
                                    )}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                          <div className="placement-actions">
                            <button
                              className="secondary-button"
                              disabled={fleetLocked}
                              onClick={() =>
                                setOrientation((current) =>
                                  current === "horizontal"
                                    ? "vertical"
                                    : "horizontal",
                                )
                              }
                              title={
                                orientation === "horizontal"
                                  ? "Сейчас горизонтально"
                                  : "Сейчас вертикально"
                              }
                            >
                              <RotateCw size={15} />
                              Повернуть
                              <span className="key-hint">
                                {orientation === "horizontal" ? "↔" : "↕"}
                              </span>
                            </button>
                            <button
                              className="icon-button bordered"
                              disabled={fleetLocked}
                              onClick={() => {
                                setFleet([]);
                                setSelectedSize(4);
                              }}
                              aria-label="Очистить поле"
                              title="Очистить поле"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                          <button
                            className="shuffle-button"
                            disabled={fleetLocked}
                            onClick={() => setFleet(randomFleet())}
                          >
                            <Sparkles size={16} />
                            Расставить случайно
                            <RotateCw size={14} />
                          </button>
                          <div className="placement-tip">
                            <Info size={15} />
                            <p>
                              Оставляй между кораблями хотя бы одну клетку, даже
                              по диагонали.
                            </p>
                          </div>
                        </div>
                      </div>
                      {mode === "solo" ? (
                        <div className="launch-area">
                          <div className="difficulty-label">
                            <span>СОПЕРНИК</span>
                            <p>{DIFFICULTIES[difficulty].description}</p>
                          </div>
                          <div className="launch-row">
                            <div
                              className="difficulty-picker"
                              aria-label="Сложность бота"
                            >
                              {(["easy", "medium", "hard"] as Difficulty[]).map(
                                (item, index) => (
                                  <button
                                    key={item}
                                    className={
                                      difficulty === item ? "selected" : ""
                                    }
                                    onClick={() => setDifficulty(item)}
                                    aria-pressed={difficulty === item}
                                  >
                                    <span className="difficulty-bars">
                                      {[0, 1, 2].map((bar) => (
                                        <i
                                          key={bar}
                                          className={
                                            bar <= index ? "filled" : ""
                                          }
                                        />
                                      ))}
                                    </span>
                                    {DIFFICULTIES[item].label}
                                  </button>
                                ),
                              )}
                            </div>
                            <button
                              className="primary-button start-button"
                              onClick={startSolo}
                              disabled={!validFleet}
                            >
                              В бой
                              <ArrowRight size={19} />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="friend-area">
                          {!room ? (
                            <>
                              <div className="friend-copy">
                                <h3>Свой человек. Честный поединок.</h3>
                                <p>
                                  Создай комнату и отправь другу ссылку.
                                  Регистрация не нужна.
                                </p>
                              </div>
                              <div className="room-form">
                                <label>
                                  Твой позывной
                                  <input
                                    value={roomName}
                                    onChange={(event) =>
                                      setRoomName(event.target.value)
                                    }
                                    maxLength={24}
                                    placeholder="Капитан"
                                  />
                                </label>
                                <button
                                  className="primary-button"
                                  disabled={!!pending}
                                  onClick={() => roomAction("create")}
                                >
                                  {pending === "create" ? (
                                    <Loader2 className="spin" size={17} />
                                  ) : (
                                    <Users size={17} />
                                  )}
                                  Создать комнату
                                </button>
                              </div>
                              <div className="join-form">
                                <input
                                  aria-label="Код комнаты"
                                  value={joinCode}
                                  onChange={(event) =>
                                    setJoinCode(
                                      event.target.value.toUpperCase(),
                                    )
                                  }
                                  placeholder="Есть код комнаты?"
                                  maxLength={12}
                                />
                                <button
                                  className="text-button"
                                  disabled={!joinCode.trim() || !!pending}
                                  onClick={() => roomAction("join")}
                                >
                                  {pending === "join" ? (
                                    <Loader2 className="spin" size={16} />
                                  ) : null}
                                  Присоединиться
                                  <ArrowRight size={16} />
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="room-info">
                                <div>
                                  <span className="eyebrow">КОМНАТА</span>
                                  <strong>{room.code}</strong>
                                </div>
                                <button
                                  className="secondary-button"
                                  onClick={copyRoom}
                                >
                                  {copied ? (
                                    <Check size={16} />
                                  ) : (
                                    <Copy size={16} />
                                  )}
                                  {copied ? "Скопировано" : "Пригласить друга"}
                                </button>
                              </div>
                              <div className="room-status">
                                <span
                                  className={`connection-dot ${room.opponentJoined ? "connected" : ""}`}
                                />
                                {room.opponentJoined
                                  ? `${room.opponentName} ${room.opponentReady ? "готов к бою" : "расставляет флот"}`
                                  : "Ждём друга. Поделись ссылкой на комнату."}
                              </div>
                              <div className="room-actions">
                                <button
                                  className="text-button muted"
                                  onClick={leaveRoom}
                                >
                                  Выйти из комнаты
                                </button>
                                <button
                                  className="primary-button"
                                  disabled={
                                    !validFleet || room.ready || !!pending
                                  }
                                  onClick={() => roomAction("ready")}
                                >
                                  {pending === "ready" ? (
                                    <Loader2 className="spin" size={17} />
                                  ) : room.ready ? (
                                    <Check size={17} />
                                  ) : (
                                    <Flag size={17} />
                                  )}
                                  {room.ready
                                    ? "Ждём соперника"
                                    : "Готов к бою"}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {finished && (
                        <div className={`result-strip ${won ? "victory" : ""}`}>
                          <div className="result-icon">
                            {won ? <Trophy size={26} /> : <Anchor size={26} />}
                          </div>
                          <div>
                            <strong>
                              {won
                                ? "Этот океан — твой."
                                : "Новый бой — новый шанс."}
                            </strong>
                            <p>
                              {won
                                ? "Весь флот соперника отправлен на дно."
                                : "Твой флот потоплен. Посмотри разбор и попробуй ещё."}
                            </p>
                          </div>
                          <button
                            className="secondary-button"
                            onClick={() =>
                              currentRecord && setReport(currentRecord)
                            }
                            disabled={!currentRecord}
                          >
                            Разбор
                            <ArrowRight size={15} />
                          </button>
                        </div>
                      )}
                      {!finished && (
                        <div
                          className={`turn-banner ${yourTurn ? "your-turn" : ""}`}
                        >
                          <div>
                            {yourTurn ? (
                              <Crosshair size={20} />
                            ) : (
                              <Radio size={20} className="thinking" />
                            )}
                            <span>
                              <strong>
                                {yourTurn
                                  ? "Твой ход, капитан"
                                  : mode === "solo"
                                    ? "Соперник выбирает цель…"
                                    : "Соперник делает ход…"}
                              </strong>
                              <small>
                                {yourTurn
                                  ? "Выбери клетку на поле соперника. Попадание даёт ещё один ход."
                                  : "Твоя акватория под наблюдением. Скоро твоя очередь."}
                              </small>
                            </span>
                          </div>
                          <span className="live-dot" />
                        </div>
                      )}
                      <div className="battle-boards">
                        <div>
                          <div className="board-heading">
                            <h3>
                              <ShieldCheck size={16} />
                              Твой флот
                            </h3>
                            <span>{20 - countHits(incoming)} / 20 палуб</span>
                          </div>
                          <Board
                            fleet={ownFleet}
                            shots={incoming}
                            label="Твой флот и выстрелы соперника"
                            theme={boardTheme}
                          />
                          <div className="board-caption">
                            <span>
                              <i className="legend-ship" />
                              Твой корабль
                            </span>
                            <span>
                              <i className="legend-hit" />
                              Попадание
                            </span>
                          </div>
                        </div>
                        <div>
                          <div className="board-heading enemy-heading">
                            <h3>
                              <Crosshair size={16} />
                              {mode === "solo"
                                ? "Флот соперника"
                                : room?.opponentName}
                            </h3>
                            <span>{destroyed} / 10 потоплено</span>
                          </div>
                          <Board
                            fleet={enemyFleet}
                            shots={ownShots}
                            label="Поле соперника — выбери цель"
                            interactive={!finished && !!yourTurn && !pending}
                            onCell={(cell) =>
                              mode === "solo"
                                ? fireSolo(cell)
                                : roomAction("fire", cell)
                            }
                            theme={boardTheme}
                            enemy
                          />
                          <div className="board-caption">
                            <span>
                              <i className="legend-miss" />
                              Мимо
                            </span>
                            <span>
                              {finished ? "Флот раскрыт" : "Наведи и стреляй"}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="battle-footer">
                        <div className="battle-metrics">
                          <div>
                            <strong>{ownShots.length}</strong>
                            <span>выстрелов</span>
                          </div>
                          <div>
                            <strong>
                              {percent(countHits(ownShots), ownShots.length)}
                            </strong>
                            <span>точность</span>
                          </div>
                        </div>
                        {finished ? (
                          <button className="primary-button" onClick={replay}>
                            Ещё один бой
                            <ArrowRight size={18} />
                          </button>
                        ) : (
                          <span className="autosave-note">
                            {storageFailed && cloud !== "synced" ? (
                              <Info size={14} />
                            ) : (
                              <Check size={14} />
                            )}
                            {cloud === "synced"
                              ? "Сохранено в аккаунте"
                              : storageFailed
                                ? "Копия не сохранена"
                                : "Сохранено на устройстве"}
                          </span>
                        )}
                      </div>
                      <div className="battle-log" aria-live="polite">
                        <span className="log-label">БОРТОВОЙ ЖУРНАЛ</span>
                        {lastOwn || lastIncoming ? (
                          <div>
                            {lastOwn && (
                              <p>
                                <span className="log-dot coral" />
                                <strong>Ты · {coordinate(lastOwn.cell)}</strong>
                                <span>{outcomeText(lastOwn)}</span>
                              </p>
                            )}
                            {lastIncoming && (
                              <p>
                                <span className="log-dot" />
                                <strong>
                                  {mode === "solo" ? "Бот" : "Друг"} ·{" "}
                                  {coordinate(lastIncoming.cell)}
                                </strong>
                                <span>{outcomeText(lastIncoming)}</span>
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="log-empty">
                            Здесь появится история последних выстрелов.
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </section>
                <div className="below-game">
                  <span>
                    <ShieldCheck size={14} />
                    Бот не видит твои корабли
                  </span>
                  <span>10 кораблей · 20 палуб · 1 победитель</span>
                  <button
                    className="text-button"
                    onClick={() => setPage("pro")}
                  >
                    Чуть больше с Pro
                    <Sparkles size={13} />
                  </button>
                </div>
              </>
            )}

            {page === "history" && (
              <>
                <section className="hero section-hero">
                  <div>
                    <div className="eyebrow">
                      <span className="tiny-cross">+</span>КАЖДАЯ ПАРТИЯ — ОПЫТ
                    </div>
                    <h1>
                      Бортовой журнал<span>.</span>
                    </h1>
                    <p>Твои победы, выводы и следующий точный выстрел.</p>
                  </div>
                  <History size={60} className="hero-page-icon" />
                </section>
                <div className="history-stats">
                  <div>
                    <span>Сыграно партий</span>
                    <strong>
                      {history.length.toString().padStart(2, "0")}
                    </strong>
                  </div>
                  <div>
                    <span>Побед</span>
                    <strong>{totalWins.toString().padStart(2, "0")}</strong>
                  </div>
                  <div>
                    <span>Точность</span>
                    <strong>{percent(totalHits, totalShots)}</strong>
                  </div>
                </div>
                <section className="history-panel">
                  <div className="panel-heading">
                    <h2>Прошлые выходы в море</h2>
                    <span className="small-muted">
                      {user ? "В твоём аккаунте" : "На этом устройстве"}
                    </span>
                  </div>
                  {!history.length ? (
                    <div className="empty-state">
                      <div className="empty-icon">
                        <Waves size={42} />
                      </div>
                      <h3>Океан ждёт первую историю</h3>
                      <p>
                        Сыграй партию — здесь появятся результат,
                        <br />
                        статистика и персональный разбор.
                      </p>
                      <button
                        className="primary-button"
                        onClick={() => setPage("play")}
                      >
                        Отправиться в бой
                        <ArrowRight size={17} />
                      </button>
                    </div>
                  ) : (
                    <div className="match-list">
                      {history.map((record) => (
                        <button
                          className="match-item"
                          key={record.id}
                          onClick={() => setReport(record)}
                        >
                          <div
                            className={`match-outcome ${record.outcome === "win" ? "win" : ""}`}
                          >
                            {record.outcome === "win" ? (
                              <Trophy size={19} />
                            ) : (
                              <Anchor size={19} />
                            )}
                          </div>
                          <div className="match-description">
                            <strong>
                              {record.outcome === "win"
                                ? "Победа"
                                : "Поражение"}
                              <span>
                                {record.mode === "friend"
                                  ? "С другом"
                                  : DIFFICULTIES[record.difficulty ?? "medium"]
                                      .label}
                              </span>
                            </strong>
                            <small>
                              {new Intl.DateTimeFormat("ru", {
                                day: "numeric",
                                month: "short",
                                hour: "2-digit",
                                minute: "2-digit",
                              }).format(record.finishedAt)}{" "}
                              · {formatTime(record.durationMs)}
                            </small>
                          </div>
                          <div className="match-accuracy">
                            <strong>
                              {percent(record.hits, record.shots)}
                            </strong>
                            <span>точность</span>
                          </div>
                          <ChevronRight size={19} />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
                {!user && (
                  <div className="account-nudge">
                    <UserRound size={22} />
                    <div>
                      <strong>Твой опыт путешествует с тобой</strong>
                      <p>
                        Создай аккаунт, чтобы продолжить на другом устройстве.
                      </p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setModal("account")}
                    >
                      Войти
                      <ArrowRight size={16} />
                    </button>
                  </div>
                )}
              </>
            )}

            {page === "pro" && (
              <>
                <section className="hero section-hero">
                  <div>
                    <div className="eyebrow">
                      <span className="tiny-cross">+</span>БОЛЬШЕ ТВОЕГО
                      ХАРАКТЕРА
                    </div>
                    <h1>
                      Твой личный
                      <br />
                      океан<span>.</span>
                    </h1>
                    <p>Смена настроения. Больше деталей. Всё ещё SALVO.</p>
                  </div>
                  <div className="pro-emblem">
                    <Crown size={49} />
                    <span>PRO</span>
                  </div>
                </section>
                <section className="pro-panel">
                  <div className="pro-topline">
                    <span className="pro-badge">
                      <Sparkles size={14} />
                      SALVO PRO
                    </span>
                    <span className="demo-label">ДЕМОНСТРАЦИЯ</span>
                  </div>
                  <h2>Победа — в деталях.</h2>
                  <p>
                    Попробуй оформление полей и расширенный разбор своей игры.
                  </p>
                  <div className="pro-features">
                    <div>
                      <Waves size={23} />
                      <h3>Три акватории</h3>
                      <p>Спокойная мята, открытый океан или ночной рейд.</p>
                    </div>
                    <div>
                      <Target size={23} />
                      <h3>Взгляд тренера</h3>
                      <p>Точность, лишние выстрелы и полная хронология боя.</p>
                    </div>
                    <div>
                      <UserRound size={23} />
                      <h3>Твой позывной</h3>
                      <p>Значок Pro в штабе и синхронизация с аккаунтом.</p>
                    </div>
                  </div>
                  <div className="pro-activation">
                    <div>
                      <strong>
                        {proDemo
                          ? "Pro уже на борту"
                          : "Открой деморежим бесплатно"}
                      </strong>
                      <span>
                        Без платежей, карты и автоматических списаний.
                      </span>
                    </div>
                    <button
                      className={
                        proDemo ? "secondary-button" : "primary-button"
                      }
                      onClick={() => {
                        setProDemo((current) => !current);
                        setNotice(
                          proDemo
                            ? "Деморежим Pro выключен"
                            : "Pro включён. Выбирай свою акваторию.",
                        );
                      }}
                    >
                      {proDemo ? <Check size={17} /> : <Sparkles size={17} />}
                      {proDemo ? "Выключить Pro" : "Попробовать Pro"}
                    </button>
                  </div>
                </section>
                <section className="theme-section">
                  <div className="panel-heading">
                    <h2>Настроение твоего поля</h2>
                    {!proDemo && (
                      <span className="small-muted">
                        Включи деморежим для выбора
                      </span>
                    )}
                  </div>
                  <div className="theme-options">
                    {(
                      [
                        {
                          id: "mint",
                          title: "Тихая гавань",
                          note: "Знакомая классика",
                        },
                        {
                          id: "blue",
                          title: "Открытый океан",
                          note: "На синей волне",
                        },
                        {
                          id: "night",
                          title: "Ночной рейд",
                          note: "После заката",
                        },
                      ] as { id: BoardTheme; title: string; note: string }[]
                    ).map((item) => (
                      <button
                        key={item.id}
                        className={`theme-option ${boardTheme === item.id ? "selected" : ""}`}
                        disabled={!proDemo}
                        onClick={() => setTheme(item.id)}
                        aria-pressed={boardTheme === item.id}
                      >
                        <div className={`theme-preview theme-${item.id}`}>
                          <span className="theme-ship" />
                          <span className="theme-dot" />
                          <span className="theme-cross">×</span>
                          {boardTheme === item.id && (
                            <span className="theme-check">
                              <Check size={15} />
                            </span>
                          )}
                        </div>
                        <strong>{item.title}</strong>
                        <small>{item.note}</small>
                      </button>
                    ))}
                  </div>
                </section>
              </>
            )}
          </main>

          <aside className="headquarters">
            <div className="headquarters-heading">
              <span>ТВОЙ ШТАБ</span>
              <span className="small-plus">+</span>
            </div>
            <section className="commander-card">
              <div className="avatar">
                <Anchor size={30} />
                <span>{proDemo ? <Crown size={12} /> : <span />}</span>
              </div>
              <div className="commander-name">
                <h2>{user?.displayName ?? "Привет, капитан"}</h2>
                <span>
                  {proDemo
                    ? "На борту с Pro"
                    : history.length >= 10
                      ? "Опытный мореплаватель"
                      : history.length
                        ? "Курс на победу"
                        : "Большое плавание начинается"}
                </span>
              </div>
              <div className="commander-stats">
                <div>
                  <strong>{history.length.toString().padStart(2, "0")}</strong>
                  <span>боёв</span>
                </div>
                <div>
                  <strong>{percent(totalWins, history.length)}</strong>
                  <span>побед</span>
                </div>
                <div>
                  <strong>{percent(totalHits, totalShots)}</strong>
                  <span>точность</span>
                </div>
              </div>
              {!user ? (
                <button
                  className="commander-login"
                  onClick={() => setModal("account")}
                >
                  Сохрани свой позывной
                  <ArrowRight size={15} />
                </button>
              ) : (
                <span className="commander-synced">
                  <ShieldCheck size={14} />
                  {cloud === "error"
                    ? "Сохранено на устройстве"
                    : "Аккаунт капитана"}
                </span>
              )}
            </section>
            <section className="mission-card">
              <div className="mission-icon">
                <Flag size={18} />
              </div>
              <span className="eyebrow">ТВОЯ ПЕРВАЯ МИССИЯ</span>
              <h3>{totalWins ? "Есть первая победа!" : "Начать с победы"}</h3>
              <p>
                {totalWins
                  ? "Так держать. Теперь время отточить точность."
                  : "Потопи весь флот соперника. Остальное — дело практики."}
              </p>
              <div className="mission-progress">
                <span style={{ width: totalWins ? "100%" : "0%" }} />
              </div>
              <div className="mission-progress-label">
                <span>{totalWins ? "Миссия выполнена" : "Первая победа"}</span>
                <strong>{totalWins ? "1" : "0"} / 1</strong>
              </div>
            </section>
            <section className="coach-card">
              <div className="coach-tag">
                <span>
                  <Sparkles size={15} />
                  ТРЕНЕР SALVO
                </span>
                <span>↗</span>
              </div>
              <h3>
                Каждый выстрел
                <br />
                имеет значение.
              </h3>
              <p>
                {history.length
                  ? "Твоя последняя партия уже готова к разбору. Найдём следующий точный ход."
                  : "После партии разберём твою тактику и найдём, где можно сыграть точнее."}
              </p>
              <button
                onClick={() =>
                  history.length ? setReport(history[0]) : setPage("history")
                }
              >
                Посмотреть разбор
                <ArrowRight size={17} />
              </button>
              <div className="coach-target">
                <span />
                <span />
                <span />
                <Crosshair size={18} />
              </div>
            </section>
            <div className="sidebar-note">
              <Waves size={24} />
              <p>
                Никакой суеты.
                <br />
                Только ты и следующий ход.
              </p>
            </div>
            <div className="sidebar-footer">
              <span>СДЕЛАНО ДЛЯ ПАУЗЫ</span>
              <span>© SALVO 2026</span>
            </div>
          </aside>
        </div>
        <footer className="mobile-footer">
          SALVO · Твой следующий точный ход.
        </footer>
      </div>

      {error && (
        <div className="toast error-toast" role="alert">
          <Info size={19} />
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Закрыть сообщение">
            <X size={17} />
          </button>
        </div>
      )}
      {notice && (
        <div className="toast notice-toast" role="status">
          <Check size={18} />
          <span>{notice}</span>
          <button
            onClick={() => setNotice("")}
            aria-label="Закрыть уведомление"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal === "rules" && (
        <Modal title="Правила морского боя" onClose={closeModal}>
          <div className="rules-intro">
            <Anchor size={29} />
            <p>
              Всё знакомо. Десять кораблей, сто клеток и немного морской
              интуиции.
            </p>
          </div>
          <ol className="rules-list">
            <li>
              <strong>Подготовь флот</strong>
              <p>
                Один линкор на 4 клетки, два крейсера на 3, три эсминца на 2 и
                четыре катера на 1. Корабли не касаются, даже углами.
              </p>
            </li>
            <li>
              <strong>Выбери цель</strong>
              <p>
                Нажимай на клетки поля соперника. Точка — мимо, крестик —
                попадание. В одну клетку можно стрелять только раз.
              </p>
            </li>
            <li>
              <strong>Продолжай после попадания</strong>
              <p>
                Попал — стреляешь снова. Промахнулся — ход переходит сопернику.
                Потопи все 10 кораблей, чтобы победить.
              </p>
            </li>
          </ol>
          <div className="rules-extra">
            <ShieldCheck size={20} />
            <p>
              Бот знает только результаты своих выстрелов. Его сложность меняет
              стратегию, а не доступ к твоим кораблям.
            </p>
          </div>
          <div className="keyboard-note">
            <strong>Игра с клавиатуры</strong>
            <p>
              Tab — перейти на поле, стрелки — выбрать клетку, Enter или пробел
              — сделать ход. Escape — закрыть это окно.
            </p>
          </div>
          <button className="primary-button full-width" onClick={closeModal}>
            Понятно. Погнали
            <ArrowRight size={18} />
          </button>
        </Modal>
      )}
      {modal === "account" && (
        <Modal
          title={user ? "Твой аккаунт" : "Добро пожаловать на борт"}
          onClose={closeModal}
        >
          {user ? (
            <div className="account-profile">
              <div className="profile-avatar">
                <Anchor size={35} />
              </div>
              <h3>{user.displayName}</h3>
              <p>@{user.username}</p>
              <div className="account-cloud-note">
                <ShieldCheck size={20} />
                <span>
                  {cloud === "error"
                    ? "Нет связи с сервером. Изменения хранятся на этом устройстве."
                    : "Партия, история и деморежим Pro сохраняются в аккаунте."}
                </span>
              </div>
              {accountError && (
                <p className="form-error" role="alert">
                  {accountError}
                </p>
              )}
              <button
                className="secondary-button full-width"
                disabled={!!pending}
                onClick={signOut}
              >
                <LogOut size={17} />
                Выйти из аккаунта
              </button>
            </div>
          ) : (
            <>
              <p className="modal-description">
                Сохрани свой прогресс и продолжай на любом устройстве. Играть
                можно и без аккаунта.
              </p>
              <div className="auth-switch">
                <button
                  className={accountMode === "register" ? "selected" : ""}
                  onClick={() => {
                    setAccountMode("register");
                    setAccountError("");
                  }}
                >
                  Регистрация
                </button>
                <button
                  className={accountMode === "login" ? "selected" : ""}
                  onClick={() => {
                    setAccountMode("login");
                    setAccountError("");
                  }}
                >
                  Вход
                </button>
              </div>
              <form className="account-form" onSubmit={submitAccount}>
                {accountMode === "register" && (
                  <label>
                    Позывной
                    <input
                      name="displayName"
                      placeholder="Как к тебе обращаться?"
                      autoComplete="nickname"
                      maxLength={24}
                      required
                    />
                  </label>
                )}
                <label>
                  Логин
                  <input
                    name="username"
                    placeholder="captain_salvo"
                    autoComplete="username"
                    pattern="[a-zA-Z0-9_]{3,24}"
                    title="От 3 до 24 латинских букв, цифр или символов _"
                    minLength={3}
                    maxLength={24}
                    required
                  />
                </label>
                <label>
                  Пароль
                  <input
                    name="password"
                    type="password"
                    placeholder="Минимум 8 символов"
                    autoComplete={
                      accountMode === "login"
                        ? "current-password"
                        : "new-password"
                    }
                    minLength={8}
                    maxLength={128}
                    required
                  />
                </label>
                {accountError && (
                  <p className="form-error" role="alert">
                    {accountError}
                  </p>
                )}
                <button
                  className="primary-button full-width"
                  disabled={!!pending}
                  type="submit"
                >
                  {pending === "account" ? (
                    <Loader2 className="spin" size={18} />
                  ) : (
                    <ArrowRight size={18} />
                  )}
                  {accountMode === "register"
                    ? "Создать аккаунт"
                    : "Войти на борт"}
                </button>
                <p className="auth-note">
                  Без email и лишних сообщений. Запомни логин и пароль:
                  восстановление по почте не предусмотрено.
                </p>
              </form>
            </>
          )}
        </Modal>
      )}
      {report && (
        <Modal title="Разбор партии" onClose={closeReport}>
          <CoachReportView
            record={report}
            proDemo={proDemo}
            onOpenPro={() => {
              setReport(null);
              setPage("pro");
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function CoachReportView({
  record,
  proDemo,
  onOpenPro,
}: {
  record: MatchRecord;
  proDemo: boolean;
  onOpenPro: () => void;
}) {
  const analysis = analyzeGame(record.shotHistory, record.durationMs);
  return (
    <div className="coach-report">
      <span className="report-tag">
        <Sparkles size={14} />
        ТРЕНЕР SALVO · АНАЛИЗ ПО ПРАВИЛАМ
      </span>
      <h3>{analysis.title}</h3>
      <div className="report-metrics">
        <div>
          <strong>{analysis.accuracy}%</strong>
          <span>точность</span>
        </div>
        <div>
          <strong>{record.shots}</strong>
          <span>выстрелов</span>
        </div>
        <div>
          <strong>{formatTime(record.durationMs)}</strong>
          <span>время</span>
        </div>
      </div>
      <div className="report-grade">
        <Target size={19} />
        <span>{analysis.grade}</span>
      </div>
      <div className="report-tips">
        {analysis.tips.map((tip, index) => (
          <div key={index}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <p>{tip}</p>
          </div>
        ))}
      </div>
      {proDemo ? (
        <div className="pro-report">
          <div className="pro-report-heading">
            <Crown size={16} />
            <h4>Расширенный разбор</h4>
          </div>
          <p>
            <strong>{analysis.wastedShots}</strong> выстрелов в клетки, где
            корабля уже не могло быть.
          </p>
          <h4>Твои выстрелы по порядку</h4>
          <div className="shot-timeline">
            {record.shotHistory.map((shot, index) => (
              <span
                className={shot.result}
                key={shot.cell}
                title={`${index + 1}. ${coordinate(shot.cell)} — ${outcomeText(shot)}`}
              >
                {coordinate(shot.cell)}
                {shot.result === "miss" ? "·" : "×"}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <button className="report-pro-link" onClick={onOpenPro}>
          <Crown size={17} />
          <span>
            Открыть полную хронологию с Pro<small>Деморежим, без оплаты</small>
          </span>
          <ArrowRight size={16} />
        </button>
      )}
      <p className="report-note">
        Разбор основан на истории выстрелов этой партии. Тренер не использует
        LLM и не отправляет данные во внешний AI-сервис.
      </p>
    </div>
  );
}

export default App;

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AccountState,
  MatchRecord,
  SoloGame,
} from "../src/shared/contracts.js";
import {
  accountState,
  hashPassword,
  readSession,
  replaceSession,
  sha256,
  verifyPassword,
} from "./auth.js";
import {
  createRoom,
  fireRoom,
  joinRoom,
  placeRoom,
  readRoom,
} from "./rooms.js";
import {
  createPostgresStore,
  emptyAccountData,
  MemoryStore,
  type SessionRecord,
  type Store,
  type UserRecord,
} from "./store.js";
import * as validate from "./validation.js";

export type Endpoint = "account" | "room" | "health";
export type ApiRequest = IncomingMessage & {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
};
export interface ApiDependencies {
  store: Store | null;
  now?: () => number;
  secureCookies?: boolean;
}
const MAX_BODY = 512 * 1024;
let configuredStore: Store | null | undefined;
function runtimeDependencies(): ApiDependencies {
  if (configuredStore === undefined) {
    configuredStore = process.env.DATABASE_URL
      ? createPostgresStore(process.env.DATABASE_URL)
      : process.env.SALVO_LOCAL_MEMORY === "1" &&
          process.env.NODE_ENV !== "production" &&
          !process.env.VERCEL
        ? new MemoryStore()
        : null;
  }
  return {
    store: configuredStore,
    secureCookies: Boolean(
      process.env.VERCEL || process.env.NODE_ENV === "production",
    ),
  };
}
function header(req: ApiRequest, key: string): string | undefined {
  const value = req.headers[key];
  return Array.isArray(value) ? value[0] : value;
}
async function parseBody(req: ApiRequest): Promise<Record<string, unknown>> {
  if (
    !header(req, "content-type")?.toLowerCase().startsWith("application/json")
  )
    throw new validate.HttpError(415, "Используйте JSON для отправки данных.");
  if (Number(header(req, "content-length") ?? 0) > MAX_BODY)
    throw new validate.HttpError(413, "Слишком большой запрос.");
  let value = req.body;
  if (value === undefined) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY)
        throw new validate.HttpError(413, "Слишком большой запрос.");
      chunks.push(buffer);
    }
    value = Buffer.concat(chunks).toString("utf8");
  }
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    const raw = value.toString();
    if (Buffer.byteLength(raw) > MAX_BODY)
      throw new validate.HttpError(413, "Слишком большой запрос.");
    try {
      value = JSON.parse(raw);
    } catch {
      throw new validate.HttpError(400, "Не удалось прочитать JSON.");
    }
  } else if (Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_BODY)
    throw new validate.HttpError(413, "Слишком большой запрос.");
  return validate.object(value);
}
function checkOrigin(req: ApiRequest): void {
  const origin = header(req, "origin");
  if (!origin) return; // Non-browser clients have no ambient browser cookies.
  try {
    if (new URL(origin).host === header(req, "host")) return;
  } catch {
    /* Reject malformed origins. */
  }
  throw new validate.HttpError(
    403,
    "Запрос пришёл с другого сайта. Откройте SALVO напрямую.",
  );
}
function clientIp(req: ApiRequest): string {
  // Vercel replaces this header with the actual client address. Local development trusts only its socket.
  return process.env.VERCEL
    ? (header(req, "x-vercel-forwarded-for")?.split(",")[0]?.trim() ??
        req.socket.remoteAddress ??
        "unknown")
    : (req.socket.remoteAddress ?? "local");
}
async function rate(
  store: Store,
  req: ApiRequest,
  action: string,
  limit: number,
  windowMs: number,
  now: number,
): Promise<void> {
  const allowed = await store.consumeRate(
    sha256(`${action}:${clientIp(req)}`),
    limit,
    windowMs,
    now,
  );
  if (!allowed)
    throw new validate.HttpError(
      429,
      "Слишком много запросов. Подождите немного и попробуйте снова.",
    );
}
async function getAccount(
  store: Store,
  session: SessionRecord | null,
): Promise<AccountState> {
  return accountState(
    session?.userId ? await store.getUser(session.userId) : null,
  );
}
function mergeHistory(
  current: MatchRecord[],
  incoming: MatchRecord[],
): MatchRecord[] {
  const byId = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming)
    if (!byId.has(record.id)) byId.set(record.id, record);
  return [...byId.values()]
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, 100);
}
function mergeSavedGame(
  current: SoloGame | null,
  incoming: SoloGame | null | undefined,
  clearedGameIds: string[],
): SoloGame | null {
  if (current && clearedGameIds.includes(current.id)) current = null;
  // A null snapshot from an idle device is not an instruction to delete a newer game.
  // Explicit resets name the discarded game, preventing an old tab from resurrecting it.
  if (!incoming || clearedGameIds.includes(incoming.id)) return current;
  if (!current) return incoming;
  if (current.id !== incoming.id)
    return current.startedAt > incoming.startedAt ? current : incoming;
  const currentShots = current.playerShots.length + current.botShots.length;
  const incomingShots = incoming.playerShots.length + incoming.botShots.length;
  // A delayed request from another device must not roll back a game already played further.
  if (current.phase === "finished" || currentShots > incomingShots)
    return current;
  return incoming;
}

export function createApiHandler(
  endpoint: Endpoint,
  injected?: ApiDependencies,
) {
  return async (req: ApiRequest, res: ServerResponse): Promise<void> => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    try {
      const dependencies = injected ?? runtimeDependencies();
      const store = dependencies.store;
      const now = (dependencies.now ?? Date.now)();
      const secure = dependencies.secureCookies ?? false;
      const method = req.method ?? "GET";
      if (
        (method !== "GET" && method !== "POST") ||
        (endpoint === "health" && method !== "GET")
      ) {
        res.setHeader("Allow", endpoint === "health" ? "GET" : "GET, POST");
        throw new validate.HttpError(405, "Метод не поддерживается.");
      }
      if (endpoint === "health") {
        if (!store) {
          json(503, { ok: false, service: "unavailable" });
          return;
        }
        await store.ping();
        json(200, { ok: true, service: "ready" });
        return;
      }
      if (!store) {
        if (endpoint === "account" && method === "GET") {
          json(200, accountState(null));
          return;
        }
        throw new validate.HttpError(
          503,
          "Онлайн-сервис пока не настроен. Соло доступно без регистрации.",
        );
      }
      if (method === "POST") checkOrigin(req);
      const body = method === "POST" ? await parseBody(req) : {};
      await rate(
        store,
        req,
        `${endpoint}:${method}`,
        method === "GET" ? 360 : 120,
        60_000,
        now,
      );
      let session = await readSession(store, header(req, "cookie"), now);
      const issueSession = async (userId: string | null) => {
        const issued = await replaceSession(
          store,
          session,
          userId,
          now,
          secure,
        );
        session = issued.session;
        res.setHeader("Set-Cookie", issued.cookie);
      };
      if (endpoint === "account") {
        if (method === "GET") {
          // A read never sets a guest cookie: an initial fetch could otherwise arrive after login/create
          // and replace the authenticated or room-bound cookie in the browser.
          json(200, await getAccount(store, session));
          return;
        }
        switch (body.action) {
          case "register": {
            await rate(store, req, "register", 10, 60 * 60_000, now);
            const userName = validate.username(body.username);
            const password = validate.password(body.password);
            const user: UserRecord = {
              id: randomUUID(),
              username: userName,
              displayName: validate.name(body.displayName, userName),
              passwordHash: await hashPassword(password),
              data: emptyAccountData(),
              revision: 0,
            };
            if (!(await store.createUser(user)))
              throw new validate.HttpError(
                409,
                "Этот логин уже занят. Выберите другой.",
              );
            await issueSession(user.id);
            json(200, accountState(user));
            return;
          }
          case "login": {
            await rate(store, req, "login", 20, 15 * 60_000, now);
            let userName: string;
            let password: string;
            try {
              userName = validate.username(body.username);
              password = validate.password(body.password);
            } catch {
              throw new validate.HttpError(401, "Неверный логин или пароль.");
            }
            const user = await store.findUser(userName);
            if (!(await verifyPassword(password, user?.passwordHash)) || !user)
              throw new validate.HttpError(401, "Неверный логин или пароль.");
            await issueSession(user.id);
            json(200, accountState(user));
            return;
          }
          case "logout":
            await issueSession(null);
            json(200, accountState(null));
            return;
          case "sync": {
            if (!session?.userId)
              throw new validate.HttpError(
                401,
                "Войдите, чтобы синхронизировать партии.",
              );
            const incomingHistory =
              body.history === undefined
                ? []
                : validate.history(body.history, now);
            const incomingGame =
              body.savedGame === undefined
                ? undefined
                : validate.savedGame(body.savedGame, now);
            if (body.proDemo !== undefined && typeof body.proDemo !== "boolean")
              validate.fail("Некорректное значение Pro Demo.");
            const clearSavedGameId = body.clearSavedGameId;
            if (
              clearSavedGameId !== undefined &&
              (typeof clearSavedGameId !== "string" ||
                !/^[a-zA-Z0-9_.:-]{1,100}$/.test(clearSavedGameId))
            )
              validate.fail("Некорректный идентификатор сбрасываемой партии.");
            for (let attempt = 0; attempt < 10; attempt++) {
              const user = await store.getUser(session.userId);
              if (!user)
                throw new validate.HttpError(
                  401,
                  "Сессия закончилась. Войдите заново.",
                );
              const clearedGameIds = [
                ...new Set([
                  ...(user.data.clearedGameIds ?? []),
                  ...(typeof clearSavedGameId === "string"
                    ? [clearSavedGameId]
                    : []),
                ]),
              ].slice(-100);
              const data = {
                history: mergeHistory(user.data.history, incomingHistory),
                savedGame: mergeSavedGame(
                  user.data.savedGame,
                  incomingGame,
                  clearedGameIds,
                ),
                clearedGameIds,
                proDemo:
                  typeof body.proDemo === "boolean"
                    ? body.proDemo
                    : user.data.proDemo,
              };
              if (await store.updateUserData(user.id, user.revision, data)) {
                json(200, accountState({ ...user, data }));
                return;
              }
            }
            throw new validate.HttpError(
              409,
              "Данные обновляются на другом устройстве. Повторите синхронизацию.",
            );
          }
          default:
            throw new validate.HttpError(400, "Неизвестное действие аккаунта.");
        }
      }
      if (method === "GET") {
        const code = validate.roomCode(
          req.query?.code ??
            new URL(req.url ?? "/", "http://localhost").searchParams.get(
              "code",
            ),
        );
        if (!session)
          throw new validate.HttpError(
            403,
            "Войдите в комнату по коду приглашения.",
          );
        json(200, await readRoom(store, code, session.identityId, now));
        return;
      }
      if (
        body.action !== "create" &&
        body.action !== "join" &&
        body.action !== "place" &&
        body.action !== "fire"
      )
        throw new validate.HttpError(400, "Неизвестное действие комнаты.");
      if (!session) {
        if (body.action === "place" || body.action === "fire")
          throw new validate.HttpError(
            403,
            "Войдите в комнату по коду приглашения.",
          );
        await issueSession(null);
      }
      const identityId = session!.identityId;
      if (body.action === "create") {
        await rate(store, req, "create-room", 20, 60 * 60_000, now);
        json(200, await createRoom(store, identityId, body.name, now));
        return;
      }
      const code = validate.roomCode(body.code);
      if (body.action === "join")
        json(200, await joinRoom(store, code, identityId, body.name, now));
      else if (body.action === "place")
        json(200, await placeRoom(store, code, identityId, body.fleet, now));
      else json(200, await fireRoom(store, code, identityId, body.cell, now));
    } catch (error) {
      if (error instanceof validate.HttpError) {
        if (error.status === 429) res.setHeader("Retry-After", "60");
        json(error.status, { error: error.message });
      } else {
        // Never send database errors, request payloads, tokens, or connection strings to the browser/log.
        console.error(
          `SALVO ${endpoint} failed (${error instanceof Error ? error.name : "unknown error"}).`,
        );
        json(
          503,
          endpoint === "health"
            ? { ok: false, service: "unavailable" }
            : {
                error:
                  "Онлайн-сервис временно недоступен. Ваши локальные партии сохранены.",
              },
        );
      }
    }
  };
}

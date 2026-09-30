import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireAt, randomFleet } from "../src/game/engine.js";
import type {
  MatchRecord,
  RoomView,
  SoloGame,
} from "../src/shared/contracts.js";
import {
  createApiHandler,
  type ApiDependencies,
  type Endpoint,
} from "../server/handler.js";
import { MemoryStore } from "../server/store.js";

let server: Server;
let base: string;
let store: MemoryStore;
let now: number;

async function start(dependencies: ApiDependencies) {
  const handlers = {
    account: createApiHandler("account", dependencies),
    room: createApiHandler("room", dependencies),
    health: createApiHandler("health", dependencies),
  };
  server = createServer((req, res) => {
    void handlers[
      new URL(req.url!, "http://test").pathname.slice(5) as Endpoint
    ](req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function client() {
  return {
    cookie: "",
    async request(
      endpoint: string,
      body?: unknown,
      extraHeaders?: Record<string, string>,
    ) {
      const response = await fetch(`${base}/api/${endpoint}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(this.cookie ? { Cookie: this.cookie } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const cookie = response.headers.get("set-cookie");
      if (cookie) this.cookie = cookie.split(";")[0];
      return {
        status: response.status,
        body: await response.json(),
        headers: response.headers,
      };
    },
  };
}
const record = (id: string, finishedAt: number): MatchRecord => ({
  id,
  mode: "solo",
  difficulty: "easy",
  outcome: "loss",
  shots: 1,
  hits: 0,
  durationMs: 5_000,
  finishedAt,
  shotHistory: [{ cell: 0, result: "miss" }],
});
const solo = (): SoloGame => ({
  id: "save-1",
  difficulty: "hard",
  phase: "battle",
  playerFleet: randomFleet(),
  botFleet: randomFleet(),
  playerShots: [],
  botShots: [],
  turn: "player",
  winner: null,
  startedAt: now - 5_000,
});
async function battle() {
  const first = client();
  const second = client();
  const intruder = client();
  const firstFleet = randomFleet();
  const secondFleet = randomFleet();
  const created = await first.request("room", {
    action: "create",
    name: "Первый",
  });
  const code = created.body.code as string;
  expect(created.status).toBe(200);
  expect(
    (await second.request("room", { action: "join", code, name: "Второй" }))
      .status,
  ).toBe(200);
  expect(
    (await first.request("room", { action: "place", code, fleet: firstFleet }))
      .status,
  ).toBe(200);
  expect(
    (
      await second.request("room", {
        action: "place",
        code,
        fleet: secondFleet,
      })
    ).status,
  ).toBe(200);
  const view = (await first.request(`room?code=${code}`)).body as RoomView;
  return {
    first,
    second,
    intruder,
    firstFleet,
    secondFleet,
    code,
    shooter: view.yourTurn ? first : second,
    other: view.yourTurn ? second : first,
    target: view.yourTurn ? secondFleet : firstFleet,
  };
}

beforeEach(async () => {
  store = new MemoryStore();
  now = Date.now();
  await start({ store, now: () => now, secureCookies: true });
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("account API", () => {
  it("ignores an idle device null snapshot and remembers explicit game resets", async () => {
    const first = client();
    const second = client();
    await first.request("account", {
      action: "register",
      username: "two_devices",
      password: "test-password-123",
    });
    await second.request("account", {
      action: "login",
      username: "two_devices",
      password: "test-password-123",
    });
    const game = solo();
    await first.request("account", { action: "sync", savedGame: game });
    const stale = await second.request("account", {
      action: "sync",
      savedGame: null,
      proDemo: true,
    });
    expect(stale.status).toBe(200);
    expect(stale.body.savedGame.id).toBe(game.id);
    expect(stale.body.proDemo).toBe(true);
    const cleared = await first.request("account", {
      action: "sync",
      savedGame: null,
      clearSavedGameId: game.id,
    });
    expect(cleared.body.savedGame).toBeNull();
    expect(cleared.body).not.toHaveProperty("clearedGameIds");
    const delayed = await second.request("account", {
      action: "sync",
      savedGame: game,
    });
    expect(delayed.body.savedGame).toBeNull();
    const replacement = { ...solo(), id: "save-2", startedAt: now };
    const saved = await first.request("account", {
      action: "sync",
      savedGame: replacement,
    });
    expect(saved.body.savedGame.id).toBe("save-2");
    const oldClear = await second.request("account", {
      action: "sync",
      savedGame: null,
      clearSavedGameId: game.id,
    });
    expect(oldClear.body.savedGame.id).toBe("save-2");
  });

  it("does not set a cookie on anonymous account reads that may race create or login", async () => {
    const anonymous = client();
    const response = await anonymous.request("account");
    expect(response.status).toBe(200);
    expect(response.body.user).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(anonymous.cookie).toBe("");
    const created = await anonymous.request("room", { action: "create" });
    const roomCookie = anonymous.cookie;
    expect(created.status).toBe(200);
    expect(
      (await anonymous.request("account")).headers.get("set-cookie"),
    ).toBeNull();
    expect(anonymous.cookie).toBe(roomCookie);
  });

  it("hashes passwords, rotates secure cookies, restores another device, and invalidates logout tokens", async () => {
    const first = client();
    const registered = await first.request("account", {
      action: "register",
      username: "Captain_7",
      password: "secure-pass-123",
      displayName: "Капитан",
    });
    expect(registered.status).toBe(200);
    expect(registered.body.user.username).toBe("captain_7");
    expect(registered.headers.get("set-cookie")).toContain(
      "HttpOnly; SameSite=Lax",
    );
    expect(registered.headers.get("set-cookie")).toContain("Secure");
    const stored = await store.findUser("captain_7");
    expect(stored?.passwordHash).toMatch(/^scrypt-v1\$/);
    expect(stored?.passwordHash).not.toContain("secure-pass-123");
    expect(JSON.stringify(registered.body)).not.toContain("password");
    const game = solo();
    expect(
      (
        await first.request("account", {
          action: "sync",
          history: [record("first", now)],
          savedGame: game,
          proDemo: true,
        })
      ).status,
    ).toBe(200);
    const second = client();
    const restored = await second.request("account", {
      action: "login",
      username: "CAPTAIN_7",
      password: "secure-pass-123",
    });
    expect(restored.status).toBe(200);
    expect(restored.body.history.map((entry: MatchRecord) => entry.id)).toEqual(
      ["first"],
    );
    expect(restored.body.savedGame).toEqual(game);
    expect(restored.body.proDemo).toBe(true);
    const oldCookie = first.cookie;
    expect(
      (await first.request("account", { action: "logout" })).body.user,
    ).toBeNull();
    expect(first.cookie).not.toBe(oldCookie);
    const expired = client();
    expired.cookie = oldCookie;
    expect((await expired.request("account")).body.user).toBeNull();
    expect((await second.request("account")).body.user.id).toBe(stored!.id);
  });

  it("rejects invalid credentials with a shared login error and validates registration", async () => {
    const first = client();
    expect(
      (
        await first.request("account", {
          action: "register",
          username: "x",
          password: "123",
          displayName: "x",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await first.request("account", {
          action: "register",
          username: "tester",
          password: "12345678",
          displayName: "Test",
        })
      ).status,
    ).toBe(200);
    const wrong = await first.request("account", {
      action: "login",
      username: "tester",
      password: "wrong-123",
    });
    const missing = await first.request("account", {
      action: "login",
      username: "missing_user",
      password: "wrong-123",
    });
    expect(wrong.status).toBe(401);
    expect(missing.body).toEqual(wrong.body);
    expect(
      (await client().request("account", { action: "sync", history: [] }))
        .status,
    ).toBe(401);
    expect(
      (
        await client().request("account", {
          action: "register",
          username: "TESTER",
          password: "87654321",
          displayName: "Other",
        })
      ).status,
    ).toBe(409);
  });

  it("merges concurrent history across devices without deleting an existing result", async () => {
    const first = client();
    const second = client();
    await first.request("account", {
      action: "register",
      username: "merge_user",
      password: "12345678",
    });
    await second.request("account", {
      action: "login",
      username: "merge_user",
      password: "12345678",
    });
    const results = await Promise.all([
      first.request("account", {
        action: "sync",
        history: [record("device-1", now)],
      }),
      second.request("account", {
        action: "sync",
        history: [record("device-2", now - 1)],
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    const after = await first.request("account", {
      action: "sync",
      history: [],
    });
    expect(after.body.history.map((entry: MatchRecord) => entry.id)).toEqual([
      "device-1",
      "device-2",
    ]);
    expect(
      (
        await first.request("account", {
          action: "sync",
          history: [record("device-1", now + 1)],
        })
      ).body.history,
    ).toHaveLength(2);
  });

  it("validates saved fleets, replay results, statistics, payload size, and POST origin", async () => {
    const first = client();
    await first.request("account", {
      action: "register",
      username: "validation",
      password: "12345678",
    });
    const game = solo();
    game.playerShots = [{ cell: game.botFleet[0].cells[0], result: "miss" }];
    expect(
      (await first.request("account", { action: "sync", savedGame: game }))
        .status,
    ).toBe(400);
    game.playerShots = [];
    game.botFleet[1].cells[0] = game.botFleet[0].cells[0];
    expect(
      (await first.request("account", { action: "sync", savedGame: game }))
        .status,
    ).toBe(400);
    expect(
      (
        await first.request("account", {
          action: "sync",
          history: [{ ...record("x", now), hits: 1 }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await first.request(
          "account",
          { action: "logout" },
          { Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await first.request("account", {
          action: "sync",
          padding: "x".repeat(530_000),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await first.request(
          "account",
          { action: "sync", history: [] },
          { Origin: base },
        )
      ).status,
    ).toBe(200);
  });

  it("keeps newer progress when another device sends a stale save", async () => {
    const first = client();
    const second = client();
    await first.request("account", {
      action: "register",
      username: "progress_user",
      password: "12345678",
    });
    await second.request("account", {
      action: "login",
      username: "progress_user",
      password: "12345678",
    });
    const initial = solo();
    const advanced = {
      ...initial,
      playerShots: fireAt(
        initial.botFleet,
        [],
        initial.botFleet.find((ship) => ship.size === 4)!.cells[0],
      ).shots,
    };
    expect(
      (await first.request("account", { action: "sync", savedGame: advanced }))
        .status,
    ).toBe(200);
    const stale = await second.request("account", {
      action: "sync",
      savedGame: initial,
    });
    expect(stale.status).toBe(200);
    expect(stale.body.savedGame).toEqual(advanced);
    const olderGame = {
      ...initial,
      id: "older-game",
      startedAt: initial.startedAt - 1_000,
    };
    expect(
      (
        await second.request("account", {
          action: "sync",
          savedGame: olderGame,
        })
      ).body.savedGame,
    ).toEqual(advanced);
    const newerGame = { ...initial, id: "newer-game", startedAt: now };
    expect(
      (await first.request("account", { action: "sync", savedGame: newerGame }))
        .body.savedGame,
    ).toEqual(newerGame);
  });

  it("persists rate limits and resets the window", async () => {
    const first = client();
    for (let index = 0; index < 20; index++)
      expect(
        (
          await first.request("account", {
            action: "login",
            username: "nonexistent",
            password: "wrong-123",
          })
        ).status,
      ).toBe(401);
    const limited = await first.request("account", {
      action: "login",
      username: "nonexistent",
      password: "wrong-123",
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    now += 16 * 60_000;
    expect(
      (
        await first.request("account", {
          action: "login",
          username: "nonexistent",
          password: "wrong-123",
        })
      ).status,
    ).toBe(401);
  });
});

describe("room API", () => {
  it("binds two slots to cookies, hides opponent fleets, and rejects observers and invalid placement", async () => {
    const first = client();
    const second = client();
    const third = client();
    const created = await first.request("room", {
      action: "create",
      name: "Host",
    });
    const code = created.body.code;
    expect(created.body.phase).toBe("waiting");
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(
      (await first.request("room", { action: "place", code, fleet: [] }))
        .status,
    ).toBe(400);
    const fleet = randomFleet();
    expect(
      (await first.request("room", { action: "place", code, fleet })).body
        .ready,
    ).toBe(true);
    expect(
      (await second.request("room", { action: "join", code, name: "Friend" }))
        .body.opponentReady,
    ).toBe(true);
    const view = await second.request(`room?code=${code}`);
    expect(view.body.ownFleet).toEqual([]);
    expect(view.body.opponentFleet).toBeUndefined();
    expect(JSON.stringify(view.body)).not.toContain("identityId");
    expect((await third.request(`room?code=${code}`)).status).toBe(403);
    expect(
      (await third.request("room", { action: "join", code, name: "Intruder" }))
        .status,
    ).toBe(409);
    expect(
      (await third.request("room", { action: "place", code, fleet })).status,
    ).toBe(403);
    expect(
      (await first.request("room", { action: "join", code, name: "Host" }))
        .status,
    ).toBe(200);
    const oldCookie = first.cookie;
    await first.request("account", {
      action: "register",
      username: "hostaccount",
      password: "12345678",
    });
    expect(first.cookie).not.toBe(oldCookie);
    expect((await first.request(`room?code=${code}`)).body.ownFleet).toEqual(
      fleet,
    );
    await first.request("account", { action: "logout" });
    expect((await first.request(`room?code=${code}`)).body.ownFleet).toEqual(
      fleet,
    );
  });

  it("resolves concurrent joins with exactly one second player", async () => {
    const owner = client();
    const a = client();
    const b = client();
    const code = (await owner.request("room", { action: "create" })).body.code;
    const joined = await Promise.all([
      a.request("room", { action: "join", code, name: "A" }),
      b.request("room", { action: "join", code, name: "B" }),
    ]);
    expect(joined.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await owner.request(`room?code=${code}`)).body.revision).toBe(1);
  });

  it("applies a duplicate concurrent shot once, preserves hit turn, changes miss turn, and reloads", async () => {
    const { shooter, other, target, code } = await battle();
    const cell = target.find((ship) => ship.size === 4)!.cells[0];
    const before = (await shooter.request(`room?code=${code}`))
      .body as RoomView;
    const responses = await Promise.all([
      shooter.request("room", { action: "fire", code, cell }),
      shooter.request("room", { action: "fire", code, cell }),
    ]);
    expect(responses.map((result) => result.status).sort()).toEqual([200, 409]);
    const after = (await shooter.request(`room?code=${code}`)).body as RoomView;
    expect(after.shots).toEqual([{ cell, result: "hit" }]);
    expect(after.yourTurn).toBe(true);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.opponentFleet).toBeUndefined();
    expect(
      (await other.request("room", { action: "fire", code, cell: 0 })).status,
    ).toBe(409);
    expect(
      (await shooter.request("room", { action: "fire", code, cell: 100 }))
        .status,
    ).toBe(400);
    const occupied = new Set(target.flatMap((ship) => ship.cells));
    const miss = Array.from({ length: 100 }, (_, index) => index).find(
      (candidate) => !occupied.has(candidate),
    )!;
    const missed = await shooter.request("room", {
      action: "fire",
      code,
      cell: miss,
    });
    expect(missed.body.yourTurn).toBe(false);
    const reloaded = client();
    reloaded.cookie = other.cookie;
    const view = (await reloaded.request(`room?code=${code}`)).body as RoomView;
    expect(view.yourTurn).toBe(true);
    expect(view.incoming).toHaveLength(2);
  });

  it("ends exactly at 20 hits, reveals fleets only at the end, and rejects later shots", async () => {
    const { shooter, other, target, code } = await battle();
    const cells = target.flatMap((ship) => ship.cells);
    for (const [index, cell] of cells.entries()) {
      const result = await shooter.request("room", {
        action: "fire",
        code,
        cell,
      });
      expect(result.status).toBe(200);
      if (index < 19) {
        expect(result.body.phase).toBe("battle");
        expect(result.body.opponentFleet).toBeUndefined();
      } else {
        expect(result.body.phase).toBe("finished");
        expect(result.body.winner).toBe("you");
        expect(result.body.finishedAt).toBe(now);
        expect(result.body.opponentFleet).toEqual(target);
      }
    }
    expect((await other.request(`room?code=${code}`)).body.winner).toBe(
      "opponent",
    );
    expect(
      (await shooter.request("room", { action: "fire", code, cell: 99 }))
        .status,
    ).toBe(409);
    expect(
      (
        await shooter.request("room", {
          action: "place",
          code,
          fleet: randomFleet(),
        })
      ).status,
    ).toBe(409);
  });

  it("expires invitations and reports absent storage honestly", async () => {
    const first = client();
    const code = (await first.request("room", { action: "create" })).body.code;
    now += 8 * 86_400_000;
    expect((await first.request(`room?code=${code}`)).status).toBe(404);
    const dependencies: ApiDependencies = { store: null };
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start(dependencies);
    expect((await first.request("health")).status).toBe(503);
    expect((await first.request("account")).body.user).toBeNull();
    expect((await first.request("room", { action: "create" })).status).toBe(
      503,
    );
    expect(
      (
        await first.request("account", {
          action: "register",
          username: "test",
          password: "12345678",
        })
      ).status,
    ).toBe(503);
  });
});

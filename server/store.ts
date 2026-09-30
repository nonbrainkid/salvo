import { neon } from "@neondatabase/serverless";
import type {
  AccountState,
  Fleet,
  Shot,
  User,
} from "../src/shared/contracts.js";

export type AccountData = Omit<AccountState, "user"> & {
  clearedGameIds?: string[];
};
export interface UserRecord extends User {
  passwordHash: string;
  data: AccountData;
  revision: number;
}
export interface SessionRecord {
  tokenHash: string;
  identityId: string;
  userId: string | null;
  expiresAt: number;
}
export interface RoomPlayer {
  identityId: string;
  name: string;
  fleet: Fleet;
  shots: Shot[];
}
export interface RoomState {
  code: string;
  phase: "waiting" | "placement" | "battle" | "finished";
  players: [RoomPlayer, RoomPlayer | null];
  turn: 0 | 1;
  winner: 0 | 1 | null;
  createdAt: number;
  finishedAt?: number;
}
export interface RoomRecord {
  state: RoomState;
  revision: number;
  expiresAt: number;
}
export interface Store {
  ping(): Promise<void>;
  findUser(username: string): Promise<UserRecord | null>;
  getUser(id: string): Promise<UserRecord | null>;
  createUser(user: UserRecord): Promise<boolean>;
  updateUserData(
    id: string,
    revision: number,
    data: AccountData,
  ): Promise<boolean>;
  getSession(tokenHash: string, now: number): Promise<SessionRecord | null>;
  putSession(session: SessionRecord): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  getRoom(code: string, now: number): Promise<RoomRecord | null>;
  createRoom(room: RoomRecord): Promise<boolean>;
  updateRoom(
    code: string,
    revision: number,
    state: RoomState,
    now: number,
  ): Promise<boolean>;
  consumeRate(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
  ): Promise<boolean>;
}

export const emptyAccountData = (): AccountData => ({
  history: [],
  savedGame: null,
  proDemo: false,
});

/** In-memory storage is only for tests or explicitly enabled local development. */
export class MemoryStore implements Store {
  private users = new Map<string, UserRecord>();
  private sessions = new Map<string, SessionRecord>();
  private rooms = new Map<string, RoomRecord>();
  private rates = new Map<string, { count: number; resetAt: number }>();
  async ping() {}
  async findUser(username: string) {
    return structuredClone(
      [...this.users.values()].find((user) => user.username === username) ??
        null,
    );
  }
  async getUser(id: string) {
    return structuredClone(this.users.get(id) ?? null);
  }
  async createUser(user: UserRecord) {
    if (
      [...this.users.values()].some(
        (existing) => existing.username === user.username,
      )
    )
      return false;
    this.users.set(user.id, structuredClone(user));
    return true;
  }
  async updateUserData(id: string, revision: number, data: AccountData) {
    const user = this.users.get(id);
    if (!user || user.revision !== revision) return false;
    this.users.set(id, {
      ...user,
      data: structuredClone(data),
      revision: revision + 1,
    });
    return true;
  }
  async getSession(tokenHash: string, now: number) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.expiresAt <= now) return null;
    return structuredClone(session);
  }
  async putSession(session: SessionRecord) {
    this.sessions.set(session.tokenHash, structuredClone(session));
  }
  async deleteSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }
  async getRoom(code: string, now: number) {
    const room = this.rooms.get(code);
    return room && room.expiresAt > now ? structuredClone(room) : null;
  }
  async createRoom(room: RoomRecord) {
    if (this.rooms.has(room.state.code)) return false;
    this.rooms.set(room.state.code, structuredClone(room));
    return true;
  }
  async updateRoom(
    code: string,
    revision: number,
    state: RoomState,
    now: number,
  ) {
    const room = this.rooms.get(code);
    if (!room || room.revision !== revision || room.expiresAt <= now)
      return false;
    this.rooms.set(code, {
      ...room,
      state: structuredClone(state),
      revision: revision + 1,
    });
    return true;
  }
  async consumeRate(key: string, limit: number, windowMs: number, now: number) {
    const previous = this.rates.get(key);
    const next =
      previous && previous.resetAt > now
        ? { ...previous, count: previous.count + 1 }
        : { count: 1, resetAt: now + windowMs };
    this.rates.set(key, next);
    return next.count <= limit;
  }
}

function userFromRow(
  row: Record<string, unknown> | undefined,
): UserRecord | null {
  if (!row) return null;
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    passwordHash: String(row.password_hash),
    data: row.data as AccountData,
    revision: Number(row.revision),
  };
}

export function createPostgresStore(connectionString: string): Store {
  const sql = neon(connectionString);
  return {
    async ping() {
      await sql`SELECT 1 FROM salvo_rooms LIMIT 1`;
    },
    async findUser(username) {
      return userFromRow(
        (await sql`SELECT * FROM salvo_users WHERE username = ${username}`)[0],
      );
    },
    async getUser(id) {
      return userFromRow(
        (await sql`SELECT * FROM salvo_users WHERE id = ${id}`)[0],
      );
    },
    async createUser(user) {
      const rows =
        await sql`INSERT INTO salvo_users (id, username, display_name, password_hash, data)
        VALUES (${user.id}, ${user.username}, ${user.displayName}, ${user.passwordHash}, ${JSON.stringify(user.data)}::jsonb)
        ON CONFLICT (username) DO NOTHING RETURNING id`;
      return rows.length === 1;
    },
    async updateUserData(id, revision, data) {
      const rows =
        await sql`UPDATE salvo_users SET data = ${JSON.stringify(data)}::jsonb, revision = revision + 1
        WHERE id = ${id} AND revision = ${revision} RETURNING id`;
      return rows.length === 1;
    },
    async getSession(tokenHash, now) {
      const rows =
        await sql`SELECT * FROM salvo_sessions WHERE token_hash = ${tokenHash} AND expires_at > ${now}`;
      const row = rows[0];
      return row
        ? {
            tokenHash: String(row.token_hash),
            identityId: String(row.identity_id),
            userId: row.user_id ? String(row.user_id) : null,
            expiresAt: Number(row.expires_at),
          }
        : null;
    },
    async putSession(session) {
      await sql`INSERT INTO salvo_sessions (token_hash, identity_id, user_id, expires_at)
        VALUES (${session.tokenHash}, ${session.identityId}, ${session.userId}, ${session.expiresAt})`;
    },
    async deleteSession(tokenHash) {
      await sql`DELETE FROM salvo_sessions WHERE token_hash = ${tokenHash}`;
    },
    async getRoom(code, now) {
      const rows =
        await sql`SELECT state, revision, expires_at FROM salvo_rooms WHERE code = ${code} AND expires_at > ${now}`;
      const row = rows[0];
      return row
        ? {
            state: row.state as RoomState,
            revision: Number(row.revision),
            expiresAt: Number(row.expires_at),
          }
        : null;
    },
    async createRoom(room) {
      const rows =
        await sql`INSERT INTO salvo_rooms (code, state, revision, expires_at)
        VALUES (${room.state.code}, ${JSON.stringify(room.state)}::jsonb, ${room.revision}, ${room.expiresAt})
        ON CONFLICT (code) DO NOTHING RETURNING code`;
      return rows.length === 1;
    },
    async updateRoom(code, revision, state, now) {
      const rows =
        await sql`UPDATE salvo_rooms SET state = ${JSON.stringify(state)}::jsonb, revision = revision + 1
        WHERE code = ${code} AND revision = ${revision} AND expires_at > ${now} RETURNING code`;
      return rows.length === 1;
    },
    async consumeRate(key, limit, windowMs, now) {
      const rows =
        await sql`INSERT INTO salvo_rate_limits (key, count, reset_at) VALUES (${key}, 1, ${now + windowMs})
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN salvo_rate_limits.reset_at <= ${now} THEN 1 ELSE salvo_rate_limits.count + 1 END,
          reset_at = CASE WHEN salvo_rate_limits.reset_at <= ${now} THEN ${now + windowMs} ELSE salvo_rate_limits.reset_at END
        RETURNING count`;
      return Number(rows[0].count) <= limit;
    },
  };
}

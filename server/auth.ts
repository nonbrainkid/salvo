import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { AccountState } from "../src/shared/contracts.js";
import type { SessionRecord, Store, UserRecord } from "./store.js";
import { emptyAccountData } from "./store.js";

const scrypt = promisify(scryptCallback);
const SESSION_DAYS = 30;
const COOKIE_NAME = "salvo_session";
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt-v1$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(
  password: string,
  stored: string | undefined,
): Promise<boolean> {
  // Missing users take the same expensive path and receive the same error as an incorrect password.
  const [, salt, key] = (
    stored ?? `scrypt-v1$${"0".repeat(32)}$${"0".repeat(128)}`
  ).split("$");
  if (!/^[a-f0-9]{32}$/.test(salt ?? "") || !/^[a-f0-9]{128}$/.test(key ?? ""))
    return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(derived, Buffer.from(key, "hex")) && Boolean(stored);
}
export function sessionToken(cookie: string | undefined): string | null {
  const value = cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export async function readSession(
  store: Store,
  cookie: string | undefined,
  now: number,
): Promise<SessionRecord | null> {
  const token = sessionToken(cookie);
  return token ? store.getSession(sha256(token), now) : null;
}
export async function replaceSession(
  store: Store,
  previous: SessionRecord | null,
  userId: string | null,
  now: number,
  secure: boolean,
) {
  const token = randomBytes(32).toString("base64url");
  const session: SessionRecord = {
    tokenHash: sha256(token),
    identityId: previous?.identityId ?? randomUUID(),
    userId,
    expiresAt: now + SESSION_DAYS * 86_400_000,
  };
  await store.putSession(session);
  if (previous) await store.deleteSession(previous.tokenHash);
  return {
    session,
    cookie: `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`,
  };
}
export function accountState(user: UserRecord | null): AccountState {
  return user
    ? {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
        },
        history: user.data.history,
        savedGame: user.data.savedGame,
        proDemo: user.data.proDemo,
      }
    : { user: null, ...emptyAccountData() };
}

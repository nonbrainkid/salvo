import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    'DATABASE_URL is required. Add it to .env.local or the deployment environment.',
  );
const sql = neon(url);
await sql`CREATE TABLE IF NOT EXISTS salvo_users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{"history":[],"savedGame":null,"proDemo":false}'::jsonb,
  revision INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;
await sql`CREATE TABLE IF NOT EXISTS salvo_sessions (
  token_hash TEXT PRIMARY KEY, identity_id TEXT NOT NULL,
  user_id TEXT REFERENCES salvo_users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL
)`;
await sql`CREATE INDEX IF NOT EXISTS salvo_sessions_expiry ON salvo_sessions (expires_at)`;
await sql`CREATE TABLE IF NOT EXISTS salvo_rooms (
  code TEXT PRIMARY KEY, state JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 0, expires_at BIGINT NOT NULL
)`;
await sql`CREATE INDEX IF NOT EXISTS salvo_rooms_expiry ON salvo_rooms (expires_at)`;
await sql`CREATE TABLE IF NOT EXISTS salvo_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at BIGINT NOT NULL)`;
await sql`CREATE INDEX IF NOT EXISTS salvo_rate_expiry ON salvo_rate_limits (reset_at)`;
// Running setup again is safe; expired transient records can be removed without losing accounts or history.
await sql`DELETE FROM salvo_sessions WHERE expires_at < ${Date.now()}`;
await sql`DELETE FROM salvo_rooms WHERE expires_at < ${Date.now()}`;
await sql`DELETE FROM salvo_rate_limits WHERE reset_at < ${Date.now()}`;
console.log('SALVO database schema is ready.');

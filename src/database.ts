import type { Pool } from "pg";
import { emptyGarden, type Garden } from "./garden.js";
export type Database = Pick<Pool, "query">;
export async function migrate(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, openid text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS gardens (user_id text PRIMARY KEY REFERENCES users(id), revision integer NOT NULL DEFAULT 0, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS media (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), size integer NOT NULL, digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,digest));
    CREATE INDEX IF NOT EXISTS media_owner_idx ON media(user_id);`);
}
export async function readGarden(
  db: Database,
  user: string,
): Promise<{ state: Garden; revision: number }> {
  const r = await db.query(
    "SELECT state, revision FROM gardens WHERE user_id=$1",
    [user],
  );
  return r.rows[0] || { state: emptyGarden(), revision: 0 };
}
export async function writeGarden(
  db: Database,
  user: string,
  state: Garden,
  revision: number,
) {
  // 单条条件更新保证并发设备只能有一方成功，避免读取后覆盖。
  const r = await db.query(
    "UPDATE gardens SET state=$1,revision=revision+1,updated_at=now() WHERE user_id=$2 AND revision=$3 RETURNING revision",
    [JSON.stringify(state), user, revision],
  );
  return r.rows[0]?.revision as number | undefined;
}

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS api_keys (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      name                 TEXT    NOT NULL,
      note                 TEXT,
      key_hash             TEXT    NOT NULL UNIQUE,   -- sha256 of the client key, used for lookups
      key_prefix           TEXT    NOT NULL,          -- first characters, for display only
      key_enc              TEXT,                      -- AES-256-GCM encrypted client key, so the admin can copy it again
      upstream_key_enc     TEXT,                      -- AES-256-GCM encrypted agentshop key (as_...)
      upstream_fingerprint TEXT    UNIQUE,            -- sha256 of the upstream key, enforces 1 client key : 1 upstream key
      upstream_hint        TEXT,                      -- masked upstream key, for display only
      status               TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      expires_at           TEXT,                      -- ISO 8601 UTC, NULL = never expires
      created_at           TEXT    NOT NULL,
      updated_at           TEXT    NOT NULL,
      last_used_at         TEXT,
      request_count        INTEGER NOT NULL DEFAULT 0
    );
  `)

  // Migration: databases created before key copying existed lack key_enc (those keys stay uncopyable until rotated).
  const columns = db.prepare('PRAGMA table_info(api_keys)').all().map((c) => c.name)
  if (!columns.includes('key_enc')) db.exec('ALTER TABLE api_keys ADD COLUMN key_enc TEXT')

  return db
}

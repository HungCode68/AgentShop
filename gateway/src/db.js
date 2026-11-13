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

  // Plans (revidapi upstream): which pack a key rents, for how long, and since when.
  if (!columns.includes('plan')) {
    db.exec(`
      ALTER TABLE api_keys ADD COLUMN plan TEXT;            -- trial | starter | pro | business | enterprise, NULL = no plan yet
      ALTER TABLE api_keys ADD COLUMN plan_days INTEGER;
      ALTER TABLE api_keys ADD COLUMN plan_started_at TEXT; -- ISO 8601 UTC; a new rental starts usage from zero
    `)
  }
  // The trial is limited in minutes (a paid pack has no time limit: null = no expiry).
  if (!columns.includes('plan_minutes')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN plan_minutes INTEGER')
  }

  db.exec(`
    -- Usage counters per key for the current rental (see quota.js).
    CREATE TABLE IF NOT EXISTS key_usage (
      key_id           INTEGER PRIMARY KEY,
      plan_started_at  TEXT    NOT NULL,
      session_start    INTEGER,
      session_used     REAL    NOT NULL DEFAULT 0,
      week_index       INTEGER NOT NULL DEFAULT 0,
      week_used        REAL    NOT NULL DEFAULT 0,
      balance          REAL    NOT NULL,
      balance_at       INTEGER NOT NULL,
      total_used       REAL    NOT NULL DEFAULT 0,
      updated_at       TEXT    NOT NULL
    );
    -- One-off markers, e.g. that the agentshop → plan migration already ran.
    CREATE TABLE IF NOT EXISTS gateway_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // Credit-based accounting (2026-11-12): a paid pack is a credit budget with no time limit,
  // the trial is a token budget with a time limit. Both counters live on the usage row.
  const usageColumns = db.prepare('PRAGMA table_info(key_usage)').all().map((c) => c.name)
  if (!usageColumns.includes('credits_used')) db.exec('ALTER TABLE key_usage ADD COLUMN credits_used REAL NOT NULL DEFAULT 0')
  if (!usageColumns.includes('tokens_used')) db.exec('ALTER TABLE key_usage ADD COLUMN tokens_used REAL NOT NULL DEFAULT 0')
  // Credits held by requests that are still running, so they cannot overdraw the pack.
  if (!usageColumns.includes('reserved_credits')) db.exec('ALTER TABLE key_usage ADD COLUMN reserved_credits REAL NOT NULL DEFAULT 0')
  // Per-model token breakdown as JSON, so the customer can see where their credits went.
  if (!usageColumns.includes('models_used')) db.exec("ALTER TABLE key_usage ADD COLUMN models_used TEXT NOT NULL DEFAULT '{}'")

  return db
}

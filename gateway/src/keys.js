import { decrypt, encrypt, generateKey, sha256 } from './crypto.js'

export class StoreError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const nowIso = () => new Date().toISOString()
const maskKey = (k) => (k.length <= 12 ? `${k.slice(0, 3)}…` : `${k.slice(0, 6)}…${k.slice(-4)}`)

const PATCHABLE = new Set(['name', 'note', 'upstreamKey', 'expiresAt', 'status'])

function normName(v) {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 100) {
    throw new StoreError(400, 'name is required (string, max 100 characters)')
  }
  return v.trim()
}

function normNote(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string' || v.length > 500) throw new StoreError(400, 'note must be a string (max 500 characters)')
  return v
}

/** undefined = leave unchanged, null = unassign. */
function normUpstream(v) {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  if (typeof v !== 'string' || !/^\S{8,4096}$/.test(v.trim())) {
    throw new StoreError(400, 'upstreamKey must be a string without spaces (8-4096 characters)')
  }
  return v.trim()
}

/** undefined = leave unchanged, null = never expires. */
function normExpiresAt(v) {
  if (v === undefined) return undefined
  if (v === null || v === '' || v === 'never') return null
  const d = new Date(v)
  if (typeof v !== 'string' || Number.isNaN(d.getTime())) {
    throw new StoreError(400, 'expiresAt must be an ISO 8601 date string or null')
  }
  return d.toISOString()
}

function effectiveStatus(row, now = Date.now()) {
  if (row.status === 'revoked') return 'revoked'
  if (row.expires_at && Date.parse(row.expires_at) <= now) return 'expired'
  if (!row.upstream_key_enc) return 'unassigned'
  return 'active'
}

/** Safe representation for admin output: never contains the client key or the upstream key in clear. */
function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    keyPrefix: `${row.key_prefix}…`,
    canCopy: !!row.key_enc,
    upstreamKey: row.upstream_hint,
    status: row.status,
    effectiveStatus: effectiveStatus(row),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    requestCount: row.request_count,
  }
}

export class KeyStore {
  #db
  #encKey
  #prefix

  constructor(db, { encryptionKey, keyPrefix = 'ak_' }) {
    this.#db = db
    this.#encKey = encryptionKey
    this.#prefix = keyPrefix
  }

  list() {
    return this.#db.prepare('SELECT * FROM api_keys ORDER BY id DESC').all().map(toPublic)
  }

  get(id) {
    return toPublic(this.#row(id))
  }

  create({ name, note, upstreamKey, expiresAt } = {}) {
    const n = normName(name)
    const up = normUpstream(upstreamKey) ?? null
    const exp = normExpiresAt(expiresAt) ?? null
    const fp = up ? sha256(up) : null
    if (fp) this.#assertUpstreamFree(fp)

    const key = generateKey(this.#prefix)
    const ts = nowIso()
    const { lastInsertRowid } = this.#db
      .prepare(
        `INSERT INTO api_keys
           (name, note, key_hash, key_prefix, key_enc, upstream_key_enc, upstream_fingerprint, upstream_hint, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        n, normNote(note), sha256(key), this.#displayPrefix(key), encrypt(key, this.#encKey),
        up ? encrypt(up, this.#encKey) : null, fp, up ? maskKey(up) : null, exp, ts, ts,
      )
    return { key, record: this.get(Number(lastInsertRowid)) }
  }

  update(id, patch = {}) {
    this.#row(id)
    const unknown = Object.keys(patch).filter((k) => !PATCHABLE.has(k))
    if (unknown.length) throw new StoreError(400, `Unknown field(s): ${unknown.join(', ')}`)

    const sets = []
    const vals = []
    const set = (col, val) => {
      sets.push(`${col} = ?`)
      vals.push(val)
    }

    if (patch.name !== undefined) set('name', normName(patch.name))
    if (patch.note !== undefined) set('note', normNote(patch.note))
    const up = normUpstream(patch.upstreamKey)
    if (up === null) {
      set('upstream_key_enc', null)
      set('upstream_fingerprint', null)
      set('upstream_hint', null)
    } else if (up !== undefined) {
      const fp = sha256(up)
      this.#assertUpstreamFree(fp, id)
      set('upstream_key_enc', encrypt(up, this.#encKey))
      set('upstream_fingerprint', fp)
      set('upstream_hint', maskKey(up))
    }
    const exp = normExpiresAt(patch.expiresAt)
    if (exp !== undefined) set('expires_at', exp)
    if (patch.status !== undefined) {
      if (patch.status !== 'active' && patch.status !== 'revoked') throw new StoreError(400, "status must be 'active' or 'revoked'")
      set('status', patch.status)
    }

    if (!sets.length) throw new StoreError(400, 'Nothing to update')
    set('updated_at', nowIso())
    this.#db.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
    return this.get(id)
  }

  /** Issues a new client key for the same record; the old key stops working immediately. */
  rotate(id) {
    this.#row(id)
    const key = generateKey(this.#prefix)
    this.#db
      .prepare('UPDATE api_keys SET key_hash = ?, key_prefix = ?, key_enc = ?, updated_at = ? WHERE id = ?')
      .run(sha256(key), this.#displayPrefix(key), encrypt(key, this.#encKey), nowIso(), id)
    return { key, record: this.get(id) }
  }

  remove(id) {
    this.#row(id)
    this.#db.prepare('DELETE FROM api_keys WHERE id = ?').run(id)
  }

  /**
   * Validates a client key and returns the upstream key it maps to.
   * @returns {{ok: true, record: object, upstreamKey: string} | {ok: false, reason: 'invalid'|'revoked'|'expired'|'unassigned'}}
   */
  resolve(clientKey) {
    if (typeof clientKey !== 'string' || !clientKey.startsWith(this.#prefix)) return { ok: false, reason: 'invalid' }
    const row = this.#db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(sha256(clientKey))
    if (!row) return { ok: false, reason: 'invalid' }
    const status = effectiveStatus(row)
    if (status !== 'active') return { ok: false, reason: status }
    return { ok: true, record: toPublic(row), upstreamKey: decrypt(row.upstream_key_enc, this.#encKey) }
  }

  /** The full client key, for the admin to copy again; null for keys created before key copying existed. */
  revealKey(id) {
    const row = this.#row(id)
    return row.key_enc ? decrypt(row.key_enc, this.#encKey) : null
  }

  /** Decrypted upstream key of a record (for the admin usage view), or null when unassigned. */
  upstreamKeyOf(id) {
    const row = this.#row(id)
    return row.upstream_key_enc ? decrypt(row.upstream_key_enc, this.#encKey) : null
  }

  touch(id) {
    this.#db.prepare('UPDATE api_keys SET last_used_at = ?, request_count = request_count + 1 WHERE id = ?').run(nowIso(), id)
  }

  #displayPrefix(key) {
    return key.slice(0, this.#prefix.length + 6)
  }

  #row(id) {
    const row = Number.isInteger(id) ? this.#db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) : undefined
    if (!row) throw new StoreError(404, `Key #${id} not found`)
    return row
  }

  #assertUpstreamFree(fingerprint, exceptId = -1) {
    const other = this.#db.prepare('SELECT id FROM api_keys WHERE upstream_fingerprint = ? AND id != ?').get(fingerprint, exceptId)
    if (other) throw new StoreError(409, `This upstream key is already assigned to key #${other.id}`)
  }
}

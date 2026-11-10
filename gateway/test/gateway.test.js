import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, beforeEach, describe, test } from 'node:test'
import { decrypt, encrypt, parseEncryptionKey, sha256 } from '../src/crypto.js'
import { openDb } from '../src/db.js'
import { KeyStore } from '../src/keys.js'
import { createGateway } from '../src/server.js'
import { buildBashScript } from '../src/setup.js'

const ENC_KEY = parseEncryptionKey('11'.repeat(32))
const ADMIN_TOKEN = 'admin-token-for-tests-0123456789'
const UPSTREAM_GOOD = 'as_good_upstream_key_123'
const UPSTREAM_OTHER = 'as_other_upstream_key_456'
// Same shape as real agentshop keys: as_<JWT> whose payload has the plan length and expiry.
const jwtPart = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const UPSTREAM_JWT = `as_${jwtPart({ alg: 'HS512' })}.${jwtPart({ sub: 'u1', productId: 7, accountTime: '30 days', iat: 1893456000, exp: 1896048000 })}.signature`

/** Fake agentshop247: records what it received so tests can assert on the forwarded request. */
let received = []
const upstream = createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks).toString()
  const url = new URL(req.url, 'http://x')
  received.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body })

  if (url.pathname === '/api/proxy/check-usage') {
    const ok = [UPSTREAM_GOOD, UPSTREAM_JWT].includes(url.searchParams.get('key'))
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(
      JSON.stringify(
        ok
          ? { success: true, message: 'Success', data: { tier: 'PRO', tokensUsed: 100, tokenBudget: 300000, usagePercentage: 0.03 } }
          : { success: false, message: 'API key not found or unassigned.', data: null },
      ),
    )
  }
  if (url.pathname === '/api/proxy/v1/messages' && JSON.parse(body || '{}').stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'upstream=1' })
    for (const ev of ['message_start', 'content_block_delta', 'message_stop']) {
      res.write(`event: ${ev}\ndata: {}\n\n`)
      await new Promise((r) => setTimeout(r, 20))
    }
    return res.end()
  }
  res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' })
  res.end(JSON.stringify({ id: 'msg_1', echo: body }))
})

let gateway
let base
let store
let config

before(async () => {
  upstream.listen(0)
  await once(upstream, 'listening')
  config = {
    port: 0,
    adminToken: ADMIN_TOKEN,
    encryptionKey: ENC_KEY,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/api`,
    dbPath: ':memory:',
    keyPrefix: 'ak_',
    corsOrigins: ['*'],
    maxBodyBytes: 1024 * 1024,
    publicApiHost: 'https://agentshop.id.vn/api/proxy',
  }
  store = new KeyStore(openDb(':memory:'), config)
  gateway = createGateway({ config, store, log: () => {} })
  gateway.listen(0)
  await once(gateway, 'listening')
  base = `http://127.0.0.1:${gateway.address().port}`
})

after(() => {
  gateway.close()
  upstream.close()
})

beforeEach(() => {
  received = []
  for (const k of store.list()) store.remove(k.id)
})

const admin = (path, init = {}) =>
  fetch(`${base}/api/admin${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json', ...init.headers },
  })

describe('crypto', () => {
  test('encrypt/decrypt round-trips and detects tampering', () => {
    const c = encrypt('as_secret', ENC_KEY)
    assert.equal(decrypt(c, ENC_KEY), 'as_secret')
    assert.notEqual(encrypt('as_secret', ENC_KEY), c, 'random IV per encryption')
    const parts = c.split('.')
    parts[3] = Buffer.from('as_secreX').toString('base64url')
    assert.throws(() => decrypt(parts.join('.'), ENC_KEY))
  })
})

describe('check-usage', () => {
  test('maps client key to upstream key and adds key info', async () => {
    const { key } = store.create({ name: 'A', upstreamKey: UPSTREAM_GOOD, expiresAt: '2030-01-01T00:00:00Z' })
    const res = await fetch(`${base}/api/proxy/check-usage?key=${key}`)
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.success, true)
    assert.equal(body.data.tokensUsed, 100)
    assert.equal(body.data.keyName, 'A')
    assert.equal(body.data.keyExpiresAt, '2030-01-01T00:00:00.000Z')
    assert.equal(received[0].search, `?key=${UPSTREAM_GOOD}`)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.equal(body.data.upstreamExpiresAt, null, 'non-JWT upstream key has no decodable expiry')
  })

  test('adds the agentshop key expiry decoded from its JWT', async () => {
    const { key } = store.create({ name: 'J', upstreamKey: UPSTREAM_JWT })
    const body = await (await fetch(`${base}/api/proxy/check-usage?key=${key}`)).json()
    assert.equal(body.success, true)
    assert.equal(body.data.keyExpiresAt, null)
    assert.equal(body.data.upstreamExpiresAt, '2030-01-31T00:00:00.000Z')
    assert.equal(body.data.upstreamIssuedAt, '2030-01-01T00:00:00.000Z')
    assert.equal(body.data.upstreamPlan, '30 days')
  })

  test('rejects unknown, revoked, expired and unassigned keys without calling upstream', async () => {
    const revoked = store.create({ name: 'R', upstreamKey: 'as_revoked_1234' })
    store.update(revoked.record.id, { status: 'revoked' })
    const expired = store.create({ name: 'E', upstreamKey: 'as_expired_1234', expiresAt: '2020-01-01T00:00:00Z' })
    const unassigned = store.create({ name: 'U' })

    const cases = [
      ['ak_doesnotexist', 401, 'API key not found or unassigned.'],
      [UPSTREAM_GOOD, 401, 'API key not found or unassigned.'],
      [revoked.key, 403, 'API key has been revoked.'],
      [expired.key, 403, 'API key has expired.'],
      [unassigned.key, 403, 'API key is not linked to an upstream account yet.'],
    ]
    for (const [key, status, message] of cases) {
      const res = await fetch(`${base}/api/proxy/check-usage?key=${encodeURIComponent(key)}`)
      assert.equal(res.status, status, key)
      assert.deepEqual(await res.json(), { success: false, message, data: null })
    }
    assert.equal(received.length, 0)
  })

  test('reports a dead upstream key as 502', async () => {
    const { key } = store.create({ name: 'Dead', upstreamKey: 'as_dead_upstream_key' })
    const res = await fetch(`${base}/api/proxy/check-usage?key=${key}`)
    assert.equal(res.status, 502)
    assert.match((await res.json()).message, /Upstream account/)
  })
})

describe('AI proxy', () => {
  test('x-api-key is swapped for the upstream key; body, path and query are forwarded', async () => {
    const { key } = store.create({ name: 'A', upstreamKey: UPSTREAM_GOOD })
    const res = await fetch(`${base}/api/proxy/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude', messages: [] }),
    })
    assert.equal(res.status, 201)
    assert.equal(res.headers.get('x-upstream'), 'yes')
    assert.equal((await res.json()).id, 'msg_1')

    const r = received[0]
    assert.equal(r.path, '/api/proxy/v1/messages')
    assert.equal(r.search, '?beta=true')
    assert.equal(r.headers['x-api-key'], UPSTREAM_GOOD)
    assert.equal(r.headers.authorization, undefined)
    assert.equal(r.headers['anthropic-version'], '2023-06-01')
    assert.equal(JSON.parse(r.body).model, 'claude')
    assert.equal(store.list()[0].requestCount, 1)
  })

  test('Authorization: Bearer is swapped too', async () => {
    const { key } = store.create({ name: 'A', upstreamKey: UPSTREAM_GOOD })
    await fetch(`${base}/api/proxy/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '{}' })
    assert.equal(received[0].headers.authorization, `Bearer ${UPSTREAM_GOOD}`)
    assert.equal(received[0].headers['x-api-key'], undefined)
  })

  test('streams SSE responses chunk by chunk and drops upstream cookies', async () => {
    const { key } = store.create({ name: 'A', upstreamKey: UPSTREAM_GOOD })
    const res = await fetch(`${base}/api/proxy/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': key },
      body: JSON.stringify({ stream: true }),
    })
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    assert.equal(res.headers.get('set-cookie'), null)
    let reads = 0
    let text = ''
    const decoder = new TextDecoder()
    for await (const chunk of res.body) {
      reads++
      text += decoder.decode(chunk)
    }
    assert.ok(reads >= 2, `expected multiple chunks, got ${reads}`)
    assert.match(text, /message_start[\s\S]*message_stop/)
  })

  test('rejects requests with missing or invalid keys in Anthropic error format', async () => {
    const missing = await fetch(`${base}/api/proxy/v1/messages`, { method: 'POST', body: '{}' })
    assert.equal(missing.status, 401)
    assert.deepEqual(await missing.json(), { type: 'error', error: { type: 'authentication_error', message: 'API key is missing.' } })

    const invalid = await fetch(`${base}/api/proxy/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'ak_nope' }, body: '{}' })
    assert.equal(invalid.status, 401)
    assert.equal(received.length, 0)
  })
})

describe('admin API', () => {
  test('requires the admin token', async () => {
    assert.equal((await fetch(`${base}/api/admin/keys`)).status, 401)
    assert.equal((await fetch(`${base}/api/admin/keys`, { headers: { authorization: 'Bearer wrong' } })).status, 401)
  })

  test('create → list → update → rotate → delete', async () => {
    const created = await admin('/keys', { method: 'POST', body: JSON.stringify({ name: 'Khách A', upstreamKey: UPSTREAM_GOOD }) })
    assert.equal(created.status, 201)
    const { key, record } = await created.json()
    assert.match(key, /^ak_[A-Za-z0-9_-]{43}$/)
    assert.equal(record.effectiveStatus, 'active')

    const listText = await (await admin('/keys')).text()
    assert.ok(!listText.includes(UPSTREAM_GOOD), 'upstream key must never be returned in clear')
    assert.ok(!listText.includes(key), 'client key must never be returned after creation')

    const patched = await admin(`/keys/${record.id}`, { method: 'PATCH', body: JSON.stringify({ upstreamKey: UPSTREAM_OTHER, name: 'Khách A2' }) })
    assert.equal(patched.status, 200)
    assert.equal((await patched.json()).name, 'Khách A2')
    assert.equal(store.resolve(key).upstreamKey, UPSTREAM_OTHER)

    const rotated = await (await admin(`/keys/${record.id}/rotate`, { method: 'POST' })).json()
    assert.equal(store.resolve(key).ok, false, 'old key stops working')
    assert.equal(store.resolve(rotated.key).upstreamKey, UPSTREAM_OTHER)

    assert.equal((await admin(`/keys/${record.id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await admin(`/keys/${record.id}`)).status, 404)
  })

  test('enforces one client key per upstream key and validates input', async () => {
    store.create({ name: 'A', upstreamKey: UPSTREAM_GOOD })
    const dup = await admin('/keys', { method: 'POST', body: JSON.stringify({ name: 'B', upstreamKey: UPSTREAM_GOOD }) })
    assert.equal(dup.status, 409)

    assert.equal((await admin('/keys', { method: 'POST', body: JSON.stringify({}) })).status, 400)
    assert.equal((await admin('/keys', { method: 'POST', body: 'not json' })).status, 400)
    const badDate = await admin('/keys', { method: 'POST', body: JSON.stringify({ name: 'C', expiresAt: 'tomorrow' }) })
    assert.equal(badDate.status, 400)
  })

  test('shows provider usage per key without exposing keys', async () => {
    const good = store.create({ name: 'Good', upstreamKey: UPSTREAM_GOOD }).record
    const dead = store.create({ name: 'Dead', upstreamKey: 'as_dead_upstream_key' }).record
    const none = store.create({ name: 'None' }).record

    const res = await admin(`/keys/${good.id}/usage`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const text = await res.text()
    assert.equal(JSON.parse(text).usage.tokensUsed, 100)
    assert.ok(!text.includes(UPSTREAM_GOOD))

    assert.equal((await admin(`/keys/${dead.id}/usage`)).status, 502)
    assert.equal((await admin(`/keys/${none.id}/usage`)).status, 409)
    assert.equal((await admin('/keys/999/usage')).status, 404)
    assert.equal((await admin(`/keys/${good.id}/usage`, { method: 'POST' })).status, 405)
  })

  test('lets the admin copy a client key again, also after rotation', async () => {
    const { key, record } = store.create({ name: 'Copy' })
    assert.equal(record.canCopy, true)

    const res = await admin(`/keys/${record.id}/key`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal((await res.json()).key, key)

    const rotated = store.rotate(record.id)
    assert.equal((await (await admin(`/keys/${record.id}/key`)).json()).key, rotated.key)
    assert.equal((await fetch(`${base}/api/admin/keys/${record.id}/key`)).status, 401)
    assert.equal((await admin(`/keys/${record.id}/key`, { method: 'POST' })).status, 405)
  })
})

describe('database migration', () => {
  test('adds key_enc to an old database; old keys keep working but cannot be copied until rotated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-'))
    const path = join(dir, 'old.db')
    try {
      const old = new DatabaseSync(path)
      old.exec(`CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, note TEXT, key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL, upstream_key_enc TEXT, upstream_fingerprint TEXT UNIQUE, upstream_hint TEXT,
        status TEXT NOT NULL DEFAULT 'active', expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_used_at TEXT, request_count INTEGER NOT NULL DEFAULT 0)`)
      const legacyKey = 'ak_legacy_key_0123456789'
      old
        .prepare('INSERT INTO api_keys (name, key_hash, key_prefix, upstream_key_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('Old', sha256(legacyKey), 'ak_legacy', encrypt(UPSTREAM_GOOD, ENC_KEY), 't', 't')
      old.close()

      const db = openDb(path)
      const migrated = new KeyStore(db, { encryptionKey: ENC_KEY })
      assert.equal(migrated.get(1).canCopy, false)
      assert.equal(migrated.revealKey(1), null)
      assert.equal(migrated.resolve(legacyKey).upstreamKey, UPSTREAM_GOOD, 'old key still works')
      const { key } = migrated.rotate(1)
      assert.equal(migrated.revealKey(1), key)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('unreliable connection to agentshop', () => {
  /** What Node's fetch throws when the connection could not be opened (the request never left). */
  const connectError = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })
  const failWith = (code) => () => Promise.reject(connectError(code))
  /** An attempt that never answers until the gateway aborts it. */
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))

  /** Runs a second gateway whose first fetch calls behave as given, then fall through to the fake agentshop. */
  async function withFlakyUpstream(failures, fn, extraConfig = {}) {
    let calls = 0
    const fetchImpl = (url, init) => (failures[calls++] ?? fetch)(url, init)
    const gw = createGateway({ config: { ...config, ...extraConfig }, store, fetchImpl, log: () => {} })
    gw.listen(0)
    await once(gw, 'listening')
    try {
      return await fn(`http://127.0.0.1:${gw.address().port}`, () => calls)
    } finally {
      gw.close()
    }
  }

  test('check-usage retries when the connection cannot be opened', async () => {
    const { key } = store.create({ name: 'C', upstreamKey: UPSTREAM_GOOD })
    await withFlakyUpstream([failWith('UND_ERR_CONNECT_TIMEOUT')], async (gw, calls) => {
      const res = await fetch(`${gw}/api/proxy/check-usage?key=${key}`)
      assert.equal(res.status, 200)
      assert.equal((await res.json()).data.tokensUsed, 100)
      assert.equal(calls(), 2)
    })
  })

  test('check-usage abandons a hung attempt early and retries', async () => {
    const { key } = store.create({ name: 'H', upstreamKey: UPSTREAM_GOOD })
    await withFlakyUpstream(
      [hang],
      async (gw, calls) => {
        const started = Date.now()
        const res = await fetch(`${gw}/api/proxy/check-usage?key=${key}`)
        assert.equal(res.status, 200)
        assert.equal(calls(), 2)
        assert.ok(Date.now() - started < 1500, 'did not wait for the full timeout')
      },
      { checkUsageTimeoutsMs: [100, 2000] },
    )
  })

  test('check-usage still answers 502 once every attempt failed', async () => {
    const { key } = store.create({ name: 'F', upstreamKey: UPSTREAM_GOOD })
    const fail = failWith('EAI_AGAIN')
    await withFlakyUpstream([fail, fail, fail, fail], async (gw, calls) => {
      const res = await fetch(`${gw}/api/proxy/check-usage?key=${key}`)
      assert.equal(res.status, 502)
      assert.equal((await res.json()).message, 'Upstream service is unreachable.')
      assert.equal(calls(), 2)
    })
  })

  test('AI requests are resent when the connection could not be opened', async () => {
    const { key } = store.create({ name: 'P', upstreamKey: UPSTREAM_GOOD })
    await withFlakyUpstream([failWith('UND_ERR_CONNECT_TIMEOUT')], async (gw, calls) => {
      const res = await fetch(`${gw}/api/proxy/v1/messages`, { method: 'POST', headers: { 'x-api-key': key }, body: '{"model":"m"}' })
      assert.equal(res.status, 201)
      assert.equal(calls(), 2)
      assert.equal(received.length, 1)
      assert.equal(received[0].body, '{"model":"m"}')
    })
  })

  test('AI requests are not resent when they may already have reached agentshop', async () => {
    const { key } = store.create({ name: 'N', upstreamKey: UPSTREAM_GOOD })
    await withFlakyUpstream([failWith('ECONNRESET')], async (gw, calls) => {
      const res = await fetch(`${gw}/api/proxy/v1/messages`, { method: 'POST', headers: { 'x-api-key': key }, body: '{}' })
      assert.equal(res.status, 502)
      assert.equal(calls(), 1)
    })
  })
})

describe('setup endpoint', () => {
  test('returns a bash script (os=mac) that carries the key, host and pinned models', async () => {
    const { key } = store.create({ name: 'S', upstreamKey: UPSTREAM_GOOD })
    const res = await fetch(`${base}/api/setup?key=${key}&os=mac`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.match(res.headers.get('content-disposition') ?? '', /attachment.*agentshop-setup\.sh/)
    const text = await res.text()
    assert.match(text, /API_HOST=/)
    assert.ok(text.includes(`API_KEY='${key}'`), 'script embeds the caller\'s key')
    assert.ok(text.includes("API_HOST='https://agentshop.id.vn/api/proxy'"))
    assert.match(text, /ANTHROPIC_MODEL='claude-sonnet-5-5'/)
    assert.match(text, /ANTHROPIC_SMALL_FAST_MODEL='claude-haiku-4-5'/)
    assert.match(text, /claudeCode\.environmentVariables/)
    assert.match(text, /disableLoginPrompt/)
    // The generated script never points at a raw key in a URL — it writes config to files.
    assert.doesNotMatch(text, /check-usage\?key=/)
    assert.equal(received.length, 0, 'setup does not call upstream')
  })

  test('returns a PowerShell script (os=windows) that carries the key and models', async () => {
    const { key } = store.create({ name: 'W', upstreamKey: UPSTREAM_GOOD })
    const res = await fetch(`${base}/api/setup?key=${key}&os=windows`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-disposition') ?? '', /agentshop-setup\.ps1/)
    const text = await res.text()
    assert.ok(text.includes(`$ApiKey = '${key}'`), 'script embeds the caller\'s key')
    assert.match(text, /\$Model = 'claude-sonnet-5-5'/)
    assert.match(text, /\$SmallModel = 'claude-haiku-4-5'/)
    assert.match(text, /claudeCode\.environmentVariables/)
    assert.match(text, /disableLoginPrompt/)
    assert.match(text, /npm\.cmd install -g @anthropic-ai\/claude-code/)
    assert.ok(text.includes("Join-Path $HOME '.claude/settings.json'"), 'settings path survives template escaping')
    assert.ok(text.includes("-match '^[0-9]+$'"))
    assert.doesNotMatch(text, /[^\x00-\x7F]/, 'ASCII only: PowerShell 5.1 pipes text to node as ASCII')
  })

  describe('generated settings merge (run for real in a temp dir)', () => {
    let dir
    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'setup-merge-'))
    })
    after(() => rmSync(dir, { recursive: true, force: true }))

    /** Runs the exact Node block the scripts embed, the way they run it: `node - <args>` with the code on stdin. */
    async function runMerge(claudeFile, vscodeFile) {
      const script = buildBashScript({ apiHost: 'https://gw.example/api/proxy', key: 'ak_NEW' })
      const code = script.slice(script.indexOf("<<'NODE'\n") + 9, script.indexOf('\nNODE\n'))
      const child = spawn(process.execPath, ['-', claudeFile, vscodeFile, 'https://gw.example/api/proxy', 'ak_NEW', 'm-big', 'm-small'])
      child.stdin.end(code)
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      const [exitCode] = await once(child, 'close')
      assert.equal(exitCode, 0, out)
      return out
    }
    const read = (p) => JSON.parse(readFileSync(p, 'utf8'))

    test('keeps existing settings, replaces stale values, drops ANTHROPIC_API_KEY, is idempotent', async () => {
      const c = join(dir, 'a-claude.json')
      const v = join(dir, 'a-vscode.json')
      writeFileSync(c, JSON.stringify({ model: 'opus', env: { KEEP: '1', ANTHROPIC_API_KEY: 'ak_OLD', ANTHROPIC_MODEL: 'old' } }))
      writeFileSync(v, JSON.stringify({ 'editor.fontSize': 15, 'claudeCode.environmentVariables': [{ name: 'FOO', value: 'bar' }, { name: 'ANTHROPIC_API_KEY', value: 'ak_OLD' }] }))
      await runMerge(c, v)
      await runMerge(c, v)

      assert.deepEqual(read(c), {
        model: 'opus',
        env: { KEEP: '1', ANTHROPIC_MODEL: 'm-big', ANTHROPIC_BASE_URL: 'https://gw.example/api/proxy', ANTHROPIC_AUTH_TOKEN: 'ak_NEW', ANTHROPIC_SMALL_FAST_MODEL: 'm-small' },
      })
      const vs = read(v)
      assert.equal(vs['editor.fontSize'], 15)
      assert.equal(vs['claudeCode.disableLoginPrompt'], true)
      assert.deepEqual(vs['claudeCode.environmentVariables'].map((e) => e.name), [
        'FOO', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
      ])
      // The untouched original is kept once, not overwritten by the second run.
      assert.equal(JSON.parse(readFileSync(`${c}.agentshop-backup`, 'utf8')).env.ANTHROPIC_API_KEY, 'ak_OLD')
    })

    test('reads VS Code JSONC (comments, trailing commas) and creates missing files', async () => {
      const c = join(dir, 'b-missing', 'claude.json')
      const v = join(dir, 'b-vscode.json')
      writeFileSync(v, '// my settings\n{\n  "workbench.colorTheme": "Dark+", /* theme */\n  "url": "http://x//y",\n  "list": [1, 2,],\n}\n')
      await runMerge(c, v)
      const vs = read(v)
      assert.equal(vs['workbench.colorTheme'], 'Dark+')
      assert.equal(vs.url, 'http://x//y', '// inside a string is not a comment')
      assert.deepEqual(vs.list, [1, 2])
      assert.equal(read(c).env.ANTHROPIC_AUTH_TOKEN, 'ak_NEW')
    })

    test('leaves a file it cannot parse untouched instead of overwriting it', async () => {
      const c = join(dir, 'c-claude.json')
      const v = join(dir, 'c-vscode.json')
      const broken = '{ "editor.fontSize": 15, oops }'
      writeFileSync(v, broken)
      const out = await runMerge(c, v)
      assert.equal(readFileSync(v, 'utf8'), broken)
      assert.match(out, /left unchanged/)
      assert.equal(read(c).env.ANTHROPIC_AUTH_TOKEN, 'ak_NEW', 'the other file is still written')
    })
  })

  test('rejects missing or invalid os', async () => {
    const { key } = store.create({ name: 'O', upstreamKey: UPSTREAM_GOOD })
    assert.equal((await fetch(`${base}/api/setup?key=${key}`)).status, 400)
    assert.equal((await fetch(`${base}/api/setup?key=${key}&os=android`)).status, 400)
  })

  test('rejects unknown, revoked, expired and unassigned keys', async () => {
    const revoked = store.create({ name: 'R', upstreamKey: 'as_revoked_1234' })
    store.update(revoked.record.id, { status: 'revoked' })
    const expired = store.create({ name: 'E', upstreamKey: 'as_expired_1234', expiresAt: '2020-01-01T00:00:00Z' })
    const unassigned = store.create({ name: 'U' })

    const cases = [
      ['ak_doesnotexist', 401, 'API key not found or unassigned.'],
      [revoked.key, 403, 'API key has been revoked.'],
      [expired.key, 403, 'API key has expired.'],
      [unassigned.key, 403, 'API key is not linked to an upstream account yet.'],
    ]
    for (const [key, status, message] of cases) {
      const res = await fetch(`${base}/api/setup?key=${key}&os=mac`)
      assert.equal(res.status, status, key)
      assert.deepEqual(await res.json(), { success: false, message, data: null })
    }
    assert.equal(received.length, 0, 'rejected keys never reach upstream')
  })

  test('missing key → 400, wrong method → 405', async () => {
    assert.equal((await fetch(`${base}/api/setup?os=mac`)).status, 400)
    const { key } = store.create({ name: 'A', upstreamKey: UPSTREAM_GOOD })
    assert.equal((await fetch(`${base}/api/setup?key=${key}&os=mac`, { method: 'POST' })).status, 405)
  })
})

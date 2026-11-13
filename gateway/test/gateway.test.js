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
import { convertedTokens, creditsForUsage, DAY_MS, HOUR_MS, MODEL_RATES, MINUTE_MS, PLANS, planCap } from '../src/plans.js'
import { QuotaStore } from '../src/quota.js'
import { createGateway } from '../src/server.js'
import { buildBashScript } from '../src/setup.js'
import { estimateInputTokens } from '../src/tokens.js'

const ENC_KEY = parseEncryptionKey('11'.repeat(32))
const ADMIN_TOKEN = 'admin-token-for-tests-0123456789'
const REVID_KEY = 'sk_test_revid_account_key'
const MODEL = 'claude-sonnet-5-5'
// Same shape as real agentshop keys: as_<JWT> whose payload has the plan length and expiry (for the migration).
const jwtPart = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const agentshopKey = (expSec) => `as_${jwtPart({ alg: 'HS512' })}.${jwtPart({ sub: 'u1', accountTime: '30 days', iat: expSec - 30 * 86400, exp: expSec })}.signature`
const METERED_USAGE = { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000, output_tokens: 500 }
const METERED = 1940 // converted tokens of METERED_USAGE on Sonnet

/** Fake revidapi: records what it received; the test-only `scenario` field in the body steers it. */
let received = []
let usageFail = 0 // how many upcoming /v1/usage requests answer 502 (balance fallback test)
let stallFirst = 0 // how many upcoming /v1/messages requests should stall (hedging tests)
const upstream = createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks).toString()
  const url = new URL(req.url, 'http://x')
  received.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body })

  if (url.pathname === '/v1/usage') {
    if (usageFail > 0) {
      usageFail--
      res.writeHead(502, { 'content-type': 'text/html' })
      return res.end('<html>bad gateway</html>')
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ object: 'usage', requests: 7, credits_used: 5.5, credits_remaining: 123.4, last_request_at: '2026-11-12T02:00:00Z' }))
  }
  if (url.pathname === '/v1/messages/count_tokens') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ input_tokens: 42 }))
  }
  const parsed = (() => {
    try {
      return JSON.parse(body || '{}')
    } catch {
      return {}
    }
  })()
  const scenario = parsed.scenario
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

  if (stallFirst > 0) {
    stallFirst--
    await wait(600)
    if (res.destroyed || req.destroyed) return
  }
  if (scenario === 'slow') await wait(300)
  if (scenario === 'upstream-400') {
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad thing' } }))
  }
  if (scenario === 'json-truncated') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ type: 'message', stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 16384 } }))
  }
  if (parsed.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'upstream=1' })
    // output_tokens is a power of two when an upstream limit cut the answer.
    const outTokens = scenario === 'truncated' || scenario === 'split' ? 2048 : scenario === 'metered' ? METERED_USAGE.output_tokens : 12
    const startUsage =
      scenario === 'metered'
        ? { ...METERED_USAGE, output_tokens: 1 }
        : { input_tokens: scenario === 'real-usage' ? 777 : 0, output_tokens: 0 }
    const events = [
      sse('message_start', { message: { usage: startUsage } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outTokens } }),
      sse('message_stop', {}),
    ]
    if (scenario === 'split') {
      for (const ch of events.join('')) {
        res.write(ch)
        await wait(0)
      }
      return res.end()
    }
    for (const [i, ev] of events.entries()) {
      if (scenario === 'break' && i === 2) return res.destroy()
      if (scenario === 'nostop' && i === 3) return res.end()
      if (scenario === 'silent' && i === 2) await wait(300)
      res.write(ev)
      await wait(20)
    }
    return res.end()
  }
  res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' })
  res.end(JSON.stringify({ id: 'msg_1', type: 'message', stop_reason: 'end_turn', echo: body, usage: scenario === 'metered' ? METERED_USAGE : { input_tokens: 10, output_tokens: 5 } }))
})

let gateway
let base
let db
let store
let quota
let config

before(async () => {
  upstream.listen(0)
  await once(upstream, 'listening')
  config = {
    port: 0,
    adminToken: ADMIN_TOKEN,
    encryptionKey: ENC_KEY,
    revidBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    revidApiKey: REVID_KEY,
    hedgeAfterMs: 0,
    maxConcurrentPerKey: 0,
    revidLowCredits: 300,
    dbPath: ':memory:',
    keyPrefix: 'ak_',
    corsOrigins: ['*'],
    maxBodyBytes: 1024 * 1024,
    publicApiHost: 'https://agentshop.id.vn/api/proxy',
  }
  db = openDb(':memory:')
  store = new KeyStore(db, config)
  quota = new QuotaStore(db)
  gateway = createGateway({ config, store, quota, log: () => {} })
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
  stallFirst = 0
  for (const k of store.list()) store.remove(k.id)
})

const admin = (path, init = {}) =>
  fetch(`${base}/api/admin${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json', ...init.headers },
  })
const planKey = (name = 'K', plan = 'pro') => store.create({ name, plan })
/** POST /v1/messages through a gateway; returns the response. */
const ask = (gwBase, key, payload = {}, extraHeaders = {}) =>
  fetch(`${gwBase}/api/proxy/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content: 'hi' }], ...payload }),
  })

/** A second gateway with its own config / clock / fetch and a captured log. */
async function withGateway({ extraConfig = {}, now, fetchImpl } = {}, fn) {
  const lines = []
  const ks = now ? new KeyStore(db, { ...config, now }) : store
  const qs = now ? new QuotaStore(db, { now }) : quota
  const gw = createGateway({ config: { ...config, ...extraConfig }, store: ks, quota: qs, fetchImpl, log: (l) => lines.push(l) })
  gw.listen(0)
  await once(gw, 'listening')
  try {
    return await fn(`http://127.0.0.1:${gw.address().port}`, lines, { store: ks, quota: qs })
  } finally {
    gw.close()
  }
}

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

describe('plans and cost accounting', () => {
  test('converted tokens weigh input, cache and output', () => {
    // 1000*0.36 + 2000*0.36 + 10000*0.036 + 500 = 1940
    assert.equal(convertedTokens(METERED_USAGE), METERED)
    assert.equal(convertedTokens({}), 0)
  })

  test('credits are computed from revidapi\'s published per-model rates', () => {
    // Sonnet: 1000 in + 2000 write + 10000 read + 500 out
    const credits =
      (1000 * MODEL_RATES[MODEL].in +
        2000 * MODEL_RATES[MODEL].write +
        10_000 * MODEL_RATES[MODEL].read +
        500 * MODEL_RATES[MODEL].out) /
      1e6
    assert.equal(creditsForUsage(METERED_USAGE, MODEL), credits)
    assert.ok(creditsForUsage(METERED_USAGE, 'claude-opus-5-5') > credits, 'Opus costs more than Sonnet')
    assert.ok(creditsForUsage(METERED_USAGE, 'claude-haiku-5-5') < credits, 'Haiku costs less than Sonnet')
    assert.equal(creditsForUsage({}, MODEL), 0)
    assert.equal(creditsForUsage({ output_tokens: 100 }, 'unknown-model'), 0, 'unpriced models cost nothing (they are refused earlier)')
  })

  test('a plan is capped in credits; the trial in tokens', () => {
    assert.equal(planCap(PLANS.pro), PLANS.pro.credits)
    assert.equal(planCap(PLANS.starter), 1_500)
    assert.equal(planCap(PLANS.business), 13_000)
    assert.equal(planCap(PLANS.enterprise), 30_000)
    assert.equal(planCap(PLANS.trial), 100_000)
    assert.equal(PLANS.trial.credits, 0, 'the trial is free')
  })
})

describe('quota limits', () => {
  /** A key store + quota store on a fake clock. */
  function setup(plan = 'pro', minutes = null) {
    const clock = { t: Date.parse('2026-11-12T00:00:00Z') }
    const now = () => clock.t
    const d = openDb(':memory:')
    const ks = new KeyStore(d, { encryptionKey: ENC_KEY, now })
    const qs = new QuotaStore(d, { now })
    const { record } = ks.create({ name: 'Q', plan, planMinutes: minutes })
    return { clock, ks, qs, record: () => ks.get(record.id) }
  }

  test('a paid pack starts with its full credit budget and never expires', () => {
    const { qs, record } = setup()
    assert.deepEqual(qs.check(record()), { ok: true })
    const snap = qs.snapshot(record())
    assert.equal(snap.cap, PLANS.pro.credits)
    assert.equal(snap.used, 0)
    assert.equal(snap.remaining, PLANS.pro.credits)
    assert.equal(snap.expiresAt, null, 'a paid pack has no time limit')
    assert.equal(snap.unlimited, true)
  })

  test('a pack blocks once its credits are used up, and never refills', () => {
    const { clock, qs, record } = setup()
    qs.charge(record(), { credits: PLANS.pro.credits, tokens: 1000, model: MODEL })
    const blocked = qs.check(record())
    assert.equal(blocked.ok, false)
    assert.equal(blocked.limit, 'credits')
    assert.equal(blocked.retryAt, null)
    clock.t += 30 * DAY_MS
    assert.equal(qs.check(record()).ok, false, 'a pack never refills')
  })

  test('a request in flight holds its credits back, so a pack cannot be overdrawn', () => {
    const { qs, record } = setup()
    const held = qs.reserve(record(), 400)
    assert.equal(held.ok, true)
    assert.equal(qs.snapshot(record()).reserved, 400)
    assert.equal(qs.snapshot(record()).creditsRemaining, PLANS.pro.credits - 400)
    // A second request that would push past the pack is refused.
    const tooMuch = qs.reserve(record(), PLANS.pro.credits)
    assert.equal(tooMuch.ok, false)
    // Releasing the reservation gives the credits back.
    qs.release(record(), 400)
    assert.equal(qs.snapshot(record()).reserved, 0)
    assert.equal(qs.check(record()).ok, true)
  })

  test('charging replaces the reservation with the real cost', () => {
    const { qs, record } = setup()
    qs.reserve(record(), 400)
    qs.charge(record(), { credits: 12.5, tokens: 100, model: MODEL, reserved: 400 })
    const snap = qs.snapshot(record())
    assert.equal(snap.reserved, 0, 'the reservation is released')
    assert.equal(snap.used, 12.5, 'only the real cost is charged')
    assert.equal(snap.models[MODEL].credits, 12.5)
    assert.equal(snap.models[MODEL].tokens, 100)
  })

  test('a new pack (plan changed) starts from zero', () => {
    const { clock, ks, qs, record } = setup()
    qs.charge(record(), { credits: PLANS.pro.credits, tokens: 0, model: MODEL })
    assert.equal(qs.check(record()).ok, false)
    clock.t += 1000
    ks.update(record().id, { plan: 'business' })
    assert.equal(qs.check(record()).ok, true)
    const snap = qs.snapshot(record())
    assert.equal(snap.plan.id, 'business')
    assert.equal(snap.used, 0)
    assert.equal(snap.cap, PLANS.business.credits)
  })
})

describe('trial plan', () => {
  test('lasts the minutes the admin sets and allows 100k converted tokens in total, no refill', () => {
    const clock = { t: Date.parse('2026-11-12T00:00:00Z') }
    const now = () => clock.t
    const d = openDb(':memory:')
    const ks = new KeyStore(d, { encryptionKey: ENC_KEY, now })
    const qs = new QuotaStore(d, { now })
    const { record } = ks.create({ name: 'Thử', plan: 'trial', planMinutes: 360 })
    assert.equal(record.planName, 'Dùng thử')
    assert.equal(record.planMinutes, 360)
    assert.equal(Date.parse(record.expiresAt) - clock.t, 360 * MINUTE_MS)
    assert.equal(qs.snapshot(ks.get(record.id)).cap, 100_000)
    qs.charge(ks.get(record.id), { credits: 0, tokens: 100_000, model: null })
    clock.t += 5 * HOUR_MS + 1 // a new period would not refill: the cap is total, not per session
    assert.deepEqual(qs.check(ks.get(record.id)), { ok: false, limit: 'tokens', retryAt: null })
    clock.t += HOUR_MS
    assert.equal(ks.resolve(ks.revealKey(record.id)).ok, false, 'expired after 6 hours')
  })

  test('the quota page shows the trial as one 100k token allowance until it expires', async () => {
    const { key, record } = store.create({ name: 'Thử', plan: 'trial', planMinutes: 360 })
    quota.charge(store.get(record.id), { credits: 0, tokens: 1234, model: null })
    const d = (await (await fetch(`${base}/api/proxy/check-usage?key=${key}`)).json()).data
    assert.equal(d.tier, 'Dùng thử')
    assert.equal(d.unit, 'token')
    assert.equal(d.used, 1234)
    assert.equal(d.cap, 100_000)
    assert.equal(d.remaining, 100_000 - 1234)
    assert.equal(d.plan, 'trial')
    assert.equal(d.planMinutes, 360)
    assert.equal(d.unlimited, false)
    assert.equal(d.keyExpiresAt, d.expiresAt, 'the trial key expires with its time limit')
    assert.ok(Date.parse(d.expiresAt) > Date.now())
  })

  test('a trial with no minutes set falls back to the 60-minute default', () => {
    const d = openDb(':memory:')
    const ks = new KeyStore(d, { encryptionKey: ENC_KEY, now: () => Date.parse('2026-11-12T00:00:00Z') })
    const { record } = ks.create({ name: 'T', plan: 'trial' })
    assert.equal(record.planMinutes, 60, 'default trial length')
  })

  test('the customer is told the trial is used up', async () => {
    const { key, record } = store.create({ name: 'Thử', plan: 'trial', planMinutes: 60 })
    quota.charge(store.get(record.id), { credits: 0, tokens: 100_000, model: null })
    const res = await ask(base, key)
    assert.equal(res.status, 429)
    assert.match((await res.json()).error.message, /Đã dùng hết 100k token của gói dùng thử/)
    assert.equal(received.length, 0)
  })
})

describe('check-usage', () => {
  test('returns the pack usage in the shape the quota page reads', async () => {
    const { key, record } = planKey('A', 'business')
    quota.charge(store.get(record.id), { credits: 120, tokens: 900, model: MODEL })
    const res = await fetch(`${base}/api/proxy/check-usage?key=${key}`)
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.equal(body.success, true)
    const d = body.data
    assert.equal(d.tier, 'Business')
    assert.equal(d.unit, 'credit')
    assert.equal(d.used, 120)
    assert.equal(d.cap, PLANS.business.credits)
    assert.equal(d.remaining, PLANS.business.credits - 120)
    assert.equal(d.usagePercentage, (120 / PLANS.business.credits) * 100)
    assert.equal(d.expiresAt, null, 'a paid pack never expires')
    assert.equal(d.unlimited, true)
    assert.equal(d.plan, 'business')
    assert.equal(d.planMinutes, null)
    assert.equal(d.keyName, 'A')
    assert.deepEqual(d.models, { [MODEL]: { tokens: 900, credits: 120 } })
    assert.equal(d.reserved, 0)
    assert.equal(received.length, 0, 'no upstream call')
  })

  test('rejects unknown, revoked, expired and plan-less keys', async () => {
    const revoked = planKey('R')
    store.update(revoked.record.id, { status: 'revoked' })
    const expired = store.create({ name: 'E', plan: 'pro', expiresAt: '2020-01-01T00:00:00Z' })
    const noPlan = store.create({ name: 'U' })
    const cases = [
      ['ak_doesnotexist', 401, 'API key not found or unassigned.'],
      [revoked.key, 403, 'API key has been revoked.'],
      [expired.key, 403, 'API key has expired.'],
      [noPlan.key, 403, 'API key has no plan yet. Please contact the administrator.'],
    ]
    for (const [key, status, message] of cases) {
      const res = await fetch(`${base}/api/proxy/check-usage?key=${encodeURIComponent(key)}`)
      assert.equal(res.status, status, key)
      assert.deepEqual(await res.json(), { success: false, message, data: null })
    }
  })
})

describe('AI proxy (revidapi)', () => {
  test('forwards to revidapi /v1/messages with the account key; the client key never leaves', async () => {
    const { key } = planKey()
    const res = await ask(base, key, {}, { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'claude-code-20250219' })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-upstream'), 'yes')
    assert.equal((await res.json()).id, 'msg_1')
    const r = received[0]
    assert.equal(r.path, '/v1/messages')
    assert.equal(r.headers['x-api-key'], REVID_KEY)
    assert.equal(r.headers.authorization, undefined)
    assert.equal(r.headers['anthropic-version'], '2023-06-01')
    assert.equal(r.headers['anthropic-beta'], 'claude-code-20250219')
    assert.ok(!JSON.stringify(r).includes(key), 'client key not forwarded')
    assert.equal(store.list()[0].requestCount, 1)
  })

  test('Chatbox paths without /v1 ({host}/messages, /models) reach the same endpoints', async () => {
    const { key, record } = planKey()
    const res = await fetch(`${base}/api/proxy/messages`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, stream: true, scenario: 'metered', messages: [] }),
    })
    assert.equal(res.status, 200)
    await res.text()
    assert.equal(received[0].path, '/v1/messages')
    assert.equal(quota.snapshot(store.get(record.id)).creditsUsed, creditsForUsage(METERED_USAGE, MODEL), 'metered like any other request')

    const models = await fetch(`${base}/api/proxy/models`, { headers: { 'x-api-key': key } })
    assert.equal(models.status, 200)
    assert.ok((await models.json()).data.some((m) => m.id === 'claude-opus-5-5'))

    const ct = await fetch(`${base}/api/proxy/messages/count_tokens`, { method: 'POST', headers: { 'x-api-key': key }, body: JSON.stringify({ model: MODEL, messages: [] }) })
    assert.equal(ct.status, 200)
    assert.equal(received.at(-1).path, '/v1/messages/count_tokens')
  })

  test('Authorization: Bearer works the same way', async () => {
    const { key } = planKey()
    const res = await fetch(`${base}/api/proxy/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages: [] }),
    })
    assert.equal(res.status, 200)
    assert.equal(received[0].headers['x-api-key'], REVID_KEY)
    assert.equal(received[0].headers.authorization, undefined)
  })

  test('charges a streamed answer its real credit cost', async () => {
    const { key, record } = planKey()
    const res = await ask(base, key, { stream: true, scenario: 'metered' })
    await res.text()
    assert.equal(quota.snapshot(store.get(record.id)).creditsUsed, creditsForUsage(METERED_USAGE, MODEL))
  })

  test('charges a non-streamed answer too, weighted by model', async () => {
    const { key, record } = planKey()
    await (await ask(base, key, { scenario: 'metered', model: 'claude-opus-5-5' })).text()
    assert.equal(quota.snapshot(store.get(record.id)).creditsUsed, creditsForUsage(METERED_USAGE, 'claude-opus-5-5'))
  })

  test('a stream broken before its final usage is still charged (output estimated from content)', async () => {
    const { key, record } = planKey()
    await (await ask(base, key, { stream: true, scenario: 'break' })).text()
    assert.ok(quota.snapshot(store.get(record.id)).creditsUsed > 0)
  })

  test('refuses models outside the priced Claude list, without calling revidapi', async () => {
    const { key } = planKey()
    for (const model of ['gpt-6-sol', 'claude-fable-5-1', 'claude-fable-5-1-20260101', undefined]) {
      const res = await ask(base, key, { model })
      assert.equal(res.status, 400, String(model))
      const err = (await res.json()).error
      assert.equal(err.type, 'invalid_request_error')
      assert.match(err.message, /Available models: claude-sonnet-5-5/)
    }
    assert.equal(received.length, 0)
  })

  test('a dated or older model id is accepted and sent normalised onto the priced id', async () => {
    const { key } = planKey()
    const res = await ask(base, key, { model: 'claude-haiku-4-5-20251001' })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(received[0].body).model, 'claude-haiku-5-5', 'haiku 4.5 is billed as haiku 5.5')
  })

  test('refuses every other revidapi endpoint (OpenAI format, images…) so nothing bypasses metering', async () => {
    const { key } = planKey()
    for (const path of ['/v1/chat/completions', '/v1/responses', '/v1/images/generations', '/v2/messages', '/chat/completions', '/v1', '/v1/v1/messages']) {
      const res = await fetch(`${base}/api/proxy${path}`, { method: 'POST', headers: { 'x-api-key': key }, body: '{"model":"claude-sonnet-5-5"}' })
      assert.equal(res.status, 404, path)
    }
    assert.equal(received.length, 0)
  })

  test('/v1/models lists exactly the three allowed models, answered by the gateway', async () => {
    const { key } = planKey()
    const res = await fetch(`${base}/api/proxy/v1/models`, { headers: { 'x-api-key': key } })
    const ids = (await res.json()).data.map((m) => m.id)
    assert.deepEqual(ids, ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'])
    assert.equal(received.length, 0)
  })

  test('count_tokens is forwarded and not charged', async () => {
    const { key, record } = planKey()
    const res = await fetch(`${base}/api/proxy/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'x-api-key': key },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.deepEqual(await res.json(), { input_tokens: 42 })
    assert.equal(received[0].path, '/v1/messages/count_tokens')
    assert.equal(quota.snapshot(store.get(record.id)).creditsUsed, 0)
  })

  test('upstream errors are passed through unchanged and not charged', async () => {
    const { key, record } = planKey()
    const res = await ask(base, key, { scenario: 'upstream-400' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.message, 'bad thing')
    assert.equal(quota.snapshot(store.get(record.id)).creditsUsed, 0, 'a failed request is not charged')
    assert.equal(quota.snapshot(store.get(record.id)).reserved, 0, 'its reservation is released too')
  })

  test('over the credit budget → 429 rate_limit_error in Vietnamese, revidapi not called', async () => {
    const { key, record } = planKey()
    quota.charge(store.get(record.id), { credits: PLANS.pro.credits, tokens: 0, model: null })
    const res = await ask(base, key)
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('retry-after'), null, 'a pack never refills')
    const err = (await res.json()).error
    assert.equal(err.type, 'rate_limit_error')
    assert.match(err.message, /Gói Pro đã dùng hết 5\.000 credit được mua/)
    assert.equal(received.length, 0)
  })

  test('a request that could overdraw the pack is refused before it is sent', async () => {
    const { key, record } = planKey()
    // Leave only 1 credit of headroom: a big request's worst case does not fit, a small one does.
    quota.charge(store.get(record.id), { credits: PLANS.pro.credits - 1, tokens: 0, model: null })
    const big = await ask(base, key, { max_tokens: 1000 }) // reserves ~1.5 credits → does not fit
    assert.equal(big.status, 429, 'the estimate exceeds the leftover, so it is refused')
    assert.match((await big.json()).error.message, /không còn đủ credit cho yêu cầu này/)
    const small = await ask(base, key, { max_tokens: 400 }) // reserves ~0.6 credits → fits
    await small.text()
    assert.equal(small.status, 200, 'a request that fits the leftover budget still goes through')
    const snap = quota.snapshot(store.get(record.id))
    assert.ok(snap.creditsUsed >= PLANS.pro.credits - 1 && snap.creditsUsed <= PLANS.pro.credits, 'never overdrawn')
    assert.equal(snap.reserved, 0)
    assert.equal(received.filter((r) => r.path === '/v1/messages').length, 1, 'the refused request never reached revidapi')
  })

  test('rejects missing and invalid keys in Anthropic error format', async () => {
    const missing = await fetch(`${base}/api/proxy/v1/messages`, { method: 'POST', body: '{}' })
    assert.equal(missing.status, 401)
    assert.deepEqual(await missing.json(), { type: 'error', error: { type: 'authentication_error', message: 'API key is missing.' } })
    const invalid = await fetch(`${base}/api/proxy/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'ak_nope' }, body: '{}' })
    assert.equal(invalid.status, 401)
    const noPlan = store.create({ name: 'U' })
    const unassigned = await ask(base, noPlan.key)
    assert.equal(unassigned.status, 403)
    assert.equal(received.length, 0)
  })

  test('limits concurrent requests per key, and frees the slot when a request ends', async () => {
    await withGateway({ extraConfig: { maxConcurrentPerKey: 2 } }, async (gw) => {
      const { key } = planKey()
      const slow = [ask(gw, key, { scenario: 'slow' }), ask(gw, key, { scenario: 'slow' })]
      await new Promise((r) => setTimeout(r, 80))
      const third = await ask(gw, key)
      assert.equal(third.status, 429)
      assert.equal(third.headers.get('retry-after'), '2')
      assert.match((await third.json()).error.message, /tối đa 2/)
      for (const r of await Promise.all(slow)) assert.equal(r.status, 200)
      assert.equal((await ask(gw, key)).status, 200, 'slots freed')
      const other = planKey('Other')
      assert.equal((await ask(gw, other.key)).status, 200, 'per key, not global')
    })
  })

  test('answers 503 when the revidapi key is not configured', async () => {
    await withGateway({ extraConfig: { revidApiKey: '' } }, async (gw) => {
      const { key } = planKey()
      const res = await ask(gw, key)
      assert.equal(res.status, 503)
      assert.equal(received.length, 0)
    })
  })
})

describe('stalled revidapi: the request is sent again', () => {
  test('no answer within hedgeAfterMs → a second attempt answers; charged once; WARN logged', async () => {
    await withGateway({ extraConfig: { hedgeAfterMs: 100 } }, async (gw, lines) => {
      const { key, record } = planKey()
      stallFirst = 1
      const started = Date.now()
      const res = await ask(gw, key, { stream: true, scenario: 'metered' })
      await res.text()
      assert.equal(res.status, 200)
      assert.ok(Date.now() - started < 550, 'did not wait for the stalled attempt')
      assert.equal(received.filter((r) => r.path === '/v1/messages').length, 2)
      assert.equal(quota.snapshot(store.get(record.id)).creditsUsed, creditsForUsage(METERED_USAGE, MODEL), 'charged once')
      assert.ok(lines.some((l) => /WARN .*sending the request again/.test(l)), lines.join('\n'))
    })
  })

  test('a quick answer sends nothing twice', async () => {
    await withGateway({ extraConfig: { hedgeAfterMs: 200 } }, async (gw) => {
      const { key } = planKey()
      await (await ask(gw, key, { stream: true })).text()
      await new Promise((r) => setTimeout(r, 250))
      assert.equal(received.length, 1)
    })
  })
})

describe('unreliable connection to revidapi', () => {
  /** What Node's fetch throws when the connection could not be opened (the request never left). */
  const connectError = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })
  const failWith = (code) => () => Promise.reject(connectError(code))

  async function withFlakyUpstream(failures, fn) {
    let calls = 0
    const fetchImpl = (url, init) => (failures[calls++] ?? fetch)(url, init)
    return withGateway({ fetchImpl }, (gw) => fn(gw, () => calls))
  }

  test('AI requests are resent when the connection could not be opened', async () => {
    const { key } = planKey()
    await withFlakyUpstream([failWith('UND_ERR_CONNECT_TIMEOUT')], async (gw, calls) => {
      const res = await ask(gw, key)
      assert.equal(res.status, 200)
      assert.equal(calls(), 2)
      assert.equal(received.length, 1)
    })
  })

  test('AI requests are not resent when they may already have reached revidapi', async () => {
    const { key, record } = planKey()
    await withFlakyUpstream([failWith('ECONNRESET')], async (gw, calls) => {
      const res = await ask(gw, key)
      assert.equal(res.status, 502)
      assert.equal(calls(), 1)
      assert.equal(quota.snapshot(store.get(record.id)).creditsUsed, 0)
    })
  })
})

describe('admin API', () => {
  test('requires the admin token', async () => {
    assert.equal((await fetch(`${base}/api/admin/keys`)).status, 401)
    assert.equal((await fetch(`${base}/api/admin/keys`, { headers: { authorization: 'Bearer wrong' } })).status, 401)
    assert.equal((await fetch(`${base}/api/admin/upstream`)).status, 401)
  })

  test('upstream balance: retries once, then serves the last good reading as stale', async () => {
    usageFail = 1
    let j = await (await admin('/upstream')).json()
    assert.equal(j.ok, true, 'one failure is retried')
    assert.equal(j.creditsRemaining, 123.4)
    assert.equal(j.stale, false)

    usageFail = 2
    j = await (await admin('/upstream')).json()
    assert.equal(j.ok, true, 'two failures fall back to the cached reading')
    assert.equal(j.stale, true)
    assert.equal(j.creditsRemaining, 123.4)
    assert.match(j.error, /HTTP 502/)
    assert.equal(usageFail, 0)
  })

  test('create with a pack → change the pack (fresh period) → rotate → delete', async () => {
    const created = await admin('/keys', { method: 'POST', body: JSON.stringify({ name: 'Khách A', plan: 'pro' }) })
    assert.equal(created.status, 201)
    const { key, record } = await created.json()
    assert.match(key, /^ak_[A-Za-z0-9_-]{43}$/)
    assert.equal(record.effectiveStatus, 'active')
    assert.equal(record.plan, 'pro')
    assert.equal(record.planName, 'Pro')
    assert.equal(record.expiresAt, null, 'a paid pack never expires')
    assert.equal(record.planDays, null, 'the legacy day counter is gone')
    assert.ok(record.planStartedAt)

    const listText = await (await admin('/keys')).text()
    assert.ok(!listText.includes(key), 'client key never returned after creation')

    quota.charge(store.get(record.id), { credits: 50, tokens: 1000, model: MODEL })
    assert.equal(quota.snapshot(store.get(record.id)).creditsUsed, 50)
    const patched = await (await admin(`/keys/${record.id}`, { method: 'PATCH', body: JSON.stringify({ plan: 'enterprise' }) })).json()
    assert.equal(patched.plan, 'enterprise')
    assert.equal(quota.snapshot(store.get(record.id)).creditsUsed, 0, 'new pack, fresh usage')
    assert.equal(quota.snapshot(store.get(record.id)).cap, PLANS.enterprise.credits)

    const usage = await (await admin(`/keys/${record.id}/usage`)).json()
    assert.equal(usage.usage.tier, 'Enterprise')
    assert.equal(usage.usage.unit, 'credit')

    const rotated = await (await admin(`/keys/${record.id}/rotate`, { method: 'POST' })).json()
    assert.equal(store.resolve(key).ok, false, 'old key stops working')
    assert.equal(store.resolve(rotated.key).ok, true)

    assert.equal((await admin(`/keys/${record.id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await admin(`/keys/${record.id}`)).status, 404)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM key_usage WHERE key_id = ?').get(record.id).n, 0, 'usage rows deleted too')
  })

  test('validates plans and minutes', async () => {
    assert.equal((await admin('/keys', { method: 'POST', body: JSON.stringify({ name: 'X', plan: 'ultra' }) })).status, 400)
    assert.equal((await admin('/keys', { method: 'POST', body: JSON.stringify({ name: 'X', plan: 'trial', planMinutes: 0 }) })).status, 400, 'under one minute')
    assert.equal((await admin('/keys', { method: 'POST', body: JSON.stringify({ name: 'X', plan: 'trial', planMinutes: 527_041 }) })).status, 400, 'over 366 days')
    assert.equal((await admin('/keys', { method: 'POST', body: JSON.stringify({ name: 'X', plan: 'trial', planMinutes: 'abc' }) })).status, 400)
    assert.equal((await admin('/keys', { method: 'POST', body: JSON.stringify({}) })).status, 400)
    assert.equal((await admin('/keys', { method: 'POST', body: 'not json' })).status, 400)
    const trial = await (await admin('/keys', { method: 'POST', body: JSON.stringify({ name: 'T', plan: 'trial' }) })).json()
    assert.equal(trial.record.planMinutes, 60, 'the trial defaults to 60 minutes')
    assert.ok(trial.record.expiresAt, 'the trial expires; a paid pack would not')
    const noPlan = store.create({ name: 'N' }).record
    assert.equal((await admin(`/keys/${noPlan.id}`, { method: 'PATCH', body: JSON.stringify({ planMinutes: 3 }) })).status, 400, 'minutes need a plan')
    assert.equal((await admin(`/keys/${noPlan.id}/usage`)).status, 409)
    const removed = await (await admin(`/keys/${planKey().record.id}`, { method: 'PATCH', body: JSON.stringify({ plan: null }) })).json()
    assert.equal(removed.plan, null)
    assert.equal(removed.effectiveStatus, 'unassigned')
  })

  test('reports the revidapi balance and flags it when low', async () => {
    const res = await admin('/upstream')
    assert.equal(res.status, 200)
    const { fetchedAt, ...b } = await res.json()
    assert.ok(Math.abs(Date.parse(fetchedAt) - Date.now()) < 5000)
    assert.deepEqual(b, {
      stale: false,
      ok: true,
      creditsRemaining: 123.4,
      creditsUsedToday: 5.5,
      requestsToday: 7,
      lastRequestAt: '2026-11-12T02:00:00Z',
      lowBalance: true,
      lowThreshold: 300,
    })
    assert.equal(received[0].headers['x-api-key'], REVID_KEY)
    assert.ok(!JSON.stringify(b).includes(REVID_KEY))
  })

  test('lets the admin copy a client key again, also after rotation', async () => {
    const { key, record } = planKey('Copy')
    const res = await admin(`/keys/${record.id}/key`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal((await res.json()).key, key)
    const rotated = store.rotate(record.id)
    assert.equal((await (await admin(`/keys/${record.id}/key`)).json()).key, rotated.key)
    assert.equal((await admin(`/keys/${record.id}/key`, { method: 'POST' })).status, 405)
  })
})

describe('database migration', () => {
  function oldDatabase(dir) {
    const path = join(dir, 'old.db')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, note TEXT, key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL, upstream_key_enc TEXT, upstream_fingerprint TEXT UNIQUE, upstream_hint TEXT,
      status TEXT NOT NULL DEFAULT 'active', expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_used_at TEXT, request_count INTEGER NOT NULL DEFAULT 0)`)
    return { path, old }
  }

  test('agentshop-era keys get a credit pack and stop expiring, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-'))
    try {
      const { path, old } = oldDatabase(dir)
      const now = Date.parse('2026-11-12T00:00:00Z')
      const insert = old.prepare('INSERT INTO api_keys (name, key_hash, key_prefix, upstream_key_enc, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      // A: agentshop key ends in 10 days, own expiry later → 10 days. B: own expiry in 3 days → 3. C: no agentshop key → untouched.
      insert.run('A', sha256('ak_a'), 'ak_a', encrypt(agentshopKey(now / 1000 + 10 * 86400), ENC_KEY), '2027-01-01T00:00:00.000Z', 't', 't')
      insert.run('B', sha256('ak_b'), 'ak_b', encrypt(agentshopKey(now / 1000 + 30 * 86400), ENC_KEY), new Date(now + 3 * DAY_MS).toISOString(), 't', 't')
      insert.run('C', sha256('ak_c'), 'ak_c', null, null, 't', 't')
      old.close()

      const d = openDb(path)
      const ks = new KeyStore(d, { encryptionKey: ENC_KEY, now: () => now })
      const [a, b, c] = [1, 2, 3].map((id) => ks.get(id))
      assert.equal(a.plan, 'pro', 'the agentshop-era plan became the Pro credit pack')
      assert.equal(a.planDays, null, 'the legacy day counter is gone')
      assert.equal(a.planMinutes, null, 'a paid pack has no time limit')
      assert.equal(a.expiresAt, null, 'a paid pack never expires')
      assert.equal(b.plan, 'pro')
      assert.equal(b.expiresAt, null)
      assert.equal(c.plan, null)
      assert.equal(ks.resolve('ak_a').ok, true, 'old customers keep working after the deploy')
      assert.equal(a.canCopy, false, 'pre-copy keys still need a rotation to be copyable')

      // Runs once: a plan the admin removes later is not re-added on the next start.
      ks.update(1, { plan: null })
      const again = new KeyStore(d, { encryptionKey: ENC_KEY, now: () => now })
      assert.equal(again.get(1).plan, null)
      d.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('old session/week plans are remapped onto credit packs and their usage is reset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-'))
    try {
      const path = join(dir, 'old.db')
      const old = new DatabaseSync(path)
      old.exec(`CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, note TEXT, key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL, upstream_key_enc TEXT, upstream_fingerprint TEXT UNIQUE, upstream_hint TEXT,
        status TEXT NOT NULL DEFAULT 'active', expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_used_at TEXT, request_count INTEGER NOT NULL DEFAULT 0,
        plan TEXT, plan_days INTEGER, plan_started_at TEXT)`)
      const insert = old.prepare('INSERT INTO api_keys (name, key_hash, key_prefix, plan, plan_days, plan_started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      insert.run('5x', sha256('ak_5x'), 'ak_5x', 'max5x', 30, 't', 't', 't')
      insert.run('20x', sha256('ak_20x'), 'ak_20x', 'max20x', 30, 't', 't', 't')
      insert.run('trial', sha256('ak_tr'), 'ak_tr', 'trial', 1, 't', 't', 't')
      old.exec(`CREATE TABLE key_usage (
        key_id INTEGER PRIMARY KEY, plan_started_at TEXT NOT NULL, session_start INTEGER,
        session_used REAL NOT NULL DEFAULT 0, week_index INTEGER NOT NULL DEFAULT 0,
        week_used REAL NOT NULL DEFAULT 0, balance REAL NOT NULL, balance_at INTEGER NOT NULL,
        total_used REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`)
      old.prepare('INSERT INTO key_usage (key_id, plan_started_at, balance, balance_at, total_used, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 't', 100, 0, 500, 't')
      old.close()

      const d = openDb(path)
      const ks = new KeyStore(d, { encryptionKey: ENC_KEY, now: () => Date.parse('2026-11-12T00:00:00Z') })
      assert.equal(ks.get(1).plan, 'business', 'max5x → Business')
      assert.equal(ks.get(2).plan, 'enterprise', 'max20x → Enterprise')
      assert.equal(ks.get(3).plan, 'trial')
      assert.equal(ks.get(3).planMinutes, 1440, 'a 1-day trial became 1440 minutes')
      assert.equal(ks.get(1).expiresAt, null, 'a paid pack never expires')
      assert.equal(d.prepare('SELECT COUNT(*) AS n FROM key_usage WHERE key_id = 1').get().n, 0, 'the old counters are dropped')
      d.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Claude Code streams through upstream quirks', () => {
  /** Sends a streamed /v1/messages request and returns the parsed events the client received. */
  async function stream(gwBase, payload) {
    const { key } = planKey(`S${Math.random()}`)
    const res = await ask(gwBase, key, { stream: true, ...payload })
    const text = await res.text()
    const events = text
      .split('\n\n')
      .filter((e) => e.trim())
      .map((e) => JSON.parse(e.split('\n').find((l) => l.startsWith('data:')).slice(5)))
    return { status: res.status, events, text, headers: res.headers }
  }
  const stopReason = (events) => events.find((e) => e.type === 'message_delta')?.delta.stop_reason

  test('a normal answer passes through, chunked, without upstream cookies', async () => {
    const { events, text, headers } = await stream(base, {})
    assert.deepEqual(events.map((e) => e.type), ['message_start', 'content_block_delta', 'message_delta', 'message_stop'])
    assert.equal(stopReason(events), 'end_turn')
    assert.doesNotMatch(text, /ping|error/)
    assert.equal(headers.get('content-type'), 'text/event-stream')
    assert.equal(headers.get('set-cookie'), null)
  })

  test('an answer cut at an upstream limit but labelled end_turn is relabelled max_tokens', async () => {
    await withGateway({}, async (gw, lines) => {
      const { events } = await stream(gw, { scenario: 'truncated' })
      assert.equal(stopReason(events), 'max_tokens')
      assert.equal(events.at(-1).type, 'message_stop')
      assert.ok(lines.some((l) => /WARN .*output limit \(2048 tokens\)/.test(l)), lines.join('\n'))
    })
  })

  test('a natural end below the requested limit is not relabelled', async () => {
    const { events } = await stream(base, { max_tokens: 32000, scenario: 'truncated' })
    assert.equal(stopReason(events), 'end_turn')
  })

  test('events split across many chunks are reassembled before being inspected', async () => {
    const { events } = await stream(base, { scenario: 'split' })
    assert.equal(events.length, 4)
    assert.equal(stopReason(events), 'max_tokens')
  })

  test('pings are sent while the upstream is silent, only between events', async () => {
    await withGateway({ extraConfig: { streamPingMs: 50 } }, async (gw) => {
      const { events } = await stream(gw, { scenario: 'silent' })
      const types = events.map((e) => e.type)
      assert.ok(types.includes('ping'), types.join(','))
      assert.deepEqual(types.filter((t) => t !== 'ping'), ['message_start', 'content_block_delta', 'message_delta', 'message_stop'])
    })
  })

  test('a connection that breaks mid-answer ends with an error event and a WARN log', async () => {
    await withGateway({}, async (gw, lines) => {
      const { status, events } = await stream(gw, { scenario: 'break' })
      assert.equal(status, 200)
      assert.equal(events.at(-1).type, 'error')
      assert.equal(events.at(-1).error.type, 'api_error')
      assert.ok(!events.some((e) => e.type === 'message_stop'))
      assert.ok(lines.some((l) => /WARN .*broke after \d+ms/.test(l)), lines.join('\n'))
    })
  })

  test('a stream that ends without message_stop also gets an error event', async () => {
    await withGateway({}, async (gw, lines) => {
      const { events } = await stream(gw, { scenario: 'nostop' })
      assert.equal(events.at(-1).type, 'error')
      assert.ok(lines.some((l) => /WARN .*without message_stop/.test(l)), lines.join('\n'))
    })
  })

  test('non-streamed answers get the same stop_reason fix', async () => {
    const { key } = planKey()
    const res = await ask(base, key, { max_tokens: 32000, scenario: 'json-truncated' })
    assert.equal(res.status, 200)
    const msg = await res.json()
    assert.equal(msg.stop_reason, 'max_tokens')
    assert.ok(msg.usage.input_tokens > 0, 'input_tokens filled in for non-streamed answers too')
  })

  test('input_tokens=0 is replaced by an estimate so Claude Code can auto-compact', async () => {
    const big = 'x'.repeat(40_000) // ~10k tokens
    const { events } = await stream(base, { system: big })
    const est = events.find((e) => e.type === 'message_start').message.usage.input_tokens
    assert.ok(est >= 10_000 && est < 10_200, `estimate ${est}`)
  })

  test('a backend that reports real input usage is left alone', async () => {
    const { events } = await stream(base, { scenario: 'real-usage' })
    assert.equal(events.find((e) => e.type === 'message_start').message.usage.input_tokens, 777)
  })

  test('the estimate counts attachments at a fixed cost, not by their base64 size', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2_000_000) } }
    const est = estimateInputTokens({ messages: [{ role: 'user', content: [image, { type: 'text', text: 'what is this?' }] }] })
    assert.ok(est > 1600 && est < 1700, `estimate ${est}`)
    assert.equal(estimateInputTokens({ prompt: 'not a messages request' }), undefined)
  })
})

describe('setup endpoint', () => {
  test('returns a bash script (os=mac) that carries the key, host and pinned models', async () => {
    const { key } = store.create({ name: 'S', plan: 'pro' })
    const res = await fetch(`${base}/api/setup?key=${key}&os=mac`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.match(res.headers.get('content-disposition') ?? '', /attachment.*agentshop-setup\.sh/)
    const text = await res.text()
    assert.match(text, /API_HOST=/)
    assert.ok(text.includes(`API_KEY='${key}'`), 'script embeds the caller\'s key')
    assert.ok(text.includes("API_HOST='https://agentshop.id.vn/api/proxy'"))
    assert.match(text, /ANTHROPIC_MODEL='claude-sonnet-5-5'/)
    assert.match(text, /ANTHROPIC_SMALL_FAST_MODEL='claude-haiku-5-5'/)
    assert.match(text, /claudeCode\.environmentVariables/)
    assert.match(text, /disableLoginPrompt/)
    // The generated script never points at a raw key in a URL — it writes config to files.
    assert.doesNotMatch(text, /check-usage\?key=/)
    assert.equal(received.length, 0, 'setup does not call upstream')
  })

  test('returns a PowerShell script (os=windows) that carries the key and models', async () => {
    const { key } = store.create({ name: 'W', plan: 'pro' })
    const res = await fetch(`${base}/api/setup?key=${key}&os=windows`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-disposition') ?? '', /agentshop-setup\.ps1/)
    const text = await res.text()
    assert.ok(text.includes(`$ApiKey = '${key}'`), 'script embeds the caller\'s key')
    assert.match(text, /\$Model = 'claude-sonnet-5-5'/)
    assert.match(text, /\$SmallModel = 'claude-haiku-5-5'/)
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
        env: {
          KEEP: '1', ANTHROPIC_MODEL: 'm-big', ANTHROPIC_BASE_URL: 'https://gw.example/api/proxy', ANTHROPIC_AUTH_TOKEN: 'ak_NEW',
          ANTHROPIC_SMALL_FAST_MODEL: 'm-small', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm-small', CLAUDE_CODE_SUBAGENT_MODEL: 'm-small', CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
        },
      })
      const vs = read(v)
      assert.equal(vs['editor.fontSize'], 15)
      assert.equal(vs['claudeCode.disableLoginPrompt'], true)
      assert.deepEqual(vs['claudeCode.environmentVariables'].map((e) => e.name), [
        'FOO', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_DISABLE_1M_CONTEXT',
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
    const { key } = store.create({ name: 'O', plan: 'pro' })
    assert.equal((await fetch(`${base}/api/setup?key=${key}`)).status, 400)
    assert.equal((await fetch(`${base}/api/setup?key=${key}&os=android`)).status, 400)
  })

  test('rejects unknown, revoked, expired and unassigned keys', async () => {
    const revoked = store.create({ name: 'R', plan: 'pro' })
    store.update(revoked.record.id, { status: 'revoked' })
    const expired = store.create({ name: 'E', plan: 'pro', expiresAt: '2020-01-01T00:00:00Z' })
    const unassigned = store.create({ name: 'U' })

    const cases = [
      ['ak_doesnotexist', 401, 'API key not found or unassigned.'],
      [revoked.key, 403, 'API key has been revoked.'],
      [expired.key, 403, 'API key has expired.'],
      [unassigned.key, 403, 'API key has no plan yet. Please contact the administrator.'],
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
    const { key } = store.create({ name: 'A', plan: 'pro' })
    assert.equal((await fetch(`${base}/api/setup?key=${key}&os=mac`, { method: 'POST' })).status, 405)
  })

  test('path form /api/setup/<os>/<key> works and the key never reaches the log', async () => {
    const lines = []
    const gw = createGateway({ config, store, quota, log: (l) => lines.push(l) })
    gw.listen(0)
    await once(gw, 'listening')
    try {
      const { key } = store.create({ name: 'P', plan: 'pro' })
      const gwBase = `http://127.0.0.1:${gw.address().port}`
      const win = await fetch(`${gwBase}/api/setup/windows/${key}`)
      assert.equal(win.status, 200)
      assert.ok((await win.text()).includes(`$ApiKey = '${key}'`))
      const mac = await fetch(`${gwBase}/api/setup/mac/${key}/`)
      assert.equal(mac.status, 200)
      assert.match(await mac.text(), /^#!\/usr\/bin\/env bash/)
      assert.equal((await fetch(`${gwBase}/api/setup/android/${key}`)).status, 400)
      assert.equal((await fetch(`${gwBase}/api/setup/windows/ak_nope`)).status, 401)
      assert.equal((await fetch(`${gwBase}/api/setup/windows/${key}/extra`)).status, 400)

      await new Promise((r) => setTimeout(r, 20)) // 'finish' handlers log after the response
      assert.ok(lines.some((l) => l.includes('GET /api/setup/windows/*** 200')), lines.join('\n'))
      assert.ok(lines.every((l) => !l.includes(key) && !l.includes('ak_nope')), 'no key in any log line')
    } finally {
      gw.close()
    }
  })
})

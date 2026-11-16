import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { failureKind, modelChain, NvidiaRouter, parseRetryAfter, tierModels, tierOf } from '../src/nvidia-router.js'

const config = {
  nvidiaModel: 'super',
  nvidiaModels: { opus: 'ultra', sonnet: 'super', haiku: 'light' },
  nvidiaVisionModels: ['super', 'omni'],
}

describe('NVIDIA model choice', () => {
  test('the Claude model picks the tier', () => {
    assert.equal(tierOf('claude-opus-5-5'), 'opus')
    assert.equal(tierOf('claude-sonnet-5-5'), 'sonnet')
    assert.equal(tierOf('claude-haiku-5-5'), 'haiku')
    assert.equal(tierOf('something-else'), 'sonnet')
  })

  test('without per-tier models every tier uses the single nvidiaModel', () => {
    assert.deepEqual(tierModels({ nvidiaModel: 'only' }), { opus: 'only', sonnet: 'only', haiku: 'only' })
  })

  test('the chain starts with the tier\'s own model, then the closest others', () => {
    assert.deepEqual(modelChain(config, 'claude-opus-5-5', false), ['ultra', 'super', 'light'])
    assert.deepEqual(modelChain(config, 'claude-sonnet-5-5', false), ['super', 'ultra', 'light'])
    assert.deepEqual(modelChain(config, 'claude-haiku-5-5', false), ['light', 'super', 'ultra'])
  })

  test('a chain has no duplicates when tiers share a model', () => {
    assert.deepEqual(modelChain({ nvidiaModel: 'only' }, 'claude-opus-5-5', false), ['only'])
  })

  test('a request with images only goes to models that see images, the tier\'s own first when it is one', () => {
    assert.deepEqual(modelChain(config, 'claude-opus-5-5', true), ['super', 'omni'])
    assert.deepEqual(modelChain(config, 'claude-haiku-5-5', true), ['super', 'omni'])
    assert.deepEqual(modelChain({ ...config, nvidiaVisionModels: ['omni', 'super'] }, 'claude-sonnet-5-5', true), ['super', 'omni'])
  })
})

describe('NVIDIA failure handling', () => {
  test('failures are classified by status', () => {
    assert.equal(failureKind(429), 'rate')
    assert.equal(failureKind(503), 'server')
    assert.equal(failureKind(0), 'server') // no answer at all: timeout, connection lost
    assert.equal(failureKind(401), 'auth')
    assert.equal(failureKind(403), 'auth')
    assert.equal(failureKind(400), 'request')
    assert.equal(failureKind(404), 'request')
  })

  test('Retry-After is read as seconds or as a date', () => {
    assert.equal(parseRetryAfter('7'), 7000)
    assert.equal(parseRetryAfter(null), undefined)
    assert.equal(parseRetryAfter('garbage'), undefined)
    const inTen = new Date(Date.now() + 10_000).toUTCString()
    assert.ok(Math.abs(parseRetryAfter(inTen) - 10_000) < 1500)
  })
})

describe('NvidiaRouter', () => {
  const lane = (id) => ({ id, key: `key-${id}` })
  let t
  const router = (opts = {}) => new NvidiaRouter({ now: () => t, maxPerLane: 2, ...opts })
  const reset = () => { t = 1_000_000 }

  test('picks the first model of the chain on the first lane', () => {
    reset()
    const a = router().acquire(['ultra', 'super'], [lane('shared:0'), lane('shared:1')])
    assert.equal(a.model, 'ultra')
    assert.equal(a.lane.id, 'shared:0')
  })

  test('a rate-limited model rests, and the next model of the chain is used meanwhile', () => {
    reset()
    const r = router()
    const a = r.acquire(['ultra', 'super'], [lane('s')])
    const f = r.failure(a, { status: 429 })
    a.release()
    assert.equal(f.kind, 'rate')
    assert.equal(f.waitMs, 10_000)
    assert.equal(r.acquire(['ultra', 'super'], [lane('s')]).model, 'super')
    t += 10_001
    assert.equal(r.acquire(['ultra', 'super'], [lane('s')]).model, 'ultra', 'rested long enough')
  })

  test('the rest grows with repeated failures (10s, 20s, 40s, then at most 60s) and resets after a success', () => {
    reset()
    const r = router()
    const waits = []
    for (let i = 0; i < 6; i++) {
      t += 100_000
      const a = r.acquire(['m'], [lane('s')])
      waits.push(r.failure(a, { status: 429 }).waitMs)
      a.release()
    }
    assert.deepEqual(waits, [10_000, 20_000, 40_000, 60_000, 60_000, 60_000])
    t += 100_000
    const ok = r.acquire(['m'], [lane('s')])
    r.success(ok)
    ok.release()
    const a = r.acquire(['m'], [lane('s')])
    assert.equal(r.failure(a, { status: 429 }).waitMs, 10_000)
  })

  test('Retry-After from NVIDIA decides how long to rest (at most 2 minutes)', () => {
    reset()
    const r = router()
    const a = r.acquire(['m'], [lane('s')])
    assert.equal(r.failure(a, { status: 429, retryAfterMs: 25_000 }).waitMs, 25_000)
    const b = r.acquire(['m2'], [lane('s')])
    assert.equal(r.failure(b, { status: 429, retryAfterMs: 900_000 }).waitMs, 120_000)
  })

  test('a rejected key rests on every model; a bad request rests nothing', () => {
    reset()
    const r = router()
    const a = r.acquire(['ultra', 'super'], [lane('s')])
    assert.equal(r.failure(a, { status: 401 }).waitMs, 300_000)
    assert.equal(r.acquire(['ultra', 'super'], [lane('s')]), null, 'no model works with that key')
    const other = r.acquire(['ultra'], [lane('s'), lane('t')])
    assert.equal(other.lane.id, 't', 'another key still works')

    reset()
    const r2 = router()
    const b = r2.acquire(['ultra'], [lane('s')])
    assert.equal(r2.failure(b, { status: 400 }).waitMs, 0)
    b.release()
    assert.equal(r2.acquire(['ultra'], [lane('s')]).model, 'ultra')
  })

  test('the right model on another key comes before a different model on the same key', () => {
    reset()
    const r = router()
    const a = r.acquire(['ultra', 'super'], [lane('s'), lane('t')])
    r.failure(a, { status: 429 })
    a.release()
    const b = r.acquire(['ultra', 'super'], [lane('s'), lane('t')])
    assert.deepEqual([b.model, b.lane.id], ['ultra', 't'])
  })

  test('each key and model has its own slots', () => {
    reset()
    const r = router() // 2 per lane and model
    const x1 = r.acquire(['m'], [lane('s')])
    const x2 = r.acquire(['m'], [lane('s')])
    assert.ok(x1 && x2)
    assert.equal(r.acquire(['m'], [lane('s')]), null, 'full')
    assert.equal(r.acquire(['m', 'n'], [lane('s')]).model, 'n', 'another model has its own slots')
    x1.release()
    x1.release() // releasing twice must not free a second slot
    assert.ok(r.acquire(['m'], [lane('s')]))
    assert.equal(r.acquire(['m'], [lane('s')]), null)
  })

  test('an attempt that already failed can be skipped', () => {
    reset()
    const r = router()
    const a = r.acquire(['ultra', 'super'], [lane('s')])
    const next = r.acquire(['ultra', 'super'], [lane('s')], new Set([a.key]))
    assert.equal(next.model, 'super')
  })

  test('the first lane to try rotates, to spread requests over a pool of keys', () => {
    reset()
    const r = router()
    const lanes = [lane('a'), lane('b'), lane('c')]
    const order = Array.from({ length: 6 }, () => r.rotate(lanes)[0].id)
    assert.deepEqual(order, ['a', 'b', 'c', 'a', 'b', 'c'])
    assert.deepEqual(r.rotate([lane('only')]).map((l) => l.id), ['only'])
  })
})

describe('NVIDIA config', () => {
  const env = { ADMIN_TOKEN: 'a'.repeat(32), ENCRYPTION_KEY: '11'.repeat(32), REVID_API_KEY: 'sk_x' }

  test('defaults: a model per Claude tier, models that see images, and the caps', async () => {
    const { loadConfig } = await import('../src/config.js')
    const c = loadConfig(env)
    assert.deepEqual(c.nvidiaModels, {
      opus: 'nvidia/nemotron-3-ultra-550b-a55b',
      sonnet: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      haiku: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    })
    assert.equal(c.nvidiaModel, c.nvidiaModels.sonnet, 'the single model is the Sonnet one')
    assert.deepEqual(c.nvidiaVisionModels, ['nvidia/nemotron-3.5-super-vl-120b-a12b', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'])
    assert.equal(c.maxTotalConcurrent, 60)
    assert.equal(c.nvidiaFirstByteTimeoutMs, 60_000)
    assert.equal(c.nvidiaApiKeys.length, 1)
  })

  test('NVIDIA_MODEL still sets the Sonnet model; the per-tier variables override', async () => {
    const { loadConfig } = await import('../src/config.js')
    const c = loadConfig({ ...env, NVIDIA_MODEL: 'my/sonnet', NVIDIA_MODEL_OPUS: 'my/opus', NVIDIA_MODEL_HAIKU: 'my/haiku', NVIDIA_VISION_MODELS: 'my/vl, my/vl2' })
    assert.deepEqual(c.nvidiaModels, { opus: 'my/opus', sonnet: 'my/sonnet', haiku: 'my/haiku' })
    assert.equal(c.nvidiaModel, 'my/sonnet')
    assert.deepEqual(c.nvidiaVisionModels, ['my/vl', 'my/vl2'])
  })

  test('NVIDIA_API_KEYS is a pool of shared keys; the first is also nvidiaApiKey', async () => {
    const { loadConfig } = await import('../src/config.js')
    const c = loadConfig({ ...env, NVIDIA_API_KEYS: 'nvapi-aaaaaaaa, nvapi-bbbbbbbb,nvapi-aaaaaaaa' })
    assert.deepEqual(c.nvidiaApiKeys, ['nvapi-aaaaaaaa', 'nvapi-bbbbbbbb'])
    assert.equal(c.nvidiaApiKey, 'nvapi-aaaaaaaa')
  })

  test('an empty NVIDIA_API_KEY switches NVIDIA off', async () => {
    const { loadConfig } = await import('../src/config.js')
    const c = loadConfig({ ...env, NVIDIA_API_KEY: '' })
    assert.deepEqual(c.nvidiaApiKeys, [])
    assert.equal(c.nvidiaApiKey, '')
  })

  test('caps and timeouts are checked', async () => {
    const { loadConfig } = await import('../src/config.js')
    assert.equal(loadConfig({ ...env, MAX_TOTAL_CONCURRENT: '0' }).maxTotalConcurrent, 0)
    assert.throws(() => loadConfig({ ...env, MAX_TOTAL_CONCURRENT: '-1' }), /MAX_TOTAL_CONCURRENT/)
    assert.throws(() => loadConfig({ ...env, NVIDIA_FIRST_BYTE_TIMEOUT_MS: 'soon' }), /NVIDIA_FIRST_BYTE_TIMEOUT_MS/)
  })
})

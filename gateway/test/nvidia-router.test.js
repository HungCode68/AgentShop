import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { allModels, classifyTask, failureKind, modelChain, NvidiaRouter, parseRetryAfter } from '../src/nvidia-router.js'

const config = {
  nvidiaModel: 'single',
  nvidiaChains: { chat: ['omni', 'light', 'super', 'ultra'], agent: ['ultra', 'super', 'omni', 'light'], vision: ['super', 'omni'] },
}

const user = (content) => ({ role: 'user', content })
const asst = (content) => ({ role: 'assistant', content })
const req = (messages, extra = {}) => ({ model: 'claude-sonnet-5-5', max_tokens: 1000, messages, ...extra })
const kind = (messages, extra, opts) => classifyTask(req(messages, extra), opts).kind

describe('task classification', () => {
  test('everyday questions and chat are "chat" (the fast models)', () => {
    for (const q of ['Thủ đô của Nhật Bản là gì?', 'Cho mình 3 mẹo học tiếng Anh nhanh', 'Viết một câu chúc mừng sinh nhật bạn thân', 'What is the tallest mountain in the world?', 'Dịch câu này sang tiếng Anh: hôm nay trời đẹp']) {
      assert.equal(kind([user(q)]), 'chat', q)
    }
  })

  test('code and technical requests are "agent" (the strong models), in English and in Vietnamese with or without accents', () => {
    const asks = [
      'Viết hàm tính giai thừa bằng Python',
      'viet code python doc file csv giup minh',
      'Sửa lỗi này giúp mình:\n```js\nconst a = 1\n```',
      'Why does my React component throw an exception?',
      'Phân tích kiến trúc hệ thống này giúp mình',
      'Traceback (most recent call last):\n  File "a.py", line 1',
      'Giải thích thuật toán quicksort',
      'chạy lệnh git status rồi cho mình biết kết quả',
      'refactor this module and add unit tests',
      // work on the customer's machine or project, with no technical word in it
      'Tạo file README cho dự án này',
      'Dự án này dùng framework gì?',
      'Review my pull request',
      'Mở trình duyệt Chrome giúp mình',
    ]
    for (const q of asks) assert.equal(kind([user(q)]), 'agent', q)
  })

  test('an image makes it "vision", even when the conversation has tools or code', () => {
    const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    assert.equal(kind([user([{ type: 'text', text: 'what is this?' }, png])]), 'vision')
    assert.equal(kind([user([{ type: 'text', text: 'fix this bug' }, png])], { tools: [{ name: 'Bash', input_schema: { type: 'object' } }] }), 'vision')
  })

  test('Claude Code\'s own reminders and IDE notes are not what the customer asked', () => {
    const text = [
      { type: 'text', text: '<system-reminder>The code, git, test and python tools are available. Run the build.</system-reminder>' },
      { type: 'text', text: '<ide_opened_file>The user opened a file app.py in the IDE.</ide_opened_file>' },
      { type: 'text', text: 'Xin chào, bạn khỏe không?' },
    ]
    assert.equal(kind([user(text)]), 'chat')
  })

  test('only the latest message of the customer decides the topic', () => {
    assert.equal(kind([user('viết hàm python tính tổng'), asst('def f(a, b): return a + b'), user('cảm ơn, hôm nay trời đẹp nhỉ')]), 'chat')
    assert.equal(kind([user('xin chào'), asst('Chào bạn!'), user('viết hàm python tính tổng')]), 'agent')
  })

  test('once tools have been used the conversation is an agent session and stays one', () => {
    const msgs = [
      user('xin chào'),
      asst([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      asst('xong'),
      user('cảm ơn nhé'),
    ]
    const c = classifyTask(req(msgs))
    assert.equal(c.kind, 'agent')
    assert.match(c.reason, /tool/)
  })

  test('extended thinking, a forced tool and structured output mean a job that needs care', () => {
    assert.equal(kind([user('xin chào')], { thinking: { type: 'enabled', budget_tokens: 8000 } }), 'agent')
    assert.equal(kind([user('xin chào')], { tools: [{ name: 'verdict', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 'verdict' } }), 'agent')
    assert.equal(kind([user('xin chào')], { output_config: { format: { type: 'json_schema', schema: {} } } }), 'agent')
    assert.equal(kind([user('xin chào')], { thinking: { type: 'disabled' } }), 'chat')
  })

  test('a long conversation goes to the strong models', () => {
    assert.equal(kind([user('tóm tắt giúp mình')], undefined, { inputEstimate: 25_000 }), 'agent')
    assert.equal(kind([user('tóm tắt giúp mình')], undefined, { inputEstimate: 5_000 }), 'chat')
    assert.equal(kind([user('tóm tắt giúp mình')], undefined, { inputEstimate: 25_000, longContextTokens: 50_000 }), 'chat')
  })

  test('with task routing off everything is "agent", except images which still need a vision model', () => {
    assert.equal(kind([user('xin chào')], undefined, { routing: false }), 'agent')
    const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    assert.equal(kind([user([png])], undefined, { routing: false }), 'vision')
  })

  test('says why, for the log and the response header', () => {
    assert.match(classifyTask(req([user('xin chào')])).reason, /chat/)
    assert.match(classifyTask(req([user('viết code python')])).reason, /code/)
  })
})

describe('model chains', () => {
  test('each kind of task has its own chain', () => {
    assert.deepEqual(modelChain(config, 'chat'), ['omni', 'light', 'super', 'ultra'])
    assert.deepEqual(modelChain(config, 'agent'), ['ultra', 'super', 'omni', 'light'])
    assert.deepEqual(modelChain(config, 'vision'), ['super', 'omni'])
  })

  test('without chains every kind uses the single nvidiaModel', () => {
    assert.deepEqual(modelChain({ nvidiaModel: 'only' }, 'chat'), ['only'])
    assert.deepEqual(modelChain({ nvidiaModel: 'only' }, 'vision'), ['only'])
  })

  test('allModels lists each model once (for the connection test)', () => {
    assert.deepEqual(allModels(config), ['omni', 'light', 'super', 'ultra'])
    assert.deepEqual(allModels({ nvidiaModel: 'only' }), ['only'])
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

  test('defaults: a chain of models per kind of task, and the caps', async () => {
    const { loadConfig } = await import('../src/config.js')
    const c = loadConfig(env)
    const ultra = 'nvidia/nemotron-3-ultra-550b-a55b'
    const superVl = 'nvidia/nemotron-3.5-super-vl-120b-a12b'
    const omni = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'
    const light = 'nvidia/nemotron-3.5-lightning-30b-a3b'
    assert.deepEqual(c.nvidiaChains, { chat: [omni, light, superVl, ultra], agent: [ultra, superVl, omni, light], vision: [superVl, omni] })
    assert.equal(c.nvidiaModel, ultra, 'the single model is the first of the agent chain')
    assert.equal(c.nvidiaTaskRouting, true)
    assert.equal(c.nvidiaLongContextTokens, 20_000)
    assert.equal(c.maxTotalConcurrent, 60)
    assert.equal(c.nvidiaFirstByteTimeoutMs, 60_000)
    assert.equal(c.nvidiaApiKeys.length, 1)
  })

  test('each chain can be set with a comma separated list', async () => {
    const { loadConfig } = await import('../src/config.js')
    const c = loadConfig({ ...env, NVIDIA_CHAT_MODELS: 'my/fast, my/fast2', NVIDIA_AGENT_MODELS: 'my/strong', NVIDIA_VISION_MODELS: 'my/vl' })
    assert.deepEqual(c.nvidiaChains, { chat: ['my/fast', 'my/fast2'], agent: ['my/strong'], vision: ['my/vl'] })
    assert.equal(c.nvidiaModel, 'my/strong')
  })

  test('task routing can be switched off, and the long-conversation size set', async () => {
    const { loadConfig } = await import('../src/config.js')
    assert.equal(loadConfig({ ...env, NVIDIA_TASK_ROUTING: 'off' }).nvidiaTaskRouting, false)
    assert.equal(loadConfig({ ...env, NVIDIA_LONG_CONTEXT_TOKENS: '50000' }).nvidiaLongContextTokens, 50_000)
    assert.throws(() => loadConfig({ ...env, NVIDIA_LONG_CONTEXT_TOKENS: 'big' }), /NVIDIA_LONG_CONTEXT_TOKENS/)
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

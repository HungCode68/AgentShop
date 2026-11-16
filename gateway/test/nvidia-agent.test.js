import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { anthropicToOpenAi, openAiToAnthropic, relayOpenAiStreamToAnthropic } from '../src/nvidia.js'

const base = { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }

describe('NVIDIA adapter: agent conversation history', () => {
  const convert = (messages) => anthropicToOpenAi({ ...base, messages }).messages
  const call = { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }

  test('text next to a tool_result is kept, as a user message after the tool message', () => {
    const out = convert([
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: [call] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }, { type: 'text', text: 'also: use fewer files' }] },
    ])
    assert.deepEqual(out.slice(-2), [
      { role: 'tool', tool_call_id: 'toolu_1', content: 'ok' },
      { role: 'user', content: 'also: use fewer files' },
    ])
  })

  test('a failed tool_result tells the model it failed', () => {
    const out = convert([
      { role: 'assistant', content: [call] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'command not found' }] },
    ])
    assert.equal(out.at(-1).content, 'Error: command not found')
  })

  test('an image inside a tool_result (a screenshot) reaches the model as a user message', () => {
    const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    const out = convert([
      { role: 'assistant', content: [call] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'screenshot taken' }, png] }] },
    ])
    assert.deepEqual(out.at(-2), { role: 'tool', tool_call_id: 'toolu_1', content: 'screenshot taken' })
    assert.deepEqual(out.at(-1), { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] })
  })

  test('assistant text blocks become a plain string; a thinking-only turn is dropped', () => {
    const out = convert([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: '' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    ])
    assert.deepEqual(out, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a\nb' },
    ])
  })
})

describe('NVIDIA adapter: streamed answer relayed as Anthropic SSE', () => {
  const fakeRes = () => ({
    destroyed: false,
    out: [],
    ended: false,
    write(s) {
      this.out.push(s)
      return true
    },
    end() {
      this.ended = true
    },
  })
  const events = (res) =>
    res.out
      .join('')
      .split('\n\n')
      .filter(Boolean)
      .map((b) => {
        const [e, d] = b.split('\n')
        return { event: e.slice(7), data: JSON.parse(d.slice(6)) }
      })
  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`
  const delta = (d, finish = null) => sse({ choices: [{ delta: d, finish_reason: finish }] })
  const DONE = 'data: [DONE]\n\n'
  async function* feed(...items) {
    for (const i of items) {
      if (i instanceof Error) throw i
      yield i
    }
  }
  async function relay(items, opts = {}) {
    const res = fakeRes()
    const usage = []
    await relayOpenAiStreamToAnthropic(feed(...items), res, { requestedModel: 'm', onUsage: (u) => usage.push(u), ...opts })
    return { res, ev: events(res), usage }
  }
  const toolStart = (index, id, name, args = '') => delta({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }] })
  const toolArgs = (index, args, name) => delta({ tool_calls: [{ index, function: { ...(name ? { name } : {}), arguments: args } }] })
  const stopReason = (ev) => ev.find((e) => e.event === 'message_delta')?.data.delta.stop_reason
  const toolBlocks = (ev) => ev.filter((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')

  test('a tool call whose chunks repeat the function name stays ONE tool_use block', async () => {
    const { ev } = await relay([toolStart(0, 'c1', 'Bash'), toolArgs(0, '{"command":', 'Bash'), toolArgs(0, '"ls"}', 'Bash'), delta({}, 'tool_calls'), DONE])
    assert.equal(toolBlocks(ev).length, 1)
    const json = ev
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => e.data.delta.partial_json)
      .join('')
    assert.deepEqual(JSON.parse(json), { command: 'ls' })
    assert.equal(stopReason(ev), 'tool_use')
  })

  test('parallel tool calls (index 0 and 1) become two tool_use blocks', async () => {
    const { ev } = await relay([toolStart(0, 'c1', 'Read', '{"a":1}'), toolStart(1, 'c2', 'Glob', '{"b":2}'), delta({}, 'tool_calls'), DONE])
    assert.deepEqual(
      toolBlocks(ev).map((e) => [e.data.content_block.id, e.data.content_block.name]),
      [
        ['c1', 'Read'],
        ['c2', 'Glob'],
      ],
    )
  })

  test('tool call ids are unique even when the provider sends none', async () => {
    const { ev } = await relay([
      delta({ tool_calls: [{ index: 0, function: { name: 'A', arguments: '{}' } }] }),
      delta({ tool_calls: [{ index: 1, function: { name: 'B', arguments: '{}' } }] }),
      delta({}, 'tool_calls'),
      DONE,
    ])
    const ids = toolBlocks(ev).map((e) => e.data.content_block.id)
    assert.equal(ids.length, 2)
    assert.equal(new Set(ids).size, 2)
  })

  test('stop_reason follows finish_reason: length → max_tokens, even mid tool call', async () => {
    const { ev } = await relay([toolStart(0, 'c1', 'Write', '{"content":"abc'), delta({}, 'length'), DONE])
    assert.equal(stopReason(ev), 'max_tokens')
  })

  test('a provider that says "stop" after tool calls still gets tool_use', async () => {
    const { ev } = await relay([toolStart(0, 'c1', 'Bash', '{}'), delta({}, 'stop'), DONE])
    assert.equal(stopReason(ev), 'tool_use')
  })

  test('plain answers end with end_turn', async () => {
    const { ev } = await relay([delta({ content: 'hi' }), delta({}, 'stop'), DONE])
    assert.equal(stopReason(ev), 'end_turn')
    assert.equal(ev.at(-1).event, 'message_stop')
  })

  test('the client sees an input-token estimate (so it can auto-compact); billing keeps the real count', async () => {
    const { ev, usage } = await relay([delta({ content: 'hi' }), delta({}, 'stop'), DONE], { inputEstimate: 4321 })
    assert.equal(ev[0].data.message.usage.input_tokens, 4321)
    assert.equal(ev.find((e) => e.event === 'message_delta').data.usage.input_tokens, 4321)
    assert.equal(usage[0].input_tokens, 0, 'no real usage from the provider: billing is unchanged')
  })

  test('real usage from the provider wins over the estimate in message_delta and billing', async () => {
    const { ev, usage } = await relay(
      [delta({ content: 'hi' }), sse({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 7 } }), delta({}, 'stop'), DONE],
      { inputEstimate: 4321 },
    )
    assert.equal(ev.find((e) => e.event === 'message_delta').data.usage.input_tokens, 900)
    assert.equal(usage[0].input_tokens, 900)
  })

  test('a stream cut off without a finish ends with an error event, not a fake clean ending', async () => {
    const { res, ev, usage } = await relay([delta({ content: 'partial' })])
    assert.equal(ev.at(-1).event, 'error')
    assert.equal(ev.at(-1).data.error.type, 'api_error')
    assert.ok(!ev.some((e) => e.event === 'message_stop'))
    assert.ok(res.ended)
    assert.equal(usage.length, 1, 'what was produced is still accounted for, once')
  })

  test('a connection that breaks mid-stream becomes an error event and never throws', async () => {
    const boom = Object.assign(new Error('terminated'), { cause: { code: 'UND_ERR_SOCKET' } })
    const { res, ev, usage } = await relay([delta({ content: 'partial' }), boom])
    assert.equal(ev.at(-1).event, 'error')
    assert.match(ev.at(-1).data.error.message, /UND_ERR_SOCKET/)
    assert.ok(res.ended)
    assert.equal(usage.length, 1)
  })

  test('a multi-byte character split across two network chunks arrives intact', async () => {
    const line = Buffer.from(delta({ content: 'Xin chào Việt Nam' }))
    const cut = line.indexOf(Buffer.from('à')) + 1 // in the middle of the 2-byte "à"
    const { ev } = await relay([line.subarray(0, cut), line.subarray(cut), Buffer.from(delta({}, 'stop')), Buffer.from(DONE)])
    const text = ev
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => e.data.delta.text)
      .join('')
    assert.equal(text, 'Xin chào Việt Nam')
  })
})

describe('NVIDIA adapter: non-streamed answer', () => {
  const toolCall = { id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }
  const answer = (finish, message) => openAiToAnthropic({ id: 'chatcmpl-1', choices: [{ finish_reason: finish, message }], usage: { prompt_tokens: 3, completion_tokens: 4 } }, 'm')

  test('a tool call is tool_use even when the provider says "stop"', () => {
    assert.equal(answer('stop', { content: null, tool_calls: [toolCall] }).stop_reason, 'tool_use')
  })

  test('a cut-off answer is max_tokens; a plain one is end_turn', () => {
    assert.equal(answer('length', { content: 'abc' }).stop_reason, 'max_tokens')
    assert.equal(answer('stop', { content: 'abc' }).stop_reason, 'end_turn')
  })
})

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { anthropicToOpenAi, requestShape } from '../src/nvidia.js'

const base = { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }
const tool = { name: 'verdict', description: 'Return the verdict', input_schema: { type: 'object', properties: { ok: { type: 'boolean' } } } }

describe('NVIDIA adapter: request conversion', () => {
  test('a request without "stream" is not streamed (Anthropic default)', () => {
    assert.equal(anthropicToOpenAi(base).stream, false)
    assert.equal(anthropicToOpenAi({ ...base, stream: false }).stream, false)
    assert.equal(anthropicToOpenAi({ ...base, stream: true }).stream, true)
  })

  test('tool_choice is mapped to the OpenAI form', () => {
    const conv = (tool_choice) => anthropicToOpenAi({ ...base, tools: [tool], tool_choice })
    assert.equal(conv({ type: 'auto' }).tool_choice, 'auto')
    assert.equal(conv({ type: 'any' }).tool_choice, 'required')
    assert.equal(conv({ type: 'none' }).tool_choice, 'none')
    assert.deepEqual(conv({ type: 'tool', name: 'verdict' }).tool_choice, { type: 'function', function: { name: 'verdict' } })
    assert.equal(conv(undefined).tool_choice, undefined)
  })

  test('disable_parallel_tool_use turns off parallel tool calls', () => {
    const p = anthropicToOpenAi({ ...base, tools: [tool], tool_choice: { type: 'tool', name: 'verdict', disable_parallel_tool_use: true } })
    assert.equal(p.parallel_tool_calls, false)
    assert.equal(anthropicToOpenAi({ ...base, tools: [tool], tool_choice: { type: 'auto' } }).parallel_tool_calls, undefined)
  })

  test('stop_sequences become "stop" (OpenAI accepts at most 4)', () => {
    assert.deepEqual(anthropicToOpenAi({ ...base, stop_sequences: ['</a>'] }).stop, ['</a>'])
    assert.deepEqual(anthropicToOpenAi({ ...base, stop_sequences: ['1', '2', '3', '4', '5'] }).stop, ['1', '2', '3', '4'])
    assert.equal(anthropicToOpenAi({ ...base, stop_sequences: [] }).stop, undefined)
    assert.equal(anthropicToOpenAi(base).stop, undefined)
  })

  test('a JSON schema output format becomes response_format', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
    const expected = { type: 'json_schema', json_schema: { name: 'output', schema, strict: true } }
    assert.deepEqual(anthropicToOpenAi({ ...base, output_config: { format: { type: 'json_schema', schema } } }).response_format, expected)
    assert.deepEqual(anthropicToOpenAi({ ...base, output_format: { type: 'json_schema', schema } }).response_format, expected)
    assert.equal(anthropicToOpenAi(base).response_format, undefined)
  })
})

describe('NVIDIA adapter: request shape for the log', () => {
  test('describes the request without any of its content', () => {
    const shape = requestShape({
      ...base,
      system: 'SECRET SYSTEM',
      messages: [{ role: 'user', content: 'SECRET PROMPT' }],
      tools: [tool],
      tool_choice: { type: 'tool', name: 'verdict' },
      stop_sequences: ['x'],
    })
    assert.equal(shape, 'model=claude-sonnet-5-5 stream=false max_tokens=100 tools=1 tool_choice=tool:verdict stop=1 format=none')
    assert.doesNotMatch(shape, /SECRET/)
  })
})

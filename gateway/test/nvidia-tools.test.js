import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { anthropicToOpenAi, hasImages, onlyServerTools } from '../src/nvidia.js'

const base = { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }
const custom = { name: 'Bash', description: 'run', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }
const webSearch = { type: 'web_search_20250305', name: 'web_search', max_uses: 8 }

describe('hasImages', () => {
  const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  test('finds an image in a user message', () => {
    assert.equal(hasImages({ messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, png] }] }), true)
  })
  test('finds an image inside a tool_result (a screenshot) anywhere in the history', () => {
    const msgs = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Screenshot', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }, png] }] },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'thanks' },
    ]
    assert.equal(hasImages({ messages: msgs }), true)
  })
  test('is false for text only, and for a body without messages', () => {
    assert.equal(hasImages({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'yo' }] }] }), false)
    assert.equal(hasImages({}), false)
  })
})

describe('server tools', () => {
  test('a request whose only tools run on Anthropic\'s servers (web search) cannot be served by NVIDIA', () => {
    assert.equal(onlyServerTools({ ...base, tools: [webSearch] }), true)
    assert.equal(onlyServerTools({ ...base, tools: [webSearch, { type: 'web_fetch_20250910', name: 'web_fetch' }] }), true)
  })
  test('requests with a normal tool, or with no tools, can', () => {
    assert.equal(onlyServerTools({ ...base, tools: [custom] }), false)
    assert.equal(onlyServerTools({ ...base, tools: [custom, webSearch] }), false)
    assert.equal(onlyServerTools(base), false)
    assert.equal(onlyServerTools({ ...base, tools: [] }), false)
  })
  test('next to normal tools, a server tool is left out instead of being sent as an empty function', () => {
    const p = anthropicToOpenAi({ ...base, tools: [custom, webSearch] })
    assert.deepEqual(p.tools.map((t) => t.function.name), ['Bash'])
  })
  test('with no usable tool left, no tools are sent at all', () => {
    const p = anthropicToOpenAi({ ...base, tools: [webSearch], tool_choice: { type: 'auto' } })
    assert.equal(p.tools, undefined)
    assert.equal(p.tool_choice, undefined)
  })
})

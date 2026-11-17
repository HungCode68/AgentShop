/**
 * Relays an OpenAI chat-completions SSE stream (NVIDIA NIM) to the client as Anthropic SSE events,
 * the way Claude Code / Claude Desktop expect them from /v1/messages.
 *
 * What an agent needs from this stream, and what this file takes care of:
 *  - Tool calls arrive intact: one tool_use block per call, found by the provider's `index`
 *    (providers that repeat the function name on every chunk, or send no id, still give one block).
 *  - stop_reason is truthful: "tool_use" when a tool was called, "max_tokens" when the answer was cut
 *    off (so half a tool call is never run), "end_turn" otherwise.
 *  - The client sees how big the conversation is (input_tokens, estimated when the provider reports
 *    none), so Claude Code can auto-compact a long session. Billing still uses the provider's real
 *    numbers only, see onUsage.
 *  - A stream that breaks or ends early becomes a proper `error` event, never a fake clean ending
 *    and never an exception that would send the same request to another provider mid-answer.
 */

/** Output tokens are counted per streamed delta when the provider reports no usage. */
const COUNTED_TOKENS_PER_DELTA = 1

/**
 * Drops lines that are only a horizontal rule ("---") from streamed text; the NVIDIA models put them between
 * every section. Code blocks are left alone. Text may arrive in pieces of any size, so a line that could still
 * turn out to be a rule is held back until it is known.
 */
export function makeRuleFilter() {
  let pending = '' // start of the current line while it is only dashes and spaces
  let pass = false // the current line is already known not to be a rule
  let head = '' // first characters of the current line, to notice code fences
  let fence = false
  const isRule = (s) => /^ {0,3}-{3,}[ \t]*$/.test(s)
  const endLine = () => {
    if (head.startsWith('```')) fence = !fence
    head = ''
  }
  return {
    push(text) {
      let out = ''
      for (const ch of text) {
        if (!pass) {
          if (ch === '-' || ch === ' ') {
            pending += ch
            continue
          }
          if (ch === '\n') {
            if (fence || !isRule(pending)) out += `${pending}\n`
            pending = ''
            head = ''
            continue
          }
          out += pending
          head = pending.trimStart()
          pending = ''
          pass = true
        }
        out += ch
        if (head.length < 3) head += ch
        if (ch === '\n') {
          endLine()
          pass = false
        }
      }
      return out
    },
    /** The end of the text: whatever is still held back. */
    flush() {
      const rest = !fence && isRule(pending) ? '' : pending
      pending = ''
      return rest
    },
  }
}

const stopReasonOf =(finishReason, sawToolUse) => {
  if (finishReason === 'length') return 'max_tokens'
  return sawToolUse ? 'tool_use' : 'end_turn'
}

/**
 * @param {AsyncIterable<Uint8Array|string>} openAiChunks  body of the provider's streamed response
 * @param {import('node:http').ServerResponse} res  headers already written
 * @param {{requestedModel: string, inputEstimate?: number, onUsage?: (usage: object) => void}} opts
 *   inputEstimate: input tokens shown to the client when the provider reports none.
 *   onUsage: called exactly once, at the end (also after a broken stream), with the usage to bill:
 *            the provider's real numbers, or output counted from the stream and input 0.
 */
export async function relayOpenAiStreamToAnthropic(openAiChunks, res, { requestedModel, onUsage, inputEstimate = 0 } = {}) {
  const stamp = Date.now()
  const decoder = new TextDecoder()
  let buffer = ''
  let blockType = null // type of the open content block, null = none open
  let blockIndex = 0
  let toolIndex = null // the provider's index of the open tool call
  let toolId = null
  let toolCount = 0
  let sawToolUse = false
  let finishReason = null
  let sawDone = false
  let reportedInput // from the provider's usage, undefined until it reports
  let reportedOutput
  let countedOutput = 0
  let rules = makeRuleFilter()

  const send = (event, data) => {
    if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const closeBlock = () => {
    if (blockType === null) return
    if (blockType === 'text') {
      const rest = rules.flush()
      if (rest) blockDelta({ type: 'text_delta', text: rest })
    }
    send('content_block_stop', { type: 'content_block_stop', index: blockIndex })
    blockType = null
    blockIndex++
  }
  const openBlock = (type, contentBlock) => {
    closeBlock()
    blockType = type
    send('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: contentBlock })
  }
  const blockDelta = (delta) => send('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta })

  send('message_start', {
    type: 'message_start',
    message: {
      id: `msg_nvidia_${stamp}`,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputEstimate, output_tokens: 0 },
    },
  })

  const handleToolCall = (tc) => {
    const idx = Number.isInteger(tc.index) ? tc.index : null
    // The same call continues while its index (or, without an index, its id) does not change.
    const continues = blockType === 'tool_use' && (idx !== null ? idx === toolIndex : !tc.id || tc.id === toolId)
    if (!continues) {
      toolCount++
      toolIndex = idx
      toolId = tc.id || `toolu_nv_${stamp}_${toolCount}`
      sawToolUse = true
      openBlock('tool_use', { type: 'tool_use', id: toolId, name: tc.function?.name || '', input: {} })
    }
    const a = tc.function?.arguments
    const args = typeof a === 'string' ? a : a != null ? JSON.stringify(a) : ''
    if (args) {
      blockDelta({ type: 'input_json_delta', partial_json: args })
      countedOutput += COUNTED_TOKENS_PER_DELTA
    }
  }

  const handleLine = (line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (data === '[DONE]') {
      sawDone = true
      return
    }
    let chunk
    try {
      chunk = JSON.parse(data)
    } catch {
      return
    }
    if (chunk.usage) {
      reportedInput = chunk.usage.prompt_tokens ?? reportedInput
      reportedOutput = chunk.usage.completion_tokens ?? reportedOutput
    }
    const choice = chunk.choices?.[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    const delta = choice?.delta
    if (!delta) return

    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (reasoning) {
      if (blockType !== 'thinking') openBlock('thinking', { type: 'thinking', thinking: '' })
      blockDelta({ type: 'thinking_delta', thinking: reasoning })
      countedOutput += COUNTED_TOKENS_PER_DELTA
    }
    if (delta.content) {
      if (blockType !== 'text') {
        rules = makeRuleFilter()
        openBlock('text', { type: 'text', text: '' })
      }
      const shown = rules.push(delta.content)
      if (shown) blockDelta({ type: 'text_delta', text: shown })
      countedOutput += COUNTED_TOKENS_PER_DELTA
    }
    if (Array.isArray(delta.tool_calls)) for (const tc of delta.tool_calls) handleToolCall(tc)
  }

  const drainLines = () => {
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // the last line may be incomplete
    for (const line of lines) handleLine(line)
  }

  let failure = null
  try {
    for await (const raw of openAiChunks) {
      if (res.destroyed) break
      // A streaming decoder: a multi-byte character (Vietnamese!) split across two network chunks stays whole.
      buffer += (typeof raw === 'string' ? raw : decoder.decode(raw, { stream: true })).replace(/\r\n/g, '\n')
      drainLines()
      // A client that cannot keep up: stop reading from NVIDIA until it has caught up, so many slow
      // connections cannot pile up unsent text in memory.
      if (res.writableNeedDrain) await new Promise((resolve) => res.once('drain', resolve).once('close', resolve))
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n')
    drainLines()
    handleLine(buffer)
  } catch (err) {
    failure = err
  }

  const outputTokens = reportedOutput ?? countedOutput
  if (!res.destroyed) {
    if (failure || !(sawDone || finishReason)) {
      const code = failure?.cause?.code ?? failure?.code ?? failure?.name
      send('error', {
        type: 'error',
        error: {
          type: 'api_error',
          message: failure
            ? `Connection to the upstream provider was lost mid-response (${code}). Please retry.`
            : 'The upstream response ended before it was complete. Please retry.',
        },
      })
    } else {
      closeBlock()
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReasonOf(finishReason, sawToolUse), stop_sequence: null },
        usage: { input_tokens: reportedInput ?? inputEstimate, output_tokens: outputTokens },
      })
      send('message_stop', { type: 'message_stop' })
    }
    res.end()
  }

  onUsage?.({
    input_tokens: reportedInput ?? 0,
    output_tokens: outputTokens,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
}

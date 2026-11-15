/**
 * NVIDIA NIM adapter: converts Anthropic Messages API format (/v1/messages)
 * to NVIDIA OpenAI-compatible format (/v1/chat/completions) and streams back
 * Anthropic SSE events to the client.
 */

export const DEFAULT_NVIDIA_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b'

/**
 * Transforms an Anthropic Messages request into an OpenAI Chat Completion request.
 */
export function anthropicToOpenAi(request, targetModel = DEFAULT_NVIDIA_MODEL) {
  const messages = []

  // 1. System prompt: Anthropic sends it as top-level `system` (string or array of text blocks)
  if (request.system) {
    let systemText = ''
    if (typeof request.system === 'string') {
      systemText = request.system
    } else if (Array.isArray(request.system)) {
      systemText = request.system.map((s) => (typeof s === 'string' ? s : s?.text || '')).join('\n')
    }
    if (systemText.trim()) {
      messages.push({ role: 'system', content: systemText })
    }
  }

  // 2. Messages: convert user/assistant/tool messages
  if (Array.isArray(request.messages)) {
    for (const msg of request.messages) {
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content })
        continue
      }

      if (Array.isArray(msg.content)) {
        // Check if there are tool_use or tool_result blocks
        const toolResults = msg.content.filter((b) => b?.type === 'tool_result')
        const toolUses = msg.content.filter((b) => b?.type === 'tool_use')
        const textBlocks = msg.content.filter((b) => b?.type === 'text')
        const imageBlocks = msg.content.filter((b) => b?.type === 'image')

        // Case A: tool_result blocks (from client tool execution)
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            let resContent = ''
            if (typeof tr.content === 'string') {
              resContent = tr.content
            } else if (Array.isArray(tr.content)) {
              resContent = tr.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n')
            }
            messages.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id,
              content: resContent || 'Success',
            })
          }
          continue
        }

        // Case B: assistant message containing tool_use blocks
        if (msg.role === 'assistant' && toolUses.length > 0) {
          const textContent = textBlocks.map((t) => t.text).join('\n')
          const toolCalls = toolUses.map((tu) => ({
            id: tu.id,
            type: 'function',
            function: {
              name: tu.name,
              arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input ?? {}),
            },
          }))
          messages.push({
            role: 'assistant',
            content: textContent || null,
            tool_calls: toolCalls,
          })
          continue
        }

        // Case C: multimodal content (text + images)
        const parts = []
        for (const part of msg.content) {
          if (part.type === 'text') {
            parts.push({ type: 'text', text: part.text })
          } else if (part.type === 'image') {
            const mediaType = part.source?.media_type || 'image/png'
            const data = part.source?.data || ''
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${mediaType};base64,${data}` },
            })
          }
        }
        messages.push({ role: msg.role, content: parts.length > 0 ? parts : '' })
      }
    }
  }

  // 3. Tools conversion
  let tools = undefined
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    tools = request.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }))
  }

  const payload = {
    model: targetModel,
    messages,
    stream: request.stream !== false, // Always true for Claude Desktop/Code unless explicitly false
    temperature: typeof request.temperature === 'number' ? request.temperature : 0.7,
  }

  if (Number.isFinite(request.max_tokens)) {
    payload.max_tokens = request.max_tokens
  }
  if (tools) {
    payload.tools = tools
  }

  return payload
}

/**
 * Transforms an OpenAI non-stream response into an Anthropic Messages format.
 */
export function openAiToAnthropic(openAiRes, requestedModel) {
  const choice = openAiRes.choices?.[0] || {}
  const msg = choice.message || {}
  const content = []

  // Reasoning content if available
  if (msg.reasoning_content) {
    content.push({
      type: 'thinking',
      thinking: msg.reasoning_content,
      signature: '',
    })
  }

  // Standard text content
  if (msg.content) {
    content.push({
      type: 'text',
      text: msg.content,
    })
  }

  // Tool calls
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let parsedInput = {}
      try {
        parsedInput = JSON.parse(tc.function?.arguments || '{}')
      } catch {
        parsedInput = { raw: tc.function?.arguments }
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name,
        input: parsedInput,
      })
    }
  }

  let stopReason = 'end_turn'
  if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use'
  else if (choice.finish_reason === 'length') stopReason = 'max_tokens'

  return {
    id: openAiRes.id ? `msg_${openAiRes.id.replace(/^chatcmpl-/, '')}` : `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openAiRes.usage?.prompt_tokens ?? 0,
      output_tokens: openAiRes.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }
}

/**
 * Streams an OpenAI SSE response chunk by chunk, converting events into Anthropic SSE format.
 */
export async function relayOpenAiStreamToAnthropic(openAiChunks, res, { requestedModel, onUsage }) {
  const msgId = `msg_nvidia_${Date.now()}`
  let buffer = ''
  let sentMessageStart = false
  let sentContentBlockStart = false
  let currentBlockType = null // 'thinking' | 'text' | 'tool_use'
  let currentBlockIndex = 0
  let currentToolId = null
  let currentToolName = null
  let totalInputTokens = 0
  let totalOutputTokens = 0

  const sendEvent = (event, data) => {
    if (res.destroyed) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  // 1. Send initial message_start event
  sendEvent('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
  sentMessageStart = true

  const closeCurrentBlock = () => {
    if (sentContentBlockStart) {
      sendEvent('content_block_stop', {
        type: 'content_block_stop',
        index: currentBlockIndex,
      })
      sentContentBlockStart = false
      currentBlockIndex++
    }
  }

  for await (const rawChunk of openAiChunks) {
    if (res.destroyed) break
    buffer += Buffer.isBuffer(rawChunk) ? rawChunk.toString('utf8') : String(rawChunk)

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // keep remainder

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data:')) continue
      const dataStr = trimmed.slice(5).trim()
      if (dataStr === '[DONE]') continue

      let chunk
      try {
        chunk = JSON.parse(dataStr)
      } catch {
        continue
      }

      if (chunk.usage) {
        totalInputTokens = chunk.usage.prompt_tokens ?? totalInputTokens
        totalOutputTokens = chunk.usage.completion_tokens ?? totalOutputTokens
      }

      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue

      // Case 1: Reasoning content (thinking block)
      if (delta.reasoning_content) {
        if (!sentContentBlockStart || currentBlockType !== 'thinking') {
          closeCurrentBlock()
          currentBlockType = 'thinking'
          sendEvent('content_block_start', {
            type: 'content_block_start',
            index: currentBlockIndex,
            content_block: { type: 'thinking', thinking: '' },
          })
          sentContentBlockStart = true
        }
        sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: currentBlockIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        })
        totalOutputTokens += 1
      }

      // Case 2: Regular text content
      if (delta.content) {
        if (!sentContentBlockStart || currentBlockType !== 'text') {
          closeCurrentBlock()
          currentBlockType = 'text'
          sendEvent('content_block_start', {
            type: 'content_block_start',
            index: currentBlockIndex,
            content_block: { type: 'text', text: '' },
          })
          sentContentBlockStart = true
        }
        sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: currentBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        })
        totalOutputTokens += 1
      }

      // Case 3: Tool calls
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (tc.id || tc.function?.name) {
            closeCurrentBlock()
            currentBlockType = 'tool_use'
            currentToolId = tc.id || `tool_${Date.now()}`
            currentToolName = tc.function?.name || ''
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: currentBlockIndex,
              content_block: {
                type: 'tool_use',
                id: currentToolId,
                name: currentToolName,
                input: {},
              },
            })
            sentContentBlockStart = true
          }
          if (tc.function?.arguments) {
            sendEvent('content_block_delta', {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: tc.function.arguments,
              },
            })
            totalOutputTokens += 1
          }
        }
      }
    }
  }

  // Close any open block
  closeCurrentBlock()

  // Send message_delta with final stop_reason
  sendEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: currentBlockType === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: totalOutputTokens },
  })

  // Send message_stop
  sendEvent('message_stop', { type: 'message_stop' })

  if (onUsage) {
    onUsage({
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  }

  res.end()
}

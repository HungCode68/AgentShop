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
  if (Array.isArray(request.messages)) convertMessages(request.messages, messages)

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
    // Anthropic streams only when asked: a request without "stream" expects one JSON answer.
    // Claude Code's side requests (e.g. auto mode's safety check) rely on this.
    stream: request.stream === true,
    temperature: typeof request.temperature === 'number' ? request.temperature : 0.7,
  }

  if (Number.isFinite(request.max_tokens)) {
    payload.max_tokens = request.max_tokens
  }
  if (tools) {
    payload.tools = tools
    const choice = toolChoice(request.tool_choice)
    if (choice !== undefined) payload.tool_choice = choice
    if (request.tool_choice?.disable_parallel_tool_use === true) payload.parallel_tool_calls = false
  }
  if (Array.isArray(request.stop_sequences) && request.stop_sequences.length > 0) {
    payload.stop = request.stop_sequences.slice(0, 4) // OpenAI accepts at most 4
  }
  const format = outputFormat(request)
  if (format?.type === 'json_schema' && format.schema) {
    payload.response_format = { type: 'json_schema', json_schema: { name: 'output', schema: format.schema, strict: true } }
  }

  // 4. Map Thinking / Effort
  if (request.thinking && typeof request.thinking === 'object') {
    if (request.thinking.type === 'enabled') {
      const budget = request.thinking.budget_tokens || 2048
      if (budget <= 2048) {
        payload.reasoning_effort = 'low'
      } else if (budget <= 8192) {
        payload.reasoning_effort = 'medium'
      } else {
        payload.reasoning_effort = 'high'
      }
      // Đảm bảo max_tokens của NVIDIA đủ lớn để chứa cả thinking budget và câu trả lời
      if (payload.max_tokens && payload.max_tokens < budget + 1024) {
        payload.max_tokens = budget + 2048
      }
    }
  }

  return payload
}

const textOf = (blocks) => blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')

const imagePart = (b) => ({
  type: 'image_url',
  image_url: { url: b.source?.type === 'url' ? b.source.url : `data:${b.source?.media_type || 'image/png'};base64,${b.source?.data || ''}` },
})

/** A tool_result's text and images (its content is a string, or a list of blocks). */
function toolResultParts(tr) {
  if (typeof tr.content === 'string') return { text: tr.content, images: [] }
  const blocks = Array.isArray(tr.content) ? tr.content : []
  return {
    text: blocks.map((c) => (typeof c === 'string' ? c : c?.type === 'image' ? '' : c?.text || '')).filter(Boolean).join('\n'),
    images: blocks.filter((c) => c?.type === 'image').map(imagePart),
  }
}

/**
 * Anthropic messages → OpenAI messages, appended to `out`. What an agent loop depends on:
 * every tool_result becomes a `tool` message; text and images that came with the results (a screenshot,
 * a note from the user) are kept, as a user message right after, because `tool` messages carry text only.
 */
function convertMessages(src, out) {
  for (const msg of src) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content })
      continue
    }
    if (!Array.isArray(msg.content)) continue
    const blocks = msg.content
    const toolResults = blocks.filter((b) => b?.type === 'tool_result')
    const toolUses = blocks.filter((b) => b?.type === 'tool_use')
    const text = textOf(blocks)
    const images = blocks.filter((b) => b?.type === 'image').map(imagePart)

    if (toolResults.length > 0) {
      const resultImages = []
      for (const tr of toolResults) {
        const { text: t, images: imgs } = toolResultParts(tr)
        resultImages.push(...imgs)
        let content = t || (imgs.length ? '(image attached in the next message)' : 'Success')
        if (tr.is_error) content = /^error/i.test(t) ? t : `Error: ${t || 'the tool call failed'}`
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content })
      }
      const allImages = [...resultImages, ...images]
      if (allImages.length) out.push({ role: 'user', content: [...(text ? [{ type: 'text', text }] : []), ...allImages] })
      else if (text) out.push({ role: 'user', content: text })
      continue
    }

    if (msg.role === 'assistant') {
      if (toolUses.length > 0) {
        out.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolUses.map((tu) => ({
            id: tu.id,
            type: 'function',
            function: { name: tu.name, arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input ?? {}) },
          })),
        })
      } else if (text) {
        out.push({ role: 'assistant', content: text }) // a thinking-only turn has nothing to send
      }
      continue
    }

    if (images.length) {
      const parts = []
      for (const b of blocks) {
        if (b?.type === 'text') parts.push({ type: 'text', text: b.text })
        else if (b?.type === 'image') parts.push(imagePart(b))
      }
      out.push({ role: msg.role, content: parts })
    } else if (text) {
      out.push({ role: msg.role, content: text })
    }
  }
}

/** Anthropic tool_choice → OpenAI tool_choice (undefined = leave the provider default). */
function toolChoice(tc) {
  switch (tc?.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return tc.name ? { type: 'function', function: { name: tc.name } } : 'required'
    default:
      return undefined
  }
}

/** Structured output request (output_config.format, or the older top-level output_format). */
const outputFormat = (request) => request.output_config?.format ?? request.output_format

/**
 * One-line description of a request for the log: which features it uses, never its content
 * (no prompt, system or tool text), so side requests that misbehave on NVIDIA can be identified.
 */
export function requestShape(request) {
  const tc = request.tool_choice
  const choice = !tc ? 'none' : tc.type === 'tool' ? `tool:${tc.name}` : tc.type
  return [
    `model=${request.model}`,
    `stream=${request.stream === true}`,
    `max_tokens=${request.max_tokens ?? '-'}`,
    `tools=${Array.isArray(request.tools) ? request.tools.length : 0}`,
    `tool_choice=${choice}`,
    `stop=${Array.isArray(request.stop_sequences) ? request.stop_sequences.length : 0}`,
    `format=${outputFormat(request)?.type ?? 'none'}`,
  ].join(' ')
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
  if (choice.finish_reason === 'length') stopReason = 'max_tokens'
  else if (choice.finish_reason === 'tool_calls' || content.some((b) => b.type === 'tool_use')) stopReason = 'tool_use'

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

export { relayOpenAiStreamToAnthropic } from './nvidia-stream.js'

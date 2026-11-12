/**
 * Relays an Anthropic-style SSE stream (POST /v1/messages with stream: true) from agentshop to the
 * client, event by event, fixing what agentshop gets wrong for Claude Code:
 *
 *  - Truncated answers labelled as finished. agentshop applies its own output limit (it rounds the
 *    requested max_tokens up to a power of two and caps it at 16384) and, when the answer hits it,
 *    still reports stop_reason "end_turn". Claude Code then believes the turn is complete and stops
 *    mid-task. Such endings are relabelled "max_tokens", the truthful value.
 *  - Long silences. agentshop sends no `ping` events and can go quiet for a minute (e.g. while a big
 *    tool call is generated). A ping is sent to the client after `pingMs` without upstream events,
 *    so nothing between the client and the gateway treats the connection as dead.
 *  - Streams that break mid-answer. Instead of a silent, cut-off response, the client receives a
 *    proper `error` event, so Claude Code reports the failure instead of acting on half an answer.
 */

/** agentshop never lets an answer run past this many output tokens. */
export const AGENTSHOP_OUTPUT_CAP = 16384
const isPow2 = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0

/**
 * True when an "end_turn" answer actually stopped at agentshop's output limit.
 * The limit is a power of two at or above min(requested max_tokens, 16384); a natural ending that
 * lands exactly on such a count is vanishingly unlikely, which keeps false positives near zero.
 */
export function looksTruncated(stopReason, outputTokens, requestedMax) {
  if (stopReason !== 'end_turn' || !isPow2(outputTokens) || outputTokens < 1024) return false
  const asked = Number.isFinite(requestedMax) && requestedMax > 0 ? requestedMax : AGENTSHOP_OUTPUT_CAP
  return outputTokens >= Math.min(asked, AGENTSHOP_OUTPUT_CAP)
}

const PING = 'event: ping\ndata: {"type": "ping"}\n\n'
const errorEvent = (message) =>
  `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`

/** True when a usage object reports no input at all (agentshop always does). */
const reportsNoInput = (u) =>
  !!u && !(u.input_tokens > 0) && !(u.cache_read_input_tokens > 0) && !(u.cache_creation_input_tokens > 0)

/**
 * Fills in an estimated input_tokens where upstream reported none, so Claude Code can see how big
 * the conversation is and auto-compact it. Returns true when the usage object was changed.
 */
export function fillInputTokens(usage, inputEstimate) {
  if (!(inputEstimate > 0) || !reportsNoInput(usage) || !('input_tokens' in usage)) return false
  usage.input_tokens = inputEstimate
  return true
}

/** Rewrites one complete SSE event if needed. Returns [text to send, info]. */
function processEvent(event, { requestedMax, inputEstimate }) {
  const lines = event.split('\n')
  const i = lines.findIndex((l) => l.startsWith('data:'))
  if (i < 0) return [event, null]
  const data = lines[i].slice(5).trim()
  if (data.includes('"message_stop"')) return [event, { stop: true }]
  if (data.includes('"type":"error"') || data.includes('"type": "error"')) return [event, { error: true }]
  // Generated content: counted only to estimate output tokens if the stream breaks before the final usage.
  if (data.includes('"content_block_delta"')) return [event, { contentChars: data.length }]
  const isStart = data.includes('"message_start"')
  if (!isStart && !data.includes('"message_delta"')) return [event, null]
  let msg
  try {
    msg = JSON.parse(data)
  } catch {
    return [event, null]
  }
  const info = {}
  if (msg.type === 'message_start') {
    if (fillInputTokens(msg.message?.usage, inputEstimate)) info.filledInput = true
    info.usage = msg.message?.usage
  } else if (msg.type === 'message_delta') {
    if (fillInputTokens(msg.usage, inputEstimate)) info.filledInput = true
    const out = msg.usage?.output_tokens
    if (looksTruncated(msg.delta?.stop_reason, out, requestedMax)) {
      msg.delta.stop_reason = 'max_tokens'
      info.relabelled = out
    }
    info.usage = msg.usage
  }
  if (!info.filledInput && !info.relabelled) return [event, info]
  lines[i] = `data: ${JSON.stringify(msg)}`
  return [lines.join('\n'), info]
}

/**
 * @param {ReadableStream} upstreamBody  fetch() response body from agentshop
 * @param {import('node:http').ServerResponse} res  headers already written
 * @param {{requestedMax?: number, inputEstimate?: number, pingMs?: number, warn?: (msg: string) => void,
 *          onUsage?: (usage: object, info: {complete: boolean}) => void}} opts
 *   onUsage is called exactly once at the end with the answer's usage (Anthropic shape). When the stream
 *   broke before the final count, output_tokens is estimated from the content received (rounded up).
 */
export async function relayMessageStream(upstreamBody, res, { requestedMax, inputEstimate, pingMs = 15_000, warn = () => {}, onUsage } = {}) {
  const started = Date.now()
  const decoder = new TextDecoder()
  let pending = '' // start of an event whose end has not arrived yet
  let sawStop = false
  let sawError = false
  let timer
  const usage = {}
  let contentChars = 0

  const write = (text) =>
    res.write(text) ? Promise.resolve() : new Promise((resolve) => res.once('drain', resolve).once('close', resolve))
  const clientGone = () => res.destroyed || res.writableEnded
  const armPing = () => {
    clearTimeout(timer)
    if (!(pingMs > 0)) return
    timer = setTimeout(() => {
      // Only between events: a ping in the middle of a half-received event would corrupt it.
      if (!clientGone() && pending === '') res.write(PING)
      armPing()
    }, pingMs)
    timer.unref?.()
  }

  const flushEvents = async () => {
    let end
    while ((end = pending.indexOf('\n\n')) >= 0) {
      const event = pending.slice(0, end + 2)
      pending = pending.slice(end + 2)
      const [text, info] = processEvent(event, { requestedMax, inputEstimate })
      if (info?.stop) sawStop = true
      if (info?.error) sawError = true
      if (info?.usage) Object.assign(usage, info.usage)
      if (info?.contentChars) contentChars += info.contentChars
      if (info?.relabelled) {
        warn(`stream cut at the upstream's output limit (${info.relabelled} tokens) but labelled end_turn; sent max_tokens`)
      }
      await write(text)
    }
  }

  armPing()
  try {
    for await (const chunk of upstreamBody) {
      if (clientGone()) return
      // SSE allows CRLF; JSON payloads never contain raw newlines, so normalising is safe.
      pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
      await flushEvents()
      armPing()
    }
    pending += decoder.decode().replace(/\r\n/g, '\n')
    await flushEvents()
    if (pending && !clientGone()) await write(pending)
    if (!sawStop && !sawError && !clientGone()) {
      warn(`upstream stream ended without message_stop after ${Date.now() - started}ms`)
      await write(errorEvent('The upstream response ended before it was complete. Please retry.'))
    }
  } catch (err) {
    if (clientGone()) return
    const code = err?.cause?.code ?? err?.code ?? err?.name
    warn(`upstream stream broke after ${Date.now() - started}ms: ${code}`)
    if (!sawStop && !sawError) {
      // Half-received events are never forwarded, so the error event always starts on a clean boundary.
      await write(errorEvent(`Connection to the upstream provider was lost mid-response (${code}). Please retry.`))
    }
  } finally {
    clearTimeout(timer)
    if (!clientGone()) res.end()
    if (onUsage) {
      const final = { ...usage }
      if (!sawStop || !Number.isFinite(final.output_tokens)) final.output_tokens = Math.max(final.output_tokens ?? 0, Math.ceil(contentChars / 4))
      try {
        onUsage(final, { complete: sawStop })
      } catch (err) {
        warn(`usage accounting failed: ${err?.message ?? err}`)
      }
    }
  }
}

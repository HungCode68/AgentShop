/**
 * Rough input-token estimate for a /v1/messages request.
 *
 * agentshop reports usage.input_tokens = 0. Claude Code decides when to auto-compact a long
 * conversation from that number, so with 0 it never compacts: every turn resends an ever-growing
 * context and gets slower. The gateway fills in this estimate instead (only when upstream says 0).
 *
 * ~4 characters per token for text/JSON. Attachments are not counted by their base64 length
 * (a screenshot would otherwise look like 100k+ tokens and trigger compaction far too early):
 * a fixed cost per image / document is used instead.
 */
const CHARS_PER_TOKEN = 4
const IMAGE_TOKENS = 1600
const DOCUMENT_TOKENS = 3000

function countValue(v) {
  if (v == null) return 0
  if (typeof v === 'string') return v.length
  if (typeof v !== 'object') return String(v).length
  if (Array.isArray(v)) return v.reduce((n, x) => n + countValue(x), 0)
  // Attachments: fixed cost, never their base64 payload.
  if (v.type === 'image') return IMAGE_TOKENS * CHARS_PER_TOKEN
  if (v.type === 'document') return DOCUMENT_TOKENS * CHARS_PER_TOKEN
  let n = 0
  for (const [k, x] of Object.entries(v)) n += k.length + countValue(x)
  return n
}

/** @returns {number|undefined} estimated input tokens, or undefined when the body is not a messages request */
export function estimateInputTokens(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return undefined
  const chars = countValue(body.system) + countValue(body.tools) + countValue(body.messages)
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

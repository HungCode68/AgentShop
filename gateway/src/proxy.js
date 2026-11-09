import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readBody, sendJson } from './http.js'

/** Why a client key was rejected → [HTTP status, Anthropic error type, message]. */
const REJECTIONS = {
  missing: [401, 'authentication_error', 'API key is missing.'],
  invalid: [401, 'authentication_error', 'API key not found or unassigned.'],
  revoked: [403, 'permission_error', 'API key has been revoked.'],
  expired: [403, 'permission_error', 'API key has expired.'],
  unassigned: [403, 'permission_error', 'API key is not linked to an upstream account yet.'],
}
const UPSTREAM_INVALID = 'Upstream account is unavailable or expired. Please contact the administrator.'
const UPSTREAM_DOWN = 'Upstream service is unreachable.'

// Request headers never forwarded upstream (hop-by-hop, client identity, and the client's own credentials).
const DROP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding', 'cookie', 'origin', 'referer',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'authorization', 'x-api-key',
])
// Response headers not passed back (fetch already decoded the body; CORS and cookies are ours to decide).
const DROP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie',
  'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-expose-headers', 'access-control-max-age', 'vary',
])

function anthropicError(res, status, type, message) {
  sendJson(res, status, { type: 'error', error: { type, message } })
}

/** Claude Code / Anthropic SDKs send the key either as `x-api-key` or `Authorization: Bearer`. */
function extractClientKey(req) {
  const xKey = req.headers['x-api-key']
  if (xKey) return { key: String(xKey).trim(), via: 'x-api-key' }
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')
  if (m) return { key: m[1].trim(), via: 'bearer' }
  return null
}

/**
 * Calls the provider's check-usage endpoint with an upstream key.
 * @returns {Promise<{ok: true, data: object} | {ok: false, message: string}>}
 */
export async function fetchUpstreamUsage(upstreamKey, { config, fetchImpl }) {
  let body
  try {
    const upstream = await fetchImpl(`${config.upstreamBaseUrl}/proxy/check-usage?key=${encodeURIComponent(upstreamKey)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    body = await upstream.json()
  } catch {
    return { ok: false, message: UPSTREAM_DOWN }
  }
  if (!body?.success || !body.data) return { ok: false, message: UPSTREAM_INVALID }
  return { ok: true, data: body.data }
}

/**
 * GET /api/proxy/check-usage?key=<client key>
 * Looks up the mapped upstream key and returns the provider's usage data plus the client key's own expiry.
 */
export async function handleCheckUsage(req, res, url, { store, config, fetchImpl }) {
  const envelope = (status, message, data = null) => sendJson(res, status, { success: data !== null, message, data })

  const clientKey = url.searchParams.get('key')?.trim()
  if (!clientKey) return envelope(400, REJECTIONS.missing[2])

  const resolved = store.resolve(clientKey)
  if (!resolved.ok) {
    const [status, , message] = REJECTIONS[resolved.reason]
    return envelope(status, message)
  }
  res.keyId = resolved.record.id

  const usage = await fetchUpstreamUsage(resolved.upstreamKey, { config, fetchImpl })
  if (!usage.ok) return envelope(502, usage.message)

  return envelope(200, 'Success', {
    ...usage.data,
    keyName: resolved.record.name,
    keyExpiresAt: resolved.record.expiresAt,
  })
}

/**
 * Any other /api/proxy/* request (e.g. POST /api/proxy/v1/messages from Claude Code):
 * swap the client key for the upstream key and stream the provider's response back unchanged.
 */
export async function handleAiProxy(req, res, url, { store, config, fetchImpl }) {
  const found = extractClientKey(req)
  const resolved = found ? store.resolve(found.key) : { ok: false, reason: 'missing' }
  if (!resolved.ok) {
    const [status, type, message] = REJECTIONS[resolved.reason]
    return anthropicError(res, status, type, message)
  }
  res.keyId = resolved.record.id
  store.touch(resolved.record.id)

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const body = hasBody ? await readBody(req, config.maxBodyBytes) : undefined

  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (!DROP_REQUEST_HEADERS.has(name) && value !== undefined) headers[name] = value
  }
  if (found.via === 'x-api-key') headers['x-api-key'] = resolved.upstreamKey
  else headers.authorization = `Bearer ${resolved.upstreamKey}`

  // /api/proxy/v1/messages → {upstreamBaseUrl}/proxy/v1/messages
  const target = config.upstreamBaseUrl + url.pathname.replace(/^\/api/, '') + url.search

  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) abort.abort()
  })

  let upstream
  try {
    upstream = await fetchImpl(target, { method: req.method, headers, body, signal: abort.signal, redirect: 'manual' })
  } catch {
    if (abort.signal.aborted) return
    return anthropicError(res, 502, 'api_error', UPSTREAM_DOWN)
  }

  const outHeaders = {}
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE_HEADERS.has(name)) outHeaders[name] = value
  })
  res.writeHead(upstream.status, outHeaders)

  if (!upstream.body || req.method === 'HEAD') return res.end()
  try {
    // Streams SSE chunks as they arrive; if the client disconnects the upstream request is cancelled too.
    await pipeline(Readable.fromWeb(upstream.body), res)
  } catch {
    res.destroy()
  }
}

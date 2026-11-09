import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readBody, sendJson } from './http.js'
import { decodeUpstreamKey } from './keys.js'

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

// Opening a new connection to agentshop occasionally stalls on the server (DNS or TCP), and Node's fetch only
// gives up after 10s. The first request after a quiet spell opens a new connection, so that is when it shows.
// check-usage: each attempt gets its own short timeout and the read-only GET is simply retried.
const CHECK_USAGE_TIMEOUTS_MS = [4_000, 8_000]
// AI requests: resent once, but only when the connection was never opened, so agentshop cannot have seen
// (and billed) the first attempt. A reset after sending is not retried.
const AI_ATTEMPTS = 2
const NOT_SENT = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])

const causeCode = (err) => err?.cause?.code ?? err?.code
const describeError = (err) => `${err?.name ?? 'Error'}: ${causeCode(err) ?? err?.message ?? err}`
const warn = (log, msg) => log?.(`${new Date().toISOString()} WARN ${msg}`)

/**
 * Calls the provider's check-usage endpoint with an upstream key.
 * @returns {Promise<{ok: true, data: object} | {ok: false, message: string}>}
 */
export async function fetchUpstreamUsage(upstreamKey, { config, fetchImpl, log }) {
  const url = `${config.upstreamBaseUrl}/proxy/check-usage?key=${encodeURIComponent(upstreamKey)}`
  const timeouts = config.checkUsageTimeoutsMs ?? CHECK_USAGE_TIMEOUTS_MS
  let body
  for (const [i, ms] of timeouts.entries()) {
    try {
      const upstream = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ms) })
      body = await upstream.json()
      break
    } catch (err) {
      warn(log, `check-usage upstream attempt ${i + 1}/${timeouts.length} failed: ${describeError(err)}`)
      if (i === timeouts.length - 1) return { ok: false, message: UPSTREAM_DOWN }
    }
  }
  if (!body?.success || !body.data) return { ok: false, message: UPSTREAM_INVALID }
  return { ok: true, data: body.data }
}

/**
 * GET /api/proxy/check-usage?key=<client key>
 * Looks up the mapped upstream key and returns the provider's usage data plus both expiries:
 * the client key's own (set by the admin) and the agentshop key's (decoded from its JWT).
 */
export async function handleCheckUsage(req, res, url, { store, config, fetchImpl, log }) {
  const envelope = (status, message, data = null) => sendJson(res, status, { success: data !== null, message, data })

  const clientKey = url.searchParams.get('key')?.trim()
  if (!clientKey) return envelope(400, REJECTIONS.missing[2])

  const resolved = store.resolve(clientKey)
  if (!resolved.ok) {
    const [status, , message] = REJECTIONS[resolved.reason]
    return envelope(status, message)
  }
  res.keyId = resolved.record.id

  const usage = await fetchUpstreamUsage(resolved.upstreamKey, { config, fetchImpl, log })
  if (!usage.ok) return envelope(502, usage.message)

  const upstream = decodeUpstreamKey(resolved.upstreamKey)
  return envelope(200, 'Success', {
    ...usage.data,
    keyName: resolved.record.name,
    keyExpiresAt: resolved.record.expiresAt,
    // From the mapped agentshop key itself (its check-usage response has no expiry field).
    upstreamExpiresAt: upstream?.expiresAt ?? null,
    upstreamIssuedAt: upstream?.issuedAt ?? null,
    upstreamPlan: upstream?.plan ?? null,
  })
}

/**
 * Any other /api/proxy/* request (e.g. POST /api/proxy/v1/messages from Claude Code):
 * swap the client key for the upstream key and stream the provider's response back unchanged.
 */
export async function handleAiProxy(req, res, url, { store, config, fetchImpl, log }) {
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
  for (let attempt = 1; !upstream; attempt++) {
    try {
      upstream = await fetchImpl(target, { method: req.method, headers, body, signal: abort.signal, redirect: 'manual' })
    } catch (err) {
      if (abort.signal.aborted) return
      const retry = attempt < AI_ATTEMPTS && NOT_SENT.has(causeCode(err))
      warn(log, `${req.method} ${url.pathname} upstream attempt ${attempt}/${AI_ATTEMPTS} failed: ${describeError(err)}${retry ? ', retrying' : ''}`)
      if (!retry) return anthropicError(res, 502, 'api_error', UPSTREAM_DOWN)
    }
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

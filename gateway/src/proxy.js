import { readBody, sendJson } from './http.js'
import { ALLOWED_MODELS, convertedTokens, creditsForUsage, MODEL_RATES, normalizeModel, PLANS } from './plans.js'
import { estimateRequestCredits } from './quota.js'
import { fillInputTokens, looksTruncated, relayMessageStream } from './sse.js'
import { estimateInputTokens } from './tokens.js'

/** Why a client key was rejected → [HTTP status, Anthropic error type, message]. */
const REJECTIONS = {
  missing: [401, 'authentication_error', 'API key is missing.'],
  invalid: [401, 'authentication_error', 'API key not found or unassigned.'],
  revoked: [403, 'permission_error', 'API key has been revoked.'],
  expired: [403, 'permission_error', 'API key has expired.'],
  unassigned: [403, 'permission_error', 'API key has no plan yet. Please contact the administrator.'],
}
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

/**
 * The only upstream endpoints customers can reach. revidapi also serves other APIs (OpenAI format, images,
 * TTS…) that are not metered by our plans, so everything else is refused.
 */
const ROUTES = {
  '/v1/messages': 'messages',
  '/v1/messages/count_tokens': 'count_tokens',
  '/v1/models': 'models',
}

/**
 * Upstream path for a client path, or null. Clients differ on whether the API host includes /v1:
 * Claude Code sends {host}/v1/messages, Chatbox (Claude provider) sends {host}/messages - accept both.
 */
function routeOf(pathname) {
  const p = pathname.replace(/^\/api\/proxy/, '').replace(/\/+$/, '')
  const path = p.startsWith('/v1/') ? p : '/v1' + p
  return ROUTES[path] ? { route: ROUTES[path], path } : null
}

// A request is resent once when the connection was never opened (the upstream cannot have seen or billed it).
const NOT_SENT = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])

const causeCode = (err) => err?.cause?.code ?? err?.code
const describeError = (err) => `${err?.name ?? 'Error'}: ${causeCode(err) ?? err?.message ?? err}`
const warn = (log, msg) => log?.(`${new Date().toISOString()} WARN ${msg}`)

function anthropicError(res, status, type, message, headers = {}) {
  sendJson(res, status, { type: 'error', error: { type, message } }, headers)
}

/** Claude Code / Anthropic SDKs send the key either as `x-api-key` or `Authorization: Bearer`. */
function extractClientKey(req) {
  const xKey = req.headers['x-api-key']
  if (xKey) return { key: String(xKey).trim(), via: 'x-api-key' }
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')
  if (m) return { key: m[1].trim(), via: 'bearer' }
  return null
}

/* ------------------------------------------------------------------ usage page */

/**
 * The quota page's data for a plan key. A paid pack is a credit budget with no time limit; the
 * trial is a token budget with a time limit. Both are shown with the same fields so the page
 * does not need to know which one it is looking at.
 */
export function usageData(record, q) {
  const free = q.plan.free
  const used = free ? q.tokensUsed : q.creditsUsed
  const cap = q.cap
  return {
    tier: q.plan.name,
    // Credits for a paid pack, converted tokens for the trial.
    unit: free ? 'token' : 'credit',
    used: Math.round(used * 100) / 100,
    cap: Math.round(cap * 100) / 100,
    remaining: Math.round(q.remaining * 100) / 100,
    usagePercentage: cap > 0 ? (used / cap) * 100 : 0,
    // The trial's expiry; a paid pack never expires.
    expiresAt: q.expiresAt,
    startedAt: q.startedAt,
    // Per-model breakdown of what the customer used, so they can see where the credits went.
    models: q.models,
    // True while requests are running and their credits are held back.
    reserved: Math.round(q.reserved * 100) / 100,
    keyName: record.name,
    keyExpiresAt: record.expiresAt,
    plan: record.plan,
    planMinutes: record.planMinutes,
    planStartedAt: record.planStartedAt,
    unlimited: q.unlimited,
  }
}

/** GET /api/proxy/check-usage?key=<client key>: the key's plan usage, computed by the gateway. */
export async function handleCheckUsage(req, res, url, { store, quota }) {
  const envelope = (status, message, data = null) => sendJson(res, status, { success: data !== null, message, data })

  const clientKey = url.searchParams.get('key')?.trim()
  if (!clientKey) return envelope(400, REJECTIONS.missing[2])

  const resolved = store.resolve(clientKey)
  if (!resolved.ok) {
    const [status, , message] = REJECTIONS[resolved.reason]
    return envelope(status, message)
  }
  res.keyId = resolved.record.id
  return envelope(200, 'Success', usageData(resolved.record, quota.snapshot(resolved.record)))
}

/* ------------------------------------------------------------------ limits */

const vnParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hourCycle: 'h23' })
/** "15:35 ngày 12/11" in Vietnam time. */
const vnTime = {
  format(date) {
    const p = Object.fromEntries(vnParts.formatToParts(date).map((x) => [x.type, x.value]))
    return `${p.hour}:${p.minute} ngày ${p.day}/${p.month}`
  },
}
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}M` : `${Math.round(n / 1000)}k`) + ' token'

/** Customer-facing (Vietnamese) reason for a blocked request; Claude Code shows it as is. */
function limitMessage(check, plan) {
  switch (check.limit) {
    case 'credits':
      return `Gói ${plan.name} đã dùng hết ${fmtCredits(plan.credits)} được mua. Gói không tự nạp lại, vui lòng mua thêm gói để tiếp tục.`
    case 'tokens':
      return `Đã dùng hết ${fmtTokens(plan.tokenCap)} của gói dùng thử. Vui lòng liên hệ để mua gói Starter / Pro.`
    case 'expired':
      return `Gói dùng thử của bạn đã hết thời gian. Vui lòng liên hệ để mua gói chính thức.`
    default:
      return `Gói ${plan.name} hiện không dùng được. Vui lòng liên hệ quản trị viên.`
  }
}

/** The pack still has credits, but not enough left for this one request (its worst case). */
const notEnoughCredits = (plan, needed) =>
  `Gói ${plan.name} không còn đủ credit cho yêu cầu này (cần tối đa ${fmtCredits(needed)}). Gói không tự nạp lại, vui lòng mua thêm gói để tiếp tục.`
const fmtCredits = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}M` : `${n.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}`) + ' credit'

/** Requests currently running per key id (to cap concurrency). */
const inFlight = new Map()

/* ------------------------------------------------------------------ upstream */

/**
 * Sends the request to revidapi and resolves with the first attempt that produced a response and its first
 * body chunk. With `hedgeAfterMs`, a second identical attempt starts if the first has not answered by then
 * (revidapi sometimes stalls ~60s); the slower one is cancelled. A connection that could not be opened is
 * retried once. At most two attempts in total.
 */
function openUpstream({ target, init, hedgeAfterMs, fetchImpl, clientSignal, onWarn }) {
  return new Promise((resolve, reject) => {
    const attempts = []
    let settled = false
    let failures = 0
    let hedgeTimer

    const done = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(hedgeTimer)
      fn(value)
    }

    const launch = (reason) => {
      if (settled || attempts.length >= 2) return
      const attempt = { n: attempts.length + 1, reason, ac: new AbortController() }
      attempts.push(attempt)
      if (clientSignal.aborted) attempt.ac.abort()
      else clientSignal.addEventListener('abort', () => attempt.ac.abort(), { once: true })

      ;(async () => {
        const res = await fetchImpl(target, { ...init, signal: attempt.ac.signal, redirect: 'manual' })
        const reader = res.body ? res.body.getReader() : null
        const first = reader ? await reader.read() : { done: true }
        return { res, reader, first: first.done ? null : first.value, ended: first.done }
      })().then(
        (v) => {
          if (settled) {
            v.reader?.cancel().catch(() => {})
            return
          }
          for (const a of attempts) if (a !== attempt) a.ac.abort()
          if (attempt.n > 1) onWarn(`attempt ${attempt.n} (${reason}) answered first`)
          done(resolve, { ...v, abort: () => attempt.ac.abort() })
        },
        (err) => {
          if (settled) return
          failures++
          if (clientSignal.aborted) return done(reject, err)
          onWarn(`upstream attempt ${attempt.n}/2 (${reason}) failed: ${describeError(err)}`)
          if (attempts.length < 2 && NOT_SENT.has(causeCode(err))) return launch('retry')
          if (failures === attempts.length) done(reject, err)
        },
      )
    }

    launch('first')
    if (hedgeAfterMs > 0) {
      hedgeTimer = setTimeout(() => {
        if (settled || attempts.length >= 2) return
        onWarn(`no answer after ${hedgeAfterMs}ms, sending the request again`)
        launch('hedge')
      }, hedgeAfterMs)
    }
  })
}

/** The winner's body as an async iterable: the chunk already read, then the rest. */
async function* bodyChunks(first, reader) {
  if (first) yield first
  if (!reader) return
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    yield value
  }
}

async function pipeChunks(chunks, res) {
  for await (const chunk of chunks) {
    if (res.destroyed) return
    if (!res.write(chunk)) await new Promise((r) => res.once('drain', r).once('close', r))
  }
  if (!res.destroyed) res.end()
}

/* ------------------------------------------------------------------ AI proxy */

/**
 * /api/proxy/v1/messages (+ count_tokens, models) from Claude Code or Chatbox: check the client key, its plan
 * and limits, forward to revidapi with the gateway's account key, relay the answer, charge its usage.
 */
export async function handleAiProxy(req, res, url, { store, quota, config, fetchImpl, log }) {
  const found = extractClientKey(req)
  const resolved = found ? store.resolve(found.key) : { ok: false, reason: 'missing' }
  if (!resolved.ok) {
    const [status, type, message] = REJECTIONS[resolved.reason]
    return anthropicError(res, status, type, message)
  }
  const record = resolved.record
  res.keyId = record.id

  const matched = routeOf(url.pathname)
  if (!matched) return anthropicError(res, 404, 'not_found_error', `Not found: ${url.pathname.replace(/^\/api\/proxy/, '')}`)
  const { route, path: upstreamPath } = matched

  if (route === 'models') {
    if (req.method !== 'GET') return anthropicError(res, 405, 'invalid_request_error', 'Method not allowed')
    const data = ALLOWED_MODELS.map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' }))
    return sendJson(res, 200, { data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id })
  }
  if (req.method !== 'POST') return anthropicError(res, 405, 'invalid_request_error', 'Method not allowed')

  const body = await readBody(req, config.maxBodyBytes)
  let request
  try {
    request = JSON.parse(body.toString('utf8'))
  } catch {
    return anthropicError(res, 400, 'invalid_request_error', 'Request body must be a JSON object.')
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return anthropicError(res, 400, 'invalid_request_error', 'Request body must be a JSON object.')
  }
  // Dated ids from older configs (e.g. fallbackModels: "claude-haiku-4-5-20251001") and older
  // model ids (haiku 4.5 → haiku 5.5) mean the model we actually bill for.
  let forwardBody = body
  let model = normalizeModel(request.model)
  if (model !== request.model) {
    request.model = model
    forwardBody = Buffer.from(JSON.stringify(request))
  }
  if (!MODEL_RATES[model]) {
    return anthropicError(res, 400, 'invalid_request_error', `Model "${request.model}" is not available. Available models: ${ALLOWED_MODELS.join(', ')}`)
  }

  // The credit reservation this request holds. It is settled exactly once: by charge() when the
  // answer arrives (real cost charged, reservation released), or by releaseReservation() when it
  // does not (the request failed before producing an answer).
  let reservation = 0
  let settled = false
  const releaseReservation = () => {
    if (settled) return
    settled = true
    quota.release(record, reservation)
  }
  const charge = (usage) => {
    if (settled) return
    settled = true
    const { absorbed } = quota.charge(record, {
      credits: creditsForUsage(usage, request.model),
      tokens: convertedTokens(usage),
      model: request.model,
      reserved: reservation,
    })
    if (absorbed > 0) {
      warn(log, `${req.method} ${url.pathname} key=#${record.id} answer cost ${absorbed.toFixed(3)} credit more than the pack had left; customer charged up to the pack only`)
    }
  }

  if (route === 'messages') {
    const check = quota.check(record)
    if (!check.ok) {
      const retrySec = check.retryAt ? Math.max(1, Math.ceil((check.retryAt - Date.now()) / 1000)) : null
      return anthropicError(res, 429, 'rate_limit_error', limitMessage(check, PLANS[record.plan]), retrySec ? { 'retry-after': String(retrySec) } : {})
    }
    // Hold back the worst-case credit cost of this request, so the answer can never push the
    // account past the pack that was bought for this customer.
    const estimate = estimateRequestCredits({
      model: request.model,
      inputTokens: estimateInputTokens(request) ?? 0,
      maxTokens: Number.isFinite(request.max_tokens) ? request.max_tokens : 0,
    })
    const held = quota.reserve(record, estimate)
    if (!held.ok) {
      return anthropicError(res, 429, 'rate_limit_error', notEnoughCredits(PLANS[record.plan], estimate))
    }
    reservation = held.reserve
  }

  const running = inFlight.get(record.id) ?? 0
  if (config.maxConcurrentPerKey > 0 && running >= config.maxConcurrentPerKey) {
    releaseReservation()
    return anthropicError(
      res,
      429,
      'rate_limit_error',
      `Key đang chạy ${running} yêu cầu cùng lúc (tối đa ${config.maxConcurrentPerKey}). Vui lòng chờ các yêu cầu đang chạy xong.`,
      { 'retry-after': '2' },
    )
  }
  if (!config.revidApiKey) {
    releaseReservation()
    return anthropicError(res, 503, 'api_error', 'AI service is not configured. Please contact the administrator.')
  }

  inFlight.set(record.id, running + 1)
  let released = false
  const release = () => {
    if (released) return
    released = true
    const n = (inFlight.get(record.id) ?? 1) - 1
    if (n > 0) inFlight.set(record.id, n)
    else inFlight.delete(record.id)
  }
  res.once('close', release)
  store.touch(record.id)

  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (!DROP_REQUEST_HEADERS.has(name) && value !== undefined) headers[name] = value
  }
  headers['x-api-key'] = config.revidApiKey

  const target = config.revidBaseUrl + upstreamPath + url.search
  const label = `${req.method} ${url.pathname} key=#${record.id}`
  const clientAbort = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) clientAbort.abort()
  })

  let upstream
  try {
    upstream = await openUpstream({
      target,
      init: { method: 'POST', headers, body: forwardBody },
      hedgeAfterMs: route === 'messages' ? config.hedgeAfterMs : 0,
      fetchImpl,
      clientSignal: clientAbort.signal,
      onWarn: (msg) => warn(log, `${label} ${msg}`),
    })
  } catch (err) {
    release()
    releaseReservation()
    if (clientAbort.signal.aborted) return
    return anthropicError(res, 502, 'api_error', UPSTREAM_DOWN)
  }

  const outHeaders = {}
  upstream.res.headers.forEach((value, name) => {
    if (!DROP_RESPONSE_HEADERS.has(name)) outHeaders[name] = value
  })
  const contentType = upstream.res.headers.get('content-type') ?? ''
  const chunks = bodyChunks(upstream.first, upstream.reader)

  try {
    // Claude Code's main path: a streamed answer, relayed event by event (see sse.js), usage charged at the end.
    if (route === 'messages' && upstream.res.ok && contentType.includes('text/event-stream')) {
      res.writeHead(upstream.res.status, outHeaders)
      await relayMessageStream(chunks, res, {
        requestedMax: Number.isFinite(request.max_tokens) ? request.max_tokens : undefined,
        inputEstimate: estimateInputTokens(request),
        pingMs: config.streamPingMs,
        warn: (msg) => warn(log, `${label} ${msg}`),
        onUsage: charge,
      })
      return
    }

    // Non-streamed answer: same fixes on the JSON body, then charge.
    if (route === 'messages' && upstream.res.ok && contentType.includes('application/json')) {
      const parts = []
      for await (const c of chunks) parts.push(Buffer.from(c))
      const text = Buffer.concat(parts).toString('utf8')
      let out = text
      try {
        const msg = JSON.parse(text)
        let changed = fillInputTokens(msg.usage, estimateInputTokens(request))
        if (looksTruncated(msg.stop_reason, msg.usage?.output_tokens, request.max_tokens)) {
          warn(log, `${label} answer cut at the upstream's output limit (${msg.usage.output_tokens} tokens) but labelled end_turn; sent max_tokens`)
          msg.stop_reason = 'max_tokens'
          changed = true
        }
        if (changed) out = JSON.stringify(msg)
        charge(msg.usage)
      } catch {
        /* not JSON after all: pass through unchanged */
      }
      res.writeHead(upstream.res.status, outHeaders)
      return res.end(out)
    }

    // Errors from revidapi and count_tokens: passed through unchanged, nothing charged.
    res.writeHead(upstream.res.status, outHeaders)
    await pipeChunks(chunks, res)
  } catch (err) {
    if (!clientAbort.signal.aborted) warn(log, `${label} response broke: ${describeError(err)}`)
    upstream.abort()
    res.destroy()
  } finally {
    // A request that produced no usage (error, or an answer we could not read) is not charged;
    // its reservation goes back so the customer's credits are not lost.
    releaseReservation()
    release()
  }
}

import { readBody, sendJson } from './http.js'
import { ALLOWED_MODELS, convertedTokens, creditsForUsage, MODEL_RATES, normalizeModel, PLANS } from './plans.js'
import { estimateRequestCredits } from './quota.js'
import { fillInputTokens, looksTruncated, relayMessageStream } from './sse.js'
import { estimateInputTokens } from './tokens.js'
import { anthropicToOpenAi, hasImages, onlyServerTools, openAiToAnthropic, relayOpenAiStreamToAnthropic, requestShape } from './nvidia.js'
import { modelChain, NvidiaRouter, parseRetryAfter } from './nvidia-router.js'

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
      return `Đã dùng hết ${fmtTokens(plan.tokenCap)} của gói dùng thử. Vui lòng liên hệ để mua gói Mini / Starter (xem bảng giá tại /bang-gia).`
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

/** How many NVIDIA models/keys one request may try before it is sent to revid. */
const NVIDIA_MAX_ATTEMPTS = 3

/**
 * State of one gateway (one config = one gateway): which NVIDIA models and keys are busy or resting, and how
 * many AI requests run in total.
 */
const gatewayState = new WeakMap()
function stateOf(config) {
  let s = gatewayState.get(config)
  if (!s) {
    // MAX_NVIDIA_CONCURRENT is the number of requests at once per NVIDIA key and model.
    s = { router: new NvidiaRouter({ maxPerLane: config.maxNvidiaConcurrent ?? 50 }), total: 0 }
    gatewayState.set(config, s)
  }
  return s
}

/** The shared NVIDIA keys (a pool, or the one key), as lanes the router can rotate through. */
const sharedLanes = (config) => (config.nvidiaApiKeys ?? [config.nvidiaApiKey]).filter(Boolean).map((key, i) => ({ id: `shared:${i}`, key }))

/* ------------------------------------------------------------------ upstream */

/**
 * Sends the request to revidapi and resolves with the first attempt that produced a response and its first
 * body chunk. With `hedgeAfterMs`, a second identical attempt starts if the first has not answered by then
 * (revidapi sometimes stalls ~60s); the slower one is cancelled. A connection that could not be opened is
 * retried once. At most two attempts in total.
 */
function openUpstream({ target, init, hedgeAfterMs, fetchImpl, clientSignal, onWarn, firstByteTimeoutMs = 0 }) {
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
        // A provider that never answers (a queue at a free tier) must not hold the customer forever.
        const timer =
          firstByteTimeoutMs > 0
            ? setTimeout(() => attempt.ac.abort(Object.assign(new Error(`no answer within ${firstByteTimeoutMs}ms`), { name: 'TimeoutError' })), firstByteTimeoutMs)
            : null
        try {
          const res = await fetchImpl(target, { ...init, signal: attempt.ac.signal, redirect: 'manual' })
          const reader = res.body ? res.body.getReader() : null
          const first = reader ? await reader.read() : { done: true }
          return { res, reader, first: first.done ? null : first.value, ended: first.done }
        } finally {
          clearTimeout(timer)
        }
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

/**
 * The start of an error response's message, for the log: one short line, never more than 200 characters.
 * Also gives the connection back, since the body of a failed attempt is not used.
 */
async function errorDetail(upstream) {
  try {
    let text = ''
    for await (const c of bodyChunks(upstream.first, upstream.reader)) {
      text += typeof c === 'string' ? c : Buffer.from(c).toString('utf8')
      if (text.length > 400) break
    }
    upstream.abort()
    let msg = text
    try {
      const j = JSON.parse(text)
      msg = j?.error?.message ?? j?.message ?? j?.detail ?? text
    } catch {
      /* not JSON: the raw start of the body will do */
    }
    msg = (typeof msg === 'string' ? msg : JSON.stringify(msg)).replace(/\s+/g, ' ').trim().slice(0, 200)
    return msg ? `: ${msg}` : ''
  } catch {
    return ''
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

  // Protects a small server: past this many AI requests at once the extra one is told to retry, before its
  // body is even read. Claude Code retries a 429 by itself.
  if (route === 'messages') {
    const gw = stateOf(config)
    if (config.maxTotalConcurrent > 0 && gw.total >= config.maxTotalConcurrent) {
      return anthropicError(res, 429, 'rate_limit_error', 'Hệ thống đang xử lý nhiều yêu cầu cùng lúc. Vui lòng thử lại sau vài giây.', { 'retry-after': '3' })
    }
    gw.total++
    res.once('close', () => {
      gw.total--
    })
  }

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
  // Counted once per request (it walks the whole conversation) and used for the credit reserve and for what the client is told.
  const inputEstimate = estimateInputTokens(request)

  // The credit reservation this request holds. It is settled exactly once: by charge() when the
  // answer arrives (real cost charged, reservation released), or by releaseReservation() when it
  // does not (the request failed before producing an answer).
  let reservation = 0
  let settled = false
  let chargedProvider = 'revid' // 'revid' (standard rate) | 'nvidia' (discounted rate)

  const releaseReservation = () => {
    if (settled) return
    settled = true
    quota.release(record, reservation)
  }
  const charge = (usage) => {
    if (settled) return
    settled = true
    const discount = chargedProvider === 'nvidia' ? (config.nvidiaCreditDiscount ?? 0.3) : 1
    const rawCredits = creditsForUsage(usage, request.model)
    const rawTokens = convertedTokens(usage)
    const finalCredits = rawCredits * discount
    const finalTokens = rawTokens * discount

    const { absorbed } = quota.charge(record, {
      credits: finalCredits,
      tokens: finalTokens,
      model: request.model,
      reserved: reservation,
    })
    if (absorbed > 0) {
      warn(log, `${req.method} ${url.pathname} key=#${record.id} [${chargedProvider}] answer cost ${absorbed.toFixed(3)} credit more than the pack had left; customer charged up to the pack only`)
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
      inputTokens: inputEstimate ?? 0,
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

  // Which NVIDIA models and keys may serve this request, and in which order. The Claude model the customer
  // picked chooses the model (Claude Code's own side requests use Haiku, so they land on the fast one).
  const gw = stateOf(config)
  const wantsNvidia = route === 'messages' && !onlyServerTools(request)
  if (route === 'messages' && !wantsNvidia) {
    log?.(`${new Date().toISOString()} INFO ${label} [nvidia] skipped: the request only asks for tools that run on Anthropic's servers (${request.tools.map((t) => t.type ?? t.name).join(', ')}), sent to revid`)
  }

  /**
   * Tries one NVIDIA model on one key. Returns true when the request is finished (answered, or broken after
   * the answer had started), false when this attempt failed before any answer, so the next one can be tried.
   */
  const serveFromNvidia = async (attempt) => {
    const where = `${attempt.model.split('/').pop()} on ${attempt.lane.id}`
    try {
      const up = await openUpstream({
        target: `${config.nvidiaBaseUrl}/chat/completions`,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${attempt.lane.key}`,
            accept: request.stream ? 'text/event-stream' : 'application/json',
          },
          body: JSON.stringify(anthropicToOpenAi(request, attempt.model)),
        },
        hedgeAfterMs: 0,
        fetchImpl,
        clientSignal: clientAbort.signal,
        firstByteTimeoutMs: config.nvidiaFirstByteTimeoutMs ?? 60_000,
        onWarn: (msg) => warn(log, `${label} [nvidia] ${msg}`),
      })
      if (!up.res.ok) {
        throw Object.assign(new Error(`NVIDIA HTTP ${up.res.status}${await errorDetail(up)}`), {
          status: up.res.status,
          retryAfterMs: parseRetryAfter(up.res.headers.get('retry-after')),
        })
      }

      // It answers: from here on the request is NVIDIA's.
      gw.router.success(attempt)
      chargedProvider = 'nvidia'
      res.once('close', attempt.release)
      const nChunks = bodyChunks(up.first, up.reader)

      // Answer in the form the client asked for: SSE only when it asked to stream.
      if (request.stream === true) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-served-by': attempt.model,
        })
        try {
          await relayOpenAiStreamToAnthropic(nChunks, res, {
            requestedModel: request.model,
            // What the client sees as the conversation size (so Claude Code can auto-compact); billing is unaffected.
            inputEstimate: inputEstimate ?? 0,
            onUsage: charge,
          })
        } finally {
          releaseReservation()
          release()
        }
        return true
      }
      // Not streamed: nothing is settled until the whole answer is converted, so an unreadable one can still go elsewhere.
      const parts = []
      for await (const c of nChunks) parts.push(Buffer.from(c))
      const anthropicRes = openAiToAnthropic(JSON.parse(Buffer.concat(parts).toString('utf8')), request.model)
      charge(anthropicRes.usage)
      releaseReservation()
      release()
      sendJson(res, 200, anthropicRes, { 'x-served-by': attempt.model })
      return true
    } catch (err) {
      attempt.release()
      if (clientAbort.signal.aborted) {
        // The customer left: nothing wrong with NVIDIA, and nobody to answer.
        releaseReservation()
        release()
        return true
      }
      if (res.headersSent) {
        // Part of the answer is already with the client: sending the request again would only double the cost.
        warn(log, `${label} NVIDIA answer broke after it had started (${where}): ${describeError(err)}`)
        releaseReservation()
        release()
        res.destroy()
        return true
      }
      const { waitMs } = gw.router.failure(attempt, { status: err.status ?? 0, retryAfterMs: err.retryAfterMs })
      warn(log, `${label} NVIDIA failover: ${where} failed (${describeError(err)})${waitMs ? `, resting ${Math.round(waitMs / 1000)}s` : ''}${attempt.lane.id.startsWith('own:') ? ' [customer own NVIDIA key]' : ''}`)
      return false
    }
  }

  if (wantsNvidia) {
    // The customer's own NVIDIA key if they have one (its own rate limit, no one else's slots), else the shared pool in turn.
    let ownKey = null
    try {
      ownKey = store.nvidiaKeyOf?.(record.id) ?? null
    } catch (err) {
      warn(log, `${label} could not read the customer's own NVIDIA key, using the shared ones: ${err?.message ?? err}`)
    }
    const lanes = ownKey ? [{ id: `own:${record.id}`, key: ownKey }] : gw.router.rotate(sharedLanes(config))
    const chain = modelChain(config, request.model, hasImages(request))
    if (lanes.length && chain.length) {
      // Chat turns stream; anything else (non-streamed, forced tool, JSON output) is a Claude Code side request
      // such as auto mode's safety check. Log its shape (never its content) so one that misbehaves can be identified.
      if (request.stream !== true || request.tool_choice || request.output_config?.format || request.output_format) {
        log?.(`${new Date().toISOString()} INFO ${label} [nvidia] side request ${requestShape(request)}`)
      }
      const tried = new Set()
      for (let n = 0; n < NVIDIA_MAX_ATTEMPTS; n++) {
        const attempt = gw.router.acquire(chain, lanes, tried)
        if (!attempt) break
        tried.add(attempt.key)
        if (await serveFromNvidia(attempt)) return
      }
      if (tried.size > 0) warn(log, `${label} NVIDIA gave no answer after ${tried.size} attempt${tried.size > 1 ? 's' : ''}, sending to revid`)
      else log?.(`${new Date().toISOString()} INFO ${label} [nvidia] every model is resting or full, sending to revid`)
    }
  }

  // Fallback hoặc gọi thẳng Revid (nếu NVIDIA đầy hoặc gặp lỗi)
  if (!upstream) {
    chargedProvider = 'revid'
    try {
      upstream = await openUpstream({
        target,
        init: { method: 'POST', headers, body: forwardBody },
        hedgeAfterMs: route === 'messages' ? config.hedgeAfterMs : 0,
        fetchImpl,
        clientSignal: clientAbort.signal,
        onWarn: (msg) => warn(log, `${label} [revid] ${msg}`),
      })
    } catch (err) {
      release()
      releaseReservation()
      if (clientAbort.signal.aborted) return
      return anthropicError(res, 502, 'api_error', UPSTREAM_DOWN)
    }
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
        inputEstimate,
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
        let changed = fillInputTokens(msg.usage, inputEstimate)
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

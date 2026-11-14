import { safeEqual } from './crypto.js'
import { readJson, sendJson } from './http.js'
import { usageData } from './proxy.js'

/**
 * Admin API (Authorization: Bearer <ADMIN_TOKEN>), used by the /admin page and by curl.
 *   GET    /api/admin/keys              list keys
 *   POST   /api/admin/keys              create   {name, plan?, planMinutes?, expiresAt?, note?}
 *   GET    /api/admin/keys/:id          show
 *   PATCH  /api/admin/keys/:id          update   {name?, note?, plan?, planMinutes?, expiresAt?, status?}
 *                                       (plan/planMinutes start a new period from now: usage resets,
 *                                        the trial expires = now + minutes; a paid pack never expires)
 *   POST   /api/admin/keys/:id/rotate   issue a new client key (old one stops working)
 *   GET    /api/admin/keys/:id/usage    plan usage of the key (credits or tokens used, remaining, per model)
 *   GET    /api/admin/upstream          revidapi account balance (credits) and today's use
 *   GET    /api/admin/keys/:id/key      the full client key, to copy it again
 *   DELETE /api/admin/keys/:id          delete
 */
export async function handleAdmin(req, res, url, { store, quota, config, fetchImpl, log }) {
  // Responses carry key material (new keys) — never let a browser or proxy cache them.
  res.setHeader('cache-control', 'no-store')

  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')
  if (!m || !safeEqual(m[1].trim(), config.adminToken)) {
    return sendJson(res, 401, { error: 'Unauthorized' })
  }

  const parts = url.pathname.replace(/^\/api\/admin\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'upstream' && parts.length === 1) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
    return sendJson(res, 200, await upstreamBalance({ config, fetchImpl, log }))
  }
  if (parts[0] !== 'keys' || parts.length > 3) return sendJson(res, 404, { error: 'Not found' })

  const method = req.method
  const notAllowed = () => sendJson(res, 405, { error: 'Method not allowed' })

  if (parts.length === 1) {
    if (method === 'GET') return sendJson(res, 200, { keys: store.list() })
    if (method === 'POST') {
      const { key, record } = store.create(await readJson(req))
      return sendJson(res, 201, { key, record, warning: 'Lấy lại key bất cứ lúc nào qua GET /api/admin/keys/:id/key.' })
    }
    return notAllowed()
  }

  const id = /^\d+$/.test(parts[1]) ? Number(parts[1]) : NaN
  if (!Number.isSafeInteger(id)) return sendJson(res, 404, { error: 'Not found' })

  if (parts.length === 3) {
    if (parts[2] === 'rotate') {
      if (method !== 'POST') return notAllowed()
      const { key, record } = store.rotate(id)
      return sendJson(res, 200, { key, record, warning: 'Key cũ đã ngừng hoạt động. Lưu key mới ngay.' })
    }
    if (parts[2] === 'key') {
      if (method !== 'GET') return notAllowed()
      const key = store.revealKey(id)
      if (!key) return sendJson(res, 409, { error: 'This key was created before key copying was available. Rotate it to get a copyable key.' })
      return sendJson(res, 200, { key })
    }
    if (parts[2] === 'usage') {
      if (method !== 'GET') return notAllowed()
      const record = store.get(id)
      if (!record.plan) return sendJson(res, 409, { error: 'Key has no plan yet.' })
      return sendJson(res, 200, { usage: usageData(record, quota.snapshot(record)) })
    }
    return sendJson(res, 404, { error: 'Not found' })
  }

  if (method === 'GET') return sendJson(res, 200, store.get(id))
  if (method === 'PATCH') return sendJson(res, 200, store.update(id, await readJson(req)))
  if (method === 'DELETE') {
    store.remove(id)
    quota.remove(id)
    res.writeHead(204).end()
    return
  }
  return notAllowed()
}

/** Last successful balance per config (one gateway = one config), served when revidapi hiccups. */
const lastBalance = new WeakMap()

async function fetchBalanceOnce({ config, fetchImpl }) {
  try {
    const res = await fetchImpl(`${config.revidBaseUrl}/v1/usage`, {
      headers: { 'x-api-key': config.revidApiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    const j = await res.json().catch(() => null)
    if (!res.ok || !j || !Number.isFinite(j.credits_remaining)) return { error: `revidapi answered HTTP ${res.status}` }
    return { data: j }
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    return { error: timedOut ? 'revidapi did not answer within 8s' : `revidapi is unreachable (${err?.cause?.code ?? err?.message})` }
  }
}

/**
 * Serves revidapi's account balance to every caller — the /admin page (GET /api/admin/upstream)
 * and the low-credit alert poller. Never throws. On a fetch failure it returns
 * {ok: false, error} when there is no prior good reading, or a stale prior reading
 * {ok: true, stale: true, error} when one exists — so a caller checking whether the read
 * actually succeeded should look at stale/error, not just ok.
 */
export async function upstreamBalance({ config, fetchImpl, log }) {
  if (!config.revidApiKey) return { ok: false, error: 'REVID_API_KEY is not set.' }
  // revidapi's usage endpoint occasionally stalls or errors for a moment: retry once, then fall
  // back to the last good reading (flagged stale) instead of blanking the admin card.
  let r = await fetchBalanceOnce({ config, fetchImpl })
  if (r.error) r = await fetchBalanceOnce({ config, fetchImpl })
  if (r.data) {
    const j = r.data
    const out = {
      ok: true,
      creditsRemaining: j.credits_remaining,
      creditsUsedToday: j.credits_used ?? null,
      requestsToday: j.requests ?? null,
      lastRequestAt: j.last_request_at ?? null,
      lowBalance: j.credits_remaining < config.revidLowCredits,
      lowThreshold: config.revidLowCredits,
      fetchedAt: new Date().toISOString(),
      stale: false,
    }
    lastBalance.set(config, out)
    return out
  }
  log?.(`${new Date().toISOString()} WARN revidapi balance check failed: ${r.error}`)
  const prev = lastBalance.get(config)
  if (prev) return { ...prev, stale: true, error: r.error }
  return { ok: false, error: r.error }
}

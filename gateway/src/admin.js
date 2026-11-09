import { safeEqual } from './crypto.js'
import { readJson, sendJson } from './http.js'
import { fetchUpstreamUsage } from './proxy.js'

/**
 * Admin API (Authorization: Bearer <ADMIN_TOKEN>), used by the /admin page and by curl.
 *   GET    /api/admin/keys              list keys
 *   POST   /api/admin/keys              create   {name, upstreamKey?, expiresAt?, note?}
 *   GET    /api/admin/keys/:id          show
 *   PATCH  /api/admin/keys/:id          update   {name?, note?, upstreamKey?, expiresAt?, status?}
 *   POST   /api/admin/keys/:id/rotate   issue a new client key (old one stops working)
 *   GET    /api/admin/keys/:id/usage    provider usage of the mapped upstream key
 *   GET    /api/admin/keys/:id/key      the full client key, to copy it again
 *   DELETE /api/admin/keys/:id          delete
 */
export async function handleAdmin(req, res, url, { store, config, fetchImpl }) {
  // Responses carry key material (new keys) — never let a browser or proxy cache them.
  res.setHeader('cache-control', 'no-store')

  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')
  if (!m || !safeEqual(m[1].trim(), config.adminToken)) {
    return sendJson(res, 401, { error: 'Unauthorized' })
  }

  const parts = url.pathname.replace(/^\/api\/admin\/?/, '').split('/').filter(Boolean)
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
      const upstreamKey = store.upstreamKeyOf(id)
      if (!upstreamKey) return sendJson(res, 409, { error: 'Key is not linked to an upstream account yet.' })
      const usage = await fetchUpstreamUsage(upstreamKey, { config, fetchImpl })
      if (!usage.ok) return sendJson(res, 502, { error: usage.message })
      return sendJson(res, 200, { usage: usage.data })
    }
    return sendJson(res, 404, { error: 'Not found' })
  }

  if (method === 'GET') return sendJson(res, 200, store.get(id))
  if (method === 'PATCH') return sendJson(res, 200, store.update(id, await readJson(req)))
  if (method === 'DELETE') {
    store.remove(id)
    res.writeHead(204).end()
    return
  }
  return notAllowed()
}

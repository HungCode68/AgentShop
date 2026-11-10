import { createServer } from 'node:http'
import { handleAdmin } from './admin.js'
import { applyCors, HttpError, sendJson } from './http.js'
import { StoreError } from './keys.js'
import { handleAiProxy, handleCheckUsage } from './proxy.js'
import { handleSetup, isSetupPath, maskSetupPath } from './setup.js'

/**
 * @param {{config: ReturnType<import('./config.js').loadConfig>, store: import('./keys.js').KeyStore,
 *          fetchImpl?: typeof fetch, log?: (line: string) => void}} deps
 */
export function createGateway({ config, store, fetchImpl = fetch, log = (line) => console.log(line) }) {
  const ctx = { config, store, fetchImpl, log }

  return createServer(async (req, res) => {
    const started = Date.now()
    // Only the path is logged: query strings may contain a key.
    const url = new URL(req.url ?? '/', 'http://gateway.local')
    // /api/setup/<os>/<key> carries the key in the path itself: mask it.
    const logPath = maskSetupPath(url.pathname)
    res.on('finish', () => {
      const key = res.keyId ? ` key=#${res.keyId}` : ''
      log(`${new Date().toISOString()} ${req.method} ${logPath} ${res.statusCode} ${Date.now() - started}ms${key}`)
    })

    try {
      const path = url.pathname

      if (path === '/healthz') return sendJson(res, 200, { ok: true })

      if (path === '/api/proxy/check-usage' || path === '/api/proxy/check-usage/') {
        applyCors(req, res, config.corsOrigins)
        if (req.method === 'OPTIONS') return res.writeHead(204).end()
        if (req.method !== 'GET') return sendJson(res, 405, { success: false, message: 'Method not allowed', data: null })
        return await handleCheckUsage(req, res, url, ctx)
      }

      if (path.startsWith('/api/proxy/')) return await handleAiProxy(req, res, url, ctx)
      if (isSetupPath(path)) return handleSetup(req, res, url, { store, config })
      if (path === '/api/admin' || path.startsWith('/api/admin/')) return await handleAdmin(req, res, url, ctx)

      return sendJson(res, 404, { error: 'Not found' })
    } catch (err) {
      if (err instanceof HttpError || err instanceof StoreError) return sendJson(res, err.status, { error: err.message })
      log(`${new Date().toISOString()} ERROR ${req.method} ${logPath}: ${err?.stack ?? err}`)
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' })
      else res.destroy()
    }
  })
}

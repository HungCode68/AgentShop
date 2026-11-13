import { parseEncryptionKey } from './crypto.js'

/**
 * Reads configuration from environment variables.
 * The CLI does not need the admin token, so it can opt out of requiring it.
 */
export function loadConfig(env = process.env, { requireAdminToken = true } = {}) {
  const errors = []

  const adminToken = env.ADMIN_TOKEN ?? ''
  if (requireAdminToken && adminToken.length < 24) {
    errors.push('ADMIN_TOKEN phải dài ít nhất 24 ký tự (tạo bằng: openssl rand -hex 32)')
  }

  const encryptionKey = parseEncryptionKey(env.ENCRYPTION_KEY)
  if (!encryptionKey) {
    errors.push('ENCRYPTION_KEY phải là 32 byte dạng hex 64 ký tự hoặc base64 (tạo bằng: openssl rand -hex 32)')
  }

  const port = Number(env.PORT ?? 8090)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) errors.push('PORT không hợp lệ')

  const maxBodyMb = Number(env.MAX_BODY_MB ?? 50)
  if (!(maxBodyMb > 0)) errors.push('MAX_BODY_MB không hợp lệ')

  if (requireAdminToken && !(env.REVID_API_KEY ?? '').trim()) {
    errors.push('REVID_API_KEY là bắt buộc: key sk_ của tài khoản revidapi (Jenkins Credentials: GATEWAY_REVID_API_KEY)')
  }

  // Off by default: revidapi's normal time to first byte is 6–30s (measured 2026-11-12), so any short
  // threshold resends healthy requests and doubles their cost. A value above ~60s only helps its ~65s stalls.
  const hedgeAfterMs = Number(env.HEDGE_AFTER_MS ?? 0)
  if (!(hedgeAfterMs >= 0)) errors.push('HEDGE_AFTER_MS không hợp lệ (0 = tắt)')
  const maxConcurrentPerKey = Number(env.MAX_CONCURRENT_PER_KEY ?? 8)
  if (!Number.isInteger(maxConcurrentPerKey) || maxConcurrentPerKey < 0) errors.push('MAX_CONCURRENT_PER_KEY không hợp lệ (0 = không giới hạn)')

  if (errors.length) {
    throw new Error('Cấu hình không hợp lệ:\n  - ' + errors.join('\n  - '))
  }

  return {
    port,
    adminToken,
    encryptionKey,
    // AI upstream: revidapi (Anthropic-compatible /v1/messages). One account key serves every customer;
    // per-customer limits are enforced by the gateway (plans.js, quota.js).
    revidBaseUrl: (env.REVID_BASE_URL || 'https://revidapi.com').replace(/\/+$/, ''),
    revidApiKey: (env.REVID_API_KEY ?? '').trim(),
    // No first byte from revidapi after this long: send the same request again and use whichever answers first.
    hedgeAfterMs,
    maxConcurrentPerKey,
    // /admin warns when the revidapi balance drops below this many credits.
    revidLowCredits: Number(env.REVID_LOW_CREDITS ?? 300),
    // Legacy agentshop upstream, only read by the CLI/admin for old keys' expiry; no AI traffic goes there.
    upstreamBaseUrl: (env.UPSTREAM_BASE_URL || 'https://api.agentshop247.com/api').replace(/\/+$/, ''),
    dbPath: env.DB_PATH || './data/gateway.db',
    keyPrefix: env.KEY_PREFIX || 'ak_',
    corsOrigins: (env.CORS_ORIGINS ?? '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Public root of the AI proxy, written into the /api/setup install script.
    publicApiHost: (env.PUBLIC_API_HOST ?? 'https://agentshop.id.vn/api/proxy').replace(/\/+$/, ''),
    maxBodyBytes: Math.floor(maxBodyMb * 1024 * 1024),
  }
}

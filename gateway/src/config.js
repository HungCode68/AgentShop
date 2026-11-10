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

  if (errors.length) {
    throw new Error('Cấu hình không hợp lệ:\n  - ' + errors.join('\n  - '))
  }

  return {
    port,
    adminToken,
    encryptionKey,
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

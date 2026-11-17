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
  const maxConcurrentPerKey = Number(env.MAX_CONCURRENT_PER_KEY ?? 12)
  if (!Number.isInteger(maxConcurrentPerKey) || maxConcurrentPerKey < 0) errors.push('MAX_CONCURRENT_PER_KEY không hợp lệ (0 = không giới hạn)')

  // NVIDIA: a pool of shared keys (NVIDIA_API_KEYS, comma separated) or the single NVIDIA_API_KEY. An empty key switches NVIDIA off.
  const nvidiaKeys = (() => {
    const pool = (env.NVIDIA_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean)
    if (pool.length) return [...new Set(pool)]
    const single = (env.NVIDIA_API_KEY ?? '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').trim()
    return single ? [single] : []
  })()
  // The task decides the NVIDIA model: a chain per kind of task, best first (each model has its own rate limit at NVIDIA,
  // so when one rests the next one answers). chat = everyday questions, fast; agent = code, tools, analysis, strong;
  // vision = the conversation has an image, models that can see.
  const list = (v, fallback) => {
    const items = (v || fallback).split(',').map((x) => x.trim()).filter(Boolean)
    return items.length ? items : fallback.split(',')
  }
  const ULTRA = 'nvidia/nemotron-3-ultra-550b-a55b'
  const SUPER_VL = 'nvidia/nemotron-3.5-super-vl-120b-a12b'
  const OMNI = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'
  const LIGHTNING = 'nvidia/nemotron-3.5-lightning-30b-a3b'
  const nvidiaChains = {
    chat: list(env.NVIDIA_CHAT_MODELS, [OMNI, LIGHTNING, SUPER_VL, ULTRA].join(',')),
    agent: list(env.NVIDIA_AGENT_MODELS, [ULTRA, SUPER_VL, OMNI, LIGHTNING].join(',')),
    vision: list(env.NVIDIA_VISION_MODELS, [SUPER_VL, OMNI].join(',')),
  }
  // NVIDIA_TASK_ROUTING=off sends everything (except images) to the agent chain, the strongest models.
  const nvidiaTaskRouting = !/^(off|false|0|no)$/i.test((env.NVIDIA_TASK_ROUTING ?? '').trim())
  // A conversation at least this long (estimated tokens) goes to the strong models.
  const nvidiaLongContextTokens = Number(env.NVIDIA_LONG_CONTEXT_TOKENS ?? 20_000)
  if (!(nvidiaLongContextTokens > 0)) errors.push('NVIDIA_LONG_CONTEXT_TOKENS không hợp lệ')
  const maxTotalConcurrent = Number(env.MAX_TOTAL_CONCURRENT ?? 60)
  if (!Number.isInteger(maxTotalConcurrent) || maxTotalConcurrent < 0) errors.push('MAX_TOTAL_CONCURRENT không hợp lệ (0 = không giới hạn)')
  const nvidiaFirstByteTimeoutMs = Number(env.NVIDIA_FIRST_BYTE_TIMEOUT_MS ?? 60_000)
  if (!(nvidiaFirstByteTimeoutMs > 0)) errors.push('NVIDIA_FIRST_BYTE_TIMEOUT_MS không hợp lệ')

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
    // NVIDIA NIM Direct API configuration
    nvidiaApiKey: nvidiaKeys[0] ?? '',
    nvidiaApiKeys: nvidiaKeys,
    nvidiaBaseUrl: (env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
    nvidiaChains,
    nvidiaModel: nvidiaChains.agent[0], // the single main model (older code and tests read this)
    nvidiaTaskRouting,
    nvidiaLongContextTokens,
    nvidiaFirstByteTimeoutMs,
    maxTotalConcurrent,
    // Requests at once per NVIDIA key and model (the shared keys, or one customer's own key); beyond it the next model, then revid.
    maxNvidiaConcurrent: Number(env.MAX_NVIDIA_CONCURRENT ?? 50),
    nvidiaCreditDiscount: Number(env.NVIDIA_CREDIT_DISCOUNT ?? 0.3), // Giảm 70% chi phí credit khi chạy qua NVIDIA
    // Background poller pings the owner on Telegram when the shared revidapi balance drops below the threshold.
    telegramBotToken: (env.TELEGRAM_BOT_TOKEN ?? '').trim(),
    telegramChatId: (env.TELEGRAM_CHAT_ID ?? '').trim(),
    telegramLowCredits: (() => { const raw = (env.TELEGRAM_LOW_CREDITS ?? '').trim(); const v = Number(raw); return raw !== '' && Number.isFinite(v) ? v : 500 })(),
    telegramAlertIntervalMin: (() => { const v = Number(env.TELEGRAM_ALERT_INTERVAL_MIN); return v > 0 ? v : 5 })(),
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

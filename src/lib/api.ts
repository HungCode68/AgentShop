export interface UsageData {
  tier: string
  /** 'credit' for a paid pack, 'token' for the free trial. */
  unit: 'credit' | 'token'
  /** How much of the pack is used (credits, or tokens for the trial). */
  used: number
  /** The pack's total (credits, or tokens for the trial). */
  cap: number
  remaining: number
  usagePercentage: number
  /** When the trial runs out; null for a paid pack (it never expires). */
  expiresAt: string | null
  startedAt: string
  /** What the customer used, per model. */
  models?: Record<string, { tokens: number; credits: number }>
  /** Credits held by requests that are still running. */
  reserved?: number
  /** Added by our gateway: name of the issued key. */
  keyName?: string
  /** Added by our gateway: expiry of the issued key (ISO, null = never). Absent when calling agentshop directly. */
  keyExpiresAt?: string | null
  /** Plan keys (revidapi): the rented pack and when it started. */
  plan?: string | null
  /** The trial's length in minutes (paid packs have no time limit). */
  planMinutes?: number | null
  planStartedAt?: string | null
  /** True for a paid pack: it has no time limit, only a credit budget. */
  unlimited?: boolean
}

interface ApiEnvelope {
  success: boolean
  message: string
  data: UsageData | null
}

export class ApiError extends Error {}

// Default: our own gateway on the same domain (dev: proxied by Vite, see vite.config.ts).
export const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

const MESSAGE_VI: Record<string, string> = {
  'API key is missing.': 'Vui lòng nhập API key.',
  'API key not found or unassigned.': 'API key không tồn tại hoặc chưa được gán cho tài khoản nào.',
  'API key has been revoked.': 'API key đã bị thu hồi. Vui lòng liên hệ quản trị viên.',
  'API key has expired.': 'API key đã hết hạn. Vui lòng liên hệ quản trị viên để gia hạn.',
  'API key is not linked to an upstream account yet.': 'API key chưa được liên kết với tài khoản AI. Vui lòng liên hệ quản trị viên.',
  'API key has no plan yet. Please contact the administrator.': 'API key chưa được gán gói. Vui lòng liên hệ quản trị viên.',
  'Upstream account is unavailable or expired. Please contact the administrator.':
    'Tài khoản AI phía sau đang không khả dụng hoặc đã hết hạn. Vui lòng liên hệ quản trị viên.',
  'Upstream service is unreachable.': 'Không kết nối được tới nhà cung cấp AI. Vui lòng thử lại sau.',
}
export const translate = (msg: string) => MESSAGE_VI[msg] ?? msg

export async function checkUsage(key: string, signal?: AbortSignal): Promise<UsageData> {
  const url = `${API_BASE}/proxy/check-usage?key=${encodeURIComponent(key)}`

  let res: Response
  try {
    res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new ApiError('Không thể kết nối tới máy chủ. Vui lòng kiểm tra mạng và thử lại.')
  }

  let body: Partial<ApiEnvelope> & { detail?: string }
  try {
    body = await res.json()
  } catch {
    throw new ApiError(`Máy chủ trả về phản hồi không hợp lệ (HTTP ${res.status}).`)
  }

  if (!res.ok) {
    throw new ApiError(translate(body.message || body.detail || `Yêu cầu thất bại (HTTP ${res.status}).`))
  }
  if (!body.success || !body.data) {
    throw new ApiError(translate(body.message ?? 'Không lấy được dữ liệu sử dụng.'))
  }
  return body.data
}

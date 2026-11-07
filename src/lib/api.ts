export interface UsageData {
  tier: string
  tokensUsed: number
  tokenBudget: number
  usagePercentage: number
  windowEnd: string | null
  sessionsUsed: number
  maxSessions: number
  weeklyLimitResetAt: string | null
}

interface ApiEnvelope {
  success: boolean
  message: string
  data: UsageData | null
}

export class ApiError extends Error {}

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? 'https://api.agentshop247.com/api').replace(/\/$/, '')

const MESSAGE_VI: Record<string, string> = {
  'API key not found or unassigned.': 'API key không tồn tại hoặc chưa được gán cho tài khoản nào.',
}

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
    throw new ApiError(body.detail || body.message || `Yêu cầu thất bại (HTTP ${res.status}).`)
  }
  if (!body.success || !body.data) {
    const msg = body.message ?? 'Không lấy được dữ liệu sử dụng.'
    throw new ApiError(MESSAGE_VI[msg] ?? msg)
  }
  return body.data
}

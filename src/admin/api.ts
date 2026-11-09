import { API_BASE, translate, type UsageData } from '../lib/api'

export type KeyStatus = 'active' | 'expired' | 'revoked' | 'unassigned'

/** Mirrors the gateway's public key record (never contains the full client or upstream key). */
export interface KeyRecord {
  id: number
  name: string
  note: string | null
  keyPrefix: string
  /** false for keys created before the gateway stored a copy; rotating fixes it. */
  canCopy: boolean
  upstreamKey: string | null
  status: 'active' | 'revoked'
  effectiveStatus: KeyStatus
  expiresAt: string | null
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
  requestCount: number
}

export interface IssuedKey {
  key: string
  record: KeyRecord
}

export interface KeyInput {
  name?: string
  note?: string | null
  upstreamKey?: string | null
  expiresAt?: string | null
  status?: 'active' | 'revoked'
}

export class AdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const ERRORS_VI: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^This upstream key is already assigned to key #(\d+)$/, (m) => `Key agentshop này đã được gán cho key #${m[1]}.`],
  [/^Key #(\d+) not found$/, (m) => `Không tìm thấy key #${m[1]} (có thể đã bị xoá).`],
  [/^name is required/, () => 'Tên là bắt buộc (tối đa 100 ký tự).'],
  [/^note must be/, () => 'Ghi chú tối đa 500 ký tự.'],
  [/^upstreamKey must be/, () => 'Key agentshop không hợp lệ (không chứa khoảng trắng, tối thiểu 8 ký tự).'],
  [/^expiresAt must be/, () => 'Ngày hết hạn không hợp lệ.'],
  [/^Nothing to update$/, () => 'Không có thay đổi nào để lưu.'],
  [/^Key is not linked to an upstream account yet\.$/, () => 'Key chưa được gán key agentshop.'],
  [/^This key was created before key copying/, () => 'Key này được tạo trước khi có tính năng sao chép. Hãy cấp lại key để có thể sao chép.'],
]

function translateAdmin(message: string): string {
  for (const [re, fn] of ERRORS_VI) {
    const m = message.match(re)
    if (m) return fn(m)
  }
  return translate(message)
}

export function createAdminApi(token: string) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${API_BASE}/admin${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      })
    } catch {
      throw new AdminError('Không kết nối được tới gateway. Kiểm tra mạng hoặc gateway có đang chạy không.', 0)
    }
    if (res.status === 204) return undefined as T

    let body: { error?: string } & Record<string, unknown> = {}
    try {
      body = await res.json()
    } catch {
      /* not JSON (e.g. nginx error page) */
    }
    if (res.ok) return body as T

    if (res.status === 401) throw new AdminError('Admin token không đúng.', 401)
    if (res.status === 429) throw new AdminError('Thao tác quá nhanh, vui lòng thử lại sau vài giây.', 429)
    if (res.status === 404 && !body.error) {
      throw new AdminError('Không truy cập được API quản trị. Kiểm tra cấu hình nginx cho /api/admin/.', 404)
    }
    throw new AdminError(body.error ? translateAdmin(body.error) : `Yêu cầu thất bại (HTTP ${res.status}).`, res.status)
  }

  const json = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) })

  return {
    list: () => request<{ keys: KeyRecord[] }>('/keys').then((r) => r.keys),
    create: (input: KeyInput) => request<IssuedKey>('/keys', json('POST', input)),
    update: (id: number, patch: KeyInput) => request<KeyRecord>(`/keys/${id}`, json('PATCH', patch)),
    rotate: (id: number) => request<IssuedKey>(`/keys/${id}/rotate`, { method: 'POST' }),
    remove: (id: number) => request<void>(`/keys/${id}`, { method: 'DELETE' }),
    revealKey: (id: number) => request<{ key: string }>(`/keys/${id}/key`).then((r) => r.key),
    usage: (id: number) => request<{ usage: UsageData }>(`/keys/${id}/usage`).then((r) => r.usage),
  }
}

export type AdminApi = ReturnType<typeof createAdminApi>

/** Base URL clients put in ANTHROPIC_BASE_URL (same origin as this page unless VITE_API_BASE_URL is absolute). */
export const proxyBaseUrl = () => new URL(`${API_BASE}/proxy`, window.location.origin).href
export const checkPageUrl = (key: string) => `${window.location.origin}/?key=${encodeURIComponent(key)}`

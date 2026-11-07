export interface KeyInfo {
  productId?: number
  accountTime?: string
  issuedAt?: Date
  expiresAt?: Date
}

/**
 * Keys look like `as_<JWT>`. The JWT payload carries plan duration and expiry.
 * Decoded client-side for display only — the signature is not verified here.
 */
export function decodeKey(key: string): KeyInfo | null {
  const jwt = key.trim().replace(/^as_/, '')
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const json = decodeURIComponent(
      Array.from(atob(padded), (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    )
    const p = JSON.parse(json) as Record<string, unknown>
    return {
      productId: typeof p.productId === 'number' ? p.productId : undefined,
      accountTime: typeof p.accountTime === 'string' ? p.accountTime : undefined,
      issuedAt: typeof p.iat === 'number' ? new Date(p.iat * 1000) : undefined,
      expiresAt: typeof p.exp === 'number' ? new Date(p.exp * 1000) : undefined,
    }
  } catch {
    return null
  }
}

const DURATION_VI: Record<string, string> = { day: 'ngày', days: 'ngày', week: 'tuần', weeks: 'tuần', month: 'tháng', months: 'tháng', year: 'năm', years: 'năm', hour: 'giờ', hours: 'giờ' }

export function translateDuration(s: string): string {
  return s.replace(/\b(hours?|days?|weeks?|months?|years?)\b/gi, (m) => DURATION_VI[m.toLowerCase()] ?? m)
}

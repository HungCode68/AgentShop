const shortFmt = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
const relFmt = new Intl.RelativeTimeFormat('vi-VN', { numeric: 'auto' })

export const formatShort = (iso: string) => shortFmt.format(new Date(iso))

export function relativeTime(iso: string, now = Date.now()): string {
  const sec = Math.round((new Date(iso).getTime() - now) / 1000)
  const abs = Math.abs(sec)
  if (abs < 60) return 'vừa xong'
  if (abs < 3600) return relFmt.format(Math.round(sec / 60), 'minute')
  if (abs < 86400) return relFmt.format(Math.round(sec / 3600), 'hour')
  if (abs < 86400 * 60) return relFmt.format(Math.round(sec / 86400), 'day')
  if (abs < 86400 * 365) return relFmt.format(Math.round(sec / (86400 * 30)), 'month')
  return relFmt.format(Math.round(sec / (86400 * 365)), 'year')
}

const pad = (n: number) => String(n).padStart(2, '0')

/** ISO → value for <input type="datetime-local"> in the browser's timezone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** End of the day `days` from today, as a datetime-local value. */
export function inDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  d.setHours(23, 59, 0, 0)
  return toLocalInput(d.toISOString())
}

const TOKEN_KEY = 'quota-admin:token'

/** Token lives in sessionStorage (cleared with the tab) unless the admin chooses to remember it. */
export const tokenStorage = {
  get(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  },
  remembered(): boolean {
    try {
      return localStorage.getItem(TOKEN_KEY) !== null
    } catch {
      return false
    }
  },
  set(token: string, remember: boolean) {
    try {
      this.clear()
      ;(remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token)
    } catch {
      /* storage unavailable: token stays in memory only */
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* ignore */
    }
  },
}

/**
 * Copies text that is still being fetched. ClipboardItem with a promise keeps the click's user activation
 * (required by Safari); other browsers fall back to writing once the text has arrived.
 */
export async function copyLater(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })])
      return
    } catch {
      /* fall through: unsupported, or the fetch itself failed (rethrown below) */
    }
  }
  if (!(await copyText(await text))) throw new Error('Trình duyệt không cho phép sao chép. Hãy thử lại.')
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fallback for non-secure contexts (plain http).
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

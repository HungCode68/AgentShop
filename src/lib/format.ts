const numberFmt = new Intl.NumberFormat('vi-VN')
const dateTimeFmt = new Intl.DateTimeFormat('vi-VN', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
const timeFmt = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export const formatNumber = (n: number) => numberFmt.format(n)
export const formatDateTime = (d: Date) => dateTimeFmt.format(d)
export const formatTime = (d: Date) => timeFmt.format(d)

/** Server timestamps come without a timezone; like the provider's own page, read them as local time. */
export function parseServerDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export interface CountdownParts {
  days: number
  hours: number
  minutes: number
  seconds: number
}

export function countdownParts(ms: number): CountdownParts {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  return {
    days: Math.floor(totalSec / 86400),
    hours: Math.floor((totalSec % 86400) / 3600),
    minutes: Math.floor((totalSec % 3600) / 60),
    seconds: totalSec % 60,
  }
}

export type Level = 'ok' | 'warn' | 'danger'
export function usageLevel(percent: number): Level {
  if (percent >= 90) return 'danger'
  if (percent >= 70) return 'warn'
  return 'ok'
}

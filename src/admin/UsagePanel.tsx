import { useCallback, useEffect, useState } from 'react'
import { RefreshIcon } from '../components/Icons'
import type { UsageData } from '../lib/api'
import { formatDateTime, formatNumber, parseServerDate, usageLevel } from '../lib/format'
import type { AdminApi } from './api'
import { InlineError } from './ui'

function Meter({ label, used, total, resetAt }: { label: string; used: number; total: number; resetAt: string | null }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
  const reset = parseServerDate(resetAt)
  return (
    <div className="meter">
      <div className="meter__head">
        <span>{label}</span>
        <span className="mono">
          {formatNumber(used)} / {formatNumber(total)} <span className="muted">({pct.toFixed(1)}%)</span>
        </span>
      </div>
      <div className={`bar bar--thin bar--${usageLevel(pct)}`}>
        <div className="bar__fill" style={{ width: `${pct}%` }} />
      </div>
      {resetAt !== null && <span className="small muted">Đặt lại: {reset ? formatDateTime(reset) : 'không có dữ liệu'}</span>}
    </div>
  )
}

export function UsagePanel({ api, id, onError }: { api: AdminApi; id: number; onError: (err: unknown) => boolean }) {
  const [data, setData] = useState<UsageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await api.usage(id))
    } catch (err) {
      if (!onError(err)) setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [api, id, onError])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="usage">
      {data ? (
        <>
          <div className="usage__meta">
            <span className="tier-badge">{data.tier}</span>
            <button type="button" className="icon-btn" onClick={load} disabled={loading} title="Tải lại" aria-label="Tải lại hạn mức">
              <RefreshIcon width={16} height={16} className={loading ? 'spin' : undefined} />
            </button>
          </div>
          <Meter label="Phiên 5 giờ" used={data.tokensUsed} total={data.tokenBudget} resetAt={data.windowEnd} />
          <Meter label="Trong tuần" used={data.sessionsUsed} total={data.maxSessions} resetAt={data.weeklyLimitResetAt} />
          {data.rentalCap != null && <Meter label="Cả kỳ thuê" used={data.rentalUsed ?? 0} total={data.rentalCap} resetAt={null} />}
          {data.available != null && (
            <span className="small">
              Có thể dùng ngay: <b className="mono">{formatNumber(data.available)}</b> token
              {data.dailyRefill != null && <span className="muted"> · mỗi ngày cộng thêm {formatNumber(data.dailyRefill)}</span>}
            </span>
          )}
        </>
      ) : loading ? (
        <span className="small muted">Đang tải hạn mức…</span>
      ) : null}
      <InlineError message={error} />
    </div>
  )
}

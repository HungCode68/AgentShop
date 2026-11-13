import { useCallback, useEffect, useState } from 'react'
import { RefreshIcon } from '../components/Icons'
import type { UsageData } from '../lib/api'
import { formatDateTime, parseServerDate, usageLevel } from '../lib/format'
import type { AdminApi } from './api'
import { InlineError } from './ui'

const MODEL_NAMES: Record<string, string> = {
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
}
const fmtCredits = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 1 })
const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}M` : `${Math.round(n).toLocaleString('vi-VN')}`)
const unit = (data: UsageData) => (data.unit === 'credit' ? 'credit' : 'token')

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

  const totalTokens = data ? Object.values(data.models ?? {}).reduce((n, m) => n + m.tokens, 0) : 0

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

          <Meter label={data.unit === 'credit' ? 'Credit đã dùng' : 'Token đã dùng'} used={data.used} total={data.cap} format={data.unit === 'credit' ? fmtCredits : fmtTokens} resetAt={data.expiresAt} />

          <div className="usage__stats">
            <span className="small">
              Còn lại: <b className="mono">{data.unit === 'credit' ? fmtCredits(data.remaining) : fmtTokens(data.remaining)}</b> {unit(data)}
              {data.unlimited ? <span className="muted"> · không thời hạn, dùng khi nào cũng được</span> : null}
            </span>
            {data.unit === 'credit' && (
              <span className="small">
                Token đã dùng: <b className="mono">{fmtTokens(totalTokens)}</b> (tổng các model)
              </span>
            )}
            {data.reserved ? (
              <span className="small muted">{fmtCredits(data.reserved)} credit đang chạy (các request chưa xong)</span>
            ) : null}
          </div>

          {data.expiresAt && (
            <span className="small muted">
              {data.unit === 'credit' ? 'Key hết hạn: ' : 'Hết thời gian dùng thử: '}
              {formatDateTime(parseServerDate(data.expiresAt) ?? new Date(data.expiresAt))}
            </span>
          )}

          {Object.keys(data.models ?? {}).length > 0 && (
            <table className="ktable usage__models">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Token</th>
                  <th>Credit</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.models!)
                  .sort((a, b) => b[1].credits - a[1].credits)
                  .map(([model, m]) => (
                    <tr key={model}>
                      <td data-label="Model">{MODEL_NAMES[model] ?? model}</td>
                      <td data-label="Token">{fmtTokens(m.tokens)}</td>
                      <td data-label="Credit">{fmtCredits(m.credits)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </>
      ) : loading ? (
        <span className="small muted">Đang tải hạn mức…</span>
      ) : null}
      <InlineError message={error} />
    </div>
  )
}

function Meter({ label, used, total, format, resetAt }: { label: string; used: number; total: number; format: (n: number) => string; resetAt: string | null }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
  const reset = parseServerDate(resetAt)
  return (
    <div className="meter">
      <div className="meter__head">
        <span>{label}</span>
        <span className="mono">
          {format(used)} / {format(total)} <span className="muted">({pct.toFixed(1)}%)</span>
        </span>
      </div>
      <div className={`bar bar--thin bar--${usageLevel(pct)}`}>
        <div className="bar__fill" style={{ width: `${pct}%` }} />
      </div>
      {resetAt !== null && <span className="small muted">Đặt lại: {reset ? formatDateTime(reset) : 'không có dữ liệu'}</span>}
    </div>
  )
}

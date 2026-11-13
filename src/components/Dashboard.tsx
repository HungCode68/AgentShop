import type { UsageData } from '../lib/api'
import { formatNumber, formatTime, parseServerDate, usageLevel } from '../lib/format'
import { ActivityIcon, CalendarIcon, CheckIcon, ClockIcon, LayersIcon, RefreshIcon, ShieldIcon, ZapIcon } from './Icons'
import { StatCard } from './StatCard'
import { TimerCard } from './TimerCard'
import { UsageGauge } from './UsageGauge'

interface Props {
  data: UsageData
  now: number
  lastChecked: Date
  loading: boolean
  onRefresh: () => void
  autoRefresh: boolean
  onAutoRefreshChange: (v: boolean) => void
}

const STATUS_TEXT = {
  ok: 'Gói còn thoải mái',
  warn: 'Đã dùng nhiều — cân nhắc tiết kiệm',
  danger: 'Gần hết hoặc đã hết hạn mức',
} as const

const MODEL_NAMES: Record<string, string> = {
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
}
const fmtCredits = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 1 })
const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}M` : formatNumber(n))

export function Dashboard({ data, now, lastChecked, loading, onRefresh, autoRefresh, onAutoRefreshChange }: Props) {
  const isPlan = data.unlimited === true || (data.plan != null && data.plan !== 'trial')
  const isTrial = data.plan === 'trial'
  const unitName = data.unit === 'credit' ? 'credit' : 'token'
  const fmt = data.unit === 'credit' ? fmtCredits : fmtTokens
  const used = data.used
  const budget = data.cap
  const remaining = data.remaining
  const percent = Number.isFinite(data.usagePercentage) ? data.usagePercentage : budget > 0 ? (used / budget) * 100 : 0
  const level = usageLevel(percent)
  const totalTokens = Object.values(data.models ?? {}).reduce((n, m) => n + m.tokens, 0)

  const windowEnd = parseServerDate(data.expiresAt)
  const keyExpiry = parseServerDate(data.keyExpiresAt)
  const keyExpired = keyExpiry ? keyExpiry.getTime() <= now : false
  const trialMinutes = data.planMinutes ? ` (${data.planMinutes} phút)` : ''

  return (
    <section className="results" aria-live="polite">
      <div className="results__toolbar">
        <div className="results__title">
          <h2>Kết quả thống kê</h2>
          <span className="tier-badge">
            <ZapIcon width={13} height={13} />
            {data.tier || 'N/A'}
          </span>
          {keyExpired && <span className="tier-badge tier-badge--danger">Key đã hết hạn</span>}
        </div>
        <div className="results__actions">
          {/* keyed on the timestamp so the "updated" flash replays after every successful refresh */}
          <span key={lastChecked.getTime()} className="updated small">
            <CheckIcon width={14} height={14} />
            Cập nhật lúc {formatTime(lastChecked)}
          </span>
          <label className="switch" title="Tự động làm mới mỗi 60 giây">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => onAutoRefreshChange(e.target.checked)} />
            <span className="switch__track"><span className="switch__thumb" /></span>
            <span className="small">Tự làm mới</span>
          </label>
          <button type="button" className="btn btn--ghost" onClick={onRefresh} disabled={loading}>
            <RefreshIcon className={loading ? 'spin' : undefined} />
            <span>{loading ? 'Đang làm mới…' : 'Làm mới'}</span>
          </button>
        </div>
      </div>

      <div className="card overview">
        <UsageGauge percent={percent} level={level} />
        <div className="overview__body">
          <span className="eyebrow">
            {isTrial
              ? `Token dùng thử đã dùng${trialMinutes}`
              : isPlan
                ? `Credit đã dùng trong gói ${data.tier}`
                : 'Đã dùng'}
          </span>
          <div className="overview__numbers">
            <span className="mono overview__used">{fmt(used)}</span>
            <span className="overview__sep">/</span>
            <span className="mono overview__budget">{fmt(budget)}</span>
            <span className="overview__unit muted small"> {unitName}</span>
          </div>
          <div className={`bar bar--${level}`} aria-hidden>
            <div className="bar__fill" style={{ width: `${Math.min(100, percent)}%` }} />
            <span className="bar__mark" style={{ left: '70%' }} />
            <span className="bar__mark" style={{ left: '90%' }} />
          </div>
          <div className="overview__legend">
            <span>0</span>
            <span>{fmt(budget)} {unitName}</span>
          </div>
          <div className={`status status--${level}`}>
            <span className="status__dot" />
            {STATUS_TEXT[level]}
          </div>
        </div>
      </div>

      <div className="grid grid--3">
        <StatCard
          icon={<LayersIcon />}
          label="Còn lại"
          value={fmt(remaining)}
          hint={data.unit === 'credit' ? 'credit' : 'token'}
          tone="accent"
        />
        <StatCard
          icon={<ZapIcon />}
          label="Gói"
          value={data.tier || '—'}
          hint={isTrial ? `miễn phí · 100k token trong thời gian thử` : isPlan ? 'không thời hạn — dùng khi nào cũng được' : undefined}
        />
        <StatCard
          icon={<ActivityIcon />}
          label="Token đã dùng (tổng)"
          value={fmtTokens(totalTokens)}
          hint={isPlan ? data.reserved ? `${fmtCredits(data.reserved)} credit đang chạy` : 'chưa có request nào đang chạy' : undefined}
        />
      </div>

      {Object.keys(data.models ?? {}).length > 0 && (
        <div className="card">
          <h3 className="card__title">Chi tiết theo model</h3>
          <table className="ktable">
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
        </div>
      )}

      <div className="grid grid--3">
        {isTrial ? (
          <TimerCard icon={<ClockIcon />} title="Hết thời gian dùng thử sau" target={windowEnd} emptyText="Chưa bắt đầu" now={now} />
        ) : (
          <div className="card">
            <h3 className="card__title">
              <ClockIcon />
              Không thời hạn
            </h3>
            <p className="small muted">Gói {data.tier} không hết hạn theo ngày — dùng tới khi hết {fmt(budget)} {unitName}.</p>
          </div>
        )}
        <div className="card">
          <h3 className="card__title">
            <CalendarIcon />
            Đã dùng từ
          </h3>
          <p className="mono small">{data.startedAt ? new Date(data.startedAt).toLocaleString('vi-VN') : '—'}</p>
        </div>
        <TimerCard
          icon={<ShieldIcon />}
          title="Key hết hạn sau"
          target={keyExpiry}
          emptyText={keyExpiry ? undefined : isPlan ? 'Không thời hạn' : undefined}
          now={now}
        />
      </div>
    </section>
  )
}


import type { UsageData } from '../lib/api'
import { formatNumber, formatTime, parseServerDate, usageLevel } from '../lib/format'
import { translateDuration, type KeyInfo } from '../lib/keyInfo'
import { ActivityIcon, CalendarIcon, CheckIcon, ClockIcon, LayersIcon, RefreshIcon, ShieldIcon, ZapIcon } from './Icons'
import { StatCard } from './StatCard'
import { TimerCard } from './TimerCard'
import { UsageGauge } from './UsageGauge'

interface Props {
  data: UsageData
  keyInfo: KeyInfo | null
  now: number
  lastChecked: Date
  loading: boolean
  onRefresh: () => void
  autoRefresh: boolean
  onAutoRefreshChange: (v: boolean) => void
}

const STATUS_TEXT = {
  ok: 'Hạn mức còn thoải mái',
  warn: 'Sắp chạm giới hạn — cân nhắc sử dụng tiết kiệm',
  danger: 'Gần hết hoặc đã hết hạn mức',
} as const

export function Dashboard({ data, keyInfo, now, lastChecked, loading, onRefresh, autoRefresh, onAutoRefreshChange }: Props) {
  const budget = data.tokenBudget
  const used = data.tokensUsed
  // Plan keys (gateway on revidapi): what is usable now also depends on the week, the rental and the daily refill.
  const isPlan = data.plan != null
  const remaining = isPlan && data.available != null ? data.available : Math.max(0, budget - used)
  const percent = Number.isFinite(data.usagePercentage) ? data.usagePercentage : budget > 0 ? (used / budget) * 100 : 0
  const level = usageLevel(percent)
  const sessionPct = data.maxSessions > 0 ? (data.sessionsUsed / data.maxSessions) * 100 : 0

  const windowEnd = parseServerDate(data.windowEnd)
  const weeklyReset = parseServerDate(data.weeklyLimitResetAt)
  const expiry = keyExpiryInfo(data, keyInfo)
  const keyExpiry = expiry.target
  const keyExpired = keyExpiry ? keyExpiry.getTime() <= now : false

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
          <span className="eyebrow">{isPlan ? 'Token đã dùng trong phiên 5 giờ' : 'Token đã dùng trong chu kỳ'}</span>
          <div className="overview__numbers">
            <span className="mono overview__used">{formatNumber(used)}</span>
            <span className="overview__sep">/</span>
            <span className="mono overview__budget">{formatNumber(budget)}</span>
          </div>
          <div className={`bar bar--${level}`} aria-hidden>
            <div className="bar__fill" style={{ width: `${Math.min(100, percent)}%` }} />
            <span className="bar__mark" style={{ left: '70%' }} />
            <span className="bar__mark" style={{ left: '90%' }} />
          </div>
          <div className="overview__legend">
            <span>0</span>
            <span>{formatNumber(budget)}</span>
          </div>
          <div className={`status status--${level}`}>
            <span className="status__dot" />
            {STATUS_TEXT[level]}
          </div>
        </div>
      </div>

      <div className="grid grid--3">
        {isPlan ? (
          <StatCard
            icon={<LayersIcon />}
            label="Có thể dùng ngay"
            value={formatNumber(remaining)}
            hint={data.dailyRefill != null ? `mỗi ngày cộng thêm ${formatNumber(data.dailyRefill)}` : 'token'}
            tone="accent"
          />
        ) : (
          <StatCard
            icon={<LayersIcon />}
            label="Còn lại"
            value={formatNumber(remaining)}
            hint={`${Math.max(0, 100 - percent).toFixed(2)}% hạn mức`}
            tone="accent"
          />
        )}
        <StatCard icon={<ZapIcon />} label={isPlan ? 'Hạn mức phiên' : 'Tổng hạn mức'} value={formatNumber(budget)} hint={isPlan ? 'token / 5 giờ' : 'token / chu kỳ'} />
        <StatCard
          icon={<ActivityIcon />}
          label={isPlan ? 'Đã dùng trong tuần' : 'Sessions'}
          value={formatNumber(data.sessionsUsed)}
          hint={`trên ${formatNumber(data.maxSessions)} (${sessionPct.toFixed(sessionPct < 1 ? 2 : 1)}%)`}
        />
      </div>

      <div className="grid grid--3">
        <TimerCard
          icon={<ClockIcon />}
          title={isPlan ? 'Phiên 5 giờ đặt lại sau' : 'Chu kỳ hiện tại đặt lại sau'}
          target={windowEnd}
          emptyText={isPlan ? 'Chưa bắt đầu phiên' : undefined}
          now={now}
        />
        <TimerCard icon={<CalendarIcon />} title="Giới hạn tuần đặt lại sau" target={weeklyReset} now={now} />
        <TimerCard
          icon={<ShieldIcon />}
          title="Key hết hạn sau"
          target={keyExpiry}
          start={expiry.start}
          emptyText={expiry.viaGateway ? 'Không thời hạn' : undefined}
          now={now}
          note={expiry.note}
        />
      </div>
    </section>
  )
}

/**
 * Through our gateway the client's key stops working at whichever comes first: the ak_ expiry set by the
 * admin, or the agentshop key's own expiry (decoded server-side from its JWT). Calling agentshop directly,
 * the as_ JWT is decoded in the browser instead.
 */
function keyExpiryInfo(data: UsageData, keyInfo: KeyInfo | null) {
  const viaGateway = data.keyExpiresAt !== undefined
  if (!viaGateway) {
    return {
      viaGateway,
      target: keyInfo?.expiresAt ?? null,
      start: keyInfo?.issuedAt ?? null,
      note: keyInfo?.accountTime ? `Gói ${translateDuration(keyInfo.accountTime)}` : undefined,
    }
  }
  const own = parseServerDate(data.keyExpiresAt)
  const upstream = parseServerDate(data.upstreamExpiresAt)
  const upstreamFirst = upstream !== null && (own === null || upstream.getTime() <= own.getTime())
  const plan = data.plan
    ? `Gói ${data.tier}${data.planDays ? ` · ${data.planDays} ngày` : ''}`
    : data.upstreamPlan
      ? `Gói ${translateDuration(data.upstreamPlan)}`
      : undefined
  return {
    viaGateway,
    target: upstreamFirst ? upstream : own,
    start: upstreamFirst ? parseServerDate(data.upstreamIssuedAt) : parseServerDate(data.planStartedAt ?? null),
    note: [data.keyName, plan].filter(Boolean).join(' · ') || undefined,
  }
}

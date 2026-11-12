import { useEffect, useMemo, useState } from 'react'
import { AlertIcon, RefreshIcon } from '../components/Icons'
import {
  CREDIT_PACKS,
  DEFAULT_PLANS,
  DEFAULT_SETTINGS,
  quote,
  unitCost,
  type Plan,
  type PricingSettings,
  type Quote,
} from './pricing'

const STORAGE_KEY = 'quota-admin:pricing'
const TABLE_DAYS = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90]
const QUICK_DAYS = [1, 3, 7, 14, 30, 60, 90]

interface Saved {
  settings: PricingSettings
  plans: Plan[]
}

/** Calculator state is only a per-browser convenience: defaults always work without it. */
function load(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const v = JSON.parse(raw) as Saved
      if (v?.settings && Array.isArray(v.plans) && v.plans.length) return { settings: { ...DEFAULT_SETTINGS, ...v.settings }, plans: v.plans }
    }
  } catch {
    /* storage unavailable or corrupt: fall back to defaults */
  }
  return { settings: DEFAULT_SETTINGS, plans: DEFAULT_PLANS }
}

const vnd = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 })
const money = (v: number) => `${vnd.format(Math.round(v))}đ`
const tokens = (v: number) => (v >= 1e6 ? `${(v / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}M` : `${Math.round(v / 1000)}k`)
const pct = (v: number) => `${(v * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`

/**
 * Parses what people type. Money ("1.550.000", "1,550,000"): separators are dropped.
 * Decimals ("0,8", "0.8", "2,5"): either comma or dot is the decimal point.
 */
const parseNumber = (text: string, decimal: boolean) =>
  Number(decimal ? text.trim().replace(',', '.') : text.trim().replace(/[.,\s]/g, ''))

function NumberInput({ value, onChange, decimal = false, suffix, label, hint }: { value: number; onChange: (v: number) => void; decimal?: boolean; suffix?: string; label: string; hint?: string }) {
  const [text, setText] = useState(String(value))
  // Re-sync only when the value changed from outside (e.g. "reset"), not while typing "0," etc.
  useEffect(() => setText((t) => (parseNumber(t, decimal) === value ? t : String(value))), [value, decimal])
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <span className="pc-input">
        <input
          className="input"
          inputMode={decimal ? 'decimal' : 'numeric'}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            const n = parseNumber(e.target.value, decimal)
            if (e.target.value.trim() && Number.isFinite(n) && n >= 0) onChange(n)
          }}
        />
        {suffix && <span className="pc-input__suffix">{suffix}</span>}
      </span>
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  )
}

function Tile({ label, value, tone, sub }: { label: string; value: string; tone?: 'ok' | 'danger' | 'muted'; sub?: string }) {
  return (
    <div className={`pc-tile${tone ? ` pc-tile--${tone}` : ''}`}>
      <span className="pc-tile__label">{label}</span>
      <span className="pc-tile__value">{value}</span>
      {sub && <span className="pc-tile__sub">{sub}</span>}
    </div>
  )
}

export function PricingCalculator() {
  const [{ settings, plans }, setState] = useState<Saved>(load)
  const [planId, setPlanId] = useState(plans[0]?.id ?? 'pro')
  const [days, setDays] = useState(7)
  const [manualPrice, setManualPrice] = useState('')

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, plans }))
    } catch {
      /* ignore */
    }
  }, [settings, plans])

  const plan = plans.find((p) => p.id === planId) ?? plans[0]
  const setSettings = (patch: Partial<PricingSettings>) => setState((s) => ({ ...s, settings: { ...s.settings, ...patch } }))
  const setPlan = (id: string, patch: Partial<Plan>) => setState((s) => ({ ...s, plans: s.plans.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
  const setAnchor = (id: string, i: number, price: number) =>
    setState((s) => ({
      ...s,
      plans: s.plans.map((p) => (p.id === id ? { ...p, anchors: p.anchors.map((a, j) => (j === i ? { ...a, price } : a)) } : p)),
    }))
  const reset = () => setState({ settings: DEFAULT_SETTINGS, plans: DEFAULT_PLANS })

  const manual = parseNumber(manualPrice, false)
  const q: Quote = quote(plan, Math.max(1, days), settings, manualPrice.trim() && Number.isFinite(manual) ? manual : undefined)
  const rows = useMemo(() => TABLE_DAYS.map((d) => quote(plan, d, settings)), [plan, settings])
  const packId = CREDIT_PACKS.find((p) => p.price === settings.creditPrice)?.id

  return (
    <section className="admin pc">
      <div className="admin__head">
        <div>
          <h1>Bảng tính giá gói</h1>
          <p className="muted small">
            Tính giá, giá vốn và tiền lãi cho số ngày thuê bất kỳ. Chỉ lưu trên trình duyệt này; giá vốn tính theo bảng giá revidapi.
          </p>
        </div>
        <div className="admin__actions">
          <button type="button" className="btn btn--ghost" onClick={reset}>
            <RefreshIcon width={16} height={16} />
            Về bảng giá đã chốt
          </button>
        </div>
      </div>

      <div className="card pc-card">
        <h2 className="pc-h2">Giá vốn</h2>
        <div className="field">
          <span className="field__label">Gói nạp revidapi</span>
          <div className="presets">
            {CREDIT_PACKS.map((p) => (
              <button key={p.id} type="button" className={`chip${packId === p.id ? ' chip--on' : ''}`} onClick={() => setSettings({ creditPrice: p.price })}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="pc-grid">
          <NumberInput decimal label="Giá 1 credit" suffix="đ" value={settings.creditPrice} onChange={(v) => setSettings({ creditPrice: v })} />
          <NumberInput
            decimal
            label="Credit cho 1M token quy đổi"
            value={settings.creditsPerMTok}
            onChange={(v) => setSettings({ creditsPerMTok: v })}
            hint="Theo giá output Sonnet 5.5 của revidapi"
          />
          <NumberInput label="Khách dùng thường gặp" suffix="%" value={Math.round(settings.typicalUsage * 100)} onChange={(v) => setSettings({ typicalUsage: Math.min(v, 100) / 100 })} />
          <NumberInput label="Lãi tối thiểu (giá sàn)" suffix="%" value={Math.round(settings.minMargin * 100)} onChange={(v) => setSettings({ minMargin: v / 100 })} />
        </div>
        <p className="field__hint">
          Giá vốn: <b>{money(unitCost(settings) * 1e6)}</b> cho mỗi 1M token quy đổi.
        </p>
      </div>

      <div className="card pc-card">
        <h2 className="pc-h2">Tính cho số ngày bất kỳ</h2>
        <div className="seg" role="tablist" aria-label="Chọn gói">
          {plans.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={p.id === plan.id} onClick={() => setPlanId(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
        <div className="pc-grid">
          <NumberInput label="Số ngày thuê" suffix="ngày" value={days} onChange={(v) => setDays(Math.max(1, Math.round(v)))} />
          <label className="field">
            <span className="field__label">Giá bán (để trống = giá đề xuất)</span>
            <input className="input" inputMode="numeric" placeholder={vnd.format(quote(plan, days, settings).price)} value={manualPrice} onChange={(e) => setManualPrice(e.target.value)} />
          </label>
        </div>
        <div className="presets">
          {QUICK_DAYS.map((d) => (
            <button key={d} type="button" className={`chip${d === days ? ' chip--on' : ''}`} onClick={() => setDays(d)}>
              {d} ngày
            </button>
          ))}
        </div>

        <div className="pc-tiles">
          <Tile label="Giá bán" value={money(q.price)} sub={`${money(q.pricePerDay)}/ngày`} />
          <Tile label="Hạn mức được dùng" value={tokens(q.allowance)} sub={`phiên 5h ${tokens(plan.sessionCap)} · tuần ${tokens(plan.weeklyCap)}`} />
          <Tile label="Giá vốn tối đa" value={money(q.maxCost)} sub="khi khách dùng hết" tone="muted" />
          <Tile label="Giá sàn" value={money(q.floor)} sub={`lãi ${pct(settings.minMargin)} khi dùng hết`} tone="muted" />
          <Tile label="Lãi xấu nhất" value={money(q.worstProfit)} sub={pct(q.worstMargin)} tone={q.worstProfit < 0 ? 'danger' : 'ok'} />
          <Tile label="Lãi thường gặp" value={money(q.typicalProfit)} sub={`khách dùng ${pct(settings.typicalUsage)}`} tone={q.typicalProfit < 0 ? 'danger' : 'ok'} />
        </div>
        {q.worstProfit < 0 && (
          <div className="notice notice--warn">
            <AlertIcon width={16} height={16} />
            <span>
              Khách dùng quá {pct(q.price / q.maxCost)} hạn mức là lỗ. Giá sàn để luôn có lãi {pct(settings.minMargin)}: {money(q.floor)}.
            </span>
          </div>
        )}
      </div>

      <div className="card table-card">
        <table className="ktable pc-table">
          <thead>
            <tr>
              <th>Số ngày</th>
              <th>Hạn mức</th>
              <th>Giá đề xuất</th>
              <th>Giá/ngày</th>
              <th>Giá vốn tối đa</th>
              <th>Giá sàn</th>
              <th>Lãi xấu nhất</th>
              <th>Lãi thường gặp</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.days} className={r.worstProfit < 0 ? 'pc-row--loss' : r.days === days ? 'pc-row--on' : undefined} onClick={() => setDays(r.days)}>
                <td data-label="Số ngày">{r.days}</td>
                <td data-label="Hạn mức">{tokens(r.allowance)}</td>
                <td data-label="Giá đề xuất">{money(r.price)}</td>
                <td data-label="Giá/ngày">{money(r.pricePerDay)}</td>
                <td data-label="Giá vốn tối đa">{money(r.maxCost)}</td>
                <td data-label="Giá sàn">{money(r.floor)}</td>
                <td data-label="Lãi xấu nhất">
                  {money(r.worstProfit)} <span className="muted">({pct(r.worstMargin)})</span>
                </td>
                <td data-label="Lãi thường gặp">{money(r.typicalProfit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card pc-card">
        <h2 className="pc-h2">Hạn mức và giá mốc của từng gói</h2>
        <div className="pc-plans">
          {plans.map((p) => (
            <div key={p.id} className="pc-plan">
              <h3>{p.name}</h3>
              <div className="pc-grid">
                <NumberInput decimal label="Trần phiên 5h" suffix="M token" value={p.sessionCap / 1e6} onChange={(v) => setPlan(p.id, { sessionCap: v * 1e6 })} />
                <NumberInput decimal label="Trần tuần" suffix="M token" value={p.weeklyCap / 1e6} onChange={(v) => setPlan(p.id, { weeklyCap: v * 1e6 })} />
                {p.anchors.map((a, i) => (
                  <NumberInput key={a.days} label={`Giá ${a.days} ngày`} suffix="đ" value={a.price} onChange={(v) => setAnchor(p.id, i, v)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <details className="card pc-card pc-formula">
        <summary>Công thức</summary>
        <ul>
          <li>
            <b>Token quy đổi</b>: 1 token output = 1; 1 token input hoặc ghi cache = 0,36; 1 token đọc cache = 0,036 (đo trên revidapi). Model Opus 5.5 nhân 2,4 (Opus 5 nhân 3); Haiku nhân 0,51.
          </li>
          <li>
            <b>Hạn mức thuê d ngày</b> = max(trần phiên 5h, trần tuần × d ÷ 7).
          </li>
          <li>
            <b>Giá vốn mỗi token</b> = giá 1 credit × số credit cho 1M token quy đổi ÷ 1.000.000.
          </li>
          <li>
            <b>Giá vốn tối đa</b> = hạn mức × giá vốn mỗi token (khi khách dùng hết).
          </li>
          <li>
            <b>Giá đề xuất</b> = nội suy tuyến tính giữa các mốc giá của gói; quá mốc cuối thì lấy giá/ngày của mốc cuối × d. Làm tròn tới 1.000đ.
          </li>
          <li>
            <b>Giá sàn</b> = giá vốn tối đa × (1 + lãi tối thiểu), làm tròn lên 1.000đ.
          </li>
          <li>
            <b>Lãi xấu nhất</b> = giá − giá vốn tối đa. <b>Lãi thường gặp</b> = giá − giá vốn tối đa × tỷ lệ dùng thường gặp.
          </li>
        </ul>
      </details>
    </section>
  )
}

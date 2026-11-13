import { fmtTokenCount, MODEL_LABELS, MODEL_RATES, PACKS, packMargin, TRIAL, TYPICAL_TURN, tokensPerCredit, tokensWorth, type ModelId } from './pricing'

const vnd = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 })
const money = (v: number) => `${vnd.format(Math.round(v))}đ`
const MODELS = Object.keys(MODEL_RATES) as ModelId[]

/**
 * The confirmed price table. Packages are revid's credit packs with no time limit - so there is
 * nothing to interpolate by days anymore. This page is a reference: what each package costs,
 * how much it is sold for, the margin if the customer uses it all, and roughly how many tokens it buys.
 */
export function PricingCalculator() {
  return (
    <section className="admin pc">
      <div className="admin__head">
        <div>
          <h1>Bảng giá gói</h1>
          <p className="muted small">
            Bốn gói credit của revid. Gói không thời hạn: khách dùng khi nào cũng được cho tới khi hết credit. Số token là ước
            tính từ bảng giá credit của revid cho từng model (mã nguồn: src/admin/pricing.ts).
          </p>
        </div>
      </div>

      <div className="card table-card">
        <table className="ktable pc-table">
          <thead>
            <tr>
              <th>Gói</th>
              <th>Credit</th>
              <th>Giá vốn (revid)</th>
              <th>Giá bán</th>
              <th>Lãi nếu dùng hết</th>
              {MODELS.map((m) => (
                <th key={m}>~Token {MODEL_LABELS[m]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PACKS.map((p) => (
              <tr key={p.id}>
                <td data-label="Gói">
                  <b>{p.name}</b>
                </td>
                <td data-label="Credit">{p.credits.toLocaleString('vi-VN')}</td>
                <td data-label="Giá vốn">{money(p.costVnd)}</td>
                <td data-label="Giá bán">{money(p.priceVnd)}</td>
                <td data-label="Lãi nếu dùng hết" className="pc-row--ok">
                  {money(packMargin(p))} <span className="muted">({((packMargin(p) / p.priceVnd) * 100).toFixed(1)}%)</span>
                </td>
                {MODELS.map((m) => (
                  <td key={m} data-label={`Token ${MODEL_LABELS[m]}`}>
                    {fmtTokenCount(tokensWorth(p.credits, m))}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td data-label="Gói">
                <b>{TRIAL.name}</b>
              </td>
              <td data-label="Credit">—</td>
              <td data-label="Giá vốn">tối đa ~3.600đ</td>
              <td data-label="Giá bán">miễn phí</td>
              <td data-label="Lãi nếu dùng hết">
                <span className="muted">—</span>
              </td>
              <td data-label="Giới hạn" colSpan={MODELS.length}>
                {TRIAL.tokenCap.toLocaleString('vi-VN')} token quy đổi, theo phút (mặc định {TRIAL.defaultMinutes} phút)
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card pc-card">
        <h2 className="pc-h2">Ghi chú</h2>
        <ul className="pc-notes">
          <li>Gói trả phí không có thời hạn — khách dùng bất kỳ lúc nào cho tới khi hết số credit. Gateway không bao giờ cho dùng quá số credit của gói.</li>
          <li>Gói dùng thử: tối đa 100.000 token quy đổi trong thời gian (theo phút) mà admin đặt, mặc định 60 phút.</li>
          <li>
            Token ước tính cho một lượt Claude Code điển hình: đọc lại {fmtTokenCount(TYPICAL_TURN.cacheRead)} token từ cache, ghi mới{' '}
            {fmtTokenCount(TYPICAL_TURN.cacheWrite)}, trả lời {fmtTokenCount(TYPICAL_TURN.output)} — tức 1 credit ≈{' '}
            {MODELS.map((m) => `${fmtTokenCount(tokensPerCredit(m))} token ${MODEL_LABELS[m]}`).join(' / ')}. Số token tính cả phần đọc
            từ cache (giống số Claude Code hiển thị).
          </li>
          <li>
            Chat ngắn hoặc trả lời dài thì được ít token hơn: token output đắt nhất, 1 credit chỉ bằng{' '}
            {MODELS.map((m) => `${Math.round(1e6 / MODEL_RATES[m].out).toLocaleString('vi-VN')} token output ${MODEL_LABELS[m]}`).join(' / ')}.
            Số credit mới là giới hạn chính xác, token chỉ để dễ hình dung.
          </li>
        </ul>
      </div>
    </section>
  )
}

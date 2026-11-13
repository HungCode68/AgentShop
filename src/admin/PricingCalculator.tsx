import { PACKS, TRIAL, packMargin, tokensWorth } from './pricing'

const vnd = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 })
const money = (v: number) => `${vnd.format(Math.round(v))}đ`
const fmtTokens = (n: number) => `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}M`

/**
 * The confirmed price table. Packages are revid's credit packs sold at cost + 30.000đ, with no
 * time limit - so there is nothing to interpolate by days anymore. This page is a reference:
 * what each package costs, how much it is sold for, and the margin if the customer uses it all.
 */
export function PricingCalculator() {
  return (
    <section className="admin pc">
      <div className="admin__head">
        <div>
          <h1>Bảng giá gói</h1>
          <p className="muted small">
            Bốn gói credit của revid, bán giá vốn + 30.000đ. Gói không thời hạn: khách dùng khi nào cũng được cho tới khi
            hết credit. Số token là ước tính theo giá credit của revid (mã nguồn: gateway/src/plans.js).
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
              <th>Ước tính token (Sonnet 5.5)</th>
              <th>Ước tính token (Opus 5.5)</th>
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
                <td data-label="Token Sonnet">
                  {fmtTokens(tokensWorth(p.credits))}
                </td>
                <td data-label="Token Opus">
                  {fmtTokens(tokensWorth(p.credits, true))}
                </td>
              </tr>
            ))}
            <tr>
              <td data-label="Gói">
                <b>{TRIAL.name}</b>
              </td>
              <td data-label="Credit">—</td>
              <td data-label="Giá vốn">miễn phí</td>
              <td data-label="Giá bán">{money(TRIAL.priceVnd)}</td>
              <td data-label="Lãi nếu dùng hết">
                <span className="muted">giá vốn tối đa ~3.600đ</span>
              </td>
              <td data-label="Token Sonnet">{TRIAL.tokenCap.toLocaleString('vi-VN')} token</td>
              <td data-label="Token Opus">{TRIAL.tokenCap.toLocaleString('vi-VN')} token</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card pc-card">
        <h2 className="pc-h2">Ghi chú</h2>
        <ul className="pc-notes">
          <li>Gói trả phí không có thời hạn — khách dùng trong bất kỳ lúc nào cho tới khi hết số credit.</li>
          <li>Gói dùng thử: tối đa 100.000 token trong thời gian (theo phút) mà admin đặt, mặc định 60 phút.</li>
          <li>Chỉ 3 model: Sonnet 5.5, Opus 5.5, Haiku 5.5.</li>
          <li>Giá ước tính token: 1 credit ≈ 17.000 token (code Sonnet, có cache) / 7.000 token (Opus). Số credit mới là giới hạn chính xác, token chỉ để dễ hình dung.</li>
        </ul>
      </div>
    </section>
  )
}

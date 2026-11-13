import { fmtTokenCount, MODEL_LABELS, MODEL_RATES, PACKS, packMargin, PROFILES, TRIAL, tokensWorth, type ModelId, type UsageProfile } from './pricing'

const vnd = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 })
const money = (v: number) => `${vnd.format(Math.round(v))}đ`
const MODELS = Object.keys(MODEL_RATES) as ModelId[]
const PROFILE_IDS = Object.keys(PROFILES) as UsageProfile[]

/**
 * The confirmed price table. Packages are revid's credit packs with no time limit. This page is a
 * reference: what each package costs, how much it is sold for, the margin if the customer uses it
 * all, and roughly how many tokens it buys (estimated the same way revid estimates its own packs).
 */
export function PricingCalculator() {
  return (
    <section className="admin pc">
      <div className="admin__head">
        <div>
          <h1>Bảng giá gói</h1>
          <p className="muted small">
            Bốn gói credit của revid. Gói không thời hạn: khách dùng khi nào cũng được cho tới khi hết credit.
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
              </tr>
            ))}
            <tr>
              <td data-label="Gói">
                <b>{TRIAL.name}</b>
              </td>
              <td data-label="Credit">—</td>
              <td data-label="Giá vốn">tối đa ~3.600đ</td>
              <td data-label="Giá bán">miễn phí</td>
              <td data-label="Giới hạn">
                {TRIAL.tokenCap.toLocaleString('vi-VN')} token quy đổi, mặc định {TRIAL.defaultMinutes} phút
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {PROFILE_IDS.map((profile) => (
        <div className="card table-card" key={profile}>
          <h2 className="pc-h2" style={{ padding: '16px 16px 0' }}>
            Token ước tính — {PROFILES[profile].label}
          </h2>
          <table className="ktable pc-table">
            <thead>
              <tr>
                <th>Model</th>
                {PACKS.map((p) => (
                  <th key={p.id}>{p.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MODELS.map((m) => (
                <tr key={m}>
                  <td data-label="Model">
                    <b>{MODEL_LABELS[m]}</b>
                  </td>
                  {PACKS.map((p) => (
                    <td key={p.id} data-label={p.name}>
                      {fmtTokenCount(tokensWorth(p.credits, m, profile))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="card pc-card">
        <h2 className="pc-h2">Ghi chú</h2>
        <ul className="pc-notes">
          <li>Gói trả phí không có thời hạn — khách dùng bất kỳ lúc nào cho tới khi hết số credit. Gateway không bao giờ cho dùng quá số credit của gói.</li>
          <li>Gói dùng thử: tối đa 100.000 token quy đổi trong thời gian (theo phút) mà admin đặt, mặc định 60 phút.</li>
          <li>
            Token ước tính tính theo cùng cách revid công bố cho gói của họ: <b>Code</b> = ngữ cảnh gửi lại mỗi lượt, phần lặp đọc từ
            cache (tỉ lệ 8 đọc cache : 1 ghi mới : 1 trả lời); <b>Chat thường</b> = mỗi câu hỏi gửi riêng, không cache (~1.000 token
            vào, ~500 token ra). Dùng thực tế có thể cao hoặc thấp hơn tuỳ độ dài hội thoại và câu trả lời.
          </li>
          <li>Số credit mới là giới hạn chính xác, token chỉ để dễ hình dung.</li>
        </ul>
      </div>
    </section>
  )
}

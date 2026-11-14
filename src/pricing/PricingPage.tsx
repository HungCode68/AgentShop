import { useState } from 'react'
import { CheckIcon, LayersIcon, ShieldIcon, ZapIcon } from '../components/Icons'
import { Topbar } from '../components/Topbar'
import {
  FREE_TRIAL,
  fmtTokenCount,
  fmtVnd,
  MODEL_LABELS,
  MODELS,
  PACKS,
  POPULAR_PACK,
  roundEstimate,
  TASKS,
  tasksPerPack,
  tokensPerCredit,
  tokensWorth,
  type ModelId,
} from '../lib/packs'
import './pricing.css'

const num = (n: number) => roundEstimate(n).toLocaleString('vi-VN')
const chatTask = TASKS.find((t) => t.id === 'chat')!
const codeTask = TASKS.find((t) => t.id === 'code')!

/** Cost of a model relative to Sonnet, for the same work (Claude Code profile). */
const relativeCost = (m: ModelId) => tokensPerCredit('claude-sonnet-5-5') / tokensPerCredit(m)

const MODEL_INFO: Record<ModelId, { tag: string; text: string }> = {
  'claude-haiku-5-5': { tag: 'Nhanh, tiết kiệm nhất', text: 'Câu hỏi nhanh, dịch, tóm tắt, phân loại. Claude Code dùng Haiku cho các việc phụ (tìm kiếm, đọc file).' },
  'claude-sonnet-5-5': { tag: 'Khuyên dùng', text: 'Cân bằng giữa chất lượng và chi phí. Phù hợp code hằng ngày, viết bài, phân tích tài liệu.' },
  'claude-opus-5-5': { tag: 'Mạnh nhất', text: 'Việc khó: thiết kế hệ thống, debug phức tạp, lập luận nhiều bước. Tốn credit nhiều nhất.' },
}
const MODEL_ORDER: ModelId[] = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']

const FAQ = [
  {
    q: 'Credit là gì?',
    a: 'Đơn vị tính phí của hệ thống. Mỗi câu trả lời trừ số credit đúng bằng chi phí thật của nó, tuỳ model và số token. Số credit còn lại xem ở trang Kiểm tra hạn mức.',
  },
  {
    q: 'Số token và số lượt trên trang này có chính xác không?',
    a: 'Đây là ước tính cho cách dùng điển hình. Thực tế thay đổi theo độ dài hội thoại và câu trả lời: hội thoại dài đọc lại nhiều từ cache nên được nhiều token hơn, câu trả lời dài thì tốn hơn vì token trả lời đắt nhất. Số credit của gói mới là giới hạn chính xác.',
  },
  {
    q: 'Gói có thời hạn không?',
    a: 'Không. Bạn dùng lúc nào cũng được cho tới khi hết credit, không mất credit theo ngày hay theo tháng.',
  },
  {
    q: 'Hết credit thì sao?',
    a: 'Hệ thống dừng nhận yêu cầu mới và báo bằng tiếng Việt, không bao giờ trừ quá số credit đã mua. Muốn dùng tiếp thì mua thêm gói.',
  },
  {
    q: 'Dùng ở đâu?',
    a: 'Claude Code trong VS Code hoặc terminal (cài bằng 1 lệnh), và app Claude Desktop trên máy tính (Windows, macOS). Xem trang Hướng dẫn.',
  },
  {
    q: 'Có dùng thử miễn phí không?',
    a: `Có. Liên hệ để nhận key dùng thử: tối đa ${FREE_TRIAL.tokenCap.toLocaleString('vi-VN')} token trong thời gian được cấp (thường ${FREE_TRIAL.defaultMinutes} phút).`,
  },
]

export default function PricingPage() {
  const [model, setModel] = useState<ModelId>('claude-sonnet-5-5')

  return (
    <div className="app">
      <div className="bg-glow" aria-hidden />
      <Topbar>
        <a className="btn btn--ghost" href="/huong-dan">
          Hướng dẫn
        </a>
        <a className="btn btn--ghost" href="/">
          Kiểm tra hạn mức
        </a>
      </Topbar>

      <main className="container pricing">
        <section className="hero">
          <h1>Bảng giá Claude</h1>
          <p>Mua một lần, không thời hạn. Dùng Claude Sonnet, Opus và Haiku qua app Claude Desktop hoặc Claude Code (VS Code).</p>
          <ul className="pricing-points">
            <li>
              <CheckIcon width={15} height={15} /> Không thời hạn
            </li>
            <li>
              <CheckIcon width={15} height={15} /> Trừ đúng theo lượng dùng thật
            </li>
            <li>
              <CheckIcon width={15} height={15} /> Không bao giờ trừ quá gói
            </li>
          </ul>
        </section>

        <section className="pack-grid" aria-label="Các gói">
          {PACKS.map((p) => {
            const popular = p.id === POPULAR_PACK
            return (
              <article key={p.id} className={`card pack${popular ? ' pack--popular' : ''}`}>
                {popular && <span className="pack__badge">Phổ biến</span>}
                <h2 className="pack__name">{p.name}</h2>
                <p className="pack__tagline">{p.tagline}</p>
                <div className="pack__price">{fmtVnd(p.priceVnd)}</div>
                <div className="pack__credits">
                  <b>{p.credits.toLocaleString('vi-VN')}</b> credit
                  <span className="pack__per muted">{Math.round(p.priceVnd / p.credits)}đ / credit</span>
                </div>
                <ul className="pack__list">
                  <li>
                    ≈ <b>{fmtTokenCount(tokensWorth(p.credits))}</b> token khi code
                  </li>
                  <li>
                    ≈ <b>{num(tasksPerPack(p.credits, codeTask, 'claude-sonnet-5-5'))}</b> lượt Claude Code
                  </li>
                  <li>
                    ≈ <b>{num(tasksPerPack(p.credits, chatTask, 'claude-sonnet-5-5'))}</b> câu hỏi chat
                  </li>
                  <li>Không thời hạn</li>
                </ul>
                <p className="pack__note">Ước tính với Sonnet 5.5</p>
              </article>
            )
          })}
        </section>

        <section className="card pricing-section" id="cong-viec">
          <div className="pricing-section__head">
            <div>
              <h2>Mỗi gói làm được bao nhiêu việc?</h2>
              <p className="small muted">Ước tính cho cách dùng điển hình, đã gồm phần hệ thống tự gửi kèm mỗi yêu cầu.</p>
            </div>
            <div className="model-tabs" role="tablist" aria-label="Chọn model">
              {MODELS.map((m) => (
                <button key={m} type="button" role="tab" aria-selected={model === m} className={model === m ? 'is-on' : ''} onClick={() => setModel(m)}>
                  {MODEL_LABELS[m]}
                </button>
              ))}
            </div>
          </div>

          <p className="table-hint small muted">Vuốt ngang bảng để xem các gói khác →</p>
          <div className="table-scroll">
            <table className="work-table">
              <thead>
                <tr>
                  <th>Loại công việc</th>
                  {PACKS.map((p) => (
                    <th key={p.id}>
                      {p.name}
                      <span>{p.credits.toLocaleString('vi-VN')} credit</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TASKS.map((t) => (
                  <tr key={t.id}>
                    <th scope="row">
                      {t.title}
                      <span>{t.example}</span>
                    </th>
                    {PACKS.map((p) => (
                      <td key={p.id}>
                        <b>{num(tasksPerPack(p.credits, t, model))}</b>
                        <span>{t.unit}</span>
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="work-table__total">
                  <th scope="row">
                    Tổng token khi code
                    <span>Tính cả token đọc lại từ cache, giống số Claude Code hiển thị.</span>
                  </th>
                  {PACKS.map((p) => (
                    <td key={p.id}>
                      <b>{fmtTokenCount(tokensWorth(p.credits, model, 'code'))}</b>
                      <span>token</span>
                    </td>
                  ))}
                </tr>
                <tr className="work-table__total">
                  <th scope="row">
                    Tổng token khi chat
                    <span>Mỗi câu hỏi gửi riêng, khoảng 1.000 token vào, 500 token ra.</span>
                  </th>
                  {PACKS.map((p) => (
                    <td key={p.id}>
                      <b>{fmtTokenCount(tokensWorth(p.credits, model, 'chat'))}</b>
                      <span>token</span>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="pricing-models" aria-label="Chọn model">
          <h2>Chọn model nào?</h2>
          <div className="pricing-models__grid">
            {MODEL_ORDER.map((m) => {
              const ratio = relativeCost(m)
              return (
                <div key={m} className={`card model-card${m === 'claude-sonnet-5-5' ? ' model-card--pick' : ''}`}>
                  <div className="model-card__head">
                    <span className="model-card__icon">{m === 'claude-haiku-5-5' ? <ZapIcon /> : m === 'claude-sonnet-5-5' ? <LayersIcon /> : <ShieldIcon />}</span>
                    <div>
                      <h3>{MODEL_LABELS[m]}</h3>
                      <span className="model-card__tag">{MODEL_INFO[m].tag}</span>
                    </div>
                  </div>
                  <p>{MODEL_INFO[m].text}</p>
                  <div className="model-card__cost">
                    {m === 'claude-sonnet-5-5' ? 'Mức chuẩn' : `≈ ${ratio.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}× credit so với Sonnet`}
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <section className="card pricing-section pricing-faq">
          <h2>Câu hỏi thường gặp</h2>
          <dl>
            {FAQ.map((f) => (
              <div key={f.q}>
                <dt>{f.q}</dt>
                <dd>{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="pricing-cta">
          <p>Đã có key? Cài đặt trong vài phút hoặc xem số credit còn lại.</p>
          <div>
            <a className="btn btn--primary" href="/huong-dan">
              Xem hướng dẫn cài đặt
            </a>
            <a className="btn btn--ghost pricing-cta__ghost" href="/">
              Kiểm tra hạn mức
            </a>
          </div>
        </section>
      </main>

      <footer className="footer">
        Giá tính bằng VNĐ. Số token và số lượt là ước tính theo bảng giá credit đo thực tế (11/2026); giới hạn chính xác là số credit của gói.
      </footer>
    </div>
  )
}

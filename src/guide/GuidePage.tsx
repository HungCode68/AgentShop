import { useState } from 'react'
import { Topbar } from '../components/Topbar'
import { API_HOST, CLAUDE_CODE_GUIDE, CopyField, knownKey, mask, Step, useHashScroll } from './shared'

/** Official Claude Desktop download page. */
const DOWNLOAD_URL = 'https://claude.ai/download'

// Links sent before the Claude Code setup moved to its own page (/huong-dan#cai-nhanh) go there.
if (window.location.hash === '#cai-nhanh') {
  window.location.replace(CLAUDE_CODE_GUIDE + window.location.search)
}

const TOC = [
  { href: '#desktop', title: 'Claude Desktop (máy tính)', desc: 'Hỏi đáp, chat ngay trong app Claude chính thức. 6 bước có ảnh, khoảng 3 phút.' },
  { href: CLAUDE_CODE_GUIDE, title: 'Claude Code (VS Code)', desc: 'Dùng Claude để viết code. Cài bằng 1 lệnh, có hướng dẫn từng bước.' },
  { href: '#gap-loi', title: 'Gặp lỗi?', desc: 'Các lỗi thường gặp và cách xử lý.' },
]

/**
 * Claude Desktop with "third-party inference": the official app sends its requests to our gateway
 * (Developer > Configure Third-Party Inference > Gateway), using the customer's ak_ key.
 */
export default function GuidePage() {
  const [key] = useState(knownKey)
  useHashScroll()
  const claudeCodeLink = CLAUDE_CODE_GUIDE + window.location.search

  return (
    <div className="app">
      <div className="bg-glow" aria-hidden />
      <Topbar>
        <a className="btn btn--ghost" href="/bang-gia">Bảng giá</a>
        <a className="btn btn--ghost" href="/">Kiểm tra hạn mức</a>
      </Topbar>

      <main className="container guide">
        <section className="hero">
          <h1>Hướng dẫn dùng Claude</h1>
          <p>Bạn chỉ cần API key dạng ak_… đã được cấp. Chọn cách bạn muốn dùng:</p>
        </section>

        <nav className="guide-toc" aria-label="Mục lục">
          {TOC.map((item) => (
            <a key={item.href} className="card guide-toc__item" href={item.href === CLAUDE_CODE_GUIDE ? claudeCodeLink : item.href}>
              <span className="guide-toc__title">{item.title}</span>
              <span className="guide-toc__desc">{item.desc}</span>
            </a>
          ))}
        </nav>

        <div className="card guide-keys" id="desktop">
          <h2>Hai thông tin bạn sẽ dán vào Claude Desktop</h2>
          <CopyField label="Gateway base URL" value={API_HOST} />
          {key ? (
            <CopyField label="Gateway API key" value={key} display={mask(key)} />
          ) : (
            <p className="small muted">
              Gateway API key: dùng key <span className="mono">ak_…</span> quản trị viên đã gửi cho bạn.
            </p>
          )}
        </div>

        <Step n={1} title="Tải và cài Claude Desktop">
          <p>
            Vào{' '}
            <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
              claude.ai/download
            </a>{' '}
            và tải bản cho máy của bạn (Windows hoặc macOS), cài xong thì mở app lên. Nếu app yêu cầu đăng nhập, dùng tài khoản Claude miễn phí
            là đủ: các câu trả lời sẽ đi qua key của bạn, không dùng hạn mức của tài khoản đó.
          </p>
        </Step>

        <Step n={2} title="Bật Developer Mode" img="desktop-2-developer-mode.png" alt="Menu Help, Troubleshooting, Enable Developer Mode trong Claude Desktop">
          <p>
            Bấm biểu tượng menu <b>☰</b> ở góc trên bên trái, chọn <b>① Help</b> → <b>② Troubleshooting</b> → <b>③ Enable Developer Mode…</b>,
            rồi đồng ý nếu app hỏi xác nhận.
          </p>
          <p className="small muted">Chỉ cần làm một lần. Sau bước này menu sẽ có thêm mục Developer.</p>
        </Step>

        <Step
          n={3}
          title="Mở Configure Third-Party Inference"
          img="desktop-3-third-party.png"
          alt="Menu Developer, mục Configure Third-Party Inference trong Claude Desktop"
        >
          <p>
            Bấm lại <b>① ☰</b>, chọn <b>② Developer</b> → <b>③ Configure Third-Party Inference…</b>
          </p>
        </Step>

        <Step n={4} title="Điền thông tin kết nối" img="desktop-4-connection.png" alt="Cửa sổ Configure third-party inference với các ô cần điền">
          <p>Trong mục Connection, làm theo đúng số trên ảnh:</p>
          <ol className="guide-list">
            <li>
              Chọn <b>Gateway</b> trong ô đầu tiên.
            </li>
            <li>
              <b>Credential kind</b>: chọn <b>Static API key</b>.
            </li>
            <li>
              <b>Gateway base URL</b>: dán <span className="mono">{API_HOST}</span>
            </li>
            <li>
              <b>Gateway API key</b>: dán key <span className="mono">ak_…</span> của bạn.
            </li>
            <li>
              Bấm <b>Test connection</b>: chấm chuyển <b className="guide-ok">xanh</b> là kết nối được.
            </li>
            <li>
              Bấm <b>Apply Changes</b>.
            </li>
          </ol>
          <p className="small muted">
            Các ô còn lại (Gateway auth scheme, Artifact preview…) để trống. Không thêm <span className="mono">/v1</span> hay dấu{' '}
            <span className="mono">/</span> vào cuối địa chỉ.
          </p>
          <div className="guide-inline-copy">
            <CopyField label="Gateway base URL" value={API_HOST} />
            {key && <CopyField label="Gateway API key" value={key} display={mask(key)} />}
          </div>
        </Step>

        <Step n={5} title="Bấm Save & Restart" img="desktop-5-restart.png" alt="Hộp thoại Save & Restart của Claude Desktop">
          <p>
            Claude Desktop hỏi khởi động lại để dùng cấu hình mới: bấm <b>Save &amp; Restart</b>. App sẽ tự tắt và mở lại.
          </p>
        </Step>

        <Step n={6} title="Chọn model và bắt đầu chat">
          <p>
            Ở ô chat, bấm vào tên model (góc phải ô chat) và chọn <b>Sonnet 5.5</b> (khuyên dùng), <b>Haiku 5.5</b> (tiết kiệm) hoặc{' '}
            <b>Opus 5.5</b> (mạnh nhất), rồi gõ câu hỏi và chat như bình thường.
          </p>
          <p className="small muted">
            Chỉ 3 model trên dùng được với key của bạn; chọn model khác sẽ báo lỗi. Số credit đã dùng xem ở trang{' '}
            <a href="/">Kiểm tra hạn mức</a>.
          </p>
        </Step>

        <a className="card guide-next" href={claudeCodeLink}>
          <span>
            <b>Dùng Claude để viết code trong VS Code?</b>
            <span className="small muted">Cài Claude Code bằng 1 lệnh, có hướng dẫn từng bước kèm ảnh.</span>
          </span>
          <span className="guide-next__arrow" aria-hidden>
            →
          </span>
        </a>

        <section className="card guide-faq" id="gap-loi">
          <h2>Gặp lỗi?</h2>
          <dl>
            <dt>Không thấy mục Developer trong menu</dt>
            <dd>Làm lại bước 2 (Enable Developer Mode), rồi tắt hẳn Claude Desktop và mở lại.</dd>
            <dt>Test connection không xanh</dt>
            <dd>
              Kiểm tra lại Gateway base URL đúng như bước 4 (không thừa <span className="mono">/v1</span> hay dấu <span className="mono">/</span>{' '}
              ở cuối) và key dán đủ, không thừa dấu cách. Credential kind phải là Static API key.
            </dd>
            <dt>Chat báo lỗi model</dt>
            <dd>
              Chọn lại <b>Sonnet 5.5</b>, <b>Haiku 5.5</b> hoặc <b>Opus 5.5</b> như bước 6.
            </dd>
            <dt>Báo hết credit hoặc key hết hạn</dt>
            <dd>
              Xem số credit còn lại ở trang <a href="/">Kiểm tra hạn mức</a>, xem các gói ở trang <a href="/bang-gia">Bảng giá</a>, hoặc liên hệ
              quản trị viên.
            </dd>
          </dl>
        </section>
      </main>

      <footer className="footer">Key chỉ lưu trong Claude Desktop trên máy bạn, đừng chia sẻ key cho người khác.</footer>
    </div>
  )
}

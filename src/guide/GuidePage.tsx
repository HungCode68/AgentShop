import { useState } from 'react'
import { Topbar } from '../components/Topbar'
import { API_HOST, CLAUDE_CODE_GUIDE, CopyField, knownKey, mask, Step, useHashScroll } from './shared'

const DOWNLOAD_URL = 'https://chatboxai.app'

// Links sent before the Claude Code setup moved to its own page (/huong-dan#cai-nhanh) go there.
if (window.location.hash === '#cai-nhanh') {
  window.location.replace(CLAUDE_CODE_GUIDE + window.location.search)
}

const TOC = [
  { href: '#chatbox', title: 'App Chatbox (máy tính)', desc: 'Hỏi đáp, chat. 6 bước có ảnh, khoảng 3 phút.' },
  { href: CLAUDE_CODE_GUIDE, title: 'Claude Code (VS Code)', desc: 'Dùng Claude để viết code. Cài bằng 1 lệnh, có hướng dẫn từng bước.' },
  { href: '#gap-loi', title: 'Gặp lỗi?', desc: 'Các lỗi thường gặp và cách xử lý.' },
]

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

        <div className="card guide-keys" id="chatbox">
          <h2>Hai thông tin bạn sẽ dán vào Chatbox</h2>
          <CopyField label="API Host" value={API_HOST} />
          {key ? (
            <CopyField label="API Key" value={key} display={mask(key)} />
          ) : (
            <p className="small muted">
              API Key: dùng key <span className="mono">ak_…</span> quản trị viên đã gửi cho bạn.
            </p>
          )}
        </div>

        <Step n={1} title="Tải và cài app Chatbox" img="1-download.png" alt="Trang tải Chatbox với các bản cho Windows, macOS và Linux">
          <p>
            Vào{' '}
            <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
              chatboxai.app
            </a>
            , bấm <b>Download</b> và chọn đúng bản cho máy tính của bạn: Windows, macOS (Apple Silicon hoặc Intel) hoặc Linux. Cài xong thì mở
            app lên.
          </p>
        </Step>

        <Step n={2} title="Mở Settings" img="2-settings.png" alt="Màn hình chính Chatbox, nút Settings ở góc dưới bên trái">
          <p>
            Bấm <b>Settings</b> ở góc dưới bên trái cửa sổ.
          </p>
        </Step>

        <Step n={3} title="Vào Model Provider" img="3-model-provider.png" alt="Trang Settings, mục Model Provider trong nhóm Models">
          <p>
            Ở cột bên trái, trong nhóm <b>Models</b>, bấm <b>Model Provider</b>. Không cần đăng nhập tài khoản Chatbox AI.
          </p>
        </Step>

        <Step n={4} title="Chọn Claude, điền API Key và API Host" img="4-claude-host-key.png" alt="Cấu hình Claude với ô API Key và API Host đã điền">
          <p>
            Chọn <b>Claude</b> trong danh sách nhà cung cấp, rồi dán hai thông tin ở đầu trang vào đúng ô:
          </p>
          <ul>
            <li>
              <b>API Key</b>: key <span className="mono">ak_…</span> của bạn.
            </li>
            <li>
              <b>API Host</b>: <span className="mono">{API_HOST}</span>
            </li>
          </ul>
          <p className="small muted">
            Dòng Preview bên dưới phải là <span className="mono">{API_HOST}/messages</span>. Không thêm <span className="mono">/v1</span> hay dấu{' '}
            <span className="mono">/</span> ở cuối.
          </p>
          <div className="guide-inline-copy">
            <CopyField label="API Host" value={API_HOST} />
            {key && <CopyField label="API Key" value={key} display={mask(key)} />}
          </div>
        </Step>

        <Step n={5} title="Bấm Check để kiểm tra kết nối" img="5-check.png" alt="Hộp thoại Model Test Results báo Connection successful">
          <p>
            Bấm nút <b>Check</b> bên cạnh ô API Key. Thấy <b className="guide-ok">Connection successful!</b> là đã kết nối xong, bấm{' '}
            <b>Confirm</b> rồi đóng Settings.
          </p>
        </Step>

        <Step n={6} title="Quay lại khung chat và chọn model" img="6-choose-model.png" alt="Danh sách model Claude trong mục More Providers">
          <p>
            Bấm vào tên model ở góc dưới bên phải ô chat, kéo xuống mục <b>More Providers</b> → <b>Claude</b> rồi chọn model muốn dùng, ví dụ{' '}
            <b>Claude Sonnet 5</b> (khuyên dùng) hoặc <b>Claude Opus 5</b> (mạnh nhất). Giờ bạn có thể bắt đầu chat.
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
            <dt>Bấm Check báo lỗi</dt>
            <dd>Kiểm tra lại API Key (dán đủ, không thừa dấu cách) và API Host đúng như bước 4.</dd>
            <dt>Chỉ thấy một model tên "claude"</dt>
            <dd>
              Chọn model trong mục <b>More Providers</b> → <b>Claude</b> như bước 6, đừng tự gõ tên model.
            </dd>
            <dt>Báo hết credit hoặc key hết hạn</dt>
            <dd>
              Xem số credit còn lại ở trang <a href="/">Kiểm tra hạn mức</a>, xem các gói ở trang <a href="/bang-gia">Bảng giá</a>, hoặc liên hệ
              quản trị viên.
            </dd>
          </dl>
        </section>
      </main>

      <footer className="footer">Chatbox là app của bên thứ ba. Key chỉ lưu trong app trên máy bạn, đừng chia sẻ key cho người khác.</footer>
    </div>
  )
}

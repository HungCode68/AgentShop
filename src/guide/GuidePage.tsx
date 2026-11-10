import { useEffect, useState, type ReactNode } from 'react'
import { CheckIcon, ClipboardIcon } from '../components/Icons'
import { Topbar } from '../components/Topbar'
import { API_BASE } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { savedKey } from '../lib/savedKey'

// What users paste into Chatbox's "API Host": our gateway's proxy root (Chatbox appends /messages itself).
const API_HOST = new URL(`${API_BASE}/proxy`, window.location.origin).href
const SETUP_URL = new URL(`${API_BASE}/setup`, window.location.origin).href
const DOWNLOAD_URL = 'https://chatboxai.app'
const KEY_PLACEHOLDER = 'KEY_CUA_BAN'

/**
 * One-line installers served by the gateway (GET /api/setup/<os>/<key>). Deliberately free of
 * quotes, "?" and "&": the earlier nested-quote form broke on some Windows shells.
 */
const setupCommands = (key: string) => ({
  windows: `irm ${SETUP_URL}/windows/${key} | iex`,
  mac: `curl -fsSL ${SETUP_URL}/mac/${key} | bash`,
  linux: `curl -fsSL ${SETUP_URL}/linux/${key} | bash`,
})

/** The user's own key, when the quota page remembered it or the link carried ?key=. */
function knownKey(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('key')?.trim()
  const key = fromUrl || savedKey.get()
  return key && key.startsWith('ak_') ? key : null
}

const mask = (k: string) => `${k.slice(0, 7)}••••••••${k.slice(-4)}`

function CopyField({ label, value, display }: { label: string; value: string; display?: string }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    if (await copyText(value)) {
      setDone(true)
      window.setTimeout(() => setDone(false), 1800)
    }
  }
  return (
    <div className="copy-field">
      <span className="copy-field__label">{label}</span>
      <code className="copy-field__value mono">{display ?? value}</code>
      <button type="button" className={`btn btn--ghost copy-field__btn${done ? ' is-done' : ''}`} onClick={copy}>
        {done ? <CheckIcon width={15} height={15} /> : <ClipboardIcon width={15} height={15} />}
        {done ? 'Đã sao chép' : 'Sao chép'}
      </button>
    </div>
  )
}

function Step({ n, title, img, alt, children }: { n: number; title: string; img: string; alt: string; children: ReactNode }) {
  const src = `/guide/${img}`
  return (
    <section className="card guide-step" id={`buoc-${n}`}>
      <div className="guide-step__head">
        <span className="guide-step__num">{n}</span>
        <h2>{title}</h2>
      </div>
      <div className="guide-step__body">{children}</div>
      <a className="guide-step__shot" href={src} target="_blank" rel="noreferrer" title="Bấm để xem ảnh lớn">
        <img src={src} alt={alt} loading={n === 1 ? 'eager' : 'lazy'} />
      </a>
    </section>
  )
}

function QuickSetup({ keyValue }: { keyValue: string | null }) {
  const real = setupCommands(keyValue ?? KEY_PLACEHOLDER)
  // Shown with the key masked; the copy button copies the real command.
  const shown = keyValue ? setupCommands(mask(keyValue)) : real
  return (
    <section className="card guide-keys guide-setup" id="cai-nhanh">
      <h2>Dùng Claude Code (VS Code / terminal)? Cài bằng 1 lệnh</h2>
      <p className="small muted">
        Lệnh tự cài Claude Code (CLI + extension VS Code) và ghi sẵn API Host, key, model vào cấu hình. Setting cũ của bạn được giữ nguyên
        (có bản sao lưu <span className="mono">.agentshop-backup</span>). Chạy xong, trong VS Code bấm <b>Developer: Reload Window</b>.
      </p>
      <p className="small muted">
        Windows: bấm Start, gõ <b>PowerShell</b>, mở lên rồi dán lệnh dưới đây (không dán vào cmd). macOS / Linux: dán vào Terminal.
      </p>
      <CopyField label="Windows (PowerShell)" value={real.windows} display={shown.windows} />
      <CopyField label="macOS" value={real.mac} display={shown.mac} />
      <CopyField label="Linux" value={real.linux} display={shown.linux} />
      {!keyValue && (
        <p className="small muted">
          Thay <span className="mono">{KEY_PLACEHOLDER}</span> bằng key <span className="mono">ak_…</span> của bạn trước khi chạy.
        </p>
      )}
    </section>
  )
}

const TOC = [
  { href: '#chatbox', title: 'App Chatbox', desc: 'Chat trên máy tính hoặc điện thoại, 6 bước, khoảng 3 phút.' },
  { href: '#cai-nhanh', title: 'Claude Code (VS Code / terminal)', desc: 'Dùng Claude để viết code, cài bằng 1 lệnh.' },
  { href: '#gap-loi', title: 'Gặp lỗi?', desc: 'Các lỗi thường gặp và cách xử lý.' },
]

export default function GuidePage() {
  const [key] = useState(knownKey)

  // The page is lazy-loaded, so the browser's own jump to #section happens before the
  // section exists. Redo it once rendered, so links like /huong-dan#cai-nhanh work.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView()
  }, [])

  return (
    <div className="app">
      <div className="bg-glow" aria-hidden />
      <Topbar>
        <a className="btn btn--ghost" href="/">Kiểm tra hạn mức</a>
      </Topbar>

      <main className="container guide">
        <section className="hero">
          <h1>Hướng dẫn dùng Claude</h1>
          <p>Bạn chỉ cần API key dạng ak_… đã được cấp. Chọn cách bạn muốn dùng:</p>
        </section>

        <nav className="guide-toc" aria-label="Mục lục">
          {TOC.map((item) => (
            <a key={item.href} className="card guide-toc__item" href={item.href}>
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

        <Step n={1} title="Tải và cài app Chatbox" img="1-download.png" alt="Trang tải Chatbox với các bản Windows, macOS, Linux, iOS, Android">
          <p>
            Vào{' '}
            <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
              chatboxai.app
            </a>
            , bấm <b>Download</b> và chọn đúng bản cho máy của bạn: Windows, macOS (Apple Silicon hoặc Intel), Linux, hoặc App Store / Google Play
            trên điện thoại. Cài xong thì mở app lên.
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
            <b>Claude Opus 5</b> hoặc <b>Claude Sonnet 5</b>. Giờ bạn có thể bắt đầu chat.
          </p>
        </Step>

        <QuickSetup keyValue={key} />

        <section className="card guide-faq" id="gap-loi">
          <h2>Gặp lỗi?</h2>
          <dl>
            <dt>Bấm Check báo lỗi</dt>
            <dd>Kiểm tra lại API Key (dán đủ, không thừa dấu cách) và API Host đúng như bước 4.</dd>
            <dt>Chỉ thấy một model tên "claude"</dt>
            <dd>
              Chọn model trong mục <b>More Providers</b> → <b>Claude</b> như bước 6, đừng tự gõ tên model.
            </dd>
            <dt>Báo key hết hạn hoặc hết hạn mức</dt>
            <dd>
              Xem hạn sử dụng và lượng token còn lại ở trang <a href="/">Kiểm tra hạn mức</a>, hoặc liên hệ quản trị viên để gia hạn.
            </dd>
          </dl>
        </section>
      </main>

      <footer className="footer">Chatbox là app của bên thứ ba. Key chỉ lưu trong app trên máy bạn, đừng chia sẻ key cho người khác.</footer>
    </div>
  )
}

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
/** Same, for the Chatbox app: installs it when missing and hands it the API Host + key. */
const chatboxCommands = (key: string) => ({
  windows: `irm ${SETUP_URL}/chatbox/windows/${key} | iex`,
  mac: `curl -fsSL ${SETUP_URL}/chatbox/mac/${key} | bash`,
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

function Step({
  n,
  id,
  title,
  img,
  alt,
  visual,
  children,
}: {
  n: number
  id?: string
  title: string
  img?: string
  alt?: string
  /** Shown instead of a screenshot (e.g. an illustrated terminal). */
  visual?: ReactNode
  children: ReactNode
}) {
  const [missing, setMissing] = useState(false)
  const src = img ? `/guide/${img}` : ''
  return (
    <section className="card guide-step" id={id ?? `buoc-${n}`}>
      <div className="guide-step__head">
        <span className="guide-step__num">{n}</span>
        <h2>{title}</h2>
      </div>
      <div className="guide-step__body">{children}</div>
      {visual}
      {img && !missing && (
        <a className="guide-step__shot" href={src} target="_blank" rel="noreferrer" title="Bấm để xem ảnh lớn">
          {/* A screenshot not uploaded yet just hides instead of showing a broken image. */}
          <img src={src} alt={alt} loading={n === 1 ? 'eager' : 'lazy'} onError={() => setMissing(true)} />
        </a>
      )}
    </section>
  )
}

/** What the customer sees after pasting the Chatbox command (an illustration of the script's real output). */
function TerminalIllustration() {
  return (
    <div className="guide-term" aria-label="Minh hoạ cửa sổ PowerShell khi chạy lệnh">
      <div className="guide-term__bar">
        <span />
        <span />
        <span />
        <b>Windows PowerShell</b>
      </div>
      <pre className="mono">
        <span className="guide-term__cmd">PS C:\Users\ban&gt; irm …/chatbox/windows/ak_… | iex</span>
        {'\n\n'}
        <span className="guide-term__ok">== Chatbox not found - installing it.</span>
        {'\n'}
        <span className="guide-term__ok">== Installing Chatbox with winget.</span>
        {'\n   Successfully installed\n\n'}
        <span className="guide-term__ok">== Opening Chatbox with your settings.</span>
        {'\n\n'}
        <span className="guide-term__ok">== Almost done - in Chatbox:</span>
        {"\n  1. In the 'Import Provider Configuration' window, click Save."}
      </pre>
    </div>
  )
}

function ChatboxQuick({ keyValue }: { keyValue: string | null }) {
  const real = chatboxCommands(keyValue ?? KEY_PLACEHOLDER)
  const shown = keyValue ? chatboxCommands(mask(keyValue)) : real
  return (
    <>
      <section className="card guide-keys guide-setup" id="chatbox">
        <h2>Chatbox trên máy tính: cài bằng 1 lệnh</h2>
        <p className="small muted">
          Lệnh tự kiểm tra máy đã có app Chatbox chưa; chưa có thì tự tải bản chính thức và cài, rồi mở Chatbox với sẵn API Host và key của
          bạn. Bạn chỉ cần bấm <b>Save</b> và bắt đầu chat. Cấu hình khác trong Chatbox được giữ nguyên.
        </p>
        <CopyField label="Windows (PowerShell)" value={real.windows} display={shown.windows} />
        <CopyField label="macOS (Terminal)" value={real.mac} display={shown.mac} />
        {!keyValue && (
          <p className="small muted">
            Thay <span className="mono">{KEY_PLACEHOLDER}</span> bằng key <span className="mono">ak_…</span> của bạn trước khi chạy.
          </p>
        )}
      </section>

      <Step n={1} id="chatbox-1" title="Mở PowerShell (hoặc Terminal) và dán lệnh" visual={<TerminalIllustration />}>
        <p>
          <b>Windows:</b> bấm Start, gõ <b>PowerShell</b>, mở lên rồi dán lệnh Windows ở trên và bấm Enter (không dán vào cmd).{' '}
          <b>macOS:</b> mở <b>Terminal</b> rồi dán lệnh macOS.
        </p>
        <p className="small muted">Lần đầu cài, lệnh tải Chatbox khoảng 240 MB nên có thể mất vài phút. Máy đã có Chatbox thì chỉ vài giây.</p>
      </Step>

      <Step
        n={2}
        id="chatbox-2"
        title="Bấm Save trong Chatbox"
        img="chatbox-quick-save.png"
        alt="Hộp thoại Import Provider Configuration của Chatbox với nút Save"
      >
        <p>
          <b>Windows:</b> Chatbox tự mở hộp thoại <b>Import Provider Configuration</b> đã điền sẵn API Host và key. Bấm <b>Save</b>. Nếu
          Chatbox hỏi ghi đè cấu hình Claude cũ, chọn đồng ý.
        </p>
        <p>
          <b>macOS:</b> cấu hình đã được chép sẵn vào clipboard. Trong Chatbox vào <b>Settings → Model Provider</b>, bấm <b>Add</b>, chọn{' '}
          <b>Import from clipboard</b> rồi bấm <b>Save</b>.
        </p>
        <p className="small muted">
          Không thấy hộp thoại trên Windows? Làm như macOS: lệnh cũng đã chép cấu hình vào clipboard.
        </p>
      </Step>

      <Step n={3} id="chatbox-3" title="Chọn model và bắt đầu chat" img="6-choose-model.png" alt="Danh sách model Claude trong mục More Providers">
        <p>
          Đóng Settings, bấm vào tên model ở góc dưới bên phải ô chat, kéo xuống <b>More Providers</b> → <b>Claude</b> và chọn model, ví dụ{' '}
          <b>Claude Sonnet 5.5</b> (khuyên dùng), <b>Haiku 5.5</b> (tiết kiệm) hoặc <b>Opus 5.5</b> (mạnh nhất). Giờ bạn có thể chat.
        </p>
      </Step>
    </>
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
  { href: '#chatbox', title: 'Chatbox trên máy tính', desc: 'Hỏi đáp, chat. Cài bằng 1 lệnh rồi bấm Save, khoảng 1 phút.' },
  { href: '#cai-nhanh', title: 'Claude Code (VS Code / terminal)', desc: 'Dùng Claude để viết code, cài bằng 1 lệnh.' },
  { href: '#chatbox-thu-cong', title: 'Chatbox trên điện thoại / cài tay', desc: '6 bước điền API Host và key, khoảng 3 phút.' },
  { href: '#gap-loi', title: 'Gặp lỗi?', desc: 'Các lỗi thường gặp và cách xử lý.' },
]

export default function GuidePage() {
  const [key] = useState(knownKey)

  // The page is lazy-loaded, so the browser's own jump to #section happens before the
  // section exists. Redo it once rendered, so links like /huong-dan#cai-nhanh work.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1))
    const target = id ? document.getElementById(id) : null
    // Old links to the manual steps (#buoc-4) point inside the collapsed section: open it first.
    const details = target?.closest('details')
    if (details) details.open = true
    target?.scrollIntoView()
  }, [])

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
            <a key={item.href} className="card guide-toc__item" href={item.href}>
              <span className="guide-toc__title">{item.title}</span>
              <span className="guide-toc__desc">{item.desc}</span>
            </a>
          ))}
        </nav>

        <ChatboxQuick keyValue={key} />

        <QuickSetup keyValue={key} />

        <details className="guide-manual" id="chatbox-thu-cong" open={window.location.hash === '#chatbox-thu-cong' || undefined}>
          <summary className="card">
            <span>
              <b>Chatbox trên điện thoại, hoặc cài tay</b>
              <span className="small muted"> · 6 bước, dùng khi không chạy được lệnh</span>
            </span>
          </summary>
          <div className="guide-manual__body">
        <div className="card guide-keys">
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
            <b>Claude Sonnet 5.5</b>, <b>Haiku 5.5</b> hoặc <b>Opus 5.5</b>. Giờ bạn có thể bắt đầu chat.
          </p>
        </Step>
          </div>
        </details>

        <section className="card guide-faq" id="gap-loi">
          <h2>Gặp lỗi?</h2>
          <dl>
            <dt>Bấm Check báo lỗi</dt>
            <dd>Kiểm tra lại API Key (dán đủ, không thừa dấu cách) và API Host đúng như bước 4.</dd>
            <dt>Chỉ thấy một model tên "claude"</dt>
            <dd>
              Chọn model trong mục <b>More Providers</b> → <b>Claude</b> như bước 6, đừng tự gõ tên model.
            </dd>
            <dt>Lệnh cài Chatbox báo lỗi hoặc không cài được</dt>
            <dd>
              Tải Chatbox tại{' '}
              <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
                chatboxai.app
              </a>
              , cài xong chạy lại lệnh: lệnh sẽ bỏ qua bước cài và chỉ mở Chatbox với cấu hình của bạn. Hoặc làm theo phần cài tay ở trên.
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

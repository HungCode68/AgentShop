import { useState } from 'react'
import { Topbar } from '../components/Topbar'
import { API_HOST, CopyField, KEY_PLACEHOLDER, knownKey, mask, SETUP_URL, Step, useHashScroll } from './shared'

/**
 * One-line installers served by the gateway (GET /api/setup/<os>/<key>). Deliberately free of
 * quotes, "?" and "&": the earlier nested-quote form broke on some Windows shells.
 */
const setupCommands = (key: string) => ({
  windows: `irm ${SETUP_URL}/windows/${key} | iex`,
  mac: `curl -fsSL ${SETUP_URL}/mac/${key} | bash`,
  linux: `curl -fsSL ${SETUP_URL}/linux/${key} | bash`,
})

/** One line of the illustrated PowerShell window: plain output, a "==" progress line, or the prompt. */
type Line = { t: string; kind?: 'cmd' | 'step' | 'done' | 'dim'; mark?: number }

/**
 * What the Windows installer prints, in order (the "==" lines are the script's own messages, see
 * gateway/src/setup.js); tool output in between is abridged. Marks tie lines to the legend below.
 */
const terminalLines = (shownKey: string): Line[] => [
  { t: 'Windows PowerShell', kind: 'dim' },
  { t: '' },
  { t: `PS C:\\Users\\ban> irm ${SETUP_URL}/windows/${shownKey} | iex`, kind: 'cmd' },
  { t: '' },
  { t: '== Node 18+ not found - installing Node LTS via winget.', kind: 'step', mark: 1 },
  { t: 'Found Node.js LTS [OpenJS.NodeJS.LTS]' },
  { t: '  ██████████████████████████████  30.1 MB / 30.1 MB', kind: 'dim' },
  { t: 'Successfully installed' },
  { t: '' },
  { t: '== Node v22.19.0 found.', kind: 'step' },
  { t: '' },
  { t: '== Installing / updating Claude Code CLI (npm).', kind: 'step', mark: 2 },
  { t: 'added 3 packages in 12s' },
  { t: '' },
  { t: '== Claude Code 2.1.323 (Claude Code)', kind: 'step' },
  { t: '' },
  { t: '== Installing / updating the Claude Code extension for VS Code.', kind: 'step', mark: 3 },
  { t: "Extension 'anthropic.claude-code' was successfully installed." },
  { t: '' },
  { t: '== Writing config.', kind: 'step', mark: 4 },
  { t: '   updated C:\\Users\\ban\\.claude/settings.json' },
  { t: '   updated C:\\Users\\ban\\AppData\\Roaming\\Code/User/settings.json' },
  { t: '' },
  { t: '== All done.', kind: 'done', mark: 5 },
  { t: "  - VS Code: run 'Developer: Reload Window' (or restart VS Code), then open Claude Code and chat." },
  { t: "  - Terminal: open a new terminal and run 'claude'." },
  { t: `  - API host: ${API_HOST.replace(/\/$/, '')}` },
]

const LEGEND = [
  'Cài Node.js (chỉ khi máy chưa có, khoảng 1–2 phút).',
  'Cài Claude Code (công cụ dòng lệnh).',
  'Cài extension Claude Code cho VS Code (khi máy có VS Code).',
  'Ghi API Host, key và model vào cấu hình. Setting cũ được giữ nguyên, có bản sao lưu .agentshop-backup.',
  'Thấy "All done" là xong. Đóng PowerShell và chuyển sang VS Code.',
]

function PowerShellIllustration({ shownKey }: { shownKey: string }) {
  return (
    <figure className="ps-window" aria-label="Minh hoạ cửa sổ PowerShell khi chạy lệnh cài">
      <div className="ps-window__bar">
        <span className="ps-window__icon" aria-hidden>
          ›_
        </span>
        <span>Windows PowerShell</span>
        <span className="ps-window__ctrl" aria-hidden>
          — ▢ ✕
        </span>
      </div>
      <pre className="ps-window__body mono">
        {terminalLines(shownKey).map((l, i) => (
          <span key={i} className={`ps-line${l.kind ? ` ps-line--${l.kind}` : ''}`}>
            {l.t || ' '}
            {l.mark && <b className="ps-mark">{l.mark}</b>}
            {'\n'}
          </span>
        ))}
      </pre>
      <figcaption>
        <ol className="ps-legend">
          {LEGEND.map((text, i) => (
            <li key={i}>
              <b className="ps-mark">{i + 1}</b>
              <span>{text}</span>
            </li>
          ))}
        </ol>
        <p className="small muted">Ảnh minh hoạ. Số phiên bản và thời gian trên máy bạn có thể khác; máy đã có Node thì bỏ qua bước 1.</p>
      </figcaption>
    </figure>
  )
}

export default function ClaudeCodeGuide() {
  const [key] = useState(knownKey)
  useHashScroll()
  const real = setupCommands(key ?? KEY_PLACEHOLDER)
  // Shown with the key masked; the copy button copies the real command.
  const shown = key ? setupCommands(mask(key)) : real

  return (
    <div className="app">
      <div className="bg-glow" aria-hidden />
      <Topbar>
        <a className="btn btn--ghost" href={'/huong-dan' + window.location.search}>
          Hướng dẫn Claude Desktop
        </a>
        <a className="btn btn--ghost" href="/">
          Kiểm tra hạn mức
        </a>
      </Topbar>

      <main className="container guide">
        <section className="hero">
          <h1>Cài Claude Code cho VS Code</h1>
          <p>Một lệnh tự cài Claude Code, extension VS Code và điền sẵn key của bạn. Khoảng 2–5 phút.</p>
        </section>

        <section className="card guide-keys guide-setup" id="cai-nhanh">
          <h2>Lệnh cài đặt</h2>
          <p className="small muted">
            Bấm <b>Sao chép</b> ở dòng đúng với máy của bạn, rồi làm theo các bước bên dưới. Lệnh có chứa key của bạn, đừng gửi cho người khác.
          </p>
          <CopyField label="Windows (PowerShell)" value={real.windows} display={shown.windows} />
          <CopyField label="macOS (Terminal)" value={real.mac} display={shown.mac} />
          <CopyField label="Linux (Terminal)" value={real.linux} display={shown.linux} />
          {!key && (
            <p className="small muted">
              Thay <span className="mono">{KEY_PLACEHOLDER}</span> bằng key <span className="mono">ak_…</span> của bạn trước khi chạy.
            </p>
          )}
        </section>

        <Step n={1} title="Mở Windows PowerShell" img="claude-1-powershell.png" alt="Menu Start tìm Windows PowerShell, nút Open">
          <p>
            Bấm phím <b>Windows</b> (hoặc nút Start), gõ <b>PowerShell</b>, chọn <b>Windows PowerShell</b> rồi bấm <b>Open</b>. Không cần{' '}
            <i>Run as Administrator</i>.
          </p>
          <p className="small muted">
            Phải là PowerShell, không dùng Command Prompt (cmd). Trên macOS / Linux: mở ứng dụng <b>Terminal</b> (macOS: bấm Cmd + Space, gõ
            Terminal).
          </p>
        </Step>

        <Step
          n={2}
          title="Dán lệnh và bấm Enter, đợi tới khi thấy All done"
          visual={<PowerShellIllustration shownKey={key ? mask(key) : KEY_PLACEHOLDER} />}
        >
          <p>
            Bấm chuột phải vào cửa sổ PowerShell để dán lệnh đã sao chép (hoặc Ctrl + V), rồi bấm <b>Enter</b>. Lệnh chạy lần lượt các bước như
            hình dưới. Đừng đóng cửa sổ cho tới khi thấy dòng <b>== All done.</b>
          </p>
        </Step>

        <Step n={3} title="Mở VS Code và mở khung Claude Code" img="claude-3-vscode.png" alt="VS Code với khung Claude Code mở ở bên phải">
          <p>
            Mở <b>VS Code</b>. Nếu VS Code đang mở sẵn, bấm <b>Ctrl + Shift + P</b>, gõ <b>Reload Window</b> rồi Enter để VS Code nhận cấu hình
            mới.
          </p>
          <p>
            Bấm biểu tượng <b>Claude</b> (hình ngôi sao màu cam) ở thanh bên trái hoặc góc trên bên phải để mở khung <b>Claude Code</b> như
            hình. Không cần đăng nhập tài khoản Anthropic.
          </p>
        </Step>

        <Step n={4} title="Chọn model và bắt đầu">
          <p>
            Gõ yêu cầu vào ô chat ở cuối khung Claude Code và bấm Enter. Model mặc định là <b>Sonnet 5.5</b>; muốn đổi, bấm vào tên model ở
            ngay dưới ô chat (hoặc gõ <span className="mono">/model</span>) và chọn <b>Opus 5.5</b> cho việc khó hoặc <b>Haiku 5.5</b> để
            tiết kiệm.
          </p>
          <p className="small muted">
            Mở một thư mục dự án trước (File → Open Folder) để Claude đọc và sửa code trong đó. Số credit đã dùng xem ở trang{' '}
            <a href="/">Kiểm tra hạn mức</a>.
          </p>
        </Step>

        <section className="card guide-faq" id="gap-loi">
          <h2>Gặp lỗi?</h2>
          <dl>
            <dt>Khung Claude Code đòi đăng nhập hoặc báo lỗi key</dt>
            <dd>
              Bấm <b>Ctrl + Shift + P</b> → <b>Reload Window</b>. Vẫn bị thì chạy lại lệnh ở bước 2 (chạy lại nhiều lần không sao) rồi khởi
              động lại VS Code.
            </dd>
            <dt>PowerShell báo lỗi khi cài Node hoặc npm</dt>
            <dd>
              Cài <b>Node.js LTS</b> từ{' '}
              <a href="https://nodejs.org" target="_blank" rel="noreferrer">
                nodejs.org
              </a>
              , mở cửa sổ PowerShell mới rồi chạy lại lệnh. Lệnh ghi nhật ký vào file <span className="mono">agentshop-setup.log</span> trong thư
              mục Temp, gửi file này cho quản trị viên nếu cần hỗ trợ.
            </dd>
            <dt>Không thấy biểu tượng Claude trong VS Code</dt>
            <dd>
              Vào Extensions (Ctrl + Shift + X), tìm <b>Claude Code</b> của Anthropic và bấm Install, rồi Reload Window.
            </dd>
            <dt>Báo hết credit hoặc key hết hạn</dt>
            <dd>
              Xem số credit còn lại ở trang <a href="/">Kiểm tra hạn mức</a>, xem các gói ở trang <a href="/bang-gia">Bảng giá</a>, hoặc liên hệ
              quản trị viên.
            </dd>
          </dl>
        </section>
      </main>

      <footer className="footer">Lệnh cài chỉ ghi cấu hình trên máy bạn. Key nằm trong lệnh, đừng chia sẻ lệnh hoặc key cho người khác.</footer>
    </div>
  )
}

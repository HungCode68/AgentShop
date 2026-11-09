import { useState } from 'react'
import { AlertIcon } from '../components/Icons'
import { checkPageUrl, proxyBaseUrl, type IssuedKey } from './api'
import { CopyButton, Modal } from './ui'

type Shell = 'unix' | 'powershell'

function claudeConfig(key: string, shell: Shell) {
  const base = proxyBaseUrl()
  return shell === 'unix'
    ? `export ANTHROPIC_BASE_URL=${base}\nexport ANTHROPIC_AUTH_TOKEN=${key}`
    : `$env:ANTHROPIC_BASE_URL="${base}"\n$env:ANTHROPIC_AUTH_TOKEN="${key}"`
}

export function NewKeyDialog({ issued, rotated, onClose }: { issued: IssuedKey; rotated: boolean; onClose: () => void }) {
  const [shell, setShell] = useState<Shell>('unix')
  const { key, record } = issued
  const link = checkPageUrl(key)
  const config = claudeConfig(key, shell)
  const message = `API key của bạn: ${key}\n\nKiểm tra hạn mức: ${link}\n\nCấu hình Claude Code:\n${claudeConfig(key, 'unix')}`

  return (
    <Modal
      title={rotated ? `Key mới cho “${record.name}”` : `Đã tạo key cho “${record.name}”`}
      onClose={onClose}
      wide
      footer={
        <>
          <CopyButton text={message} label="Chép tất cả để gửi khách" />
          <button type="button" className="btn btn--primary btn--md" onClick={onClose}>
            Xong
          </button>
        </>
      }
    >
      <div className="notice notice--warn">
        <AlertIcon width={16} height={16} />
        <span>
          Gửi thông tin dưới đây cho khách. Sau này vẫn sao chép lại được key bằng nút sao chép trong bảng.
          {rotated && <b> Key cũ của khách đã ngừng hoạt động.</b>}
        </span>
      </div>

      <div className="secret">
        <div className="secret__head">
          <span className="field__label">API key</span>
          <CopyButton text={key} />
        </div>
        <code className="secret__value">{key}</code>
      </div>

      <div className="secret">
        <div className="secret__head">
          <span className="field__label">Link kiểm tra hạn mức</span>
          <CopyButton text={link} />
        </div>
        <code className="secret__value">{link}</code>
      </div>

      <div className="secret">
        <div className="secret__head">
          <span className="field__label">Cấu hình Claude Code</span>
          <div className="secret__tools">
            <div className="seg seg--sm" role="tablist">
              <button type="button" role="tab" aria-selected={shell === 'unix'} onClick={() => setShell('unix')}>
                macOS / Linux
              </button>
              <button type="button" role="tab" aria-selected={shell === 'powershell'} onClick={() => setShell('powershell')}>
                Windows
              </button>
            </div>
            <CopyButton text={config} />
          </div>
        </div>
        <pre className="secret__value">{config}</pre>
      </div>
    </Modal>
  )
}

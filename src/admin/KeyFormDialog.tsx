import { useState, type FormEvent } from 'react'
import type { KeyInput, KeyRecord } from './api'
import { InlineError, Modal } from './ui'
import { inDays, toLocalInput } from './util'

interface Props {
  /** Absent = create a new key. */
  record?: KeyRecord
  onSubmit: (input: KeyInput) => Promise<void>
  onClose: () => void
}

const PRESETS = [
  { label: '7 ngày', days: 7 },
  { label: '30 ngày', days: 30 },
  { label: '90 ngày', days: 90 },
  { label: '1 năm', days: 365 },
]

export function KeyFormDialog({ record, onSubmit, onClose }: Props) {
  const editing = !!record
  const [name, setName] = useState(record?.name ?? '')
  const [note, setNote] = useState(record?.note ?? '')
  const [upstream, setUpstream] = useState('')
  const [unassign, setUnassign] = useState(false)
  const [never, setNever] = useState(record ? !record.expiresAt : true)
  const [expires, setExpires] = useState(record?.expiresAt ? toLocalInput(record.expiresAt) : inDays(30))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function buildInput(): KeyInput | null {
    const input: KeyInput = {}
    const trimmedName = name.trim()
    if (!editing || trimmedName !== record.name) input.name = trimmedName

    const trimmedNote = note.trim()
    if (!editing ? trimmedNote : trimmedNote !== (record.note ?? '')) input.note = trimmedNote || null

    if (unassign) input.upstreamKey = null
    else if (upstream.trim()) input.upstreamKey = upstream.trim()

    const expiresAt = never ? null : new Date(expires).toISOString()
    const before = record?.expiresAt ? new Date(record.expiresAt).toISOString() : null
    if (!editing ? expiresAt : expiresAt !== before) input.expiresAt = expiresAt

    return Object.keys(input).length ? input : null
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Vui lòng nhập tên.')
    if (!never && (!expires || Number.isNaN(new Date(expires).getTime()))) return setError('Vui lòng chọn ngày hết hạn.')

    const input = buildInput()
    if (!input) return onClose()
    setSaving(true)
    setError(null)
    try {
      await onSubmit(input)
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <Modal
      title={editing ? `Sửa key #${record.id}` : 'Tạo key mới'}
      onClose={saving ? () => {} : onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
            Huỷ
          </button>
          <button type="submit" form="key-form" className="btn btn--primary btn--md" disabled={saving}>
            {saving && <span className="spinner" />}
            {editing ? 'Lưu thay đổi' : 'Tạo key'}
          </button>
        </>
      }
    >
      <form id="key-form" className="form" onSubmit={submit} noValidate>
        <label className="field">
          <span className="field__label">
            Tên khách hàng <em>*</em>
          </span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} data-autofocus placeholder="Ví dụ: Khách A" />
        </label>

        <div className="field">
          <span className="field__label">Key agentshop (as_…)</span>
          {editing && record.upstreamKey && !unassign && (
            <div className="field__current">
              Đang gán: <code>{record.upstreamKey}</code>
              <button type="button" className="link-btn" onClick={() => setUnassign(true)}>
                Bỏ gán
              </button>
            </div>
          )}
          {unassign ? (
            <div className="field__current field__current--warn">
              Key agentshop sẽ bị bỏ gán, khách sẽ không dùng được cho tới khi gán key mới.
              <button type="button" className="link-btn" onClick={() => setUnassign(false)}>
                Hoàn tác
              </button>
            </div>
          ) : (
            <input
              className="input input--mono"
              value={upstream}
              onChange={(e) => setUpstream(e.target.value)}
              placeholder={editing && record.upstreamKey ? 'Dán key mới để thay, để trống nếu giữ nguyên' : 'as_eyJhbGciOi…'}
              autoComplete="off"
              spellCheck={false}
            />
          )}
          <span className="field__hint">Mỗi key agentshop chỉ gán được cho một khách. Có thể để trống và gán sau.</span>
        </div>

        <div className="field">
          <span className="field__label">Hạn sử dụng</span>
          <label className="checkbox">
            <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
            Không thời hạn
          </label>
          {!never && (
            <>
              <input className="input" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
              <div className="presets">
                {PRESETS.map((p) => (
                  <button key={p.days} type="button" className="chip" onClick={() => setExpires(inDays(p.days))}>
                    +{p.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <label className="field">
          <span className="field__label">Ghi chú</span>
          <textarea className="input textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} placeholder="Liên hệ, gói đã bán…" />
        </label>

        <InlineError message={error} />
      </form>
    </Modal>
  )
}

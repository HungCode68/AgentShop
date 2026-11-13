import { useState, type FormEvent } from 'react'
import type { KeyInput, KeyRecord, PlanId } from './api'
import { PACKS, TRIAL, tokensWorth } from './pricing'
import { InlineError, Modal } from './ui'
import { formatShort } from './util'

interface Props {
  /** Absent = create a new key. */
  record?: KeyRecord
  onSubmit: (input: KeyInput) => Promise<void>
  onClose: () => void
}

const MINUTE_PRESETS = [15, 30, 60, 120, 240, 480, 1440]
const vnd = new Intl.NumberFormat('vi-VN')
/** All the packs, cheapest first; the trial goes last. */
const PLAN_CHOICES: { id: PlanId; name: string; credits: number; priceVnd: number }[] = [
  ...PACKS,
  { id: 'trial', name: TRIAL.name, credits: 0, priceVnd: 0 },
]

export function KeyFormDialog({ record, onSubmit, onClose }: Props) {
  const editing = !!record
  const [name, setName] = useState(record?.name ?? '')
  const [note, setNote] = useState(record?.note ?? '')
  const [plan, setPlan] = useState<PlanId>(record?.plan ?? 'pro')
  const [minutes, setMinutes] = useState(String(record?.plan === 'trial' && record.planMinutes != null ? record.planMinutes : 60))
  // Editing: the pack only changes when the admin asks for a new period (it resets usage).
  const [renew, setRenew] = useState(!editing || !record.plan)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isTrial = plan === 'trial'
  const minuteCount = Number(minutes)
  const validMinutes = isTrial && Number.isInteger(minuteCount) && minuteCount >= 1 && minuteCount <= 366 * 24 * 60
  const pack = PACKS.find((p) => p.id === plan)
  const endsAt = isTrial && validMinutes ? new Date(Date.now() + minuteCount * 60_000) : null

  function buildInput(): KeyInput | null {
    const input: KeyInput = {}
    const trimmedName = name.trim()
    if (!editing || trimmedName !== record.name) input.name = trimmedName
    const trimmedNote = note.trim()
    if (!editing ? trimmedNote : trimmedNote !== (record.note ?? '')) input.note = trimmedNote || null
    if (renew) {
      input.plan = plan
      if (isTrial) input.planMinutes = minuteCount
    }
    return Object.keys(input).length ? input : null
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Vui lòng nhập tên.')
    if (renew && isTrial && !validMinutes) return setError('Thời gian dùng thử phải là số phút nguyên, từ 1 phút.')
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

        {editing && record.plan && (
          <div className="field">
            <span className="field__label">Gói hiện tại</span>
            <div className="field__current">
              <b>{record.planName}</b> · {record.planMinutes != null && record.plan === 'trial' ? `${record.planMinutes} phút` : 'không thời hạn'}, từ {record.planStartedAt ? formatShort(record.planStartedAt) : '—'}
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={renew} onChange={(e) => setRenew(e.target.checked)} />
              Đổi gói / bắt đầu kỳ mới (số liệu dùng được tính lại từ 0)
            </label>
          </div>
        )}

        {renew && (
          <>
            <div className="field">
              <span className="field__label">
                Gói <em>*</em>
              </span>
              <div className="seg" role="tablist" aria-label="Chọn gói">
                {PLAN_CHOICES.map((p) => (
                  <button key={p.id} type="button" role="tab" aria-selected={plan === p.id} onClick={() => setPlan(p.id as PlanId)}>
                    {p.name}
                  </button>
                ))}
              </div>
              {pack && (
                <span className="field__hint">
                  <b>{pack.credits.toLocaleString('vi-VN')} credit</b> (mua từ revid: {vnd.format(pack.costVnd)}đ, bán: {vnd.format(pack.priceVnd)}đ) · không thời hạn, khách dùng khi nào cũng được · ước tính ~
                  {Math.round(tokensWorth(pack.credits) / 1e6)}M token Sonnet / {Math.round(tokensWorth(pack.credits, true) / 1e6)}M token Opus
                </span>
              )}
              {isTrial && (
                <span className="field__hint">
                  Miễn phí cho khách trải nghiệm: tối đa <b>{TRIAL.tokenCap.toLocaleString('vi-VN')} token</b> trong thời gian thử.
                </span>
              )}
            </div>

            {isTrial && (
              <div className="field">
                <span className="field__label">
                  Thời gian dùng thử <em>*</em>
                </span>
                <span className="pc-input">
                  <input className="input" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/[^\d]/g, ''))} />
                  <span className="pc-input__suffix">phút</span>
                </span>
                <div className="presets">
                  {MINUTE_PRESETS.map((m) => (
                    <button key={m} type="button" className={`chip${minuteCount === m ? ' chip--on' : ''}`} onClick={() => setMinutes(String(m))}>
                      {m >= 1440 ? `${m / 1440} ngày` : m >= 60 ? `${m / 60} giờ` : `${m} phút`}
                    </button>
                  ))}
                </div>
                {validMinutes && <span className="field__hint">Hết hạn {endsAt ? formatShort(endsAt.toISOString()) : ''}</span>}
                {editing && record.plan && (
                  <div className="field__current field__current--warn">Kỳ mới bắt đầu từ lúc lưu: số liệu dùng được tính lại từ 0.</div>
                )}
              </div>
            )}
            {!isTrial && editing && record.plan && (
              <div className="field__current field__current--warn">Kỳ mới bắt đầu từ lúc lưu: số liệu dùng được tính lại từ 0.</div>
            )}
          </>
        )}

        <label className="field">
          <span className="field__label">Ghi chú</span>
          <textarea className="input textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} placeholder="Liên hệ, đã thanh toán…" />
        </label>

        <InlineError message={error} />
      </form>
    </Modal>
  )
}

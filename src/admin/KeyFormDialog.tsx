import { useState, type FormEvent } from 'react'
import type { KeyInput, KeyRecord, PlanId } from './api'
import { DEFAULT_PLANS, interpolatedPrice } from './pricing'
import { InlineError, Modal } from './ui'
import { formatShort } from './util'

interface Props {
  /** Absent = create a new key. */
  record?: KeyRecord
  onSubmit: (input: KeyInput) => Promise<void>
  onClose: () => void
}

const DAY_PRESETS = [1, 3, 7, 14, 30]
const vnd = new Intl.NumberFormat('vi-VN')

export function KeyFormDialog({ record, onSubmit, onClose }: Props) {
  const editing = !!record
  const [name, setName] = useState(record?.name ?? '')
  const [note, setNote] = useState(record?.note ?? '')
  const [plan, setPlan] = useState<PlanId>(record?.plan ?? 'pro')
  const [days, setDays] = useState(String(record?.planDays ?? 30))
  // Editing: the plan/days only change when the admin asks for a new rental (it resets usage and expiry).
  const [renew, setRenew] = useState(!editing || !record.plan)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dayCount = Number(days)
  const validDays = Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 366
  const planDef = DEFAULT_PLANS.find((p) => p.id === plan)
  const price = planDef && validDays ? interpolatedPrice(planDef, dayCount) : null
  const endsAt = validDays ? new Date(Date.now() + dayCount * 86_400_000) : null

  function buildInput(): KeyInput | null {
    const input: KeyInput = {}
    const trimmedName = name.trim()
    if (!editing || trimmedName !== record.name) input.name = trimmedName
    const trimmedNote = note.trim()
    if (!editing ? trimmedNote : trimmedNote !== (record.note ?? '')) input.note = trimmedNote || null
    if (renew) {
      input.plan = plan
      input.planDays = dayCount
    }
    return Object.keys(input).length ? input : null
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Vui lòng nhập tên.')
    if (renew && !validDays) return setError('Số ngày thuê phải là số nguyên từ 1 đến 366.')
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
              <b>{record.planName}</b> · {record.planDays} ngày, từ {record.planStartedAt ? formatShort(record.planStartedAt) : '—'}
              {record.expiresAt && <> đến {formatShort(record.expiresAt)}</>}
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={renew} onChange={(e) => setRenew(e.target.checked)} />
              Gia hạn / đổi gói (bắt đầu kỳ thuê mới từ bây giờ)
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
                {DEFAULT_PLANS.map((p) => (
                  <button key={p.id} type="button" role="tab" aria-selected={plan === p.id} onClick={() => setPlan(p.id as PlanId)}>
                    {p.name}
                  </button>
                ))}
              </div>
              {planDef && (
                <span className="field__hint">
                  Phiên 5 giờ {(planDef.sessionCap / 1e6).toLocaleString('vi-VN')}M token · tuần {(planDef.weeklyCap / 1e6).toLocaleString('vi-VN')}M token
                </span>
              )}
            </div>

            <div className="field">
              <span className="field__label">
                Số ngày thuê <em>*</em>
              </span>
              <input className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, ''))} />
              <div className="presets">
                {DAY_PRESETS.map((d) => (
                  <button key={d} type="button" className={`chip${dayCount === d ? ' chip--on' : ''}`} onClick={() => setDays(String(d))}>
                    {d} ngày
                  </button>
                ))}
              </div>
              {validDays && (
                <span className="field__hint">
                  Hết hạn {endsAt ? formatShort(endsAt.toISOString()) : ''}
                  {price !== null && (
                    <>
                      {' '}
                      · giá gợi ý <b>{vnd.format(price)}đ</b> (bảng giá trong tab Bảng giá)
                    </>
                  )}
                </span>
              )}
              {editing && record.plan && (
                <div className="field__current field__current--warn">Kỳ thuê mới bắt đầu từ lúc lưu: hạn mức đã dùng được tính lại từ 0.</div>
              )}
            </div>
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

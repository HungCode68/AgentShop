import { useState, type FormEvent } from 'react'
import type { KeyInput, KeyRecord, NvidiaTestResult, PlanId } from './api'
import { fmtTokenCount, PACKS, TRIAL, tokensWorth } from './pricing'
import { InlineError, Modal } from './ui'
import { formatShort } from './util'

interface Props {
  /** Absent = create a new key. */
  record?: KeyRecord
  /** Trial token cap from server config (overrides the compile-time default). */
  trialTokenCap?: number
  /** Tests a NVIDIA key: one typed in the form, this customer's saved key (id), or the shared key ({}). */
  onTestNvidia: (input: { key?: string; id?: number }) => Promise<NvidiaTestResult>
  onSubmit: (input: KeyInput) => Promise<void>
  onClose: () => void
}

const MINUTE_PRESETS = [15, 30, 60, 120, 240, 480, 1440]
const vnd = new Intl.NumberFormat('vi-VN')
/** All the packs, cheapest first; the trial goes last. */
const PLAN_CHOICES: { id: PlanId; name: string; credits: number; priceVnd: number }[] = [
  ...PACKS,
  { id: 'trial', name: TRIAL().name, credits: 0, priceVnd: 0 },
]

const NV_SOURCE = { typed: 'key vừa nhập', saved: 'key riêng đã lưu', shared: 'key chung của hệ thống' } as const

export function KeyFormDialog({ record, trialTokenCap, onTestNvidia, onSubmit, onClose }: Props) {
  const editing = !!record
  const [name, setName] = useState(record?.name ?? '')
  const [note, setNote] = useState(record?.note ?? '')
  const [plan, setPlan] = useState<PlanId>(record?.plan ?? 'pro')
  const [minutes, setMinutes] = useState(String(record?.plan === 'trial' && record.planMinutes != null ? record.planMinutes : 60))
  const [tokenCap, setTokenCap] = useState(String(record?.planTokenCap ?? ''))
  // The customer's own NVIDIA key: typed here (never shown back, only its masked form), or removed.
  const [nvidiaKey, setNvidiaKey] = useState('')
  const [showNvidiaKey, setShowNvidiaKey] = useState(false)
  const [clearNvidia, setClearNvidia] = useState(false)
  const [testing, setTesting] = useState(false)
  const [nvidiaTest, setNvidiaTest] = useState<NvidiaTestResult | null>(null)
  // Editing: the pack only changes when the admin asks for a new period (it resets usage).
  const [renew, setRenew] = useState(!editing || !record.plan)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isTrial = plan === 'trial'
  const minuteCount = Number(minutes)
  const tokenCapCount = Number(tokenCap)
  const validMinutes = isTrial && Number.isInteger(minuteCount) && minuteCount >= 1 && minuteCount <= 366 * 24 * 60
  const validTokenCap = !isTrial || tokenCap === '' || (Number.isInteger(tokenCapCount) && tokenCapCount >= 1)
  const typedNvidiaKey = nvidiaKey.trim()
  const validNvidiaKey = !typedNvidiaKey || /^\S{8,4096}$/.test(typedNvidiaKey)
  const hasSavedNvidiaKey = !!record?.nvidiaKey && !clearNvidia
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
      if (isTrial) {
        input.planMinutes = minuteCount
        if (tokenCap !== '') input.planTokenCap = tokenCapCount
      }
    }
    // The NVIDIA key does not depend on the plan: a new one replaces the old, "remove" goes back to the shared key.
    if (typedNvidiaKey) input.nvidiaKey = typedNvidiaKey
    else if (editing && clearNvidia && record.nvidiaKey) input.nvidiaKey = null
    return Object.keys(input).length ? input : null
  }

  async function testConnection() {
    setTesting(true)
    setNvidiaTest(null)
    try {
      // Typed key first; else this customer's saved key; else the shared key.
      setNvidiaTest(await onTestNvidia(typedNvidiaKey ? { key: typedNvidiaKey } : hasSavedNvidiaKey && record ? { id: record.id } : {}))
    } catch (err) {
      setNvidiaTest({ ok: false, error: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Vui lòng nhập tên.')
    if (!validNvidiaKey) return setError('Key NVIDIA không hợp lệ (không chứa khoảng trắng, từ 8 ký tự).')
    if (renew && isTrial && !validMinutes) return setError('Thời gian dùng thử phải là số phút nguyên, từ 1 phút.')
    if (renew && isTrial && !validTokenCap) return setError('Lượng token dùng thử phải là số nguyên dương.')
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
                  {fmtTokenCount(tokensWorth(pack.credits, 'claude-sonnet-5-5'))} token Sonnet / {fmtTokenCount(tokensWorth(pack.credits, 'claude-opus-5-5'))} Opus /{' '}
                  {fmtTokenCount(tokensWorth(pack.credits, 'claude-haiku-5-5'))} Haiku khi code (chat thường: ~
                  {fmtTokenCount(tokensWorth(pack.credits, 'claude-sonnet-5-5', 'chat'))} Sonnet)
                </span>
              )}
              {isTrial && (
                <span className="field__hint">
                  Miễn phí cho khách trải nghiệm: tối đa <b>{(trialTokenCap ?? TRIAL().tokenCap).toLocaleString('vi-VN')} token</b> trong thời gian thử.
                </span>
              )}
            </div>

            {isTrial && (
              <>
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
              <div className="field">
                <span className="field__label">Lượng token dùng thử</span>
                <span className="pc-input">
                  <input className="input" inputMode="numeric" value={tokenCap} onChange={(e) => setTokenCap(e.target.value.replace(/[^\d]/g, ''))} />
                  <span className="pc-input__suffix">token</span>
                </span>
                <span className="field__hint">
                  Để trống sẽ dùng mặc định {(trialTokenCap ?? TRIAL().tokenCap).toLocaleString('vi-VN')} token từ cấu hình server.
                </span>
              </div>
              </>
            )}
            {!isTrial && editing && record.plan && (
              <div className="field__current field__current--warn">Kỳ mới bắt đầu từ lúc lưu: số liệu dùng được tính lại từ 0.</div>
            )}
          </>
        )}

        <div className="field">
          <span className="field__label">Key NVIDIA riêng</span>
          {hasSavedNvidiaKey && (
            <div className="field__current">
              Đang dùng key riêng: <code>{record?.nvidiaKey}</code>
            </div>
          )}
          <input
            className="input"
            type={showNvidiaKey ? 'text' : 'password'}
            value={nvidiaKey}
            onChange={(e) => {
              setNvidiaKey(e.target.value)
              setNvidiaTest(null)
            }}
            placeholder={hasSavedNvidiaKey ? 'Nhập key mới để thay thế' : 'nvapi-…'}
            autoComplete="off"
            spellCheck={false}
            aria-label="Key NVIDIA riêng"
          />
          <div className="nv-actions">
            <button type="button" className="btn btn--ghost" onClick={testConnection} disabled={testing || !validNvidiaKey}>
              {testing && <span className="spinner" />}
              {testing ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}
            </button>
            <label className="checkbox">
              <input type="checkbox" checked={showNvidiaKey} onChange={(e) => setShowNvidiaKey(e.target.checked)} />
              Hiện key
            </label>
            {editing && record.nvidiaKey && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={clearNvidia}
                  onChange={(e) => {
                    setClearNvidia(e.target.checked)
                    setNvidiaTest(null)
                  }}
                />
                Xoá key riêng (dùng lại key chung)
              </label>
            )}
          </div>
          {nvidiaTest && (
            <span className={`field__hint nv-test nv-test--${nvidiaTest.ok ? 'ok' : 'fail'}`} role="status">
              {nvidiaTest.ok
                ? `Kết nối được · model ${nvidiaTest.model} · ${nvidiaTest.ms} ms · đã thử bằng ${NV_SOURCE[nvidiaTest.source]}.`
                : `${nvidiaTest.error}${nvidiaTest.source ? ` (đã thử bằng ${NV_SOURCE[nvidiaTest.source]})` : ''}`}
            </span>
          )}
          <span className="field__hint">
            Để trống thì khách dùng key NVIDIA chung của hệ thống. Mỗi key NVIDIA có giới hạn tốc độ riêng, nên khách dùng nhiều nên có key riêng. Nút kiểm tra thử key vừa nhập, nếu để trống thì thử key đã lưu hoặc key chung.
          </span>
        </div>

        <label className="field">
          <span className="field__label">Ghi chú</span>
          <textarea className="input textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} placeholder="Liên hệ, đã thanh toán…" />
        </label>

        <InlineError message={error} />
      </form>
    </Modal>
  )
}

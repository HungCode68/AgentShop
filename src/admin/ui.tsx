import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertIcon, CheckIcon, ClipboardIcon, XIcon } from '../components/Icons'
import { copyText } from './util'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** false: only the footer buttons close it (used when closing would lose a key shown once). */
  dismissable?: boolean
  wide?: boolean
}

/** Native <dialog>: focus trap, Esc and backdrop come for free. Mount it to open, unmount to close. */
export function Modal({ title, onClose, children, footer, dismissable = true, wide }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const d = ref.current
    if (d && !d.open) {
      d.showModal()
      // showModal() focuses the first focusable element (the close button); prefer the field marked for it.
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    }
    return () => d?.close()
  }, [])

  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' modal--wide' : ''}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        if (dismissable) onClose()
      }}
      onMouseDown={(e) => {
        if (dismissable && e.target === ref.current) onClose()
      }}
    >
      <div className="modal__inner">
        <header className="modal__head">
          <h2>{title}</h2>
          {dismissable && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng">
              <XIcon />
            </button>
          )}
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__foot">{footer}</footer>}
      </div>
    </dialog>
  )
}

export function CopyButton({ text, label = 'Sao chép' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(false), 1600)
    return () => window.clearTimeout(t)
  }, [done])

  return (
    <button type="button" className={`btn btn--ghost btn--sm${done ? ' is-done' : ''}`} onClick={async () => setDone(await copyText(text))}>
      {done ? <CheckIcon width={15} height={15} /> : <ClipboardIcon width={15} height={15} />}
      {done ? 'Đã chép' : label}
    </button>
  )
}

export function InlineError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="inline-error" role="alert">
      <AlertIcon width={16} height={16} />
      <span>{message}</span>
    </div>
  )
}

interface ConfirmProps {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<void>
  onClose: () => void
}

export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onClose }: ConfirmProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={title}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Huỷ
          </button>
          <button type="button" className={`btn ${danger ? 'btn--danger' : 'btn--primary'} btn--md`} onClick={run} disabled={busy}>
            {busy && <span className="spinner" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm__text">{message}</div>
      <InlineError message={error} />
    </Modal>
  )
}

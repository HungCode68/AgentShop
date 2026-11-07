import { useState, type FormEvent } from 'react'
import { ClipboardIcon, EyeIcon, EyeOffIcon, KeyIcon, SearchIcon, XIcon } from './Icons'

interface Props {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  loading: boolean
  remember: boolean
  onRememberChange: (v: boolean) => void
}

export function KeyForm({ value, onChange, onSubmit, loading, remember, onRememberChange }: Props) {
  const [visible, setVisible] = useState(false)
  const canPaste = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (value.trim() && !loading) onSubmit()
  }

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) onChange(text.trim())
    } catch {
      /* clipboard permission denied — user can paste manually */
    }
  }

  return (
    <form className="key-form" onSubmit={handleSubmit}>
      <label htmlFor="api-key" className="key-form__label">API Key</label>
      <div className="key-form__row">
        <div className="key-input">
          <KeyIcon className="key-input__icon" />
          <input
            id="api-key"
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="as_xxxxxxxxxxxxxxxxxxxxxxxx"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          {value && (
            <button type="button" className="icon-btn" onClick={() => onChange('')} title="Xoá" aria-label="Xoá key">
              <XIcon />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={() => setVisible((v) => !v)}
            title={visible ? 'Ẩn key' : 'Hiện key'}
            aria-label={visible ? 'Ẩn key' : 'Hiện key'}
          >
            {visible ? <EyeOffIcon /> : <EyeIcon />}
          </button>
          {canPaste && (
            <button type="button" className="icon-btn" onClick={paste} title="Dán từ clipboard" aria-label="Dán từ clipboard">
              <ClipboardIcon />
            </button>
          )}
        </div>
        <button type="submit" className="btn btn--primary" disabled={!value.trim() || loading}>
          {loading ? <span className="spinner" aria-hidden /> : <SearchIcon />}
          <span>{loading ? 'Đang kiểm tra…' : 'Kiểm tra'}</span>
        </button>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={remember} onChange={(e) => onRememberChange(e.target.checked)} />
        <span>Ghi nhớ key trên trình duyệt này</span>
      </label>
    </form>
  )
}

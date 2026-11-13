import { useEffect, useState, type ReactNode } from 'react'
import { CheckIcon, ClipboardIcon } from '../components/Icons'
import { API_BASE } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { savedKey } from '../lib/savedKey'

/** Shared pieces of the guide pages (/huong-dan for Chatbox, /huong-dan/claude-code). */

// What users paste into Chatbox's "API Host": our gateway's proxy root (Chatbox appends /messages itself).
export const API_HOST = new URL(`${API_BASE}/proxy`, window.location.origin).href
export const SETUP_URL = new URL(`${API_BASE}/setup`, window.location.origin).href
export const KEY_PLACEHOLDER = 'KEY_CUA_BAN'
/** Step-by-step Claude Code (VS Code) setup, on its own page. */
export const CLAUDE_CODE_GUIDE = '/huong-dan/claude-code'

/** The user's own key, when the quota page remembered it or the link carried ?key=. */
export function knownKey(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('key')?.trim()
  const key = fromUrl || savedKey.get()
  return key && key.startsWith('ak_') ? key : null
}

export const mask = (k: string) => `${k.slice(0, 7)}••••••••${k.slice(-4)}`

export function CopyField({ label, value, display }: { label: string; value: string; display?: string }) {
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

/** One numbered step: text, then a screenshot (`img` in public/guide) or another visual. */
export function Step({
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
  visual?: ReactNode
  children: ReactNode
}) {
  const src = img ? `/guide/${img}` : ''
  return (
    <section className="card guide-step" id={id ?? `buoc-${n}`}>
      <div className="guide-step__head">
        <span className="guide-step__num">{n}</span>
        <h2>{title}</h2>
      </div>
      <div className="guide-step__body">{children}</div>
      {visual}
      {img && (
        <a className="guide-step__shot" href={src} target="_blank" rel="noreferrer" title="Bấm để xem ảnh lớn">
          <img src={src} alt={alt} loading={n === 1 ? 'eager' : 'lazy'} />
        </a>
      )}
    </section>
  )
}

/**
 * The page is lazy-loaded, so the browser's own jump to #section happens before the section
 * exists. Redo it once rendered, so links like /huong-dan#buoc-4 work.
 */
export function useHashScroll() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView()
  }, [])
}

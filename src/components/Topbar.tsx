import type { ReactNode } from 'react'

/** Brand bar shared by the quota page and the Chatbox guide; `children` go on the right. */
export function Topbar({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <a className="brand" href="/">
        <span className="brand__mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="18" height="18">
            <path d="M16 6a10 10 0 1 0 10 10" stroke="currentColor" strokeWidth="3.2" fill="none" strokeLinecap="round" />
            <circle cx="16" cy="16" r="3" fill="currentColor" />
          </svg>
        </span>
        <span className="brand__name">Quota Monitor</span>
      </a>
      <nav className="topbar__nav">{children}</nav>
    </header>
  )
}

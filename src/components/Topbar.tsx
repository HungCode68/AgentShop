import type { ReactNode } from 'react'
import { Brand } from './Logo'

/** Brand bar shared by the public pages; `children` go on the right. */
export function Topbar({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <Brand />
      <nav className="topbar__nav">{children}</nav>
    </header>
  )
}

import { useId } from 'react'

/**
 * AgentShop mark: a bold "A" on an indigo app-icon tile, its crossbar replaced by an amber
 * spark (the agent). Same drawing as public/favicon.svg - keep the two in sync.
 */
export function LogoMark({ size = 32 }: { size?: number }) {
  // Gradient ids must be unique per instance (the mark appears more than once on a page).
  const id = useId().replace(/:/g, '')
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden focusable="false">
      <defs>
        <linearGradient id={`${id}bg`} x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8b7dff" />
          <stop offset="1" stopColor="#4338ca" />
        </linearGradient>
        <linearGradient id={`${id}sheen`} x1="16" y1="0" x2="16" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity=".22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${id}spark`} cx="16" cy="19.6" r="2.4" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffe7a3" />
          <stop offset="1" stopColor="#f59e0b" />
        </radialGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id}bg)`} />
      <rect width="32" height="32" rx="9" fill={`url(#${id}sheen)`} />
      <rect x=".5" y=".5" width="31" height="31" rx="8.5" fill="none" stroke="#fff" strokeOpacity=".22" />
      <path d="M9.6 24 16 8.2 22.4 24" fill="none" stroke="#fff" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="19.6" r="2.2" fill={`url(#${id}spark)`} />
    </svg>
  )
}

/** Mark + "AgentShop" wordmark, linking home. */
export function Brand({ href = '/', suffix }: { href?: string; suffix?: string }) {
  return (
    <a className="brand" href={href} aria-label="AgentShop - trang chủ">
      <span className="brand__mark">
        <LogoMark />
      </span>
      <span className="brand__name">
        Agent<span className="brand__accent">Shop</span>
        {suffix && <span className="brand__suffix">{suffix}</span>}
      </span>
    </a>
  )
}

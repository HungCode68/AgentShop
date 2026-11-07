import type { ReactNode } from 'react'

interface Props {
  icon: ReactNode
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'accent' | 'ok' | 'warn' | 'danger'
}

export function StatCard({ icon, label, value, hint, tone = 'default' }: Props) {
  return (
    <div className={`stat stat--${tone}`}>
      <div className="stat__head">
        <span className="stat__icon">{icon}</span>
        <span className="stat__label">{label}</span>
      </div>
      <div className="stat__value">{value}</div>
      {hint && <div className="stat__hint">{hint}</div>}
    </div>
  )
}

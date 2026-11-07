import type { Level } from '../lib/format'

interface Props {
  percent: number
  level: Level
}

const SIZE = 200
const STROKE = 16
const R = (SIZE - STROKE) / 2
const C = 2 * Math.PI * R

export function UsageGauge({ percent, level }: Props) {
  const clamped = Math.max(0, Math.min(100, percent))
  const offset = C * (1 - clamped / 100)
  const digits = clamped > 0 && clamped < 10 ? 2 : 1

  return (
    <div className={`gauge gauge--${level}`} role="img" aria-label={`Đã sử dụng ${clamped.toFixed(digits)}%`}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" height="100%">
        <circle className="gauge__track" cx={SIZE / 2} cy={SIZE / 2} r={R} strokeWidth={STROKE} fill="none" />
        <circle
          className="gauge__value"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      <div className="gauge__center">
        <span className="gauge__percent">
          {clamped.toFixed(digits)}
          <small>%</small>
        </span>
        <span className="gauge__caption">đã sử dụng</span>
      </div>
    </div>
  )
}

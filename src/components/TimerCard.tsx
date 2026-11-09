import type { ReactNode } from 'react'
import { countdownParts, formatDateTime } from '../lib/format'

const pad = (n: number) => String(n).padStart(2, '0')

function Segment({ value, unit }: { value: string | number; unit: string }) {
  return (
    <span className="cd">
      <b>{value}</b>
      <small>{unit}</small>
    </span>
  )
}

/** Countdown to the minute, e.g. "6 ngày 21 giờ 34 phút". */
function Countdown({ ms }: { ms: number }) {
  const { days, hours, minutes } = countdownParts(ms)
  if (days === 0 && hours === 0 && minutes === 0) return <>Dưới 1 phút</>
  return (
    <>
      {days > 0 && <Segment value={days} unit="ngày" />}
      {(days > 0 || hours > 0) && <Segment value={pad(hours)} unit="giờ" />}
      <Segment value={pad(minutes)} unit="phút" />
    </>
  )
}

interface Props {
  icon: ReactNode
  title: string
  target: Date | null
  now: number
  /** When known, renders a progress bar of elapsed time between `start` and `target`. */
  start?: Date | null
  note?: string
  /** Shown when there is no target date. */
  emptyText?: string
}

export function TimerCard({ icon, title, target, now, start, note, emptyText = 'Không có dữ liệu' }: Props) {
  const remaining = target ? target.getTime() - now : null
  const progress =
    target && start ? Math.max(0, Math.min(100, ((now - start.getTime()) / (target.getTime() - start.getTime())) * 100)) : null

  return (
    <div className="timer">
      <div className="timer__head">
        <span className="timer__icon">{icon}</span>
        <span className="timer__title">{title}</span>
      </div>
      {target && remaining !== null ? (
        <>
          <div className={`timer__countdown ${remaining <= 0 ? 'is-due' : ''}`}>
            {remaining <= 0 ? 'Đã đến hạn' : <Countdown ms={remaining} />}
          </div>
          <div className="timer__date">{formatDateTime(target)}</div>
          {progress !== null && (
            <div className="bar bar--thin" aria-hidden>
              <div className="bar__fill" style={{ width: `${progress}%` }} />
            </div>
          )}
        </>
      ) : (
        <div className="timer__countdown timer__countdown--muted">{emptyText}</div>
      )}
      {note && <div className="timer__note">{note}</div>}
    </div>
  )
}

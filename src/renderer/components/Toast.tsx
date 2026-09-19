import { useEffect, useRef, useState } from 'react'

/**
 * A passing message that clears itself — for news, not for decisions.
 *
 * A `Notice` holds the panes down until it is dismissed, which is right for a
 * conflict or a failed save and wrong for something the user needs only to have
 * seen, like an encoding that was sniffed rather than declared (§6). This floats
 * over the panes instead, so nothing shifts, and goes away on its own.
 *
 * Same rules as the notice: no colour, no shadow. It separates from the pane
 * behind it by the surface step and a hairline. The timer holds while the
 * pointer is over it, so a slow reader is not cut off, and a click clears it.
 */

const DEFAULT_DURATION_MS = 4000
/** Matches `--duration-standard`, the fade the stylesheet runs on the way out. */
const LEAVE_MS = 200

interface ToastProps {
  message: string
  detail?: string
  durationMs?: number
  onDone: () => void
}

export function Toast({
  message,
  detail,
  durationMs = DEFAULT_DURATION_MS,
  onDone
}: ToastProps): React.JSX.Element {
  const [leaving, setLeaving] = useState(false)
  const [paused, setPaused] = useState(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    if (paused || leaving) return
    const timer = window.setTimeout(() => setLeaving(true), durationMs)
    return () => window.clearTimeout(timer)
  }, [paused, leaving, durationMs])

  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => onDoneRef.current(), LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [leaving])

  return (
    <div
      className={leaving ? 'toast toast--leaving' : 'toast'}
      role="status"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onClick={() => setLeaving(true)}
    >
      <span className="toast__message">{message}</span>
      {detail ? <span className="toast__detail">{detail}</span> : null}
    </div>
  )
}

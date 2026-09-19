import { useCallback, useRef, useState } from 'react'

/**
 * Draggable pane divider (design 3e).
 *
 * Drag to resize; double-click restores 50/50. Neither pane can be dragged
 * narrower than MIN_RATIO of the split — the divider stops there. Carrying the
 * pointer on past a pane's minimum width (--pane-min-width) snaps the layout
 * into focus view, which is how the design lets a drag express "I only want one
 * pane" without a separate control.
 */

/** Smallest share of the split either pane can be dragged to. */
export const MIN_RATIO = 0.2
export const MAX_RATIO = 1 - MIN_RATIO

export function clampRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

interface DividerProps {
  onRatioChange: (ratio: number) => void
  onReset: () => void
  /** Called when a drag crosses the minimum width on either side. */
  onSnapToFocus: (pane: 'editor' | 'preview') => void
  minWidth: number
}

export function Divider({
  onRatioChange,
  onReset,
  onSnapToFocus,
  minWidth
}: DividerProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const snappedRef = useRef(false)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // React clears currentTarget once this handler returns, so the move
      // listener below must not read it from the event.
      const handle = event.currentTarget
      const before = handle.previousElementSibling
      const after = handle.nextElementSibling
      if (!before || !after) return

      event.preventDefault()
      handle.setPointerCapture(event.pointerId)
      setDragging(true)
      snappedRef.current = false

      // Measured against the two panes, not the whole row: the row also holds
      // the shell padding and, when open, the history sidebar.
      const start = before.getBoundingClientRect().left
      const usable = before.getBoundingClientRect().width + after.getBoundingClientRect().width
      const half = handle.offsetWidth / 2

      const onMove = (move: PointerEvent): void => {
        if (snappedRef.current) return
        const left = move.clientX - start - half

        if (left < minWidth / 2) {
          snappedRef.current = true
          onSnapToFocus('preview')
          return
        }
        if (left > usable - minWidth / 2) {
          snappedRef.current = true
          onSnapToFocus('editor')
          return
        }

        onRatioChange(clampRatio(left / usable))
      }

      const onUp = (): void => {
        setDragging(false)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [minWidth, onRatioChange, onSnapToFocus]
  )

  return (
    <div
      className={dragging ? 'divider divider--dragging' : 'divider'}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      title="Drag to resize · double-click to reset"
    >
      <div className="divider__grip" />
    </div>
  )
}

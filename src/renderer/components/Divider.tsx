import { useCallback, useRef, useState } from 'react'

/**
 * Draggable pane divider (design 3e).
 *
 * Drag to resize; double-click restores 50/50. Panels have a minimum width
 * (--pane-min-width) before the divider snaps the layout into focus view, which
 * is how the design lets a drag express "I only want one pane" without a
 * separate control.
 */

interface DividerProps {
  /** Container the ratio is measured against. */
  containerRef: React.RefObject<HTMLElement | null>
  onRatioChange: (ratio: number) => void
  onReset: () => void
  /** Called when a drag crosses the minimum width on either side. */
  onSnapToFocus: (pane: 'editor' | 'preview') => void
  minWidth: number
}

export function Divider({
  containerRef,
  onRatioChange,
  onReset,
  onSnapToFocus,
  minWidth
}: DividerProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const snappedRef = useRef(false)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current
      if (!container) return

      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
      snappedRef.current = false

      const bounds = container.getBoundingClientRect()
      // The divider occupies width the panes cannot use.
      const usable = bounds.width - event.currentTarget.offsetWidth

      const onMove = (move: PointerEvent): void => {
        if (snappedRef.current) return
        const offset = move.clientX - bounds.left
        const left = offset - event.currentTarget.offsetWidth / 2

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

        onRatioChange(Math.min(0.85, Math.max(0.15, left / usable)))
      }

      const onUp = (): void => {
        setDragging(false)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [containerRef, minWidth, onRatioChange, onSnapToFocus]
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

import { useRef, useState } from 'react'

import { dropIndexAt, isDetachGesture } from '@core/tabs/order'
import type { DocId, DocMeta } from '@shared/types'

/**
 * Tab strip (plan §4.1, design 3a/3e).
 *
 * Its own full-width row below the title bar (design 4a). The native window
 * controls are drawn over the title bar, not over this, so the tabs keep the
 * whole width on both platforms and only the filler past them drags the window.
 *
 * §4.1's rule about the close affordance: a dirty document shows a dot *in place
 * of* the close button until the tab is hovered. That is why both live in the
 * same slot and swap on hover rather than sitting side by side — a tab that
 * changes width when you point at it is worse than either.
 *
 * Dragging: a tab reorders within the strip, and a drag that ends outside it
 * detaches the document into a window of its own. The index arithmetic and the
 * detach test live in `@core/tabs/order` — both are easy to get subtly wrong and
 * neither needs a pointer to test.
 *
 * The strip does not shrink tabs below a readable minimum and scrolls instead.
 */

interface TabStripProps {
  documents: DocMeta[]
  activeId: DocId | null
  onSelect: (id: DocId) => void
  onNew: () => void
  onClose: (id: DocId) => void
  /** Commit a new tab order after a drag within the strip (§4.1). */
  onReorder: (from: number, to: number) => void
  /** The drag ended outside the strip: give this document its own window. */
  onDetach: (id: DocId) => void
}

export function TabStrip({
  documents,
  activeId,
  onSelect,
  onNew,
  onClose,
  onReorder,
  onDetach
}: TabStripProps): React.JSX.Element {
  const stripRef = useRef<HTMLDivElement | null>(null)
  const dragFrom = useRef<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  /** Tab rectangles, for deciding which gap the pointer is over. */
  const tabRects = (): Array<{ left: number; right: number }> => {
    const strip = stripRef.current
    if (!strip) return []
    return [...strip.querySelectorAll('.tab')].map((el) => {
      const rect = el.getBoundingClientRect()
      return { left: rect.left, right: rect.right }
    })
  }

  const endDrag = (): void => {
    dragFrom.current = null
    setDropAt(null)
  }

  return (
    <div
      className="tabstrip"
      role="tablist"
      aria-label="Open documents"
      ref={stripRef}
      onDragOver={(event) => {
        if (dragFrom.current === null) return
        // Without this the strip is not a drop target and dropEffect stays
        // 'none', which is the same signal a detach uses.
        event.preventDefault()
        setDropAt(dropIndexAt(event.clientX, tabRects()))
      }}
      onDrop={(event) => {
        const from = dragFrom.current
        if (from === null) return
        event.preventDefault()
        const to = dropIndexAt(event.clientX, tabRects())
        endDrag()
        onReorder(from, to)
      }}
    >
      {documents.map((document, index) => {
        const active = document.id === activeId
        return (
          // A div rather than a button: the close affordance is itself a button,
          // and a button inside a button is invalid and unreachable by keyboard.
          <div
            key={document.id}
            role="tab"
            tabIndex={active ? 0 : -1}
            aria-selected={active}
            className={[
              'tab',
              active ? 'tab--active' : '',
              dropAt === index && dragFrom.current !== null ? 'tab--dropBefore' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            draggable
            onDragStart={(event) => {
              dragFrom.current = index
              event.dataTransfer.effectAllowed = 'move'
              // Firefox refuses to start a drag without data on the transfer.
              event.dataTransfer.setData('text/plain', document.id)
            }}
            onDragEnd={(event) => {
              const from = dragFrom.current
              endDrag()
              if (from === null) return
              // dropEffect 'none' means no target inside the app took it. Paired
              // with a pointer outside the strip, that is a detach (§4.1).
              if (event.dataTransfer.dropEffect !== 'none') return

              const strip = stripRef.current?.getBoundingClientRect()
              if (!strip) return
              if (isDetachGesture({ x: event.clientX, y: event.clientY }, strip)) {
                onDetach(document.id)
              }
            }}
            onClick={() => onSelect(document.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(document.id)
              }
            }}
            title={document.path ?? document.name}
          >
            <span className="tab__name">{document.name}</span>

            <span className="tab__slot">
              {document.dirty ? <span className="tab__dot" aria-label="Unsaved changes" /> : null}
              <button
                type="button"
                className="tab__close"
                aria-label={`Close ${document.name}`}
                onClick={(event) => {
                  // The tab underneath would otherwise select on the way through.
                  event.stopPropagation()
                  onClose(document.id)
                }}
              >
                <CloseGlyph />
              </button>
            </span>
          </div>
        )
      })}

      <button
        type="button"
        className="tab-add"
        onClick={onNew}
        title="New document"
        aria-label="New document"
      >
        +
      </button>

      <div className="tabstrip__filler" />
    </div>
  )
}

/** A 1px stroke, per the system: no filled icons anywhere in the chrome. */
function CloseGlyph(): React.JSX.Element {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5" />
    </svg>
  )
}

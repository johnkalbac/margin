import { useCallback, useEffect, useRef } from 'react'

import { renderAndSanitize } from '@core/markdown'
import type { Flavor } from '@shared/types'
import { patchBlocks } from '../preview/patch'
import { PaneHeader } from './PaneHeader'

/**
 * The rendered preview (plan §4.2, §10, §11).
 *
 * Content arrives already debounced by App; this component's job is to render,
 * sanitize, and patch — never to replace the whole subtree.
 */

interface PreviewPaneProps {
  source: string
  flavor: Flavor
  maximized: boolean
  hidden: boolean
  accelerator: string | null
  onToggle: () => void
  onInteract: () => void
  scrollRef: React.RefObject<HTMLDivElement | null>
  style?: React.CSSProperties
}

export function PreviewPane({
  source,
  flavor,
  maximized,
  hidden,
  accelerator,
  onToggle,
  onInteract,
  scrollRef,
  style
}: PreviewPaneProps): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = contentRef.current
    if (!container) return
    // A background pane renders nothing at all — plan §11.
    if (hidden) return
    patchBlocks(container, renderAndSanitize(source, flavor))
  }, [source, flavor, hidden])

  /**
   * External links open in the system browser, never in-app (plan §10). The
   * main process re-validates the protocol; this only decides what to hand over.
   */
  const onClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href) return

    event.preventDefault()

    if (/^https?:/i.test(href)) {
      void window.margin.shell.openExternal(href)
      return
    }

    // In-document anchors scroll; file:// links become doc:open in Phase 2.
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1))
      const target = contentRef.current?.querySelector(`#${CSS.escape(id)}`)
      target?.scrollIntoView({ block: 'start' })
    }
  }, [])

  // As in EditorPane: the wrapper is constant so that toggling focus never
  // unmounts the scroll container and discards its position.
  return (
    <section
      className="pane"
      style={style}
      hidden={hidden}
      aria-label="Preview"
      onPointerEnter={onInteract}
      onFocusCapture={onInteract}
    >
      <PaneHeader
        label="Preview"
        maximized={maximized}
        accelerator={accelerator}
        onToggle={onToggle}
      />
      <div className={maximized ? 'pane__measure pane__measure--active' : 'pane__measure'}>
        <div className="preview__scroll" ref={scrollRef}>
          <div className="markdown" ref={contentRef} onClick={onClick} />
        </div>
      </div>
    </section>
  )
}

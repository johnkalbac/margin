import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { EditorView } from '@codemirror/view'

import { SOURCE_LINE_ATTR } from '@core/markdown'

/**
 * Scroll sync by source mapping, not percentage (plan §4.2).
 *
 * Percentage-of-height sync is visibly wrong on any document containing an image
 * or a code block, because equal spans of source do not occupy equal rendered
 * height. Instead the preview carries `data-source-line` on every block element
 * (see core/markdown/sourceLine.ts) and this hook interpolates between those
 * anchors in both directions.
 *
 * Two rules keep it from oscillating:
 *   · sync only from the pane the user is actually driving, and
 *   · hold a `syncing` flag across a frame so the programmatic scroll we cause
 *     on the far side is not read back as user input.
 */

export type SyncSource = 'editor' | 'preview'

interface Anchor {
  line: number
  top: number
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Ascending `data-source-line` anchors, measured against the scroll container. */
function readAnchors(container: HTMLElement): Anchor[] {
  const elements = container.querySelectorAll<HTMLElement>(`[${SOURCE_LINE_ATTR}]`)
  const anchors: Anchor[] = []
  for (const element of elements) {
    const line = Number(element.getAttribute(SOURCE_LINE_ATTR))
    if (!Number.isFinite(line)) continue
    const top = element.offsetTop
    // Nested blocks can repeat a line; the outermost (first seen) wins.
    if (anchors.length > 0 && anchors[anchors.length - 1]!.line === line) continue
    anchors.push({ line, top })
  }
  return anchors
}

/** Linear interpolation between the two anchors bracketing `line`. */
function topForLine(anchors: Anchor[], line: number, fallbackHeight: number): number {
  if (anchors.length === 0) return 0
  if (line <= anchors[0]!.line) return anchors[0]!.top

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]!
    const b = anchors[i + 1]!
    if (line >= a.line && line < b.line) {
      const span = b.line - a.line
      const progress = span > 0 ? (line - a.line) / span : 0
      return a.top + progress * (b.top - a.top)
    }
  }

  const last = anchors[anchors.length - 1]!
  return last.top + (line - last.line) * fallbackHeight
}

/** Inverse of `topForLine`: which source line sits at this preview offset. */
function lineForTop(anchors: Anchor[], top: number, fallbackHeight: number): number {
  if (anchors.length === 0) return 1
  if (top <= anchors[0]!.top) return anchors[0]!.line

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]!
    const b = anchors[i + 1]!
    if (top >= a.top && top < b.top) {
      const span = b.top - a.top
      const progress = span > 0 ? (top - a.top) / span : 0
      return a.line + progress * (b.line - a.line)
    }
  }

  const last = anchors[anchors.length - 1]!
  return last.line + (top - last.top) / Math.max(1, fallbackHeight)
}

/**
 * The fractional source line at the top of the editor viewport. Fractional so
 * that scrolling through a tall wrapped line or a code block still moves the
 * preview smoothly rather than in jumps.
 */
function editorTopLine(view: EditorView): number {
  const rect = view.scrollDOM.getBoundingClientRect()
  const position = view.posAtCoords({ x: rect.left + 4, y: rect.top + 1 }, false)
  const block = view.lineBlockAt(position)
  const line = view.state.doc.lineAt(block.from).number

  const coords = view.coordsAtPos(block.from)
  const progress =
    coords && block.height > 0 ? clamp((rect.top - coords.top) / block.height, 0, 1) : 0

  return line + progress
}

interface ScrollSyncOptions {
  getView: () => EditorView | null
  previewRef: RefObject<HTMLElement | null>
  /** False while a pane is maximized or the panes are not mounted. */
  enabled: boolean
}

export function useScrollSync({ getView, previewRef, enabled }: ScrollSyncOptions): {
  setSource: (source: SyncSource) => void
  alignPreview: () => void
} {
  const sourceRef = useRef<SyncSource>('editor')
  const syncingRef = useRef(false)
  const frameRef = useRef<number | null>(null)
  const alignRef = useRef<(() => void) | null>(null)

  const setSource = useCallback((source: SyncSource) => {
    sourceRef.current = source
  }, [])

  /**
   * Bring the preview to the editor's position, whichever pane was driving.
   *
   * For a tab switch: the editor restores that document's scroll snapshot, but
   * the scroll event it fires is dropped when the preview was the source, and
   * otherwise lands before the preview holds the new document. Either way the
   * preview was left wherever patching the new content put it — usually the top.
   */
  const alignPreview = useCallback(() => alignRef.current?.(), [])

  useEffect(() => {
    if (!enabled) return

    /*
     * Neither the view nor the preview element is captured here. The EditorView
     * is created and destroyed by a ref callback, and React can replace it
     * without this effect re-running: StrictMode in development mounts, tears
     * down and remounts the pane, and the effect ended up bound to the
     * scroller of the view that had just been destroyed — so in `npm run dev`
     * the editor never drove the preview at all. Both are read at event time
     * instead, and one capture-phase listener on the document sees scroll
     * events from whichever elements are current (scroll does not bubble, but
     * it does capture).
     */
    const current = (): { view: EditorView; preview: HTMLElement } | null => {
      const view = getView()
      const preview = previewRef.current
      return view && preview ? { view, preview } : null
    }

    /** Suppress the echo from the scroll we are about to cause. */
    const guard = (apply: () => void): void => {
      if (syncingRef.current) return
      syncingRef.current = true
      apply()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(() => {
        syncingRef.current = false
        frameRef.current = null
      })
    }

    const previewTargetForEditor = (view: EditorView, preview: HTMLElement): number | null => {
      const anchors = readAnchors(preview)
      if (anchors.length === 0) return null
      const target = topForLine(anchors, editorTopLine(view), view.defaultLineHeight)
      return clamp(target, 0, preview.scrollHeight - preview.clientHeight)
    }

    const syncPreviewToEditor = (view: EditorView, preview: HTMLElement): void => {
      guard(() => {
        const target = previewTargetForEditor(view, preview)
        if (target !== null) preview.scrollTop = target
      })
    }

    const syncEditorToPreview = (view: EditorView, preview: HTMLElement): void => {
      guard(() => {
        const anchors = readAnchors(preview)
        if (anchors.length === 0) return
        const scroller = view.scrollDOM
        const line = lineForTop(anchors, preview.scrollTop, view.defaultLineHeight)
        const clamped = clamp(Math.floor(line), 1, view.state.doc.lines)
        const block = view.lineBlockAt(view.state.doc.line(clamped).from)
        const fraction = line - clamped
        scroller.scrollTop = clamp(
          block.top + fraction * block.height,
          0,
          scroller.scrollHeight - scroller.clientHeight
        )
      })
    }

    const onScroll = (event: Event): void => {
      const panes = current()
      if (!panes) return
      if (event.target === panes.view.scrollDOM) {
        if (sourceRef.current === 'editor') syncPreviewToEditor(panes.view, panes.preview)
      } else if (event.target === panes.preview) {
        if (sourceRef.current === 'preview') syncEditorToPreview(panes.view, panes.preview)
      }
    }

    // Two frames on, so CodeMirror has applied the incoming state's scroll
    // restore (it lands in the view's own measure cycle, which a measure
    // request is not ordered after) and the preview holds the new document.
    let alignFrame: number | null = null
    alignRef.current = () => {
      if (alignFrame !== null) cancelAnimationFrame(alignFrame)
      alignFrame = requestAnimationFrame(() => {
        alignFrame = requestAnimationFrame(() => {
          alignFrame = null
          const panes = current()
          if (!panes) return
          syncingRef.current = false
          syncPreviewToEditor(panes.view, panes.preview)
        })
      })
    }

    document.addEventListener('scroll', onScroll, { capture: true, passive: true })

    return () => {
      alignRef.current = null
      if (alignFrame !== null) cancelAnimationFrame(alignFrame)
      document.removeEventListener('scroll', onScroll, { capture: true })
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      syncingRef.current = false
    }
  }, [enabled, getView, previewRef])

  return { setSource, alignPreview }
}

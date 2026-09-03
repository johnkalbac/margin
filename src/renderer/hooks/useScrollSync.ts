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
  /** False while a pane is maximized — there is nothing to sync to. */
  enabled: boolean
}

export function useScrollSync({ getView, previewRef, enabled }: ScrollSyncOptions): {
  setSource: (source: SyncSource) => void
} {
  const sourceRef = useRef<SyncSource>('editor')
  const syncingRef = useRef(false)
  const frameRef = useRef<number | null>(null)

  const setSource = useCallback((source: SyncSource) => {
    sourceRef.current = source
  }, [])

  useEffect(() => {
    if (!enabled) return
    const view = getView()
    const preview = previewRef.current
    if (!view || !preview) return

    const editorScroller = view.scrollDOM

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

    const onEditorScroll = (): void => {
      if (sourceRef.current !== 'editor') return
      guard(() => {
        const anchors = readAnchors(preview)
        if (anchors.length === 0) return
        const line = editorTopLine(view)
        const target = topForLine(anchors, line, view.defaultLineHeight)
        preview.scrollTop = clamp(target, 0, preview.scrollHeight - preview.clientHeight)
      })
    }

    const onPreviewScroll = (): void => {
      if (sourceRef.current !== 'preview') return
      guard(() => {
        const anchors = readAnchors(preview)
        if (anchors.length === 0) return
        const line = lineForTop(anchors, preview.scrollTop, view.defaultLineHeight)
        const clamped = clamp(Math.floor(line), 1, view.state.doc.lines)
        const block = view.lineBlockAt(view.state.doc.line(clamped).from)
        const fraction = line - clamped
        editorScroller.scrollTop = clamp(
          block.top + fraction * block.height,
          0,
          editorScroller.scrollHeight - editorScroller.clientHeight
        )
      })
    }

    editorScroller.addEventListener('scroll', onEditorScroll, { passive: true })
    preview.addEventListener('scroll', onPreviewScroll, { passive: true })

    return () => {
      editorScroller.removeEventListener('scroll', onEditorScroll)
      preview.removeEventListener('scroll', onPreviewScroll)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      syncingRef.current = false
    }
  }, [enabled, getView, previewRef])

  return { setSource }
}

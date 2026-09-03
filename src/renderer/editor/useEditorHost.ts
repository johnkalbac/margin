import { useCallback, useEffect, useRef } from 'react'
import { EditorView } from '@codemirror/view'
import { redo, selectAll, undo } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import type { EditorState } from '@codemirror/state'

/** The effect returned by `view.scrollSnapshot()`, replayed to restore scroll. */
type ScrollSnapshot = ReturnType<EditorView['scrollSnapshot']>

import type { DocId, ThemeMode } from '@shared/types'
import { createEditorState, reconfigureTheme, type EditorCallbacks } from './setup'
import { reconfigureCompare, type CompareSource } from './compare'

/**
 * One EditorView, N EditorStates (plan §11).
 *
 * Mounting an editor per tab is the single biggest memory mistake available in
 * this design, so tabs are states in a Map and switching is `view.setState`.
 *
 * Two consequences the plan calls out and this hook handles:
 *   · Selection lives in EditorState; scroll position does NOT. Without
 *     capturing `view.scrollSnapshot()` before switching away, every tab switch
 *     jumps to the top.
 *   · There is no dispose call. The Map entry is the only reference keeping a
 *     state alive, so closing a tab must delete it.
 */

export interface EditorHost {
  /** Ref callback for the element that hosts the single EditorView. */
  attach: (element: HTMLDivElement | null) => void
  getView: () => EditorView | null
  /** Create the state for a document if it does not exist yet. */
  openDocument: (docId: DocId, content: string) => void
  /**
   * Rebuild a document's state around new content, for a reload or a reopen
   * under a different encoding. Distinct from `openDocument`, which is a no-op
   * when the document already exists — the whole point here is to replace what
   * is there, including its undo history, because the bytes came from disk and
   * the old history no longer describes them.
   */
  replaceDocument: (docId: DocId, content: string) => void
  /** Make a document's state the live one, restoring its scroll position. */
  activateDocument: (docId: DocId) => void
  /** The active document's text, for a save. Null before the view exists. */
  getContent: () => string | null
  /** Drop a state so it can be collected. */
  closeDocument: (docId: DocId) => void
  focus: () => void
  /** Re-measure after the pane changes size or returns from display:none. */
  measure: () => void
  /**
   * Swap the theme without rebuilding state (plan §4.4).
   *
   * A compartment instance is per-state, so this reconfigures the *live* view
   * and updates the mode the factory builds future states with. Without the
   * second half, a tab opened after the toggle — or one reactivated from the
   * Map — comes back in the old theme, which is the light-mode residue §13's
   * Phase 3 criterion calls out.
   */
  setTheme: (mode: ThemeMode) => void
  /** Run an editor-owned command by catalog id, for a menu click (§7). */
  runCommand: (id: string) => boolean
  /**
   * Show or clear an inline diff against `source` (§13 Phase 6).
   *
   * A compartment reconfigure, like the theme — passing null leaves compare.
   * Entering and leaving does not rebuild the state, so the selection and
   * scroll position the user had are still there afterwards.
   */
  setCompare: (source: CompareSource | null) => void
}

interface HostOptions {
  mode: ThemeMode
  callbacks: EditorCallbacks
}

export function useEditorHost({ mode, callbacks }: HostOptions): EditorHost {
  const viewRef = useRef<EditorView | null>(null)
  const statesRef = useRef(new Map<DocId, EditorState>())
  const scrollRef = useRef(new Map<DocId, ScrollSnapshot>())
  const activeRef = useRef<DocId | null>(null)
  /** Set by a theme toggle; cleared as each state is reconfigured on activation. */
  const themeDirty = useRef(false)

  // Callbacks are captured inside immutable EditorState extensions, so they are
  // read through a ref rather than baked in — otherwise a re-render would need
  // every state rebuilt to see the new closure.
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  const modeRef = useRef(mode)
  modeRef.current = mode

  const stableCallbacks = useRef<EditorCallbacks>({
    onDocChanged: (docId, changes, content) =>
      callbacksRef.current.onDocChanged(docId, changes, content),
    onSelectionChanged: (docId, position) =>
      callbacksRef.current.onSelectionChanged(docId, position),
    onContentChanged: (docId, content) => callbacksRef.current.onContentChanged(docId, content)
  }).current

  const openDocument = useCallback(
    (docId: DocId, content: string) => {
      if (statesRef.current.has(docId)) return
      statesRef.current.set(
        docId,
        createEditorState({
          docId,
          content,
          mode: modeRef.current,
          callbacks: stableCallbacks
        })
      )
    },
    [stableCallbacks]
  )

  const replaceDocument = useCallback(
    (docId: DocId, content: string) => {
      const fresh = createEditorState({
        docId,
        content,
        mode: modeRef.current,
        callbacks: stableCallbacks
      })
      statesRef.current.set(docId, fresh)
      // The old scroll offset refers to a document that no longer exists.
      scrollRef.current.delete(docId)

      // If this is the live document, the view has to be told; setting the Map
      // entry alone would leave the old buffer on screen.
      if (activeRef.current === docId) viewRef.current?.setState(fresh)
    },
    [stableCallbacks]
  )

  const activateDocument = useCallback((docId: DocId) => {
    const next = statesRef.current.get(docId)
    if (!next) return

    const view = viewRef.current
    if (!view) {
      /*
       * No view yet. Since the home screen, the panes are unmounted whenever
       * there is no document, so the first document of a window is activated a
       * render before `attach` runs. Record the intent — `attach` reads
       * activeRef to choose the state it mounts with — rather than dropping the
       * activation and leaving an empty editor behind.
       */
      activeRef.current = docId
      return
    }
    if (activeRef.current === docId) return

    // Persist the outgoing document: its state carries the buffer and selection,
    // the snapshot carries the scroll position that the state does not.
    const previous = activeRef.current
    if (previous !== null) {
      statesRef.current.set(previous, view.state)
      scrollRef.current.set(previous, view.scrollSnapshot())
    }

    view.setState(next)
    activeRef.current = docId

    // The incoming state may have been built before a theme toggle, so bring it
    // up to date before anything is painted from it (plan §4.4).
    if (themeDirty.current) reconfigureTheme(view, modeRef.current)

    const restore = scrollRef.current.get(docId)
    if (restore) view.dispatch({ effects: restore })
  }, [])

  const closeDocument = useCallback((docId: DocId) => {
    statesRef.current.delete(docId)
    scrollRef.current.delete(docId)
    if (activeRef.current === docId) activeRef.current = null
  }, [])

  const attach = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      viewRef.current?.destroy()
      viewRef.current = null
      activeRef.current = null
      return
    }
    if (viewRef.current) return

    const first = activeRef.current
    const initial = first ? statesRef.current.get(first) : undefined

    viewRef.current = new EditorView({
      parent: element,
      ...(initial ? { state: initial } : {})
    })
  }, [])

  const setTheme = useCallback((mode: ThemeMode) => {
    // Future states: createEditorState reads this on construction.
    modeRef.current = mode
    // The live one: its compartment already exists and has to be reconfigured.
    const view = viewRef.current
    if (view) reconfigureTheme(view, mode)

    /*
     * Every *inactive* state keeps the compartment contents it was built with,
     * and there is no way to dispatch into a state that is not on a view. They
     * are rebuilt lazily instead: activateDocument reconfigures on the way in,
     * which is cheap and keeps this from walking every open tab on a toggle.
     */
    themeDirty.current = true
  }, [])

  const setCompare = useCallback((source: CompareSource | null) => {
    const view = viewRef.current
    if (view) reconfigureCompare(view, source)
  }, [])

  const runCommand = useCallback((id: string) => {
    const view = viewRef.current
    if (!view) return false

    switch (id) {
      case 'edit.undo':
        return undo(view)
      case 'edit.redo':
        return redo(view)
      case 'edit.selectAll':
        return selectAll(view)
      /*
       * Find and Replace open the same panel: @codemirror/search has one, with
       * the replace row shown when the panel is opened for replacing. §5 is
       * explicit that none of this is to be reimplemented.
       */
      case 'edit.find':
      case 'edit.replace':
        return openSearchPanel(view)
      default:
        return false
    }
  }, [])

  const getView = useCallback(() => viewRef.current, [])
  const focus = useCallback(() => viewRef.current?.focus(), [])
  const measure = useCallback(() => viewRef.current?.requestMeasure(), [])

  /**
   * Read straight off the live view rather than off the Map: the Map entry for
   * the active document is only refreshed when it is switched away from, so it
   * is stale by every edit made since.
   */
  const getContent = useCallback(() => viewRef.current?.state.doc.toString() ?? null, [])

  useEffect(() => {
    return () => {
      viewRef.current?.destroy()
      viewRef.current = null
      statesRef.current.clear()
      scrollRef.current.clear()
    }
  }, [])

  return {
    attach,
    getView,
    openDocument,
    replaceDocument,
    activateDocument,
    getContent,
    closeDocument,
    focus,
    measure,
    setTheme,
    runCommand,
    setCompare
  }
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { DEFAULT_FLAVOR, type Flavor } from '@core/markdown'
import { reorder } from '@core/tabs/order'
import { formatAccelerator } from '@core/commands/registry'
import { matchesAccelerator } from '@core/commands/keys'
import type { CloseChoice, DocumentPayload } from '@shared/ipc'
import type { CompareSource } from './editor/compare'
import type { DocId, DocMeta, Encoding, PaneFocus, ThemeMode } from '@shared/types'

import { CommandPalette } from './components/CommandPalette'
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog'
import { Divider } from './components/Divider'
import { EditorPane } from './components/EditorPane'
import { HistorySidebar } from './components/HistorySidebar'
import { HomeScreen } from './components/HomeScreen'
import { Notice, type NoticeAction } from './components/Notice'
import { PreviewPane } from './components/PreviewPane'
import { StatusBar } from './components/StatusBar'
import { TabStrip } from './components/TabStrip'
import { TitleBar } from './components/TitleBar'
import { createCommandRegistry, type AppContext } from './commands/appCommands'
import { useEditorHost } from './editor/useEditorHost'
import { useScrollSync } from './hooks/useScrollSync'
import type { CursorPosition } from './editor/setup'
import { WELCOME_DOCUMENT } from './welcome'

/**
 * Window shell.
 *
 * Main owns `DocMeta` through DocumentRegistry (§2); this component receives it
 * over IPC and never touches `fs`. From Phase 3 it holds many documents, one
 * `EditorState` each, sharing a single `EditorView` (§11).
 */

/** Plan §11: ~40ms, and off the critical path. */
const PREVIEW_DEBOUNCE_MS = 40
const SPLIT_STORAGE_KEY = 'margin.splitRatio'
const DEFAULT_RATIO = 0.5

interface NoticeState {
  message: string
  detail?: string
  actions?: NoticeAction[]
}

/** requestIdleCallback where available, a frame otherwise (plan §11). */
function scheduleIdle(task: () => void): void {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => task(), { timeout: 120 })
  } else {
    requestAnimationFrame(() => task())
  }
}

function readStoredRatio(): number {
  const stored = Number(window.localStorage.getItem(SPLIT_STORAGE_KEY))
  return Number.isFinite(stored) && stored > 0.1 && stored < 0.9 ? stored : DEFAULT_RATIO
}

function countWords(source: string): number {
  const matches = source.trim().match(/\S+/g)
  return matches ? matches.length : 0
}

export function App(): React.JSX.Element {
  const platform = window.margin.platform

  const [documents, setDocuments] = useState<DocMeta[]>([])
  const [activeId, setActiveId] = useState<DocId | null>(null)
  const [paneFocus, setPaneFocusState] = useState<PaneFocus>('split')
  const [ratio, setRatio] = useState(readStoredRatio)
  const [theme, setThemeState] = useState<ThemeMode>('light')
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, column: 1, selectionLength: 0 })
  const [previewSource, setPreviewSource] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)
  /**
   * What the palette opens pre-typed with. Empty for ⌘K and the footer's
   * Commands button; the encoding field seeds it so the palette lands on the
   * reopen commands instead of the whole catalog (§4.5).
   */
  const [paletteQuery, setPaletteQuery] = useState('')
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [compareSource, setCompareSource] = useState<CompareSource | null>(null)
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const [autoSave, setAutoSaveState] = useState(false)
  const [autoSaveDelayMs, setAutoSaveDelayMs] = useState(15_000)
  const [saveOnExit, setSaveOnExitState] = useState(false)

  /** True once this window has asked main for its startup document. */
  const seededRef = useRef(false)
  /**
   * True once the startup document has arrived (or been declined, for a handover
   * window). The home screen waits for it: at the first render `documents` is
   * empty because the create is still in flight, and showing the empty state
   * then would flash it on every launch.
   */
  const [booted, setBooted] = useState(false)
  const panesRef = useRef<HTMLDivElement | null>(null)
  const previewScrollRef = useRef<HTMLDivElement | null>(null)
  const previewScrollMemo = useRef(0)

  const activeDocument = documents.find((document) => document.id === activeId) ?? null
  const flavor: Flavor = activeDocument?.flavor ?? DEFAULT_FLAVOR

  // IPC subscriptions are registered once and outlive any given render, so the
  // state they read has to come through refs rather than through a closure.
  const activeIdRef = useRef<DocId | null>(null)
  activeIdRef.current = activeId
  const activeDocumentRef = useRef<DocMeta | null>(null)
  activeDocumentRef.current = activeDocument
  const documentsRef = useRef<DocMeta[]>([])
  documentsRef.current = documents

  // ── Change capture and preview scheduling ─────────────────────────────────

  /** Per-document, strictly sequential. A gap invalidates the journal (plan §9). */
  const versionsRef = useRef(new Map<string, number>())
  const pendingSourceRef = useRef('')
  const debounceRef = useRef<number | null>(null)
  const cursorFrameRef = useRef<number | null>(null)
  const pendingCursorRef = useRef<CursorPosition | null>(null)

  const onDocChanged = useCallback((docId: string, changes: unknown, content: string) => {
    const version = (versionsRef.current.get(docId) ?? 0) + 1
    versionsRef.current.set(docId, version)
    // Fire-and-forget, into HistoryService's coalescing buffer (plan §9).
    window.margin.doc.changed({ docId, changes, version, content })

    setDocuments((current) => {
      // Returning the same array lets React bail out. Mapping unconditionally
      // would allocate a new one on every keystroke and re-render the window
      // for a flag that only changes once per document (plan §11).
      const document = current.find((entry) => entry.id === docId)
      if (!document || document.dirty) return current
      return current.map((entry) =>
        entry.id === docId ? { ...entry, dirty: true, version } : entry
      )
    })

    scheduleAutoSaveRef.current(docId)
  }, [])

  const onContentChanged = useCallback((docId: string, content: string) => {
    // A background tab's preview does not render at all (plan §11).
    if (docId !== activeIdRef.current) return
    pendingSourceRef.current = content
    if (debounceRef.current !== null) return
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null
      scheduleIdle(() => setPreviewSource(pendingSourceRef.current))
    }, PREVIEW_DEBOUNCE_MS)
  }, [])

  /** Fires on every keystroke and arrow key — coalesce to one update per frame. */
  const onSelectionChanged = useCallback((_docId: string, position: CursorPosition) => {
    pendingCursorRef.current = position
    if (cursorFrameRef.current !== null) return
    cursorFrameRef.current = requestAnimationFrame(() => {
      cursorFrameRef.current = null
      if (pendingCursorRef.current) setCursor(pendingCursorRef.current)
    })
  }, [])

  const editorCallbacks = useMemo(
    () => ({ onDocChanged, onContentChanged, onSelectionChanged }),
    [onDocChanged, onContentChanged, onSelectionChanged]
  )

  const editor = useEditorHost({ mode: theme, callbacks: editorCallbacks })

  // ── Document lifecycle ────────────────────────────────────────────────────

  /**
   * Make a document the visible one, syncing the preview to its buffer.
   *
   * `knownContent` is passed when the caller already has the text and the view
   * may not exist yet — opening into an empty window, where the panes mount a
   * render after the document arrives. Reading the view in that case would set
   * the preview to nothing.
   */
  const activate = useCallback(
    (docId: DocId, knownContent?: string) => {
      editor.activateDocument(docId)
      setActiveId(docId)
      activeIdRef.current = docId

      // Otherwise read back off the view: the buffer is authoritative, and a tab
      // switched to may have been edited since it was last previewed.
      const content = knownContent ?? editor.getContent() ?? ''
      pendingSourceRef.current = content
      setPreviewSource(content)
      editor.focus()
    },
    [editor]
  )

  /**
   * Add documents main has opened, or focus them if they are already here.
   *
   * §13's Phase 3 criterion is that opening an already-open file focuses its
   * existing tab rather than duplicating it. Main enforces that at the registry
   * level and reports it back; this is the renderer half.
   */
  const adopt = useCallback(
    (payloads: Array<DocumentPayload & { alreadyOpen?: boolean }>, seed?: string) => {
      if (payloads.length === 0) return

      setDocuments((current) => {
        const next = [...current]
        for (const payload of payloads) {
          const at = next.findIndex((document) => document.id === payload.meta.id)
          if (at === -1) next.push(payload.meta)
          else next[at] = payload.meta
        }
        return next
      })

      for (const payload of payloads) {
        editor.openDocument(payload.meta.id, seed ?? payload.content)
      }

      const last = payloads[payloads.length - 1]
      if (last) activate(last.meta.id, seed ?? last.content)

      const guessed = payloads.find((payload) => payload.encodingGuessed)
      setNotice(
        guessed
          ? {
              message: `Opened ${guessed.meta.name} as ${guessed.meta.encoding.toUpperCase()}.`,
              detail: 'The encoding was detected, not declared by the file.'
            }
          : null
      )
    },
    [activate, editor]
  )

  /**
   * The document that exists at startup. Main creates it empty; the welcome text
   * is a renderer-side seed — it is buffer content, not a file, and saving it
   * prompts for a path like any untitled document.
   *
   * A window main created to receive a document (a detach, or Open in New
   * Window) says so in its URL and seeds nothing: otherwise it opens with two
   * tabs, its own and the one it was made for. The flag is read from the URL
   * rather than asked for over IPC because this runs on the first render, before
   * a round trip could answer.
   */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('handover')) {
      // Its document is on the way over `doc:opened`.
      setBooted(true)
      return
    }

    /*
     * Guarded by a ref, not by a cancellation flag.
     *
     * StrictMode mounts, unmounts and remounts in development, so this effect
     * runs twice. A cancellation flag only discards the *result* of the first
     * call — main has already registered that document, so the window shows
     * "Untitled 2" and leaks an "Untitled" nobody can reach. The ref survives
     * the simulated remount because the fiber does, so the create happens once.
     */
    if (seededRef.current) return
    seededRef.current = true

    void window.margin.doc.create().then((payload) => {
      adopt([payload], WELCOME_DOCUMENT)
      setBooted(true)
    })
    // Deliberately once: this seeds the window, and re-running would add tabs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
      if (cursorFrameRef.current !== null) cancelAnimationFrame(cursorFrameRef.current)
      if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current)
    }
  }, [])

  // Main owns the authoritative dirty flag and the window title (plan §8).
  useEffect(() => {
    if (!activeDocument) return
    window.margin.doc.setDirty({
      docId: activeDocument.id,
      dirty: activeDocument.dirty,
      name: activeDocument.name
    })
  }, [activeDocument])

  // Main routes external-change events and close prompts by document, so it has
  // to know which window holds which tabs (§2).
  useEffect(() => {
    window.margin.doc.reportTabs(documents.map((document) => document.id))
  }, [documents])

  // ── Settings and theme (§4.4) ─────────────────────────────────────────────

  const saveOnExitRef = useRef(false)
  saveOnExitRef.current = saveOnExit

  const autoSaveConfigRef = useRef({ enabled: false, delayMs: 15_000 })
  autoSaveConfigRef.current = { enabled: autoSave, delayMs: autoSaveDelayMs }
  const autoSaveTimerRef = useRef<number | null>(null)

  /**
   * Auto-save, debounced on idle (§8).
   *
   * Driven from the change callback rather than from an effect so that every
   * keystroke restarts the clock without re-rendering the window. The dirty
   * indicator deliberately stays up between the edit and the flush: §8 says not
   * to hide save state just because auto-save exists.
   *
   * The write goes through the ordinary save path, so the watcher is told what
   * was written and does not report the app's own write back as an external
   * change — the loop §8 warns auto-save turns from an annoyance into a fight.
   */
  const scheduleAutoSave = useCallback((docId: DocId) => {
    const { enabled, delayMs } = autoSaveConfigRef.current
    if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current)
    if (!enabled) return

    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null
      const document = documentsRef.current.find((entry) => entry.id === docId)
      // Never auto-save an untitled document: §8 says those always prompt for a
      // path, and a dialog is not something to spring on an idle user.
      if (!document?.path || !document.dirty) return
      void saveDocumentByIdRef.current(docId)
    }, delayMs)
  }, [])

  const scheduleAutoSaveRef = useRef(scheduleAutoSave)
  scheduleAutoSaveRef.current = scheduleAutoSave

  const applyTheme = useCallback(
    (mode: ThemeMode) => {
      setThemeState(mode)
      // Surface 1 of 3: the chrome, through a data attribute at the root.
      document.documentElement.dataset.theme = mode
      // Surface 2: the editor, through a compartment reconfigure.
      editor.setTheme(mode)
      // Surface 3, the preview, rides on the same custom properties as chrome.
    },
    [editor]
  )

  const applySettings = useCallback(
    (settings: { theme: ThemeMode; autoSave: boolean; autoSaveDelayMs: number; saveOnExit: boolean }) => {
      applyTheme(settings.theme)
      setAutoSaveState(settings.autoSave)
      setAutoSaveDelayMs(settings.autoSaveDelayMs)
      setSaveOnExitState(settings.saveOnExit)
    },
    [applyTheme]
  )

  useEffect(() => {
    void window.margin.settings.get().then(applySettings)
  }, [applySettings])

  // Settings apply to every window at once, so the broadcast is what actually
  // sets them — including for the window that asked (§4.4).
  useEffect(() => {
    return window.margin.settings.onChanged(applySettings)
  }, [applySettings])

  const setTheme = useCallback((mode: ThemeMode) => {
    void window.margin.settings.set({ theme: mode })
  }, [])

  const setAutoSave = useCallback((on: boolean) => {
    void window.margin.settings.set({ autoSave: on })
  }, [])

  const setSaveOnExit = useCallback((on: boolean) => {
    void window.margin.settings.set({ saveOnExit: on })
  }, [])

  // ── File commands ─────────────────────────────────────────────────────────

  const saveDocumentById = useCallback(
    async (docId: DocId): Promise<boolean> => {
      // Only the active document's text is readable from the shared view, so a
      // background tab is activated first. Phase 2 never hit this; tabs do.
      if (docId !== activeIdRef.current) activate(docId)
      const content = editor.getContent()
      if (content === null) return false

      const result = await window.margin.doc.save(docId, content)
      if (result.ok) {
        const saved = result.value
        setDocuments((current) => current.map((d) => (d.id === saved.id ? saved : d)))
        setNotice(null)
        return true
      }
      // A cancelled Save As dialog is a decision, not a failure.
      if (result.error !== 'cancelled') {
        setNotice({ message: 'Could not save the file.', detail: result.error })
      }
      return false
    },
    [activate, editor]
  )

  const saveDocumentByIdRef = useRef(saveDocumentById)
  saveDocumentByIdRef.current = saveDocumentById

  const saveActive = useCallback(async (): Promise<boolean> => {
    const document = activeDocumentRef.current
    return document ? saveDocumentByIdRef.current(document.id) : false
  }, [])

  const saveAsActive = useCallback(async (): Promise<boolean> => {
    const document = activeDocumentRef.current
    const content = editor.getContent()
    if (!document || content === null) return false

    const result = await window.margin.doc.saveAs(document.id, content)
    if (result.ok) {
      const saved = result.value
      setDocuments((current) => current.map((d) => (d.id === saved.id ? saved : d)))
      setNotice(null)
      return true
    }
    if (result.error !== 'cancelled') {
      setNotice({ message: 'Could not save the file.', detail: result.error })
    }
    return false
  }, [editor])

  /**
   * Put the themed prompt on screen and wait for an answer (§8).
   *
   * The dialog is drawn in-app rather than by the OS, so this owns the promise
   * the old native call used to return. Main still holds the window open until
   * the renderer reports a verdict, so the guarantee is unchanged.
   */
  const askToClose = useCallback((name: string, manyDirty: boolean): Promise<CloseChoice> => {
    return new Promise<CloseChoice>((resolve) => {
      setConfirmRequest({
        name,
        manyDirty,
        resolve: (choice) => {
          setConfirmRequest(null)
          resolve(choice)
        }
      })
    })
  }, [])

  const askToCloseRef = useRef(askToClose)
  askToCloseRef.current = askToClose

  /**
   * Ask before losing unsaved work in one document (§8). Returns false when the
   * user cancels, which every caller treats as "abandon what you were doing".
   */
  const confirmDiscard = useCallback(async (document: DocMeta | null): Promise<boolean> => {
    if (!document?.dirty) return true

    const manyDirty = documentsRef.current.filter((d) => d.dirty).length > 1
    const choice = await askToCloseRef.current(document.name, manyDirty)
    if (choice === 'cancel') return false
    if (choice === 'save' || choice === 'saveAll') {
      return saveDocumentByIdRef.current(document.id)
    }
    return true
  }, [])

  /** Drop a tab: confirm, tell main, and release the EditorState (§11). */
  const closeTab = useCallback(
    async (docId?: DocId): Promise<void> => {
      const id = docId ?? activeIdRef.current
      if (!id) return
      const document = documentsRef.current.find((d) => d.id === id) ?? null
      if (!(await confirmDiscard(document))) return

      const remaining = documentsRef.current.filter((d) => d.id !== id)
      setDocuments(remaining)
      editor.closeDocument(id)
      void window.margin.doc.close(id)

      if (activeIdRef.current !== id) return

      if (remaining.length > 0) {
        // Focus the neighbour, which is what every editor does on close.
        const wasAt = documentsRef.current.findIndex((d) => d.id === id)
        const next = remaining[Math.min(wasAt, remaining.length - 1)]
        if (next) activate(next.id)
        return
      }

      // §4.1: closing the last tab leaves an empty-state window, not a closed
      // one. That empty state is the home screen — putting a fresh unnamed
      // buffer in front of someone who just finished with a document is a
      // reasonable reading of the rule but a poor one.
      setActiveId(null)
      activeIdRef.current = null
    },
    [activate, confirmDiscard, editor]
  )

  const newDocument = useCallback(async (): Promise<void> => {
    adopt([await window.margin.doc.create()])
  }, [adopt])

  const openPath = useCallback(
    async (path: string): Promise<void> => {
      const result = await window.margin.doc.open(path)
      if (!result.ok) {
        setNotice({ message: 'Could not open the file.', detail: result.error })
        return
      }
      adopt(result.value)
    },
    [adopt]
  )

  const openDocument = useCallback(async (): Promise<void> => {
    const result = await window.margin.doc.open()
    if (!result.ok) {
      setNotice({ message: 'Could not open the file.', detail: result.error })
      return
    }
    // An empty list is a cancelled dialog.
    adopt(result.value)
  }, [adopt])

  /**
   * Re-read the file under a different encoding (§6).
   *
   * This discards the buffer, so a dirty document is confirmed first — the plan
   * is explicit that reopening a dirty buffer prompts before throwing away
   * in-memory edits.
   */
  const reopenAs = useCallback(
    async (encoding: Encoding): Promise<void> => {
      const document = activeDocumentRef.current
      if (!document?.path) return
      if (!(await confirmDiscard(document))) return

      const result = await window.margin.doc.reopenAs(document.id, encoding)
      if (!result.ok) {
        setNotice({ message: 'Could not reopen the file.', detail: result.error })
        return
      }
      const { meta, content } = result.value
      editor.replaceDocument(meta.id, content)
      setDocuments((current) => current.map((d) => (d.id === meta.id ? meta : d)))
      pendingSourceRef.current = content
      setPreviewSource(content)
      setNotice(null)
    },
    [confirmDiscard, editor]
  )

  /**
   * Restore a version from history (§9, §13 Phase 5).
   *
   * Applied as an ordinary edit rather than by rewriting the journal, so the
   * change flows back through `doc:changed` and **appends** a new entry. The
   * version restored from stays in the journal, which is §13's criterion and
   * also the only thing that makes restore safe to try: nothing is lost, and
   * undo still works because it is a normal transaction.
   */
  const restoreVersion = useCallback(
    (content: string) => {
      const view = editor.getView()
      if (!view) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content }
      })
      pendingSourceRef.current = content
      setPreviewSource(content)
      editor.focus()
    },
    [editor]
  )

  // ── Compare (§13 Phase 6) ─────────────────────────────────────────────────

  const enterCompare = useCallback(
    (source: CompareSource) => {
      setCompareSource(source)
      editor.setCompare(source)
    },
    [editor]
  )

  const exitCompare = useCallback(() => {
    setCompareSource(null)
    editor.setCompare(null)
    editor.focus()
  }, [editor])

  const compareWithFile = useCallback(async (): Promise<void> => {
    const result = await window.margin.compare.chooseFile()
    if (!result.ok) {
      setNotice({ message: 'Could not read the file.', detail: result.error })
      return
    }
    // Null is a cancelled dialog.
    if (result.value) enterCompare({ content: result.value.content, label: result.value.name })
  }, [enterCompare])

  /**
   * Leaving compare when the document changes.
   *
   * The diff is against a specific buffer; carrying it across a tab switch or a
   * reload would show a comparison the user did not ask for, against a document
   * that is no longer on screen.
   */
  useEffect(() => {
    if (!compareSource) return
    setCompareSource(null)
    editor.setCompare(null)
    // Only when the active document changes, not on every compare state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const setFlavor = useCallback((next: Flavor) => {
    // Flavor is per-document (§3), so this edits the active document rather
    // than a window-wide setting.
    const id = activeIdRef.current
    if (!id) return
    setDocuments((current) => current.map((d) => (d.id === id ? { ...d, flavor: next } : d)))
  }, [])

  // ── Tab dragging (§4.1) ───────────────────────────────────────────────────

  const reorderTabs = useCallback((from: number, to: number) => {
    setDocuments((current) => reorder(current, from, to))
  }, [])

  /**
   * Pull a tab out into a window of its own.
   *
   * The buffer travels with it, unsaved edits included — main holds no document
   * text. The tab is dropped from this window without calling `doc.close`,
   * which would unregister the document and let the same file be opened a
   * second time, breaking §2's one-document-per-file invariant.
   */
  const detachTab = useCallback(
    async (docId: DocId): Promise<void> => {
      // Only the active document's text is readable from the shared view.
      if (docId !== activeIdRef.current) activate(docId)
      const content = editor.getContent()
      if (content === null) return

      const remaining = documentsRef.current.filter((d) => d.id !== docId)
      setDocuments(remaining)
      // A window never closes because its last tab left (§4.1); it falls back
      // to the home screen, exactly as a last close does.
      if (remaining.length === 0) {
        setActiveId(null)
        activeIdRef.current = null
      } else if (activeIdRef.current === docId) {
        activate(remaining[remaining.length - 1]!.id)
      }

      editor.closeDocument(docId)
      await window.margin.doc.detach(docId, content)
    },
    [activate, editor]
  )

  // ── Tab cycling ───────────────────────────────────────────────────────────

  const step = useCallback(
    (delta: number) => {
      const list = documentsRef.current
      if (list.length < 2) return
      const at = list.findIndex((d) => d.id === activeIdRef.current)
      const next = list[(at + delta + list.length) % list.length]
      if (next) activate(next.id)
    },
    [activate]
  )

  // ── External changes ──────────────────────────────────────────────────────

  const reloadDocument = useCallback(
    (docId: DocId) => {
      void window.margin.doc.reload(docId).then((result) => {
        if (!result.ok) return
        const { meta, content } = result.value
        editor.replaceDocument(meta.id, content)
        setDocuments((current) => current.map((d) => (d.id === meta.id ? meta : d)))
        if (activeIdRef.current === meta.id) {
          pendingSourceRef.current = content
          setPreviewSource(content)
        }
      })
    },
    [editor]
  )

  useEffect(() => {
    return window.margin.app.onExternalChange((payload) => {
      // Clean buffer: nothing to lose, so reload without asking.
      if (!payload.dirty) {
        reloadDocument(payload.docId)
        return
      }

      // Dirty buffer: reloading would discard the user's edits, so it is theirs
      // to choose. No colour and no modal — a line of ink and two links.
      setNotice({
        message: `${payload.name} changed on disk.`,
        detail: 'This document has unsaved changes.',
        actions: [
          {
            label: 'Reload',
            onClick: () => {
              reloadDocument(payload.docId)
              setNotice(null)
            }
          },
          { label: 'Keep Mine', onClick: () => setNotice(null) }
        ]
      })
    })
  }, [reloadDocument])

  // Documents main opened on our behalf: the Open Recent menu, and the file a
  // new window was created to show.
  useEffect(() => {
    return window.margin.commands.onOpened((payloads) => adopt(payloads))
  }, [adopt])

  // ── Quit handshake (§8) ───────────────────────────────────────────────────

  useEffect(() => {
    return window.margin.app.onBeforeQuit(() => {
      void (async () => {
        /*
         * Save on exit writes every dirty document without prompting (§8). It is
         * independent of auto-save and off by default. An untitled document
         * still cannot be written silently, so it falls through to the prompts
         * below rather than being saved or dropped.
         */
        if (saveOnExitRef.current) {
          const named = documentsRef.current.filter((d) => d.dirty && d.path)
          for (const document of named) {
            if (!(await saveDocumentByIdRef.current(document.id))) {
              window.margin.app.resolveQuit(false)
              return
            }
          }
        }

        // Every remaining dirty document gets its own prompt, per §13.
        for (const document of documentsRef.current.filter((d) => d.dirty)) {
          const manyDirty = documentsRef.current.filter((d) => d.dirty).length > 1
          const choice = await askToCloseRef.current(document.name, manyDirty)

          if (choice === 'cancel') {
            window.margin.app.resolveQuit(false)
            return
          }
          if (choice === 'discardAll') break
          if (choice === 'save' || choice === 'saveAll') {
            const saved = await saveDocumentByIdRef.current(document.id)
            // A failed or cancelled save must not silently discard the document.
            if (!saved) {
              window.margin.app.resolveQuit(false)
              return
            }
            if (choice === 'saveAll') {
              for (const rest of documentsRef.current.filter((d) => d.dirty)) {
                if (!(await saveDocumentByIdRef.current(rest.id))) {
                  window.margin.app.resolveQuit(false)
                  return
                }
              }
              break
            }
          }
        }
        window.margin.app.resolveQuit(true)
      })()
    })
  }, [])

  // ── Pane focus and layout ─────────────────────────────────────────────────

  const setPaneFocus = useCallback((next: PaneFocus) => {
    // Read the preview's scroll offset before it is hidden — a display:none
    // element reports scrollTop 0, so this cannot wait for the effect.
    if (next === 'editor' && previewScrollRef.current) {
      previewScrollMemo.current = previewScrollRef.current.scrollTop
    }
    setPaneFocusState(next)
  }, [])

  useLayoutEffect(() => {
    if (paneFocus !== 'editor' && previewScrollRef.current) {
      previewScrollRef.current.scrollTop = previewScrollMemo.current
    }
    // CodeMirror needs a measure after the pane returns from display:none.
    editor.measure()
  }, [paneFocus, editor])

  useEffect(() => {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, String(ratio))
  }, [ratio])

  const { setSource } = useScrollSync({
    getView: editor.getView,
    previewRef: previewScrollRef,
    enabled: paneFocus === 'split'
  })

  // ── Commands ──────────────────────────────────────────────────────────────

  const registry = useMemo(() => createCommandRegistry(), [])

  const context: AppContext = useMemo(
    () => ({
      paneFocus,
      setPaneFocus,
      resetSplit: () => setRatio(DEFAULT_RATIO),
      flavor,
      setFlavor,
      focusEditor: editor.focus,
      paletteOpen,
      openPalette: () => {
        setPaletteQuery('')
        setPaletteOpen(true)
      },
      closePalette: () => setPaletteOpen(false),

      newDocument: () => void newDocument(),
      newWindow: () => void window.margin.window.create(),
      openDocument: () => void openDocument(),
      openInNewWindow: () => void window.margin.window.openInNew(),
      saveDocument: () => void saveActive(),
      saveAsDocument: () => void saveAsActive(),
      closeTab: (docId) => void closeTab(docId),
      reopenAs: (encoding) => void reopenAs(encoding),
      hasFile: Boolean(activeDocument?.path),
      encoding: activeDocument?.encoding ?? 'utf8',

      runEditorCommand: (id) => {
        editor.runCommand(id)
      },

      theme,
      setTheme,
      historyOpen,
      setHistoryOpen,
      comparing: compareSource !== null,
      compareWithFile: () => void compareWithFile(),
      exitCompare,
      nextTab: () => step(1),
      previousTab: () => step(-1),
      manyTabs: documents.length > 1,

      autoSave,
      setAutoSave,
      saveOnExit,
      setSaveOnExit
    }),
    [
      paneFocus,
      setPaneFocus,
      flavor,
      setFlavor,
      editor,
      paletteOpen,
      newDocument,
      openDocument,
      saveActive,
      saveAsActive,
      closeTab,
      reopenAs,
      activeDocument,
      theme,
      setTheme,
      historyOpen,
      compareSource,
      compareWithFile,
      exitCompare,
      step,
      documents.length,
      autoSave,
      setAutoSave,
      saveOnExit,
      setSaveOnExit
    ]
  )

  const contextRef = useRef(context)
  contextRef.current = context

  // Keep the native menu greyed out in step with the palette (§7).
  useEffect(() => {
    const disabled = registry
      .all()
      .filter((command) => !registry.isEnabled(command.id, context))
      .map((command) => command.id)
    window.margin.commands.reportEnablement(disabled)
  }, [registry, context])

  // Menu clicks and menu-registered accelerators arrive here and run through
  // the same registry the palette and keyboard use.
  useEffect(() => {
    return window.margin.commands.onInvoke((commandId) => {
      if (!registry.get(commandId)) return
      registry.invoke(commandId, contextRef.current)
    })
  }, [registry])

  useEffect(() => {
    /**
     * Capture phase, so a binding resolves before CodeMirror sees the key.
     *
     * Commands the catalog marks `editorOwnedKey` are skipped: their chord
     * belongs to CodeMirror, main registers no accelerator for them, and
     * handling them here would be the second handler §7 forbids.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      for (const command of registry.all()) {
        if (command.editorOwnedKey) continue
        const accelerator = registry.resolveAccelerator(command.id, platform)
        if (!accelerator) continue
        if (!matchesAccelerator(event, accelerator, platform)) continue
        if (!registry.isEnabled(command.id, contextRef.current)) continue
        event.preventDefault()
        event.stopPropagation()
        registry.invoke(command.id, contextRef.current)
        return
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [registry, platform])

  const paletteAccelerator = formatAccelerator(
    registry.resolveAccelerator('app.commandPalette', platform) ?? 'CmdOrCtrl+K',
    platform
  )

  const focusAccelerator = (id: string): string | null => {
    const accelerator = registry.resolveAccelerator(id, platform)
    return accelerator ? formatAccelerator(accelerator, platform) : null
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const split = paneFocus === 'split'
  const wordCount = useMemo(() => countWords(previewSource), [previewSource])

  return (
    <div className="shell">
      <TitleBar title={activeDocument?.name ?? ''} />

      <TabStrip
        documents={documents}
        activeId={activeId}
        onSelect={(id) => activate(id)}
        onNew={() => void newDocument()}
        onClose={(id) => void closeTab(id)}
        onReorder={reorderTabs}
        onDetach={(id) => void detachTab(id)}
      />

      {compareSource ? (
        <Notice
          message={`Comparing with ${compareSource.label}.`}
          detail="Deletions and insertions are marked inline."
          actions={[{ label: 'Exit Compare', onClick: exitCompare }]}
        />
      ) : notice ? (
        <Notice
          message={notice.message}
          detail={notice.detail}
          actions={notice.actions}
          onDismiss={() => setNotice(null)}
        />
      ) : null}

      {documents.length === 0 && booted ? (
        <HomeScreen
          onNew={() => void newDocument()}
          onOpen={() => void openDocument()}
          onOpenPath={(path) => void openPath(path)}
          newAccelerator={focusAccelerator('file.new')}
          openAccelerator={focusAccelerator('file.open')}
        />
      ) : (
      <div className="panes" ref={panesRef}>
        <EditorPane
          attach={editor.attach}
          maximized={paneFocus === 'editor'}
          hidden={paneFocus === 'preview'}
          accelerator={focusAccelerator('view.toggleEditorFocus')}
          onToggle={() => setPaneFocus(paneFocus === 'editor' ? 'split' : 'editor')}
          onInteract={() => setSource('editor')}
          style={split ? { flex: `${ratio} 1 0` } : { flex: '1 1 0' }}
        />

        {split ? (
          <Divider
            containerRef={panesRef}
            minWidth={280}
            onRatioChange={setRatio}
            onReset={() => setRatio(DEFAULT_RATIO)}
            onSnapToFocus={setPaneFocus}
          />
        ) : null}

        <PreviewPane
          source={previewSource}
          flavor={flavor}
          maximized={paneFocus === 'preview'}
          hidden={paneFocus === 'editor'}
          accelerator={focusAccelerator('view.togglePreviewFocus')}
          onToggle={() => setPaneFocus(paneFocus === 'preview' ? 'split' : 'preview')}
          onInteract={() => setSource('preview')}
          scrollRef={previewScrollRef}
          style={split ? { flex: `${1 - ratio} 1 0` } : { flex: '1 1 0' }}
        />

        {historyOpen ? (
          <HistorySidebar
            docId={activeId}
            hasFile={Boolean(activeDocument?.path)}
            onRestore={restoreVersion}
            onCompare={(content, label) => enterCompare({ content, label })}
            onClose={() => setHistoryOpen(false)}
          />
        ) : null}
      </div>
      )}

      <StatusBar
        cursor={cursor}
        wordCount={wordCount}
        showWordCount={paneFocus === 'preview'}
        flavor={flavor}
        eol={activeDocument?.eol ?? 'LF'}
        mixedEol={activeDocument?.mixedEol ?? false}
        encoding={activeDocument?.encoding ?? 'utf8'}
        dirty={activeDocument?.dirty ?? false}
        path={activeDocument?.path ?? null}
        paletteOpen={paletteOpen}
        paletteAccelerator={paletteAccelerator}
        onOpenPalette={() => {
          setPaletteQuery('')
          setPaletteOpen(true)
        }}
        onCycleFlavor={() => registry.invoke('format.cycleFlavor', context)}
        onPickEncoding={() => {
          setPaletteQuery('Reopen as')
          setPaletteOpen(true)
        }}
        canPickEncoding={Boolean(activeDocument?.path)}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        hasDocument={activeDocument !== null}
      />

      {confirmRequest ? <ConfirmDialog request={confirmRequest} /> : null}

      {paletteOpen ? (
        <CommandPalette
          registry={registry}
          context={context}
          platform={platform}
          initialQuery={paletteQuery}
          onClose={() => {
            setPaletteOpen(false)
            editor.focus()
          }}
        />
      ) : null}
    </div>
  )
}

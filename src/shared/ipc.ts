import type { DocId, DocMeta, Encoding, Flavor, ThemeMode } from './types'

/**
 * The IPC surface (plan §2). This is a stable contract: channel names are
 * versioned by renaming, never by overloading existing semantics.
 *
 * Phase 2 adds the file layer. `doc:moveTab`, `flavor:set` and `command:invoke`
 * remain unimplemented — they belong to Phase 3's tabs, windows and native menu.
 *
 * Four channels here are not in §2's list. They are additions rather than
 * reinterpretations, which the contract allows:
 *   · `doc:new` — §2 folds new documents into `doc:open` with no path, but that
 *     path already means "show the open dialog". Separate channel, separate verb.
 *   · `doc:reload` — re-read a file that changed underneath a clean buffer.
 *   · `file:recent` — the recent files list, which §13 puts in Phase 2 scope.
 *   · `app:*` — the quit handshake §8 requires: native dialogs live in main, but
 *     only the renderer holds buffer content, so the confirm loop is driven from
 *     the renderer and main waits for its verdict.
 */
export const IPC = {
  /** Fire-and-forget change capture. Sinks to a no-op in Phase 2; HistoryService in Phase 5. */
  docChanged: 'doc:changed',
  /** Renderer reports; main decides and owns the authoritative dirty flag. */
  docSetDirty: 'doc:setDirty',

  docNew: 'doc:new',
  docOpen: 'doc:open',
  docSave: 'doc:save',
  docSaveAs: 'doc:saveAs',
  docClose: 'doc:close',
  docReload: 'doc:reload',
  /** "Reopen with encoding…" — the manual override §6 calls the actual feature. */
  docReopenAs: 'file:reopenAs',
  recentFiles: 'file:recent',
  /** Forget every recent file. Returns the emptied list, so the caller need not re-ask. */
  clearRecentFiles: 'file:clearRecent',

  /** main -> renderer: the file changed on disk under an open document. */
  externalChange: 'file:externalChange',
  /** main -> renderer: quit was requested; run the dirty-document confirm loop. */
  beforeQuit: 'app:beforeQuit',

  /** main -> renderer: a menu item or accelerator fired (§7). */
  commandInvoke: 'command:invoke',
  /**
   * main -> renderer: main opened these documents, adopt them.
   *
   * Needed because two paths open a file without the renderer asking: the Open
   * Recent menu, and Open in New Window, where the window that must show the
   * file does not exist until after the file is read.
   */
  docOpened: 'doc:opened',
  /** renderer -> main: which command ids are currently unavailable, for menu greying. */
  commandEnablement: 'command:enablement',

  /** A second window with its own tabs. */
  windowNew: 'window:new',
  /**
   * Move a document into a window of its own (§2's reserved channel, §4.1).
   *
   * The document stays registered — same docId, same canonical key — because
   * only which window shows it is changing. Going through doc:close would
   * unregister it and break the one-document-per-file invariant on the way.
   */
  docMoveTab: 'doc:moveTab',
  /** Which documents this window holds, so main can route by document. */
  windowTabs: 'window:tabs',

  /**
   * Read a file's text for comparison without opening it as a document.
   *
   * Compare must not create a tab: §2's rule is that a document is open in
   * exactly one tab application-wide, and registering the file being compared
   * against would make it one — then closing the comparison would have to
   * un-register it again.
   */
  compareRead: 'file:readForCompare',

  /** Timestamped versions of a document (§9). */
  historyVersions: 'history:versions',
  /** The document as of one version, for the sidebar preview. */
  historyContent: 'history:content',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  /** main -> renderer: settings changed, in this window or another one. */
  settingsChanged: 'settings:changed',
  /** The renderer's verdict on the quit handshake. */
  quitVerdict: 'app:quitVerdict',

  /** External links never open in-app (plan §10). */
  openExternal: 'shell:openExternal'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/**
 * A serialized CodeMirror ChangeSet (`ChangeSet.toJSON()`), rehydrated with
 * `ChangeSet.fromJSON()`. This is the journal patch format (plan §9) — exact,
 * ordered, and needing no third-party diff library.
 */
export type SerializedChangeSet = unknown

export interface DocChangedPayload {
  docId: DocId
  changes: SerializedChangeSet
  /** Strictly sequential. A gap invalidates every patch after it. */
  version: number
  /**
   * The buffer after the change.
   *
   * Main does not hold document text — the renderer does (§2) — but the journal
   * needs it to write a snapshot every 50 patches without a round trip back.
   */
  content: string
}

export interface DocDirtyPayload {
  docId: DocId
  dirty: boolean
  /** Display name, so main can set the window title without a document lookup. */
  name: string
}

/** A document and its text. Metadata alone is not enough to fill an editor. */
export interface DocumentPayload {
  meta: DocMeta
  content: string
  /**
   * Set when the encoding was guessed rather than known from a BOM, so the UI
   * can be honest that "Reopen with encoding…" may be needed (§6).
   */
  encodingGuessed: boolean
}

/**
 * File operations fail for ordinary reasons — a read-only file, a vanished
 * network share, a full disk. Those are results, not exceptions: an editor that
 * throws away a buffer because a write failed is worse than one that reports it.
 */
export type FileResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * What the user chose when asked about a document with unsaved changes (§8).
 *
 * The prompt itself is drawn in the renderer, not by the OS — a native message
 * box cannot be themed and ignores dark mode. Main never sees these values; it
 * only waits for the renderer's final verdict on `app:quitVerdict`.
 */
export type CloseChoice = 'save' | 'discard' | 'cancel' | 'saveAll' | 'discardAll'

export interface RecentFile {
  path: string
  name: string
  /** Epoch ms of the last open, so the list can be ordered without a re-stat. */
  openedAt: number
}

export type Platform = 'darwin' | 'win32' | 'linux'

/**
 * The entire renderer-visible API. Exposed on `window.margin` by the preload via
 * contextBridge. There is no `ipcRenderer` passthrough and no `require` leakage.
 */
export interface MarginBridge {
  readonly platform: Platform
  readonly productName: string
  readonly versions: Readonly<{
    app: string
    electron: string
    chrome: string
    node: string
  }>
  readonly doc: {
    /** Publishes every editor change. Sinks to a no-op in main today. */
    changed(payload: DocChangedPayload): void
    setDirty(payload: DocDirtyPayload): void

    create(): Promise<DocumentPayload>
    /** No path opens the file dialog; a path opens that file directly. */
    open(path?: string): Promise<FileResult<DocumentPayload[]>>
    save(docId: DocId, content: string): Promise<FileResult<DocMeta>>
    saveAs(docId: DocId, content: string): Promise<FileResult<DocMeta>>
    close(docId: DocId): Promise<void>
    /** Re-read from disk, discarding the buffer. */
    reload(docId: DocId): Promise<FileResult<DocumentPayload>>
    reopenAs(docId: DocId, encoding: Encoding): Promise<FileResult<DocumentPayload>>
    /** Tell main which documents this window holds, in tab order. */
    reportTabs(docIds: DocId[]): void
    /**
     * Detach a document into a new window. The buffer travels with it: main
     * does not hold document text, and the new window has to show what the old
     * one had, unsaved edits included.
     */
    detach(docId: DocId, content: string): Promise<void>
  }
  readonly window: {
    /** A new empty window. Opening into it is the renderer's next step. */
    create(): Promise<void>
    /** Open a file chooser and put the result in a new window. */
    openInNew(): Promise<FileResult<DocumentPayload[]>>
  }
  readonly settings: {
    get(): Promise<Settings>
    set(
      patch: Partial<
        Pick<Settings, 'theme' | 'defaultFlavor' | 'autoSave' | 'autoSaveDelayMs' | 'saveOnExit'>
      >
    ): Promise<Settings>
    onChanged(handler: (settings: Settings) => void): () => void
  }
  readonly commands: {
    /** Menu items and registered accelerators arrive here (§7). */
    onInvoke(handler: (commandId: string) => void): () => void
    /** Documents main opened on the renderer's behalf. */
    onOpened(handler: (payloads: DocumentPayload[]) => void): () => void
    /** Report unavailable command ids so the menu can grey them to match. */
    reportEnablement(disabledIds: string[]): void
  }
  readonly files: {
    recent(): Promise<RecentFile[]>
    /** Resolves to the emptied list, so the caller can render the result it was handed. */
    clearRecent(): Promise<RecentFile[]>
  }
  readonly compare: {
    /** Choose a file to compare against. Null when the dialog was cancelled. */
    chooseFile(): Promise<FileResult<ComparisonSource | null>>
  }
  readonly history: {
    /** Newest first. Empty for an untitled document, which has no journal. */
    versions(docId: DocId): Promise<HistoryVersion[]>
    /** The document as of a version, or null if it cannot be replayed. */
    contentAt(docId: DocId, version: number): Promise<string | null>
  }
  readonly app: {
    /** Answer main's quit request: true proceeds, false cancels. */
    resolveQuit(proceed: boolean): void
    onBeforeQuit(handler: () => void): () => void
    onExternalChange(handler: (payload: ExternalChangePayload) => void): () => void
  }
  readonly shell: {
    openExternal(url: string): Promise<boolean>
  }
}

export interface ComparisonSource {
  path: string
  name: string
  /**
   * Buffer text, normalized to LF exactly as an opened document would be.
   *
   * This is what makes §13's Phase 6 criterion hold: two files differing only in
   * line endings normalize to the same string, so the diff is empty.
   */
  content: string
}

export interface HistoryVersion {
  v: number
  /** Epoch ms. */
  t: number
  type: 'snapshot' | 'patch'
  iso: string
}

export interface Settings {
  theme: ThemeMode
  defaultFlavor: Flavor
  recent: RecentFile[]
  /** Independent of saveOnExit; neither implies the other (§8). */
  autoSave: boolean
  autoSaveDelayMs: number
  saveOnExit: boolean
}

export interface ExternalChangePayload {
  docId: DocId
  /**
   * True when main already knows the buffer is dirty. A clean document reloads
   * silently; a dirty one must ask, because reloading would discard edits (§13).
   */
  dirty: boolean
  name: string
}

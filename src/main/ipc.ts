import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { basename, join } from 'node:path'

import {
  IPC,
  type DocChangedPayload,
  type DocDirtyPayload,
  type DocumentPayload,
  type ComparisonSource,
  type FileResult,
  type RecentFile,
  type Settings
} from '@shared/ipc'
import { windowTitle } from '@shared/branding'
import { isEncoding, type Encoding } from '@core/text/encoding'
import type { DocId, DocMeta } from '@shared/types'

import { DocumentRegistry, resolveKey } from './DocumentRegistry'
import { FileWatcher, readTextFile, writeTextFile } from './FileService'
import { HistoryService, type HistoryVersion } from './HistoryService'
import { SettingsStore } from './SettingsStore'
import type { WindowState } from './windowState'
import { WindowManager } from './WindowManager'
import { buildMenu, refreshMenu } from './MenuBuilder'
import { openExternalSafely } from './security'

/**
 * Main-process IPC (plan §2, §6, §7, §8).
 *
 * Main owns documents; renderers own views. Every handler here is the only way
 * the renderer can reach the filesystem — there is no `fs` on the other side of
 * the bridge, by design rather than by convention.
 *
 * `doc:changed` remains the important one architecturally. Nothing consumes it
 * until Phase 5, but the channel, the payload shape and the renderer that
 * publishes on it all exist from day one (§2).
 */

const MARKDOWN_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
  { name: 'All Files', extensions: ['*'] }
]

let registry: DocumentRegistry
let watcher: FileWatcher
let settings: SettingsStore
let windows: WindowManager
let history: HistoryService

let changesSeen = 0

/** Command ids the focused renderer reports as unavailable, for menu greying. */
let disabledCommandIds: ReadonlySet<string> = new Set()

/**
 * Pending quit handshakes, keyed by window. Per-window because each window
 * confirms its own dirty documents: closing one must not prompt about another.
 */
const quitResolvers = new Map<number, (proceed: boolean) => void>()

interface IpcDeps {
  /**
   * Window creation lives in index.ts, which owns the BrowserWindow options.
   * `handover` suppresses the new window's own untitled document, for a window
   * created to receive one.
   */
  createWindow: (options?: { handover?: boolean }) => BrowserWindow
}

let deps: IpcDeps

// ── Payload guards ──────────────────────────────────────────────────────────

function isChangedPayload(value: unknown): value is DocChangedPayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Partial<DocChangedPayload>
  return typeof payload.docId === 'string' && typeof payload.version === 'number'
}

function isDirtyPayload(value: unknown): value is DocDirtyPayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Partial<DocDirtyPayload>
  return (
    typeof payload.docId === 'string' &&
    typeof payload.dirty === 'boolean' &&
    typeof payload.name === 'string'
  )
}

/**
 * The journal write (§9).
 *
 * This channel has fired on every edit since Phase 1 and sank to a no-op until
 * now. §2 called building it early "the single most important instruction in
 * this document" because retrofitting change capture is where the project would
 * stall — and in the event, turning history on was replacing this function body.
 */
function changeSink(payload: DocChangedPayload, content: string): void {
  changesSeen++
  if (process.env.MARGIN_TRACE_CHANGES) {
    console.log(`[doc:changed] ${payload.docId} v${payload.version} (${changesSeen} total)`)
  }
  history.record(payload.docId, payload.changes, content)
}

/** Test/diagnostic hook — how many change events have reached main this session. */
export function changeEventCount(): number {
  return changesSeen
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function failed(error: unknown): FileResult<never> {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error'
  return { ok: false, error: message }
}

function payloadFor(meta: DocMeta, content: string, encodingGuessed: boolean): DocumentPayload {
  return { meta, content, encodingGuessed }
}

/**
 * Open one path: reuse the document already at that canonical key, or read it.
 *
 * The reuse branch is §2's "a document is open in exactly one tab,
 * application-wide" — and §13's Phase 3 criterion that opening an already-open
 * file focuses its existing tab rather than duplicating it. `alreadyOpen` tells
 * the renderer which of the two happened so it can focus instead of adding.
 */
async function openPath(path: string): Promise<DocumentPayload & { alreadyOpen: boolean }> {
  const key = await resolveKey(path)

  const existing = registry.findByKey(key)
  if (existing) {
    const snapshot = await readTextFile(existing.meta.path ?? path)
    return {
      ...payloadFor(existing.meta, snapshot.text, snapshot.encodingSource === 'detected'),
      alreadyOpen: true
    }
  }

  const snapshot = await readTextFile(path)
  const meta = registry.adopt({
    path,
    key,
    text: snapshot.text,
    encoding: snapshot.encoding,
    eol: snapshot.eol,
    mixedEol: snapshot.mixedEol,
    hash: snapshot.hash,
    mtimeMs: snapshot.mtimeMs,
    flavor: settings.all().defaultFlavor
  })

  watcher.watchFile(path, snapshot.hash)
  settings.noteOpened(path, basename(path))
  refreshMenu()
  await history.open(meta.id, key, snapshot.text)

  return {
    ...payloadFor(meta, snapshot.text, snapshot.encodingSource === 'detected'),
    alreadyOpen: false
  }
}

/** Write a document's buffer to a known path and clear its dirty state. */
async function saveTo(id: DocId, path: string, content: string): Promise<DocMeta> {
  const record = registry.get(id)
  if (!record) throw new Error(`Unknown document ${id}`)

  const result = await writeTextFile(path, content, record.meta.encoding, record.meta.eol)

  // Tell the watcher what the app just wrote, before it can report that write
  // back as an external change (§8).
  watcher.noteOwnWrite(path, result.hash)
  registry.noteDisk(id, result.hash, result.mtimeMs)
  // §9 commits the journal on every save, so a version boundary lines up with
  // something the user recognises.
  history.flush(id)

  return registry.patch(id, { dirty: false }) ?? record.meta
}

/** Save As, shared by the explicit command and by saving an untitled document. */
async function saveAsHandler(docId: DocId, content: string): Promise<FileResult<DocMeta>> {
  const record = registry.get(docId)
  if (!record) return { ok: false, error: 'Unknown document' }

  try {
    const window = windows.windowFor(docId)
    const options = {
      title: 'Save As',
      defaultPath: record.meta.path ?? `${record.meta.name}.md`,
      filters: MARKDOWN_FILTERS
    }
    const result = await (window
      ? dialog.showSaveDialog(window, options)
      : dialog.showSaveDialog(options))

    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' }

    const path = result.filePath
    const key = await resolveKey(path)

    // Saving over a file open in another tab would give two documents one path,
    // which is exactly the invariant the registry exists to hold (§2).
    const collision = registry.findByKey(key)
    if (collision && collision.meta.id !== docId) {
      return { ok: false, error: `${basename(path)} is already open in another tab` }
    }

    if (record.meta.path && record.meta.path !== path) watcher.unwatch(record.meta.path)

    registry.bindPath(docId, path, key)
    // An untitled document had nowhere to journal; it gets one now, opening
    // with the current buffer as its first snapshot.
    await history.bind(docId, key, content)
    const meta = await saveTo(docId, path, content)

    watcher.watchFile(path, registry.get(docId)?.hash ?? '')
    settings.noteOpened(path, basename(path))
    refreshMenu()

    return { ok: true, value: meta }
  } catch (error) {
    return failed(error)
  }
}

async function chooseAndOpen(
  window: BrowserWindow | null,
  path: unknown
): Promise<FileResult<Array<DocumentPayload & { alreadyOpen: boolean }>>> {
  try {
    let paths: string[]

    if (typeof path === 'string' && path.length > 0) {
      paths = [path]
    } else {
      const options = {
        title: 'Open',
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: MARKDOWN_FILTERS
      }
      const result = await (window
        ? dialog.showOpenDialog(window, options)
        : dialog.showOpenDialog(options))

      if (result.canceled) return { ok: true, value: [] }
      paths = result.filePaths
    }

    const opened = []
    for (const each of paths) opened.push(await openPath(each))
    return { ok: true, value: opened }
  } catch (error) {
    return failed(error)
  }
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerIpcHandlers(next: IpcDeps): void {
  deps = next
  registry = new DocumentRegistry()
  settings = new SettingsStore()
  windows = new WindowManager()
  history = new HistoryService(join(app.getPath('userData'), 'history'))

  watcher = new FileWatcher((path) => {
    const record = registry.findByPath(path)
    if (!record) return
    windows.windowFor(record.meta.id)?.webContents.send(IPC.externalChange, {
      docId: record.meta.id,
      dirty: record.meta.dirty,
      name: record.meta.name
    })
  })

  buildMenu({
    focusedWindow: () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null,
    recentFiles: () => settings.recent(),
    openRecent: (path) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      if (!window) return
      void chooseAndOpen(window, path).then((result) => {
        if (!result.ok) return
        // A recent entry can name a file that has since been deleted or moved;
        // drop it rather than leaving a menu item that fails every time.
        if (result.value.length === 0) settings.forget(path)
        else window.webContents.send(IPC.docOpened, result.value)
      })
    },
    disabledIds: () => disabledCommandIds
  })

  ipcMain.on(IPC.docChanged, (_event, payload: unknown) => {
    if (!isChangedPayload(payload)) return
    // The renderer sends the resulting buffer alongside the patch so a snapshot
    // can be written without asking for content main does not hold.
    changeSink(payload, typeof payload.content === 'string' ? payload.content : '')
  })

  ipcMain.on(IPC.docSetDirty, (event, payload: unknown) => {
    if (!isDirtyPayload(payload)) return
    // Dirty state is authoritative in main (plan §8).
    registry.patch(payload.docId, { dirty: payload.dirty })
    const window = BrowserWindow.fromWebContents(event.sender)
    window?.setTitle(windowTitle(payload.name, payload.dirty))
  })

  ipcMain.on(IPC.windowTabs, (event, docIds: unknown) => {
    if (!Array.isArray(docIds)) return
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return

    // Replace the window's tab order wholesale: the renderer is authoritative
    // about what it is showing, and reconciling item by item invites drift.
    for (const existing of windows.tabsOf(window.id)) windows.removeTab(window.id, existing)
    for (const docId of docIds) {
      if (typeof docId === 'string') windows.addTab(window.id, docId)
    }
  })

  ipcMain.on(IPC.commandEnablement, (_event, ids: unknown) => {
    if (!Array.isArray(ids)) return
    disabledCommandIds = new Set(ids.filter((id): id is string => typeof id === 'string'))
    refreshMenu()
  })

  ipcMain.handle(IPC.docNew, (): DocumentPayload => {
    return payloadFor(registry.createUntitled(settings.all().defaultFlavor), '', false)
  })

  ipcMain.handle(IPC.docOpen, async (event, path: unknown, intoNewWindow: unknown) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    const result = await chooseAndOpen(sender, path)

    // Open in New Window: the file is read here, and the fresh window asks for
    // it once its renderer is up. Passing the payload through the window's own
    // open call keeps one code path for reading a file.
    if (result.ok && intoNewWindow === true && result.value.length > 0) {
      const window = deps.createWindow({ handover: true })
      const payloads = result.value
      // The renderer does not exist yet, so the documents are handed over once
      // it has loaded rather than returned to the window that asked.
      window.webContents.once('did-finish-load', () => {
        window.webContents.send(IPC.docOpened, payloads)
      })
      return { ok: true, value: [] }
    }

    return result
  })

  ipcMain.handle(IPC.windowNew, (): void => {
    deps.createWindow()
  })

  ipcMain.handle(IPC.docMoveTab, (event, docId: unknown, content: unknown): void => {
    if (typeof docId !== 'string' || typeof content !== 'string') return
    const record = registry.get(docId)
    if (!record) return

    // Detach from the source window's tab list, but leave the document
    // registered: it is the same document, in a different window.
    const source = BrowserWindow.fromWebContents(event.sender)
    if (source) windows.removeTab(source.id, docId)

    const target = deps.createWindow({ handover: true })
    const payload = payloadFor(record.meta, content, false)
    target.webContents.once('did-finish-load', () => {
      target.webContents.send(IPC.docOpened, [payload])
    })
  })

  ipcMain.handle(
    IPC.docSave,
    async (_event, docId: unknown, content: unknown): Promise<FileResult<DocMeta>> => {
      if (typeof docId !== 'string' || typeof content !== 'string') {
        return { ok: false, error: 'Malformed save request' }
      }
      const record = registry.get(docId)
      if (!record) return { ok: false, error: 'Unknown document' }

      // An untitled document has nowhere to go; §8 says it always prompts.
      if (!record.meta.path) return saveAsHandler(docId, content)

      try {
        return { ok: true, value: await saveTo(docId, record.meta.path, content) }
      } catch (error) {
        return failed(error)
      }
    }
  )

  ipcMain.handle(
    IPC.docSaveAs,
    async (_event, docId: unknown, content: unknown): Promise<FileResult<DocMeta>> => {
      if (typeof docId !== 'string' || typeof content !== 'string') {
        return { ok: false, error: 'Malformed save request' }
      }
      return saveAsHandler(docId, content)
    }
  )

  ipcMain.handle(IPC.docClose, (event, docId: unknown): void => {
    if (typeof docId !== 'string') return
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) windows.removeTab(window.id, docId)

    history.close(docId)
    const record = registry.remove(docId)
    if (record?.meta.path) watcher.unwatch(record.meta.path)
  })

  ipcMain.handle(
    IPC.docReload,
    async (_event, docId: unknown): Promise<FileResult<DocumentPayload>> => {
      if (typeof docId !== 'string') return { ok: false, error: 'Malformed reload request' }
      const record = registry.get(docId)
      if (!record?.meta.path) return { ok: false, error: 'Document has no file on disk' }

      try {
        const snapshot = await readTextFile(record.meta.path)
        registry.noteDisk(docId, snapshot.hash, snapshot.mtimeMs)
        watcher.noteOwnWrite(record.meta.path, snapshot.hash)

        const meta = registry.patch(docId, {
          encoding: snapshot.encoding,
          eol: snapshot.eol,
          mixedEol: snapshot.mixedEol,
          dirty: false
        })
        return {
          ok: true,
          value: payloadFor(
            meta ?? record.meta,
            snapshot.text,
            snapshot.encodingSource === 'detected'
          )
        }
      } catch (error) {
        return failed(error)
      }
    }
  )

  ipcMain.handle(
    IPC.docReopenAs,
    async (_event, docId: unknown, encoding: unknown): Promise<FileResult<DocumentPayload>> => {
      if (typeof docId !== 'string' || !isEncoding(encoding)) {
        return { ok: false, error: 'Malformed reopen request' }
      }
      const record = registry.get(docId)
      if (!record?.meta.path) return { ok: false, error: 'Document has no file on disk' }

      try {
        // The override wins outright — detection is the convenience, this is the
        // feature (§6). The renderer prompts first when the buffer is dirty.
        const snapshot = await readTextFile(record.meta.path, encoding as Encoding)
        registry.noteDisk(docId, snapshot.hash, snapshot.mtimeMs)

        const meta = registry.patch(docId, {
          encoding: snapshot.encoding,
          eol: snapshot.eol,
          mixedEol: snapshot.mixedEol,
          dirty: false
        })
        return { ok: true, value: payloadFor(meta ?? record.meta, snapshot.text, false) }
      } catch (error) {
        return failed(error)
      }
    }
  )

  ipcMain.handle(IPC.recentFiles, (): RecentFile[] => settings.recent())

  ipcMain.handle(IPC.clearRecentFiles, (): RecentFile[] => {
    settings.clearRecent()
    // The Open Recent submenu is built from this list, so it has to be rebuilt
    // here or the menu keeps offering files the home screen no longer shows.
    refreshMenu()
    return settings.recent()
  })

  ipcMain.handle(
    IPC.compareRead,
    async (event): Promise<FileResult<ComparisonSource | null>> => {
      try {
        const window = BrowserWindow.fromWebContents(event.sender)
        const options = {
          title: 'Compare With',
          properties: ['openFile'] as Array<'openFile'>,
          filters: MARKDOWN_FILTERS
        }
        const result = await (window
          ? dialog.showOpenDialog(window, options)
          : dialog.showOpenDialog(options))

        if (result.canceled || !result.filePaths[0]) return { ok: true, value: null }

        const path = result.filePaths[0]
        // Read through FileService, so the comparison text is decoded and
        // normalized exactly as an opened document would be. Nothing is
        // registered: compare does not create a tab.
        const snapshot = await readTextFile(path)
        return { ok: true, value: { path, name: basename(path), content: snapshot.text } }
      } catch (error) {
        return failed(error)
      }
    }
  )

  ipcMain.handle(IPC.historyVersions, async (_event, docId: unknown): Promise<HistoryVersion[]> => {
    if (typeof docId !== 'string') return []
    return history.versions(docId)
  })

  ipcMain.handle(
    IPC.historyContent,
    async (_event, docId: unknown, version: unknown): Promise<string | null> => {
      if (typeof docId !== 'string' || typeof version !== 'number') return null
      return history.contentAt(docId, version)
    }
  )

  ipcMain.handle(IPC.settingsGet, (): Settings => settings.all())

  ipcMain.handle(IPC.settingsSet, (_event, patch: unknown): Settings => {
    const next: Partial<Settings> = {}
    if (typeof patch === 'object' && patch !== null) {
      const candidate = patch as Partial<Settings>
      if (candidate.theme === 'light' || candidate.theme === 'dark') next.theme = candidate.theme
      if (
        candidate.defaultFlavor === 'commonmark' ||
        candidate.defaultFlavor === 'gfm' ||
        candidate.defaultFlavor === 'gfm-extras'
      ) {
        next.defaultFlavor = candidate.defaultFlavor
      }
      if (typeof candidate.autoSave === 'boolean') next.autoSave = candidate.autoSave
      if (typeof candidate.saveOnExit === 'boolean') next.saveOnExit = candidate.saveOnExit
      // SettingsStore clamps this to the 5-60s range §8 fixes.
      if (typeof candidate.autoSaveDelayMs === 'number') {
        next.autoSaveDelayMs = candidate.autoSaveDelayMs
      }
    }

    const merged = settings.update(next)

    // Native chrome first: the caption glyphs are drawn by the OS and cannot be
    // reached from the renderer's stylesheet.
    if (next.theme) applyThemeToWindowChrome(merged.theme)

    // The theme applies to every window at once — a per-window theme is not a
    // feature (§4.4) — so this broadcasts rather than answering only the caller.
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC.settingsChanged, merged)
    }
    return merged
  })

  ipcMain.on(IPC.quitVerdict, (event, proceed: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    const resolver = quitResolvers.get(window.id)
    quitResolvers.delete(window.id)
    resolver?.(proceed === true)
  })

  ipcMain.handle(IPC.openExternal, async (_event, url: unknown) => {
    if (typeof url !== 'string') return false
    return openExternalSafely(url)
  })
}

/** Called by index.ts as each window is created. */
export function trackWindow(window: BrowserWindow): void {
  windows.register(window)
}

/**
 * The persisted theme, for chrome main paints before the renderer exists — the
 * window background and the Windows caption glyphs.
 */
export function currentTheme(): 'light' | 'dark' {
  return settings ? settings.all().theme : 'light'
}

/**
 * The geometry the last window was left at, for index.ts to reopen at.
 *
 * Like the theme, this is chrome main paints before a renderer exists, so it is
 * read from the store here rather than travelling over IPC.
 */
export function savedWindowState(): WindowState | null {
  return settings ? settings.windowState() : null
}

/** Record a window's geometry — called from index.ts as windows move and close. */
export function rememberWindowState(state: WindowState): void {
  settings?.rememberWindow(state)
}

/**
 * Repaint the native window chrome for a theme.
 *
 * The Windows caption buttons are drawn by the OS over a transparent overlay, so
 * their glyph colour is not something CSS can reach. Left alone, dark ink stays
 * on the dark title bar and the minimize/maximize/close buttons vanish.
 */
function applyThemeToWindowChrome(theme: 'light' | 'dark'): void {
  const symbolColor = theme === 'dark' ? '#E3E3E3' : '#1F1F1F'
  const background = theme === 'dark' ? '#101215' : '#EFEEE9'

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.setBackgroundColor(background)
    // Windows-only; the traffic lights follow the system appearance on macOS.
    if (process.platform !== 'win32') continue
    try {
      window.setTitleBarOverlay({ color: '#00000000', symbolColor, height: 32 })
    } catch {
      // A window created without titleBarOverlay refuses this. Not fatal.
    }
  }
}

// ── Quit handshake (§8) ─────────────────────────────────────────────────────

/** True when any document in this window has unsaved changes. */
export function windowHasDirtyDocuments(window: BrowserWindow): boolean {
  if (!registry || !windows) return false
  const ids = windows.tabsOf(window.id)
  // A window whose tabs main has not been told about yet cannot be assumed
  // clean: fall back to the global answer rather than closing over edits.
  if (ids.length === 0) return registry.dirtyDocuments().length > 0
  return ids.some((id) => registry.meta(id)?.dirty === true)
}

/**
 * Ask one window to run its confirm loop and report back.
 *
 * The split exists because neither process can do this alone: native dialogs
 * belong to main, and only the renderer holds the buffer text that a "Save"
 * answer needs to write. Main asks, the renderer drives, main waits.
 */
export function requestWindowClose(window: BrowserWindow, timeoutMs = 60_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (proceed: boolean): void => {
      if (settled) return
      settled = true
      quitResolvers.delete(window.id)
      resolve(proceed)
    }

    quitResolvers.set(window.id, finish)
    // A renderer that has crashed or hung must not wedge the app open forever.
    const timer = setTimeout(() => finish(true), timeoutMs)
    timer.unref?.()

    window.webContents.send(IPC.beforeQuit)
  })
}

/** Release watchers and commit pending journal entries on shutdown. */
export function disposeFileLayer(): void {
  // Order matters: a buffered patch that never reaches disk is a gap, and §9
  // makes every entry after a gap unreplayable.
  history?.closeAll()
  watcher?.dispose()
}

import { join } from 'node:path'
import { app, BrowserWindow, screen, session } from 'electron'

import { APP_ID, PRODUCT_NAME, windowTitle } from '@shared/branding'
import { applyContentSecurityPolicy, hardenWindow } from './security'
import {
  currentTheme,
  disposeFileLayer,
  registerIpcHandlers,
  rememberWindowState,
  requestWindowClose,
  savedWindowState,
  trackWindow,
  windowHasDirtyDocuments
} from './ipc'
import { fitToWorkAreas, type WindowState } from './windowState'

// Bundled as CommonJS (see electron.vite.config.ts), so __dirname is defined.
const dirname = __dirname

const isDev = !app.isPackaged
const devServerUrl = process.env.ELECTRON_RENDERER_URL

/**
 * Chrome painted before the renderer draws — avoids a white flash.
 *
 * These duplicate tokens.css because they are needed before any stylesheet has
 * loaded. Keep them in step with `--shell-ground` and `--ink-soft` in both
 * themes; there is no way to read a custom property from main.
 */
const SHELL_GROUND = { light: '#EFEEE9', dark: '#101215' }
/** The Windows caption glyphs. Dark ink on a dark title bar is invisible. */
const CAPTION_SYMBOL = { light: '#1F1F1F', dark: '#E3E3E3' }

/**
 * The title bar row (design 4a). MUST equal --titlebar-height in tokens.css:
 * 38 on macOS, 32 on Windows.
 *
 * On Windows this is only the caption overlay's height. On macOS the option name
 * hides how load-bearing it is: Electron hands titleBarOverlay.height to the
 * traffic-light proxy, and the proxy honours it only when it is TALLER than the
 * natural title bar container (32pt on current macOS). At exactly 32 it fails
 * that test and sizes the container as buttonHeight + 2 * trafficLightPosition.y
 * instead - 40pt - while still placing the buttons against the 32 it was given.
 * The lights then land 8px lower than asked, which is the wordmark misalignment
 * this row is measured to avoid. 38 clears the cliff.
 */
const TITLEBAR_HEIGHT = process.platform === 'darwin' ? 38 : 32

/**
 * Windows whose unsaved-changes prompt has already been answered, so the second
 * `close()` passes straight through instead of prompting again.
 */
const closingConfirmed = new WeakSet<BrowserWindow>()

/** The size a window opens at when nothing has been remembered yet. */
const DEFAULT_SIZE = { width: 1280, height: 840 }
/** Below this the two panes stop being usable side by side. */
const MINIMUM_SIZE = { width: 900, height: 560 }

/**
 * How long a window has to sit still before its geometry is written.
 *
 * `resize` and `move` fire continuously through a drag, and `persist()` in
 * SettingsStore writes synchronously — so the write waits for the gesture to
 * end. Anything that ends the window (close, quit) flushes it immediately.
 */
const GEOMETRY_SETTLE_MS = 400

/**
 * Persist a window's geometry as it changes, so the next launch reopens there.
 *
 * `getNormalBounds()` rather than `getBounds()`: on a maximized window the
 * former reports the size unmaximizing gives back, which is the one worth
 * remembering. Full screen and minimized report neither, so both are skipped —
 * a window is never restored into full screen, only into the size it had before.
 */
function rememberGeometry(window: BrowserWindow): void {
  let settle: ReturnType<typeof setTimeout> | undefined

  const capture = (): void => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return
    const { x, y, width, height } = window.getNormalBounds()
    rememberWindowState({ x, y, width, height, maximized: window.isMaximized() })
  }

  const schedule = (): void => {
    clearTimeout(settle)
    settle = setTimeout(capture, GEOMETRY_SETTLE_MS)
  }

  window.on('resize', schedule)
  window.on('move', schedule)
  window.on('maximize', schedule)
  window.on('unmaximize', schedule)
  // Fires before the window goes away — and again after the unsaved-changes
  // prompt is answered, which is harmless: the geometry has not changed.
  window.on('close', () => {
    clearTimeout(settle)
    capture()
  })
  window.on('closed', () => clearTimeout(settle))
}

/**
 * Where to open a new window.
 *
 * The saved position is only taken when no other window is open. It belongs to
 * whichever window was last moved, so reusing it for a second window would stack
 * the new one exactly on top of the old — a detached tab landing invisibly over
 * the window it was dragged out of. Those take the remembered size and let the
 * OS place them.
 */
function placement(): { width: number; height: number; position: WindowState | null } {
  const saved = savedWindowState()
  if (!saved) return { ...DEFAULT_SIZE, position: null }

  // Primary first: `fitToWorkAreas` falls back to `areas[0]` for a window that
  // overlaps no attached display, and `getAllDisplays()` does not order them.
  const primary = screen.getPrimaryDisplay()
  const areas = [
    primary.workArea,
    ...screen
      .getAllDisplays()
      .filter((display) => display.id !== primary.id)
      .map((display) => display.workArea)
  ]

  const fitted = fitToWorkAreas(saved, areas, MINIMUM_SIZE)
  if (!fitted) return { ...DEFAULT_SIZE, position: null }

  const alone = BrowserWindow.getAllWindows().length === 0
  return { width: fitted.width, height: fitted.height, position: alone ? fitted : null }
}

/**
 * True while a quit is in flight — `app.quit()` was called and not yet cancelled.
 *
 * A window that prevents its own close cancels the whole quit, and Electron does
 * not resume it once the prompt is answered. Without this, answering "Do Not
 * Save" on Cmd+Q closes the windows but leaves the app running: on Windows the
 * `window-all-closed` handler below covers it up by quitting anyway, but on
 * macOS that handler deliberately does nothing and the app lingers in the dock
 * with no windows. The verdict handler re-issues the quit instead.
 */
let quitRequested = false

/**
 * `handover` marks a window that main created to receive a document — a detach,
 * or Open in New Window. Such a window must not seed itself an untitled
 * document on boot, or it opens with two tabs: its own, and the one it was
 * created for. The flag rides on the URL because it has to be readable by the
 * renderer's first render, before any IPC round trip could answer.
 */
function createWindow(options: { handover?: boolean } = {}): BrowserWindow {
  // The window is painted before the renderer can tell us anything, so the
  // persisted theme has to come from main.
  const theme = currentTheme()
  // Bounds have to be settled before construction: setting them afterwards
  // shows the window at the default size first and then jumps it.
  const place = placement()

  const window = new BrowserWindow({
    width: place.width,
    height: place.height,
    ...(place.position ? { x: place.position.x, y: place.position.y } : {}),
    minWidth: MINIMUM_SIZE.width,
    minHeight: MINIMUM_SIZE.height,
    show: false,
    backgroundColor: SHELL_GROUND[theme],
    title: windowTitle(null, false),

    // Dev only, and not on macOS, where the icon comes from the bundle and the
    // Dock shows Electron's own during `npm run dev` regardless. A packaged
    // Windows build takes its icon from the .exe resources electron-builder
    // writes from build/icon.ico, so setting it here would be redundant — and
    // build/ is not in the `files` list, so the path would not resolve anyway.
    ...(isDev && process.platform !== 'darwin'
      ? { icon: join(dirname, '../../build/icon.png') }
      : {}),

    // Margin draws its own title bar row, so the OS one is hidden and the native
    // controls are drawn over it: traffic lights on the left on macOS, the
    // overlay on the right on Windows. The renderer reserves space for both
    // (--titlebar-inset-*).
    //
    // 'hidden' on macOS, NOT 'hiddenInset'. hiddenInset hangs an empty NSToolbar
    // off the window, which is what insets the buttons - and it also makes macOS
    // place them itself, in a title bar area taller than our 38px row, ignoring
    // trafficLightPosition entirely. The lights then sit low and the wordmark,
    // centred in the row, reads as floating above them. With 'hidden' the
    // position below is honoured and the two line up. The inset look the design
    // asks for comes from that position, not from the style.
    titleBarStyle: 'hidden',
    // Clear of the cliff above, y is exactly the gap from the top of the window
    // to the top of a button, so centring the 14pt lights in the 38px row is
    // (38 - 14) / 2 = 12. x is the design's 14px gutter; the three buttons at
    // 23px pitch end at 74px, which is what --titlebar-inset-left reserves 86px
    // for. Both numbers are measured off a real window capture, not assumed.
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 12 } } : {}),
    titleBarOverlay: {
      // Transparent, per the design: the row behind the buttons is --canvas in
      // light and dark, so the overlay must not paint a ground of its own.
      color: '#00000000',
      symbolColor: CAPTION_SYMBOL[theme],
      height: TITLEBAR_HEIGHT
    },

    webPreferences: {
      // Preload is emitted as CommonJS (.cjs) because a sandboxed renderer
      // cannot load an ESM preload — see electron.vite.config.ts.
      preload: join(dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true
    }
  })

  // Maximize before the first paint, for the same reason the bounds are set in
  // the constructor: a window that shows small and then fills the screen reads
  // as a bug. Only a window taking the saved position takes the saved state —
  // the second window of a pair was never the one that was maximized.
  if (place.position?.maximized) window.maximize()

  // Show only once the first frame is ready, so the window never appears empty.
  window.once('ready-to-show', () => window.show())

  // Register before the renderer loads: the window has to be routable the
  // moment its renderer starts reporting tabs.
  trackWindow(window)
  rememberGeometry(window)

  /**
   * The unsaved-changes prompt hangs off window close, not `before-quit` (§8).
   *
   * By the time `before-quit` fires for a window the user closed with its own
   * button, the renderer is already going away — and the renderer is the only
   * process holding the buffer text a "Save" answer has to write. Intercepting
   * close covers both routes: closing the window, and Cmd+Q, which cancels the
   * quit if a window refuses to close.
   */
  window.on('close', (event) => {
    if (closingConfirmed.has(window) || !windowHasDirtyDocuments(window)) return

    event.preventDefault()
    void requestWindowClose(window).then((proceed) => {
      if (!proceed) {
        // Cancel answers the quit as well as the close: nothing is in flight
        // any more, so a later ordinary close must not re-trigger one.
        quitRequested = false
        return
      }
      closingConfirmed.add(window)
      window.close()
      // The preventDefault above cancelled the quit this close belonged to.
      // Re-issue it so the remaining windows are asked and the app actually
      // exits; windows already confirmed pass straight through.
      if (quitRequested) app.quit()
    })
  })

  window.on('closed', () => closingConfirmed.delete(window))

  const search = options.handover ? 'handover=1' : ''

  if (isDev && devServerUrl) {
    hardenWindow(window, new URL(devServerUrl).origin)
    const url = new URL(devServerUrl)
    if (search) url.search = search
    void window.loadURL(url.href)
  } else {
    hardenWindow(window, 'file://')
    void window.loadFile(join(dirname, '../renderer/index.html'), search ? { search } : {})
  }

  return window
}

app.setName(PRODUCT_NAME)

// Stable userData path for settings and, from Phase 5, history journals.
// Changing the appId after journals exist orphans them (plan §15).
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

// One instance owns the documents; a second launch focuses the first (plan §2).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  void app.whenReady().then(() => {
    applyContentSecurityPolicy(session.defaultSession, isDev)
    // The file layer needs a way to open a second window (File > New Window,
    // Open in New Window), and window options live here.
    registerIpcHandlers({ createWindow })
    createWindow()

    // macOS: clicking the dock icon with no windows open creates one.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Set before any window's close handler runs, so a close that prompts knows
  // it is part of a quit and can resume one.
  app.on('before-quit', () => {
    quitRequested = true
  })

  // macOS keeps the app alive with no windows; Windows quits (plan §7).
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Release the file watchers rather than leaving them to process teardown.
  app.on('will-quit', () => disposeFileLayer())
}

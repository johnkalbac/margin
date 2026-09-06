/**
 * Regenerate `docs/demo.gif` — the teaser at the top of the README.
 *
 *   npm run demo
 *
 * This drives the REAL app, the way scripts/drive.mjs does, and photographs it:
 * window creation, the native menu, DocumentRegistry, FileService and
 * HistoryService are all live, and the only fiction is the two native file
 * dialogs, stubbed inside main because they cannot be driven from outside the
 * process. What ends up in the README is therefore a recording of the app, not
 * a mock of it.
 *
 * **A frame is web content plus the native caption glyphs.** Margin hides the
 * OS title bar and lets the platform draw the window controls over a
 * transparent overlay (§4.4), and those controls are not web content: a
 * renderer screenshot omits them and leaves a title floating in an empty bar,
 * which is exactly what was wrong with the recording this replaces. Only
 * `desktopCapturer` sees them — and it costs a few hundred milliseconds a
 * frame, because it composites every window on the desktop, not just this one.
 *
 * That latency is not merely slow, it is *visible in the result*: at half a
 * second between keystrokes, HistoryService's 2s coalescing window (§9) expires
 * mid-sentence and the history sidebar fills with a dozen versions where a
 * person typing the same two lines would produce two. The camera would be
 * changing the behaviour it is there to photograph.
 *
 * So the caption glyphs are captured once per theme and composited onto frames
 * that come from `capturePage`, which is fast enough to keep the app's sense of
 * time honest. The rectangle to copy is measured, not assumed — the two
 * captures are diffed along the top edge — because its width is the platform's
 * business and differs between Windows and macOS.
 *
 * The capture is stepped, not real-time: drive, photograph, drive, photograph,
 * and give each frame its own duration when the GIF is assembled. Margin
 * animates nothing structural — app.css transitions only hover colours — so a
 * stepped capture and a recording produce the same frames. It also makes the
 * result deterministic: the same script always yields the same beats, and the
 * typing is paced by the file rather than by the operator.
 *
 * This must run on the platform whose chrome you want in the picture.
 */
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { quantize, encode } from './gif.mjs'

const APP_DIR = process.env.MARGIN_DIR || process.cwd()
const OUT = process.env.DEMO_OUT || path.join(APP_DIR, 'docs', 'demo.gif')

const ELECTRON_BIN = {
  darwin: 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  win32: 'node_modules/electron/dist/electron.exe',
  linux: 'node_modules/electron/dist/electron'
}[process.platform] ?? 'node_modules/electron/dist/electron'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/**
 * The window is captured at exactly this size.
 *
 * 900 is the app's own minimum width (MINIMUM_SIZE in src/main/index.ts) — ask
 * for less and the window silently stays wider than the frame, and the capture
 * ends up scaled. The height is 60px past the minimum so that the three-pane
 * history view still shows a whole preview rather than a clipped one. The
 * README constrains nothing, so this is the size GitHub shows.
 */
const WIDTH = 900
const HEIGHT = 620

/** Mirrors TITLEBAR_HEIGHT in src/main/index.ts — how tall the overlay is. */
const TITLEBAR = process.platform === 'darwin' ? 38 : 32

/** The document the demo types into, and the older copy it is compared against. */
const NOTES = [
  '# Release notes',
  '',
  'Margin keeps the **editor** and the **preview** in step, scrolling by',
  'source line rather than percentage.',
  '',
  '- Tabs, multiple windows, detachable',
  '- Find and replace',
  '- Light and dark',
  ''
].join('\n')

const OLD_NOTES = [
  '# Release notes',
  '',
  'Margin keeps the editor and the preview roughly in',
  'step.',
  '',
  '- Tabs',
  '- Find',
  ''
].join('\n')

/** Typed a character at a time, on camera. */
const TYPED = '- Edit history and inline compare\n> Every change is journalled.'

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-demo-'))
// A userData of its own, for the reasons scripts/drive.mjs gives: the single
// instance lock is keyed on it, and an empty one makes the history sidebar show
// this run's versions rather than whatever the developer's own copy has logged.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-demo-data-'))
const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-demo-frames-'))
const notesFile = path.join(workDir, 'release-notes.md')
const oldFile = path.join(workDir, 'release-notes.old.md')
fs.writeFileSync(notesFile, NOTES)
fs.writeFileSync(oldFile, OLD_NOTES)

const env = { ...process.env }
// The trap CLAUDE.md documents: with this set Electron behaves as plain Node.
delete env.ELECTRON_RUN_AS_NODE

let app
let page
/** One entry per captured frame: the raw file on disk, and how long it shows. */
const shots = []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function menuClick(id) {
  const result = await app.evaluate(({ Menu }, wanted) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(wanted)
    if (!item) return 'NOT_FOUND'
    item.click()
    return 'OK'
  }, id)
  if (result !== 'OK') throw new Error(`menu item ${id} is missing`)
}

async function until(fn, label, timeout = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      if (await page.evaluate(fn)) return
    } catch {
      /* page mid-navigation */
    }
    await sleep(120)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Bitmaps are written from inside main rather than returned: a frame is two
 * megabytes of BGRA, and handing that back over the automation bridge as JSON
 * costs more than the capture does. `process.mainModule.require` is how a
 * CommonJS main reaches `fs` from an evaluated function, which has no `require`
 * of its own in scope.
 */

/** The window as the compositor sees it — native chrome included, and slow. */
async function captureNative(file) {
  const got = await app.evaluate(
    async ({ BrowserWindow, desktopCapturer }, args) => {
      const nodeFs = process.mainModule.require('node:fs')
      const window = BrowserWindow.getAllWindows()[0]
      const title = window.getTitle()
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: args.width, height: args.height }
      })
      const source =
        sources.find((s) => s.name === title) ?? sources.find((s) => s.name.endsWith('Margin'))
      if (!source) return null
      nodeFs.writeFileSync(args.file, source.thumbnail.toBitmap())
      return source.thumbnail.getSize()
    },
    { file, width: WIDTH, height: HEIGHT }
  )
  if (!got) throw new Error('the Margin window was not among the capturable windows')
  return got
}

/** The web contents alone — fast, and missing the native caption glyphs. */
async function captureContent(file) {
  return app.evaluate(async ({ BrowserWindow }, target) => {
    const nodeFs = process.mainModule.require('node:fs')
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
    nodeFs.writeFileSync(target, image.toBitmap())
    return image.getSize()
  }, file)
}

/**
 * The strip of the title bar the OS draws and the renderer does not, and the
 * pixels currently in it.
 *
 * Found by diffing the two captures along the top edge rather than by hardcoding
 * a rectangle: the caption buttons are 138px wide on Windows 11 today and that
 * is not a number this script gets to depend on.
 */
let caption = null

async function measureCaption() {
  const nativeFile = path.join(frameDir, 'caption-native.bin')
  const contentFile = path.join(frameDir, 'caption-content.bin')
  const got = await captureNative(nativeFile)
  const content = await captureContent(contentFile)
  if (got.width !== content.width || got.height !== content.height) {
    throw new Error(
      `the two captures disagree on size: ${JSON.stringify(got)} vs ${JSON.stringify(content)}`
    )
  }
  // Everything below indexes rows by WIDTH. On a display that scales, ask the
  // operator to run this somewhere it does not rather than quietly stretching.
  if (got.width !== WIDTH || got.height !== HEIGHT) {
    throw new Error(`captured ${got.width}×${got.height}, expected ${WIDTH}×${HEIGHT}`)
  }

  const a = fs.readFileSync(nativeFile)
  const b = fs.readFileSync(contentFile)
  let left = WIDTH
  let right = -1
  let strays = 0
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const o = (y * WIDTH + x) * 4
      if (a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2]) continue
      if (y >= TITLEBAR) {
        strays++
        continue
      }
      if (x < left) left = x
      if (x >= right) right = x + 1
    }
  }
  if (right < 0) throw new Error('found no native chrome to composite — is the overlay drawn?')
  // Below the title bar the two captures must agree pixel for pixel, or frames
  // taken the two ways would not cut together. They do agree: both are the same
  // compositor rendering the same contents.
  if (strays > 0) {
    throw new Error(`the two captures differ in ${strays} pixels below the title bar`)
  }
  caption = { left, width: right - left, height: TITLEBAR, pixels: null }
  await refreshCaption()
  return caption
}

/** Re-photograph the caption glyphs. Their colour follows the theme (§4.4). */
async function refreshCaption() {
  const file = path.join(frameDir, 'caption-native.bin')
  await captureNative(file)
  const frame = fs.readFileSync(file)
  const strip = Buffer.alloc(caption.width * caption.height * 4)
  for (let y = 0; y < caption.height; y++) {
    frame.copy(
      strip,
      y * caption.width * 4,
      (y * WIDTH + caption.left) * 4,
      (y * WIDTH + caption.left + caption.width) * 4
    )
  }
  caption.pixels = strip
}

function nextFrameFile() {
  return path.join(frameDir, `f${String(shots.length).padStart(4, '0')}.bin`)
}

/** Photograph the window exactly as it is, and give the frame `cs` on screen. */
async function shot(cs) {
  const file = nextFrameFile()
  await captureNative(file)
  shots.push({ file, delayCs: cs })
}

/**
 * The same picture, assembled instead of photographed: web contents plus the
 * caption glyphs cached by `refreshCaption`.
 *
 * Only safe while nothing is drawn over the title bar — the command palette's
 * scrim dims the row behind the buttons, and a cached strip would sit in it as
 * a bright rectangle. So this is for the typing burst and nothing else, which
 * is the one stretch where the app's own sense of elapsed time is at stake.
 */
async function shotFast(cs) {
  const file = nextFrameFile()
  const got = await captureContent(file)
  if (got.width !== WIDTH || got.height !== HEIGHT) {
    throw new Error(`frame size changed mid-run: ${got.width}×${got.height}`)
  }

  const frame = fs.readFileSync(file)
  for (let y = 0; y < caption.height; y++) {
    caption.pixels.copy(
      frame,
      (y * WIDTH + caption.left) * 4,
      y * caption.width * 4,
      (y + 1) * caption.width * 4
    )
  }
  fs.writeFileSync(file, frame)
  shots.push({ file, delayCs: cs })
}

/** Let the app settle for `ms`, then take one frame lasting `cs`. */
async function beat(ms, cs) {
  await sleep(ms)
  await shot(cs)
}

/** Where the caret is, as the status bar reports it. */
async function column() {
  const label = await page.evaluate(() => {
    const item = [...document.querySelectorAll('.footer__item')].find((n) =>
      n.textContent?.startsWith('Ln ')
    )
    return item?.textContent ?? ''
  })
  return Number(label.split('Col')[1]?.trim() ?? 1)
}

/**
 * Type into whatever is focused, one frame per character.
 *
 * Enter inside a list runs CodeMirror's markdown continuation and opens the next
 * item for you. The demo types a blockquote on the line after a list, so the
 * marker it helpfully inserts is taken straight back off — before the frame is
 * shot, so what the picture shows is the line that was actually wanted.
 */
async function typeOnCamera(text, cs, capture = shot) {
  for (const ch of text) {
    if (ch === '\n') {
      await page.keyboard.press('Enter')
      for (let col = await column(); col > 1; col--) await page.keyboard.press('Backspace')
    } else {
      await page.keyboard.type(ch)
    }
    await capture(cs)
  }
}

/** Read the captured frames back, once per pass, so nothing holds them all. */
function* readFrames() {
  for (const { file } of shots) yield fs.readFileSync(file)
}

try {
  console.log('  launching the app…')
  app = await electron.launch({
    executablePath: path.join(APP_DIR, ELECTRON_BIN),
    args: [APP_DIR, `--user-data-dir=${userDataDir}`],
    env,
    timeout: 60_000
  })
  page = await app.firstWindow({ timeout: 30_000 })
  await page.waitForLoadState('domcontentloaded')
  await until(() => !!document.querySelector('.home'), 'the home screen', 25_000)

  // Fix the frame. alwaysOnTop is not about occlusion — the capture is composited,
  // not scraped off the screen — but about keeping the window active, because an
  // inactive window draws a dimmed caption and no caret.
  await app.evaluate(
    ({ BrowserWindow }, box) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.unmaximize()
      window.setBounds({ x: 60, y: 60, width: box.width, height: box.height })
      window.setAlwaysOnTop(true)
      window.focus()
    },
    { width: WIDTH, height: HEIGHT }
  )

  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files.open] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: files.open })
  }, { open: notesFile })

  // ── Off camera: get to the state the first frame shows ────────────────────
  //
  // An untitled buffer and the release notes beside it, so the tab strip has
  // something to say from the very first frame.
  await menuClick('file.new')
  await menuClick('file.open')
  await until(() => document.querySelectorAll('.tab').length === 2, 'two tabs')
  await until(
    () => (document.querySelector('.cm-content')?.textContent ?? '').includes('Light and dark'),
    'the release notes in the editor'
  )

  // Opening a file whose encoding was sniffed rather than declared says so
  // (§6). True, and worth saying in the app; noise in a teaser, and it would
  // push the panes down for the first third of the run.
  await page.evaluate(() => document.querySelector('.notice__action--quiet')?.click())
  await until(() => !document.querySelector('.notice'), 'the encoding notice to clear')

  // The caret blinks, and a stepped capture would catch it at random — flicker
  // in the picture, and a changed region in every single frame for the encoder
  // to carry. Pin it on. This is the one thing the camera changes.
  await page.addStyleTag({
    content: '.cm-cursorLayer { animation: none !important; }'
  })

  await page.evaluate(() => document.querySelector('.cm-content')?.focus())
  // Typing starts at the end of the file. The chord differs by platform, and
  // this is one of the ones CodeMirror owns (§7), so it reaches the editor.
  await page.keyboard.press(process.platform === 'darwin' ? `${MOD}+ArrowDown` : 'Control+End')

  console.log('  measuring the native chrome…')
  const rect = await measureCaption()
  console.log(`  caption glyphs occupy ${rect.width}×${rect.height} at x=${rect.left}`)

  // ── On camera ─────────────────────────────────────────────────────────────
  console.log('  capturing: live preview')
  await beat(400, 110)
  await typeOnCamera(TYPED, 7, shotFast)
  await beat(500, 70)

  await menuClick('file.save')
  // §4.1: a dirty document shows a dot where its close affordance goes.
  await until(() => !document.querySelector('.tab--active .tab__dot'), 'the saved tab')
  await beat(300, 45)

  // HistoryService coalesces edits on a 2s idle before it writes the patch
  // (§9). Wait it out here, so the sidebar below has a version to show.
  await sleep(2600)

  console.log('  capturing: the command palette')
  await menuClick('app.commandPalette')
  await until(() => !!document.querySelector('.palette__input'), 'the palette')
  await beat(250, 50)
  await typeOnCamera('dark', 13)
  await beat(150, 95)

  await page.keyboard.press('Enter')
  await until(
    () => document.documentElement.dataset.theme === 'dark',
    'the dark theme',
    8000
  )
  // The caption glyphs are repainted for the new theme by main, and they are
  // not web content, so the composited strip has to be re-photographed.
  await sleep(400)
  await refreshCaption()
  await beat(100, 135)

  console.log('  capturing: edit history')
  await menuClick('view.toggleHistory')
  await until(() => document.querySelectorAll('.history__item').length > 0, 'history versions')
  await beat(400, 115)

  // The oldest version — the snapshot taken when the file was opened — because
  // it is the one that differs from what is on screen.
  await page.evaluate(() => {
    const items = document.querySelectorAll('.history__item')
    items[items.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await until(() => !!document.querySelector('.history__previewBody')?.textContent, 'a version preview')
  await beat(400, 165)

  await menuClick('view.toggleHistory')
  await beat(300, 35)

  console.log('  capturing: inline compare')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, oldFile)
  await menuClick('view.compareWithFile')
  await until(() => !!document.querySelector('.cm-deletedChunk'), 'the inline diff')
  await beat(500, 205)

  await menuClick('view.exitCompare')
  await until(() => !document.querySelector('.cm-deletedChunk'), 'compare to end')
  await beat(400, 85)

  // Back to light, so the loop rejoins something close to where it started.
  await menuClick('view.toggleTheme')
  await until(() => document.documentElement.dataset.theme !== 'dark', 'the light theme')
  await sleep(400)
  await refreshCaption()
  await beat(100, 120)

  console.log(`\n  ${shots.length} frames at ${WIDTH}×${HEIGHT}`)
} finally {
  if (app) {
    // Nothing is dirty by this point, so no unsaved-changes prompt stands in the
    // way of the quit (§8).
    await app.close().catch(() => app.process().kill())
  }
}

console.log('  building the palette…')
const { palette, lookup, colors } = quantize(readFrames())
console.log(`  ${colors} colours`)

console.log('  encoding…')
const gif = encode({
  width: WIDTH,
  height: HEIGHT,
  palette,
  lookup,
  frames: (function* () {
    for (const { file, delayCs } of shots) yield { data: fs.readFileSync(file), delayCs }
  })()
})

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, gif)
fs.rmSync(frameDir, { recursive: true, force: true })
fs.rmSync(workDir, { recursive: true, force: true })
fs.rmSync(userDataDir, { recursive: true, force: true })

const seconds = shots.reduce((total, s) => total + s.delayCs, 0) / 100
console.log(`\n  wrote ${OUT} — ${(gif.length / 1024).toFixed(0)}KB, ${seconds.toFixed(1)}s`)

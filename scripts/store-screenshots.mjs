/**
 * Regenerate the Mac App Store screenshots.
 *
 *   npm run build && npm run screenshots
 *
 * Drives the REAL app the way scripts/demo.mjs does — native menu, file layer
 * and history service all live, only the two file dialogs stubbed — through
 * five scenes, and photographs the window in each. scripts/store-frames.cjs
 * then sets every capture on a 2880×1800 ground with its headline. Output:
 *
 *   release/app-store/raw/       the bare window captures
 *   release/app-store/framed/    what goes to App Store Connect
 *
 * **Native capture, not capturePage.** The window controls are drawn by macOS
 * over a transparent overlay (§4.4), so a renderer screenshot shows a title bar
 * with no traffic lights in it. demo.mjs composites the glyphs onto fast
 * capturePage frames because a GIF needs speed; a still does not, so every shot
 * here comes straight from desktopCapturer. That needs Screen Recording
 * permission for whatever launched this; without it the script falls back to
 * capturePage and says so.
 *
 * **Retina only.** App Store Connect takes 2560×1600 or 2880×1800 at the top
 * end, and the window is sized in points; on a 1x display every capture would
 * come out at half the resolution the frame wants. The script refuses rather
 * than upscaling.
 *
 * Must run on macOS: the chrome in the picture is the platform's own.
 */
import { _electron as electron } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

if (process.platform !== 'darwin') {
  console.error('store-screenshots: the Mac App Store wants macOS chrome; run this on a Mac')
  process.exit(1)
}

const APP_DIR = process.env.MARGIN_DIR || process.cwd()
const OUT_DIR = path.join(APP_DIR, 'release', 'app-store')
const RAW_DIR = path.join(OUT_DIR, 'raw')
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

/**
 * The app window, in points. It sits inside a 1440×900-point frame under the
 * headline (scripts/store-frames.cjs lays it out), so it is 16:10-ish but a
 * little squatter, leaving the headline its band at the top.
 */
const WIDTH = 1200
const HEIGHT = 700

// ── Sample documents ──────────────────────────────────────────────────────────
//
// What a person would actually have open. Each one is there to show something
// specific: the itinerary renders tables, task lists and a blockquote; the API
// notes render code blocks in focus mode; the chapter grows through three
// saves so the history sidebar has versions to list and compare has a diff.
//
// Paragraphs are one line each, as most people write them: the editor soft-
// wraps, and a hard wrap at 75 columns would wrap a second time at this width.

const LISBON = `# Four days in Lisbon

A slow week by the river: mornings in the old town, afternoons wherever the tram goes, and **pastéis de nata** at every opportunity.

## Itinerary

| Day | Neighbourhood | Don't miss |
| --- | --- | --- |
| Thu | Alfama | Miradouro de Santa Luzia at sunset |
| Fri | Belém | The monastery cloisters, early |
| Sat | Sintra | Pena Palace, then the Moorish castle |
| Sun | Chiado | Livraria Bertrand, the oldest bookshop |

## Before we go

- [x] Book the Sintra train
- [x] Reserve dinner at the tasca on Rua dos Remédios
- [ ] Download offline maps
- [ ] Pack the good walking shoes

> The city is built on seven hills, and you will climb every one of them.

### Getting around

Tram 28 runs the full loop. Buy a *Viva Viagem* card at any metro station and top it up as you go.
`

const API_NOTES = `# Sync service — API notes

Every request carries a session token. Tokens expire after an hour of inactivity; the client refreshes them on a 401.

## Fetching a document

\`\`\`ts
const res = await fetch(\`\${baseUrl}/v2/documents/\${id}\`, {
  headers: { Authorization: \`Bearer \${token}\` }
})
if (res.status === 401) return refreshAndRetry(id)
const doc: Document = await res.json()
\`\`\`

## Saving a revision

\`\`\`ts
await fetch(\`\${baseUrl}/v2/documents/\${id}/revisions\`, {
  method: 'POST',
  headers: { Authorization: \`Bearer \${token}\` },
  body: JSON.stringify({ base: doc.revision, changes })
})
\`\`\`

The server rejects a revision whose \`base\` is stale with a 409. Fetch, rebase the local changes, and post again.

## Endpoints

- \`GET /v2/documents/:id\` — the current revision
- \`GET /v2/documents/:id/revisions\` — the revision log
- \`POST /v2/documents/:id/revisions\` — append a revision
`

const CHAPTER_DRAFT = `# Chapter 3 — The Lighthouse

The keeper had not spoken to anyone in eleven days. He kept the lamp, he kept the log, and he kept to himself.

On the twelfth morning a boat came round the point.

It was small and red and it sat low in the water. He watched it from the gallery.
`

/** Typed into the chapter between saves, one batch per version. */
const CHAPTER_EDITS = [
  `
The woman at the oars did not look up until the hull touched the shingle. Then she shipped the oars, stood, and raised one hand — not a wave, exactly, more the gesture of someone confirming that a door was where she had left it.
`,
  `
"You'll be Tomas," she said, when he had come all the way down the hundred and twelve steps. "They said you might not answer the radio."

"I answer it," he said. "I just don't say much."
`
]

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-shots-'))
// A userData of its own, as in demo.mjs: an empty history and its own instance lock.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-shots-data-'))
const files = {
  lisbon: path.join(workDir, 'Lisbon.md'),
  api: path.join(workDir, 'API notes.md'),
  chapter: path.join(workDir, 'Chapter 3.md'),
  draft: path.join(workDir, 'Chapter 3 (draft).md')
}
fs.writeFileSync(files.lisbon, LISBON)
fs.writeFileSync(files.api, API_NOTES)
fs.writeFileSync(files.chapter, CHAPTER_DRAFT)
fs.writeFileSync(files.draft, CHAPTER_DRAFT)

fs.rmSync(OUT_DIR, { recursive: true, force: true })
fs.mkdirSync(RAW_DIR, { recursive: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

let app
let page
let nativeCapture = true
/** One entry per scene, handed to store-frames.cjs. */
const manifest = []

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

async function until(fn, label, arg, timeout = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      if (await page.evaluate(fn, arg)) return
    } catch {
      /* page mid-navigation */
    }
    await sleep(120)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Point the stubbed Open dialog at `file`, then open it. */
async function open(file) {
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })
  }, file)
  await menuClick('file.open')
  await until(
    (name) => document.querySelector('.tab--active')?.textContent?.includes(name),
    `${path.basename(file)} to open`,
    path.basename(file, '.md')
  )
  await dismissToasts()
}

/** The sniffed-encoding toast (§6) is true and worth saying — just not in a screenshot. */
async function dismissToasts() {
  await sleep(150)
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.click()))
  await until(() => !document.querySelector('.toast'), 'toasts to clear')
}

async function selectTab(name) {
  await page.locator('.tab', { hasText: name }).first().click()
  await until((n) => document.querySelector('.tab--active')?.textContent?.includes(n), `the ${name} tab`, name)
}

async function setTheme(theme) {
  const now = await page.evaluate(() => document.documentElement.dataset.theme || 'light')
  if (now !== theme) {
    await menuClick('view.toggleTheme')
    await until((t) => (document.documentElement.dataset.theme || 'light') === t, `the ${theme} theme`, theme)
  }
  // The native window buttons repaint for the theme a beat after the DOM does.
  await sleep(400)
}

async function focusEditorAt(where) {
  await page.evaluate(() => document.querySelector('.cm-content')?.focus())
  await page.keyboard.press(where === 'end' ? 'Meta+ArrowDown' : 'Meta+ArrowUp')
}

/** Photograph the window and record the scene for the framer. */
async function capture(name, theme, headline, subline) {
  await sleep(500)
  const file = path.join(RAW_DIR, `${name}.png`)
  let size = null
  if (nativeCapture) {
    // Returns why it found nothing, not just that it did: "no sources at all"
    // means Screen Recording is not granted; sources without Margin among them
    // means the match is wrong.
    const got = await app.evaluate(
      async ({ BrowserWindow, desktopCapturer, screen }, args) => {
        const nodeFs = process.mainModule.require('node:fs')
        const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor
        // Chromium lists only windows at the normal level, and alwaysOnTop
        // lifts this one to the floating level — out of the list. Drop it for
        // the length of the capture; the window stays key meanwhile.
        window.setAlwaysOnTop(false)
        window.focus()
        await new Promise((r) => setTimeout(r, 250))
        const sources = await desktopCapturer
          .getSources({
            types: ['window'],
            thumbnailSize: { width: args.width * scale, height: args.height * scale }
          })
          .finally(() => window.setAlwaysOnTop(true))
        const id = window.getMediaSourceId()
        const source = sources.find((s) => s.id === id) ?? sources.find((s) => s.name === window.getTitle())
        if (!source || source.thumbnail.isEmpty()) {
          return {
            reason: source ? 'the Margin source has an empty thumbnail' : 'no source matched the window',
            wanted: `${id} "${window.getTitle()}"`,
            seen: sources.map((s) => `${s.id} "${s.name}"`)
          }
        }
        nodeFs.writeFileSync(args.file, source.thumbnail.toPNG())
        return { size: { ...source.thumbnail.getSize(), scale } }
      },
      { file, width: WIDTH, height: HEIGHT }
    ).catch((error) => ({ reason: `getSources threw: ${error.message}`, seen: [] }))
    size = got.size ?? null
    if (!size) {
      nativeCapture = false
      console.warn(`  ! native capture failed: ${got.reason}`)
      if (got.wanted) console.warn(`    wanted ${got.wanted}`)
      console.warn(`    ${got.seen.length} window source(s) visible${got.seen.length ? ':' : ''}`)
      for (const line of got.seen.slice(0, 8)) console.warn(`      ${line}`)
      if (got.seen.length === 0) {
        console.warn(
          '    No windows at all means Screen Recording is not granted to the app running\n' +
            '    this script — and a new grant only applies after that app is quit and reopened.'
        )
      }
      console.warn('    Falling back to capturePage: no window buttons in these shots.')
    }
  }
  if (!size) {
    size = await app.evaluate(async ({ BrowserWindow, screen }, target) => {
      const nodeFs = process.mainModule.require('node:fs')
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const image = await window.webContents.capturePage()
      const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor
      nodeFs.writeFileSync(target, image.toPNG({ scaleFactor: scale }))
      return { ...image.getSize(scale), scale }
    }, file)
  }
  if (size.scale < 2) {
    throw new Error(`the window is on a ${size.scale}x display; move it to a Retina one`)
  }
  console.log(`  ${name}: ${size.width}×${size.height}`)
  manifest.push({ file, theme, headline, subline })
}

try {
  console.log('  launching the app…')
  app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [APP_DIR, `--user-data-dir=${userDataDir}`],
    env,
    timeout: 60_000
  })
  page = await app.firstWindow({ timeout: 30_000 })
  await page.waitForLoadState('domcontentloaded')
  await until(() => !!document.querySelector('.home'), 'the home screen', undefined, 25_000)

  // alwaysOnTop keeps the window active: an inactive one draws grey traffic
  // lights and no caret.
  await app.evaluate(
    ({ BrowserWindow }, box) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.unmaximize()
      window.setBounds({ x: 80, y: 80, width: box.width, height: box.height })
      window.setAlwaysOnTop(true)
      window.focus()
    },
    { width: WIDTH, height: HEIGHT }
  )

  // A blinking caret would be caught at random; pin it on.
  await page.addStyleTag({ content: '.cm-cursorLayer { animation: none !important; }' })

  // ── Off camera: the chapter's history ──────────────────────────────────────
  //
  // Opened first so its versions are the oldest, then grown through two saves.
  // HistoryService coalesces on a 2s idle (§9); each wait outlasts it, so each
  // batch is a version of its own.
  console.log('  building edit history…')
  await setTheme('light')
  await open(files.chapter)
  for (const text of CHAPTER_EDITS) {
    await focusEditorAt('end')
    await page.keyboard.type(text, { delay: 4 })
    await sleep(2600)
    await menuClick('file.save')
    await until(() => !document.querySelector('.tab--active .tab__dot'), 'the save')
    await sleep(400)
  }

  await open(files.api)
  await open(files.lisbon)

  // ── 1. The split view ────────────────────────────────────────────────────────
  await focusEditorAt('start')
  await capture(
    '01-split-view',
    'light',
    'Write on the left. Read on the right.',
    'A live preview that keeps pace with you, line for line.'
  )

  // ── 2. The command palette, in dark ──────────────────────────────────────────
  await setTheme('dark')
  await menuClick('app.commandPalette')
  // Wait for focus, not just the element: a keystroke before the palette
  // takes focus lands in the document.
  await until(() => document.activeElement?.classList.contains('palette__input'), 'the palette')
  await page.keyboard.type('view', { delay: 30 })
  await capture(
    '02-command-palette',
    'dark',
    'Every command, one ⌘K away.',
    'A command palette over everything in the menus — in light or dark.'
  )
  await page.keyboard.press('Escape')
  await until(() => !document.querySelector('.palette__input'), 'the palette to close')

  // ── 3. Edit history ──────────────────────────────────────────────────────────
  await setTheme('light')
  await selectTab('Chapter 3')
  await focusEditorAt('start')
  await menuClick('view.toggleHistory')
  await until(() => document.querySelectorAll('.history__item').length >= 2, 'history versions')
  // The middle version when there is one: it differs from the buffer, and the
  // newest above it shows the list is a timeline.
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.history__item')]
    const pick = items[Math.min(1, items.length - 1)]
    pick?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await until(() => !!document.querySelector('.history__previewBody')?.textContent, 'a version preview')
  await capture(
    '03-edit-history',
    'light',
    'Every version, kept.',
    'Browse a file’s history and bring back any version. Nothing is overwritten.'
  )
  await menuClick('view.toggleHistory')

  // ── 4. Inline compare, in dark ───────────────────────────────────────────────
  await setTheme('dark')
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, files.draft)
  await menuClick('view.compareWithFile')
  await until(() => !!document.querySelector('.cm-insertedLine, .cm-changedLine, .cm-deletedChunk'), 'the inline diff')
  await focusEditorAt('start')
  await capture(
    '04-compare',
    'dark',
    'See exactly what changed.',
    'Compare against another file on disk, or any earlier version.'
  )
  await menuClick('view.exitCompare')

  // ── 5. Focus mode ────────────────────────────────────────────────────────────
  //
  // The preview alone, full width: rendered code, headings and lists, and a
  // picture unlike the four split views before it.
  await setTheme('light')
  await selectTab('API notes')
  await focusEditorAt('start')
  await menuClick('view.togglePreviewFocus')
  await until(
    () => (document.querySelector('.cm-editor')?.getBoundingClientRect().width ?? 0) < 10,
    'the preview to take the window'
  )
  await capture(
    '05-focus',
    'light',
    'Room to think.',
    'Give either pane the whole window: ⌘⌥1 to write, ⌘⌥2 to read.'
  )
  await menuClick('view.togglePreviewFocus')
} finally {
  if (app) await app.close().catch(() => app.process().kill())
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.rmSync(userDataDir, { recursive: true, force: true })
}

fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))

console.log('  framing…')
const framed = spawnSync(ELECTRON_BIN, [path.join(APP_DIR, 'scripts', 'store-frames.cjs'), OUT_DIR], {
  env,
  stdio: 'inherit'
})
if (framed.status !== 0) process.exit(framed.status ?? 1)

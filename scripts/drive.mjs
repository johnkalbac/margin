/**
 * End-to-end drive of the real Margin app (plan §12: "End to end | Playwright
 * (Electron) | Smoke paths only").
 *
 * Unlike scripts/smoke.cjs, this launches the ACTUAL main process — window
 * creation, the native menu, DocumentRegistry, FileService, HistoryService —
 * rather than standing up a bare window around the built renderer.
 *
 * Native dialogs cannot be driven from outside the app, so the ones this touches
 * are stubbed inside main via app.evaluate before they are triggered. That is
 * the only fiction here; everything behind them is the real code path.
 */
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = process.env.MARGIN_DIR || process.cwd()

/**
 * The Electron binary, per platform.
 *
 * §12: "CI runs the full suite on both macOS and Windows runners. Platform
 * parity asserted on only one platform is not asserted." A driver that only
 * runs on Windows would quietly make this suite one of those.
 */
const ELECTRON_BIN = {
  darwin: 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  win32: 'node_modules/electron/dist/electron.exe',
  linux: 'node_modules/electron/dist/electron'
}[process.platform] ?? 'node_modules/electron/dist/electron'

/**
 * The primary modifier, as the app resolves CmdOrCtrl.
 *
 * Only the chords CodeMirror owns are pressed here — the rest go through the
 * menu. Those are exactly the ones §7 says Electron must not register, so
 * pressing them is also a check that the key still reaches the editor.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const SHOTS = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'margin-shots')
fs.mkdirSync(SHOTS, { recursive: true })

/** Is this computed colour a light ink, i.e. the dark theme painting text? */
function isLight(rgb) {
  if (!rgb) return false
  const [r, g, b] = (rgb.match(/\d+/g) ?? []).map(Number)
  if (r === undefined) return false
  return (r + g + b) / 3 > 140
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// A scratch file the app will open and save, so the file layer runs for real.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-e2e-'))
const scratchFile = path.join(workDir, 'notes.md')
const compareFile = path.join(workDir, 'other.md')
// CRLF on purpose: the EOL round trip is a Phase 2 claim worth exercising live.
fs.writeFileSync(scratchFile, '# Notes\r\n\r\nfirst line\r\n')
fs.writeFileSync(compareFile, '# Notes\n\nfirst line CHANGED\n')

const env = { ...process.env }
// The trap CLAUDE.md documents: with this set, Electron behaves as plain Node
// and the app dies on `app.whenReady` of undefined.
delete env.ELECTRON_RUN_AS_NODE

let app, page

/**
 * Fire a menu item by catalog id, in main.
 *
 * This is the honest path: it exercises the native menu, command:invoke, and
 * the renderer's registry, which is the whole of §7's "one command set, many
 * views". Calling window.margin.* from the page would bypass all of it.
 */
async function menuClick(id) {
  return app.evaluate(({ Menu }, wanted) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(wanted)
    if (!item) return 'NOT_FOUND'
    item.click()
    return 'OK'
  }, id)
}

async function shot(name) {
  const file = path.join(SHOTS, `${name}.png`)
  await page.screenshot({ path: file })
  return file
}

/** Wait until a page predicate holds, rather than sleeping blindly. */
async function until(fn, label, timeout = 10_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      if (await page.evaluate(fn)) return true
    } catch {
      /* page mid-navigation */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  console.log(`    (timed out waiting for ${label})`)
  return false
}

/**
 * Quit the app, answering the unsaved-changes prompt that quitting raises (§8).
 *
 * The driver reaches here on purpose with a dirty document, because a quit with
 * unsaved work is the path the handshake exists for and nothing else covers it
 * end to end. It also has to be answered: Playwright's close() calls app.quit()
 * and then waits for the process to exit with no timeout of its own, so an
 * unanswered prompt hangs the driver — for the 60s handshake timeout on Windows,
 * and indefinitely on macOS, where window-all-closed deliberately does not quit.
 *
 * Answer it, assert the app exits, and kill only as a last resort, so a
 * regression here fails the run rather than wedging it.
 */
async function shutdown() {
  let exited = false
  void app
    .close()
    .catch(() => {})
    .then(() => {
      exited = true
    })

  const deadline = Date.now() + 20_000
  while (!exited && Date.now() < deadline) {
    // The prompt belongs to whichever window holds the dirty document, and the
    // others may be tearing down while we look.
    for (const win of app.windows()) {
      try {
        await win.evaluate(() => {
          const buttons = [...document.querySelectorAll('.dialog__button')]
          buttons.find((b) => b.textContent?.includes('Do Not Save'))?.click()
        })
      } catch {
        /* window going away */
      }
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  check('quitting with unsaved work is answered in-app and the app exits (§8)', exited)
  // Nothing left to drive: leave no Electron process behind for the next run.
  if (!exited) app.process().kill()
}

try {
  app = await electron.launch({
    executablePath: path.join(APP_DIR, ELECTRON_BIN),
    args: [APP_DIR],
    env,
    timeout: 60_000
  })

  page = await app.firstWindow({ timeout: 30_000 })
  await page.waitForLoadState('domcontentloaded')
  const mainWindowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)

  const ready = await until(() => !!document.querySelector('.cm-editor'), '.cm-editor', 20_000)
  check('app launches and the editor mounts', ready)

  // ── Shell ────────────────────────────────────────────────────────────────
  console.log(`\n  landing: ${await shot('01-landing')}`)

  const shell = await page.evaluate(() => ({
    tabs: document.querySelectorAll('.tab').length,
    tabName: document.querySelector('.tab__name')?.textContent ?? null,
    panes: document.querySelectorAll('.pane').length,
    footer: !!document.querySelector('.footer'),
    previewBlocks: document.querySelectorAll('.markdown > *').length,
    save: document.querySelector('.footer__save')?.textContent ?? null,
    theme: document.documentElement.dataset.theme ?? null
  }))
  // Named "Untitled", not "Untitled 2": a second create at boot would leak a
  // document in main's registry and misname the visible one.
  check('boots with exactly one tab, named Untitled',
    shell.tabs === 1 && shell.tabName === 'Untitled', `name=${shell.tabName}`)
  check('both panes and the footer render', shell.panes === 2 && shell.footer)
  check('preview rendered the welcome document', shell.previewBlocks > 5, `${shell.previewBlocks} blocks`)
  check('theme applied from settings', shell.theme === 'light' || shell.theme === 'dark', shell.theme)

  // The appearance toggle sits between the cursor position and the flavor.
  const footerOrder = await page.evaluate(() =>
    [...document.querySelectorAll('.footer__state .footer__item')].map((n) => n.textContent)
  )
  const themeAt = footerOrder.findIndex((t) => t === 'Light' || t === 'Dark')
  check('appearance toggle sits between cursor position and flavor',
    themeAt === 1 && /^Ln /.test(footerOrder[0] ?? ''),
    footerOrder.join(' · '))

  // ── Native menu (Phase 3) ────────────────────────────────────────────────
  const menu = await app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu()
    if (!m) return null
    const walk = (items) =>
      items.map((i) => ({
        id: i.id ?? null,
        label: i.label,
        accel: i.accelerator ?? null,
        role: i.role ?? null,
        sub: i.submenu ? walk(i.submenu.items) : null
      }))
    return walk(m.items)
  })
  check('native menu is built', Array.isArray(menu), menu ? `${menu.length} top-level` : 'null')

  if (menu) {
    const flat = []
    const walk = (items) => items.forEach((i) => { flat.push(i); if (i.sub) walk(i.sub) })
    walk(menu)
    const ids = flat.filter((i) => i.id).map((i) => i.id)
    check('File/Edit/View/Format sections present',
      ['File', 'Edit', 'View', 'Format'].every((s) => menu.some((m) => m.label === s)),
      menu.map((m) => m.label).join(', '))
    check('menu carries the catalog commands', ids.includes('file.save') && ids.includes('view.toggleTheme'),
      `${ids.length} command items`)
    const undo = flat.find((i) => i.id === 'edit.undo')
    check('editor-owned chord is shown in the menu', !!undo?.accel, undo?.accel ?? 'none')
    const paste = flat.find((i) => i.id === 'edit.paste')
    check('clipboard items use native roles', paste?.role === 'paste', paste?.role ?? 'none')
    check('Open Recent submenu exists', flat.some((i) => i.label === 'Open Recent'))
  }

  // ── Open a real file (Phase 2) ───────────────────────────────────────────
  //
  // Native dialogs cannot be driven from outside the process, so both are
  // stubbed in main. Everything behind them is the real code path.
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files.open] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: files.save })
  }, { open: scratchFile, save: scratchFile })

  check('File > Open is reachable from the menu', (await menuClick('file.open')) === 'OK')
  const opened = await until(
    () => document.querySelectorAll('.tab').length === 2,
    'second tab',
    15_000
  )
  const openedState = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tab__name')].map((n) => n.textContent),
    eol: [...document.querySelectorAll('.footer__item')].map((n) => n.textContent),
    editor: document.querySelector('.cm-content')?.textContent ?? ''
  }))
  check('opening a file adds a tab', opened, openedState.tabs.join(' | '))
  check('CRLF file reports CRLF in the footer',
    openedState.eol.some((t) => t?.includes('CRLF')), openedState.eol.join(' · '))
  check('editor holds the file content', openedState.editor.includes('first line'))
  console.log(`  opened: ${await shot('02-opened-file')}`)

  // Opening the SAME file again must focus the tab, not duplicate it (§2).
  await menuClick('file.open')
  await new Promise((r) => setTimeout(r, 1200))
  const afterSecondOpen = await page.evaluate(() => document.querySelectorAll('.tab').length)
  check('reopening the same file does not duplicate the tab', afterSecondOpen === 2, `${afterSecondOpen} tabs`)

  // ── Edit + save, byte-for-byte (Phase 2) ─────────────────────────────────
  await page.evaluate(() => document.querySelector('.cm-content')?.focus())
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
  await page.keyboard.type('appended by the driver\n', { delay: 5 })
  await new Promise((r) => setTimeout(r, 400))

  const dirty = await page.evaluate(() => document.querySelector('.footer__save')?.textContent)
  check('editing marks the document unsaved', dirty === 'Unsaved', dirty ?? '')

  await menuClick('file.save')
  await until(() => document.querySelector('.footer__save')?.textContent === 'Saved', 'Saved', 10_000)

  const onDisk = fs.readFileSync(scratchFile)
  check('save wrote the file', onDisk.length > 0, `${onDisk.length} bytes`)
  check('CRLF preserved on write (§6)',
    onDisk.includes(Buffer.from('\r\n')) && !/[^\r]\n/.test(onDisk.toString('latin1')),
    JSON.stringify(onDisk.toString('utf8').slice(-30)))
  console.log(`  saved: ${await shot('03-saved')}`)

  // ── Dark mode (Phase 3) ──────────────────────────────────────────────────
  await page.evaluate(() => window.margin.settings.set({ theme: 'dark' }))
  const darkOn = await until(
    () => document.documentElement.dataset.theme === 'dark',
    'dark theme',
    8000
  )
  const darkChrome = await page.evaluate(() => {
    const editor = document.querySelector('.cm-editor')
    const gutter = document.querySelector('.cm-gutters')
    return {
      root: document.documentElement.dataset.theme,
      pane: getComputedStyle(document.querySelector('.pane')).backgroundColor,
      // The editor is token-driven (§4.4), so the observable signal is the
      // colour it actually paints, not a class name.
      editorText: editor ? getComputedStyle(editor).color : null,
      gutterText: gutter ? getComputedStyle(gutter).color : null,
      classes: editor ? editor.className : null
    }
  })
  check('dark mode applies to chrome', darkOn, `theme=${darkChrome.root} pane=${darkChrome.pane}`)

  /*
   * The native window chrome follows too. The Windows caption glyphs are drawn
   * by the OS over a transparent overlay, so CSS cannot reach them and a page
   * screenshot cannot show them — dark ink stayed on the dark title bar and the
   * minimize/maximize/close buttons vanished.
   *
   * getBackgroundColor is the observable half of that same pass: if it flipped,
   * setTitleBarOverlay ran beside it. The glyph colour itself has no getter and
   * still needs an eye on a real Windows title bar.
   */
  const nativeBg = await app.evaluate(({ BrowserWindow }, id) =>
    BrowserWindow.fromId(id)?.getBackgroundColor() ?? null, mainWindowId)
  check('native window chrome follows the theme',
    typeof nativeBg === 'string' && nativeBg.toLowerCase() === '#101215',
    `window background ${nativeBg}`)
  check('dark mode repaints the editor', isLight(darkChrome.editorText),
    `editor colour ${darkChrome.editorText}`)
  console.log(`  dark: ${await shot('04-dark-mode')}`)

  // Switch tabs while dark, then back — the residue check, in the real app.
  await page.evaluate(() => {
    const tabs = document.querySelectorAll('.tab')
    tabs[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 600))
  const residue = await page.evaluate(() => {
    const editor = document.querySelector('.cm-editor')
    return {
      editorText: editor ? getComputedStyle(editor).color : null,
      pane: getComputedStyle(document.querySelector('.pane')).backgroundColor
    }
  })
  check('no light-mode residue after a tab switch (§4.4)', isLight(residue.editorText),
    `editor colour ${residue.editorText} on ${residue.pane}`)
  console.log(`  tab switch while dark: ${await shot('05-dark-other-tab')}`)

  await page.evaluate(() => window.margin.settings.set({ theme: 'light' }))
  await until(() => document.documentElement.dataset.theme === 'light', 'light theme', 8000)

  // ── Find panel (Phase 4) ─────────────────────────────────────────────────
  await page.evaluate(() => {
    const tabs = document.querySelectorAll('.tab')
    tabs[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 500))
  await page.evaluate(() => document.querySelector('.cm-content')?.focus())
  await page.keyboard.press(`${MOD}+f`)
  const findOpen = await until(() => !!document.querySelector('.cm-search'), '.cm-search', 6000)
  check('find panel opens on the editor chord (Phase 4)', findOpen)
  console.log(`  find: ${await shot('06-find-panel')}`)
  await page.keyboard.press('Escape')

  // ── History sidebar (Phase 5) ────────────────────────────────────────────
  await page.evaluate(() => document.querySelector('.cm-content')?.focus())
  await page.keyboard.press(`${MOD}+Shift+H`)
  const historyOpen = await until(() => !!document.querySelector('.history'), '.history', 8000)
  const versions = await until(
    () => document.querySelectorAll('.history__item').length > 0,
    'history versions',
    10_000
  )
  const historyState = await page.evaluate(() => ({
    items: document.querySelectorAll('.history__item').length,
    empty: document.querySelector('.history__empty')?.textContent ?? null
  }))
  check('history sidebar opens (Phase 5)', historyOpen)
  check('journal recorded versions of the saved file', versions,
    `${historyState.items} versions${historyState.empty ? ` (${historyState.empty})` : ''}`)
  console.log(`  history: ${await shot('07-history')}`)

  // Select a version to preview it.
  if (historyState.items > 0) {
    await page.evaluate(() => {
      const items = document.querySelectorAll('.history__item')
      items[items.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const previewed = await until(
      () => !!document.querySelector('.history__previewBody')?.textContent,
      'version preview',
      8000
    )
    check('a version previews its content', previewed)
    console.log(`  history preview: ${await shot('08-history-preview')}`)
  }

  // ── Compare (Phase 6) ────────────────────────────────────────────────────
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, compareFile)

  check('View > Compare With File is reachable from the menu',
    (await menuClick('view.compareWithFile')) === 'OK')
  const comparing = await until(
    () => !!document.querySelector('.cm-deletedChunk, .cm-changedLine, .cm-changedText'),
    'diff decorations',
    12_000
  )
  const compareState = await page.evaluate(() => ({
    notice: document.querySelector('.notice__message')?.textContent ?? null,
    deleted: document.querySelectorAll('.cm-deletedChunk').length,
    changed: document.querySelectorAll('.cm-changedLine').length,
    extraViews: document.querySelectorAll('.cm-editor').length
  }))
  check('compare shows an inline diff (Phase 6)', comparing,
    `deleted=${compareState.deleted} changed=${compareState.changed}`)
  check('compare announces itself in the chrome', !!compareState.notice, compareState.notice ?? '')
  check('compare mounts no extra EditorView (§11)', compareState.extraViews === 1,
    `${compareState.extraViews} .cm-editor`)
  console.log(`  compare: ${await shot('09-compare')}`)

  // ── Tab dragging (§4.1) ──────────────────────────────────────────────────
  await menuClick('view.exitCompare')
  await new Promise((r) => setTimeout(r, 600))

  // A third tab, so a reorder has somewhere to go.
  await menuClick('file.new')
  await until(() => document.querySelectorAll('.tab').length === 3, 'three tabs', 8000)

  const orderBefore = await page.evaluate(() =>
    [...document.querySelectorAll('.tab__name')].map((n) => n.textContent)
  )

  /*
   * HTML5 drag-and-drop cannot be driven by synthesised mouse movement in
   * Chromium, so the DragEvents themselves are dispatched. React listens for
   * exactly these, so the component's own handlers run.
   */
  const reordered = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tab')]
    const strip = document.querySelector('.tabstrip')
    if (tabs.length < 3 || !strip) return 'NOT_ENOUGH_TABS'

    const dt = new DataTransfer()
    const first = tabs[0]
    const last = tabs[tabs.length - 1]
    const target = last.getBoundingClientRect()

    first.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    strip.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: target.right - 4 })
    )
    strip.dispatchEvent(
      new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: target.right - 4 })
    )
    return 'OK'
  })

  await new Promise((r) => setTimeout(r, 600))
  const orderAfter = await page.evaluate(() =>
    [...document.querySelectorAll('.tab__name')].map((n) => n.textContent)
  )
  check('dragging a tab reorders the strip (§4.1)',
    reordered === 'OK' && orderAfter[orderAfter.length - 1] === orderBefore[0],
    `${orderBefore.join(' | ')}  ->  ${orderAfter.join(' | ')}`)
  check('reorder loses no tabs', orderAfter.length === orderBefore.length &&
    [...orderAfter].sort().join() === [...orderBefore].sort().join())
  console.log(`  reordered: ${await shot('10-reordered')}`)

  // Detach: a drag that ends well clear of the strip.
  const tabsBeforeDetach = await page.evaluate(() => document.querySelectorAll('.tab').length)
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tab')]
    const dt = new DataTransfer()
    // Detach the named file, so "the window holds the document" is checkable
    // against something other than another Untitled.
    const victim =
      tabs.find((t) => t.querySelector('.tab__name')?.textContent?.endsWith('.md')) ??
      tabs[tabs.length - 1]
    victim.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    // No drop inside the app, and the pointer is far below the strip.
    victim.dispatchEvent(
      new DragEvent('dragend', { bubbles: true, dataTransfer: dt, clientX: 400, clientY: 600 })
    )
  })
  await new Promise((r) => setTimeout(r, 3000))

  const afterDetach = await page.evaluate(() => document.querySelectorAll('.tab').length)
  const windowsNow = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  check('dragging a tab out detaches it into a window (§4.1)',
    afterDetach === tabsBeforeDetach - 1 && windowsNow === 2,
    `${tabsBeforeDetach} -> ${afterDetach} tabs, ${windowsNow} windows`)
  console.log(`  detached: ${await shot('11-detached')}`)

  // A second window that opened empty would be a detach in name only.
  const detachedPage = app.windows().find((w) => w !== page)
  if (detachedPage) {
    await detachedPage.waitForSelector('.cm-editor', { timeout: 15_000 }).catch(() => {})
    const landed = await detachedPage.evaluate(() => ({
      tabs: [...document.querySelectorAll('.tab__name')].map((n) => n.textContent),
      text: document.querySelector('.cm-content')?.textContent ?? ''
    }))
    check('the detached window holds exactly the detached document',
      landed.tabs.length === 1 && landed.tabs[0]?.endsWith('.md') === true,
      `tabs: ${landed.tabs.join(' | ')}`)
    await detachedPage.screenshot({ path: path.join(SHOTS, '12-detached-window.png') })
    console.log(`  detached window: ${path.join(SHOTS, '12-detached-window.png')}`)
  } else {
    check('the detached window holds the document, not an empty one', false, 'no second window page')
  }

  // ── Home screen on the last close (§4.1) ─────────────────────────────────
  //
  // The detach above gave focus to the new window, and menuClick routes to the
  // focused one — so the window under test has to be brought back first.
  await app.evaluate(({ BrowserWindow }, id) => {
    const target = BrowserWindow.fromId(id)
    target?.focus()
  }, mainWindowId)
  await new Promise((r) => setTimeout(r, 500))

  //
  // Close every remaining tab and check the window falls back to the home
  // screen rather than closing or conjuring an untitled document.
  for (let i = 0; i < 6; i++) {
    const left = await page.evaluate(() => document.querySelectorAll('.tab').length)
    if (left === 0) break
    await menuClick('file.closeTab')
    await new Promise((r) => setTimeout(r, 700))
    // A dirty document raises the themed prompt; discard so the loop continues.
    const prompt = await page.evaluate(() => !!document.querySelector('.dialog'))
    if (prompt) {
      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('.dialog__button')]
        buttons.find((b) => b.textContent?.includes('Do Not Save'))?.click()
      })
      await new Promise((r) => setTimeout(r, 700))
    }
  }

  const home = await until(() => !!document.querySelector('.home'), '.home', 8000)
  const homeState = await page.evaluate(() => ({
    tabs: document.querySelectorAll('.tab').length,
    wordmark: document.querySelector('.home__wordmark')?.textContent ?? null,
    mark: !!document.querySelector('.home svg'),
    actions: [...document.querySelectorAll('.home__action')].map((b) =>
      b.textContent?.replace(/\s+/g, ' ').trim()
    ),
    footerItems: [...document.querySelectorAll('.footer__state .footer__item')].map(
      (n) => n.textContent
    ),
    panes: document.querySelectorAll('.pane').length
  }))
  check('closing the last tab shows the home screen (§4.1)',
    home && homeState.tabs === 0 && homeState.panes === 0,
    `tabs=${homeState.tabs} panes=${homeState.panes}`)
  check('home screen shows the mark and both actions',
    homeState.mark && homeState.wordmark === 'margin' && homeState.actions.length === 2,
    homeState.actions.join(' | '))
  check('footer reports no document state on the home screen',
    homeState.footerItems.length === 1,
    homeState.footerItems.join(' · '))
  console.log(`  home: ${await shot('13-home')}`)

  // ── Clearing the recent list ─────────────────────────────────────────────
  //
  // The scratch file opened earlier put a real entry in the list, so the block
  // is showing. The control arms on the first click and only acts on the
  // second — this drives the arming and then deliberately stops.
  //
  // Confirming is NOT driven: this suite runs against the developer's real
  // userData (the app is launched with no profile override), so a confirm here
  // would erase their actual recent files. tests/main/settings.test.ts covers
  // what the second click does, against a temp settings file.
  const recentBefore = await page.evaluate(
    () => document.querySelectorAll('.home__recentItem').length
  )
  check('the home screen lists recent files after a real open', recentBefore > 0,
    `${recentBefore} entries`)

  // Focus is set explicitly rather than left to the click: Chromium on macOS
  // follows the platform and does not focus a button on mousedown, so the blur
  // below would never fire there.
  await page.evaluate(() => document.querySelector('.home__recentClear')?.focus())
  await page.click('.home__recentClear')
  const armed = await until(
    () => document.querySelector('.home__recentClear')?.textContent === 'Confirm',
    'armed clear',
    4000
  )
  check('clearing recent files arms before it acts', armed,
    await page.evaluate(() => document.querySelector('.home__recentClear')?.textContent ?? 'none'))

  await page.evaluate(() => document.querySelector('.home__recentClear')?.blur())
  const disarmed = await until(
    () => document.querySelector('.home__recentClear')?.textContent === 'Clear',
    'disarmed clear',
    4000
  )
  check('an armed clear disarms when it loses focus', disarmed)
  check('arming alone clears nothing',
    (await page.evaluate(() => document.querySelectorAll('.home__recentItem').length)) ===
      recentBefore)

  // Dark home screen, since it is a new surface.
  await page.evaluate(() => window.margin.settings.set({ theme: 'dark' }))
  await until(() => document.documentElement.dataset.theme === 'dark', 'dark', 6000)
  console.log(`  home (dark): ${await shot('14-home-dark')}`)
  await page.evaluate(() => window.margin.settings.set({ theme: 'light' }))
  await until(() => document.documentElement.dataset.theme === 'light', 'light', 6000)

  // And the home screen actually creates a document.
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.home__action')]
    buttons.find((b) => b.textContent?.includes('New Document'))?.click()
  })
  const madeOne = await until(() => document.querySelectorAll('.tab').length === 1, 'new tab', 8000)
  check('New Document on the home screen opens a document', madeOne)

  // ── The themed unsaved-changes prompt (§8) ───────────────────────────────
  await page.evaluate(() => document.querySelector('.cm-content')?.focus())
  await page.keyboard.type('unsaved work', { delay: 5 })
  await new Promise((r) => setTimeout(r, 400))
  await menuClick('file.closeTab')

  const dialogUp = await until(() => !!document.querySelector('.dialog'), '.dialog', 8000)
  const dialogState = await page.evaluate(() => {
    const dialog = document.querySelector('.dialog')
    const primary = document.querySelector('.dialog__button--primary')
    return {
      title: document.querySelector('.dialog__title')?.textContent ?? null,
      buttons: [...document.querySelectorAll('.dialog__button')].map((b) => b.textContent),
      // Themed means it uses the app's own surface, not the OS palette.
      background: dialog ? getComputedStyle(dialog).backgroundColor : null,
      primaryFill: primary ? getComputedStyle(primary).backgroundColor : null,
      focused: document.activeElement?.textContent ?? null
    }
  })
  check('the unsaved-changes prompt is drawn in-app and themed (§8)',
    dialogUp && dialogState.background === 'rgb(255, 255, 255)',
    `bg=${dialogState.background} buttons=${dialogState.buttons.join('/')}`)
  check('the prompt defaults to Save', dialogState.focused === 'Save', `focus=${dialogState.focused}`)
  console.log(`  prompt: ${await shot('15-confirm-dialog')}`)

  // Dark, because this is the surface that used to ignore the theme entirely.
  await page.evaluate(() => window.margin.settings.set({ theme: 'dark' }))
  await until(() => document.documentElement.dataset.theme === 'dark', 'dark', 6000)
  const darkDialog = await page.evaluate(() => {
    const dialog = document.querySelector('.dialog')
    return dialog ? getComputedStyle(dialog).backgroundColor : null
  })
  check('the prompt follows dark mode', darkDialog === 'rgb(23, 25, 28)', `bg=${darkDialog}`)
  console.log(`  prompt (dark): ${await shot('16-confirm-dialog-dark')}`)

  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.dialog__button')]
    buttons.find((b) => b.textContent === 'Cancel')?.click()
  })
  await new Promise((r) => setTimeout(r, 500))
  const cancelled = await page.evaluate(() => ({
    dialog: !!document.querySelector('.dialog'),
    tabs: document.querySelectorAll('.tab').length
  }))
  check('Cancel dismisses the prompt and keeps the document',
    !cancelled.dialog && cancelled.tabs === 1, `tabs=${cancelled.tabs}`)
  await page.evaluate(() => window.margin.settings.set({ theme: 'light' }))

  // ── Window geometry ──────────────────────────────────────────────────────
  //
  // Restoring cannot be driven from one launch, so this asserts the half that
  // can be: the geometry reaching the settings file as the window moves. The
  // fitting that decides where it reopens is unit-tested over synthetic
  // displays, which is the only way to test an unplugged monitor at all.
  const settingsFile = path.join(
    await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData')),
    'settings.json'
  )
  const priorGeometry = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).window ?? null

  // The move is sized to the display the window is actually on. A fixed
  // rectangle is a rectangle the runner may not have: the CI macOS display is
  // far smaller than a developer's, and macOS silently shrinks and lifts a
  // window that would not fit its work area.
  //
  // It also keeps a margin inside that work area, because a window filling it
  // exactly *is* zoomed as far as macOS is concerned — `isMaximized()` then
  // reports true, and the geometry recorded would be a maximized one.
  const moved = await app.evaluate(({ BrowserWindow, screen }, id) => {
    const window = BrowserWindow.fromId(id)
    const area = screen.getDisplayMatching(window.getNormalBounds()).workArea
    // The app's own minimums (§ index.ts MINIMUM_SIZE) still apply, so never ask
    // for less than those — Electron would resize past the request.
    const width = Math.max(900, Math.min(1180, area.width - 80))
    const height = Math.max(560, Math.min(760, area.height - 80))
    const bounds = {
      x: area.x + Math.min(40, Math.max(0, area.width - width)),
      y: area.y + Math.min(40, Math.max(0, area.height - height)),
      width,
      height
    }
    window.setBounds(bounds)
    return bounds
  }, mainWindowId)
  // Past the settle delay in index.ts, which holds the synchronous write off
  // until a drag has ended.
  await new Promise((r) => setTimeout(r, 1200))

  // Compared against what the window actually ended up at, not against what was
  // asked for: the claim under test is that the app writes the window's real
  // geometry to the settings file, and whether the OS honours a resize request
  // to the pixel is the OS's business, not Margin's.
  const actual = await app.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)
    if (!window) return null
    return { ...window.getNormalBounds(), maximized: window.isMaximized() }
  }, mainWindowId)
  const persisted = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).window ?? null
  check('window geometry is persisted as the window moves',
    !!persisted && !!actual && persisted.width === actual.width &&
      persisted.height === actual.height && persisted.x === actual.x &&
      persisted.y === actual.y && persisted.maximized === actual.maximized,
    `persisted=${JSON.stringify(persisted)} actual=${JSON.stringify(actual)} requested=${JSON.stringify(moved)}`)
  check('the geometry stays out of the renderer settings payload',
    !(await page.evaluate(async () => 'window' in (await window.margin.settings.get()))))

  // Put the window back where the run found it: this drives the real profile,
  // and the developer's next launch should not open at the test size.
  if (priorGeometry) {
    await app.evaluate(({ BrowserWindow }, args) =>
      BrowserWindow.fromId(args.id)?.setBounds(args.bounds), {
      id: mainWindowId,
      bounds: {
        x: priorGeometry.x, y: priorGeometry.y,
        width: priorGeometry.width, height: priorGeometry.height
      }
    })
  }

  // ── Multi-window (Phase 3) ───────────────────────────────────────────────
  await page.evaluate(() => window.margin.window.create())
  await new Promise((r) => setTimeout(r, 3000))
  const windowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  check('New Window opens another window (Phase 3)', windowCount >= 3, `${windowCount} windows`)

  // ── Renderer errors ──────────────────────────────────────────────────────
  //
  // Note the document left over from the Cancel above is still dirty, and is
  // meant to be: shutdown() quits through its prompt, which is the only place
  // the quit half of §8's handshake is exercised. Do not "tidy up" by saving it.
  console.log('')
} catch (error) {
  check('driver completed without throwing', false, error.message)
  console.error(error)
} finally {
  if (app) await shutdown()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`screenshots: ${SHOTS}`)
if (failed.length) {
  console.log('\nfailed:')
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`)
}
process.exit(failed.length ? 1 : 0)

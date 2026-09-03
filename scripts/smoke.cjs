/**
 * Headless smoke test for the built renderer.
 *
 * Loads out/renderer/index.html in an offscreen BrowserWindow with the real
 * preload, then asserts against the live DOM. This is what makes "the packaged
 * build runs" checkable in CI rather than a thing someone eyeballs — it catches
 * the failures a unit test cannot: a broken preload bridge, an ESM/CJS mismatch,
 * a CSP that blocks the bundle, or a renderer that throws on mount.
 *
 * Usage: npm run smoke   (after npm run build)
 */
const { join } = require('node:path')
const { app, BrowserWindow, ipcMain, session } = require('electron')


const OUT = join(__dirname, '..', 'out')

/**
 * Since Phase 2 the renderer asks main for its first document before it can
 * render anything, so a harness that answers nothing gets an empty window and
 * every DOM assertion below fails for the wrong reason.
 *
 * These are stubs on purpose. This script exercises the built renderer and its
 * preload bridge, not the file layer -- DocumentRegistry and FileService are
 * covered against a real filesystem in tests/main. Loading the real main bundle
 * here would launch the actual application instead of this offscreen window.
 */
function stubBootHandlers() {
  ipcMain.handle('doc:new', () => ({
    meta: {
      id: 'smoke-1',
      path: null,
      name: 'Untitled',
      dirty: false,
      encoding: 'utf8',
      eol: 'LF',
      mixedEol: false,
      flavor: 'gfm',
      version: 0
    },
    content: '',
    encodingGuessed: false
  }))

  // Settings drive the theme, which the renderer applies before first paint.
  ipcMain.handle('settings:get', () => ({ theme: 'light', defaultFlavor: 'gfm', recent: [] }))
  ipcMain.handle('settings:set', () => ({ theme: 'light', defaultFlavor: 'gfm', recent: [] }))

  // Fire-and-forget channels the renderer publishes on from its first render.
  ipcMain.on('doc:changed', () => {})
  ipcMain.on('doc:setDirty', () => {})
  ipcMain.on('window:tabs', () => {})
  ipcMain.on('command:enablement', () => {})
}

/** Evaluated in the page. Returns a report the main process asserts against. */
const PROBE = `(() => {
  const q = (s) => document.querySelector(s)
  const editor = q('.cm-editor')
  const content = q('.cm-content')
  const markdown = q('.markdown')
  return {
    bridge: typeof window.margin === 'object' && typeof window.margin.platform === 'string',
    platformAttr: document.documentElement.dataset.platform || null,
    titlebar: !!q('.titlebar'),
    titlebarBrand: !!q('.titlebar .brand'),
    titlebarHeight: q('.titlebar') ? getComputedStyle(q('.titlebar')).height : null,
    titlebarPadLeft: q('.titlebar') ? getComputedStyle(q('.titlebar')).paddingLeft : null,
    titlebarPadRight: q('.titlebar') ? getComputedStyle(q('.titlebar')).paddingRight : null,
    tabstripHeight: q('.tabstrip') ? getComputedStyle(q('.tabstrip')).height : null,
    shellGround: getComputedStyle(document.documentElement).getPropertyValue('--shell-ground').trim(),
    tabstrip: !!q('.tabstrip'),
    tabs: document.querySelectorAll('.tab').length,
    panes: document.querySelectorAll('.pane').length,
    footer: !!q('.footer'),
    paletteHint: q('.footer .kbd') ? q('.footer .kbd').textContent : null,
    saveState: q('.footer__save') ? q('.footer__save').textContent : null,
    editorMounted: !!editor,
    gutter: !!q('.cm-gutters'),
    editorText: content ? content.textContent.slice(0, 60) : null,
    previewBlocks: markdown ? markdown.children.length : 0,
    previewH1: q('.markdown h1') ? q('.markdown h1').textContent : null,
    sourceAnchors: document.querySelectorAll('.markdown [data-source-line]').length,
    hasTable: !!q('.markdown table'),
    hasCheckbox: !!q('.markdown input[type=checkbox]'),
    checkboxDisabled: q('.markdown input[type=checkbox]') ? q('.markdown input[type=checkbox]').disabled : null,
    scripts: document.querySelectorAll('.markdown script').length,
    tokenInk: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
    bodyFont: getComputedStyle(document.body).fontFamily,
    editorFont: content ? getComputedStyle(content).fontFamily : null,
    bodyFontSize: getComputedStyle(document.body).fontSize,
    geistLoaded: document.fonts ? document.fonts.check('16px "Geist Variable"') : null,
    geistMonoLoaded: document.fonts ? document.fonts.check('14px "Geist Mono Variable"') : null,
    errors: window.__smokeErrors || []
  }
})()`

const CHECKS = [
  ['preload bridge exposed', (r) => r.bridge === true],
  ['platform attribute set for titlebar insets', (r) => !!r.platformAttr],
  ['title bar rendered', (r) => r.titlebar],
  ['wordmark sits in the title bar, not the tab strip', (r) => r.titlebarBrand],
  ['title bar height follows the platform', (r) => r.titlebarHeight === (r.platformAttr === 'darwin' ? '38px' : '32px')],
  [
    'native window controls have their edge reserved',
    (r) => (r.platformAttr === 'darwin' ? r.titlebarPadLeft === '86px' : r.titlebarPadRight === '138px')
  ],
  ['tab strip rendered', (r) => r.tabstrip],
  ['tab strip is its own 40px row', (r) => r.tabstripHeight === '40px'],
  ['shell ground is the design canvas value', (r) => r.shellGround === '#efeee9'],
  ['one tab for the untitled document', (r) => r.tabs === 1],
  ['both panes rendered', (r) => r.panes === 2],
  ['footer rendered', (r) => r.footer],
  ['command hint shows an accelerator', (r) => /^(Cmd|Ctrl) K$/.test(r.paletteHint || '')],
  ['untitled document reports Unsaved', (r) => r.saveState === 'Unsaved'],
  ['CodeMirror mounted', (r) => r.editorMounted],
  ['gutter rendered', (r) => r.gutter],
  ['editor holds the document source', (r) => (r.editorText || '').includes('# Margin')],
  ['preview rendered blocks', (r) => r.previewBlocks > 5],
  ['preview h1 rendered', (r) => r.previewH1 === 'Margin'],
  ['scroll-sync anchors present', (r) => r.sourceAnchors > 5],
  ['GFM table rendered', (r) => r.hasTable],
  ['task-list checkbox survived sanitization', (r) => r.hasCheckbox],
  ['task-list checkbox is disabled', (r) => r.checkboxDisabled === true],
  ['no script element reached the preview', (r) => r.scripts === 0],
  ['design tokens resolved', (r) => r.tokenInk === '#0a0a0a'],
  ['body uses the design system family', (r) => /Geist Variable/.test(r.bodyFont || '')],
  ['editor uses the mono family', (r) => /Geist Mono Variable/.test(r.editorFont || '')],
  ['body type is the system 16px body size', (r) => r.bodyFontSize === '16px'],
  ['Geist actually loaded, not just requested', (r) => r.geistLoaded === true],
  ['Geist Mono actually loaded', (r) => r.geistMonoLoaded === true],
  ['no uncaught renderer errors', (r) => r.errors.length === 0]
]

async function main() {
  await app.whenReady()

  stubBootHandlers()

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: file:; font-src 'self' data:; connect-src 'self'"
        ]
      }
    })
  })

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 840,
    webPreferences: {
      preload: join(OUT, 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const consoleErrors = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') consoleErrors.push(event.message)
  })
  win.webContents.on('preload-error', (_e, path, error) => {
    consoleErrors.push(`preload ${path}: ${error.message}`)
  })

  await win.loadFile(join(OUT, 'renderer', 'index.html'))

  // Give React a beat to mount and the preview debounce to flush.
  let report = null
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    report = await win.webContents.executeJavaScript(PROBE)
    if (report.editorMounted && report.previewBlocks > 5) break
  }

  let failed = 0
  for (const [name, predicate] of CHECKS) {
    const ok = (() => { try { return predicate(report) } catch { return false } })()
    console.log(`${ok ? '  \u2713' : '  \u2717'} ${name}`)
    if (!ok) failed++
  }

  if (consoleErrors.length > 0) {
    console.log('\n  Renderer console errors:')
    for (const message of consoleErrors) console.log(`    - ${message}`)
    failed += consoleErrors.length
  }

  if (failed > 0) {
    console.log('\nReport:\n' + JSON.stringify(report, null, 2))
    console.error(`\n${failed} smoke check(s) failed`)
  } else {
    console.log(`\nAll ${CHECKS.length} smoke checks passed.`)
  }

  app.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})

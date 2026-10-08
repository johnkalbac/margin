/**
 * Frame the window captures from scripts/store-screenshots.mjs for the Mac App
 * Store: each one set on the app's own ground with a headline above it, written
 * at 2880×1800 — the largest of the four sizes App Store Connect accepts.
 *
 *   electron scripts/store-frames.cjs release/app-store
 *
 * Reads <dir>/manifest.json, writes <dir>/framed/NN-name.png. Run on its own it
 * re-frames the last captures without driving the app again, which is the loop
 * to be in while adjusting a headline.
 *
 * The frame keeps to the design system tokens.css describes: one family
 * (Geist), no signal colour, and no drop shadow — the window is set off from
 * the ground by a 1px rule, not by depth.
 */
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { basename, join } = require('node:path')
const { app, BrowserWindow } = require('electron')

// 1440×900 CSS pixels at 2x is 2880×1800, whatever display this runs on.
app.commandLine.appendSwitch('force-device-scale-factor', '2')
app.disableHardwareAcceleration()

const ROOT = join(__dirname, '..')
const FRAME = { width: 1440, height: 900 }

/**
 * Duplicated from tokens.css and SHELL_GROUND in src/main/index.ts — a Node
 * script cannot read a custom property. The grounds are the window's own
 * background colours, so the frame reads as the app's surface extended.
 */
const THEMES = {
  light: { ground: '#EFEEE9', ink: '#0A0A0A', body: '#454545', rule: 'rgba(10, 10, 10, 0.14)' },
  dark: { ground: '#101215', ink: '#FFFFFF', body: 'rgba(255, 255, 255, 0.7)', rule: 'rgba(255, 255, 255, 0.16)' }
}

const font = readFileSync(
  join(ROOT, 'node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2')
).toString('base64')

/**
 * The window's own corner radius at frame scale. macOS rounds the window at
 * 15pt, and a native capture flattens the transparent corners to black; the
 * window is drawn 1100px wide from a 1200pt capture, so 15pt is 13.75px here.
 * Half a pixel over, so the antialiased edge goes too.
 */
const RADIUS = 14.5

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function page({ file, theme, headline, subline }) {
  const t = THEMES[theme]
  const shot = readFileSync(file).toString('base64')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: Geist; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 100 900; }
    html, body { margin: 0; width: ${FRAME.width}px; height: ${FRAME.height}px; overflow: hidden; }
    body { background: ${t.ground}; font-family: Geist, sans-serif; text-align: center;
           -webkit-font-smoothing: antialiased; }
    h1 { margin: 64px 0 0; font-size: 46px; line-height: 54px; font-weight: 600;
         letter-spacing: -0.02em; color: ${t.ink}; }
    p { margin: 12px 0 0; font-size: 21px; line-height: 28px; font-weight: 400; color: ${t.body}; }
    .window { position: absolute; left: 170px; top: 202px; width: 1100px; border-radius: ${RADIUS}px;
              overflow: hidden; outline: 1px solid ${t.rule}; outline-offset: -1px; line-height: 0; }
    .window img { width: 100%; display: block; }
  </style></head><body>
    <h1>${escape(headline)}</h1>
    <p>${escape(subline)}</p>
    <div class="window"><img src="data:image/png;base64,${shot}"></div>
  </body></html>`
}

async function main() {
  const dir = process.argv[2] || join(ROOT, 'release', 'app-store')
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const outDir = join(dir, 'framed')
  mkdirSync(outDir, { recursive: true })

  await app.whenReady()
  const win = new BrowserWindow({
    ...FRAME,
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
  })

  for (const scene of manifest) {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(scene)))
    // An offscreen window captures whatever it last painted, and the first page
    // or two can come back as bare ground: wait for the font, the decoded
    // screenshot and two frames after them, and retake a capture too small to
    // hold one (a blank frame is ~20KB; a real one is several hundred).
    await win.webContents.executeJavaScript(`
      Promise.all([document.fonts.ready, document.querySelector('img').decode()])
        .then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
        .then(() => true)`)
    let image
    for (let attempt = 0; attempt < 10; attempt++) {
      win.webContents.invalidate()
      await new Promise((r) => setTimeout(r, 150))
      image = await win.webContents.capturePage({ x: 0, y: 0, ...FRAME })
      if (image.toPNG({ scaleFactor: 2 }).length > 100_000) break
    }
    const size = image.getSize(2)
    const out = join(outDir, basename(scene.file))
    writeFileSync(out, image.toPNG({ scaleFactor: 2 }))
    console.log(`  ${basename(out)}: ${size.width}×${size.height}`)
  }
  app.quit()
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})

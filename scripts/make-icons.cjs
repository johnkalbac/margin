/**
 * Generates the application icons — `npm run icons`.
 *
 * The outputs (build/icon.icns, build/icon.ico, build/icon.png) are committed;
 * this script only has to run when the artwork changes. It is deliberately not
 * part of `npm run build`: it launches a second Electron process to rasterize,
 * which is a lot of seconds to pay on every build for a file that never moves.
 *
 * WHY ELECTRON AND NOT A LIBRARY: the repo has no image dependency, and plan §1
 * rules out native modules — sharp is one. Electron is already a devDependency
 * and its Chromium renders the SVG exactly as the app does, so the icon and the
 * in-app <LogoMark /> come out of the same rasterizer.
 *
 * WHY THE CONTAINERS ARE HAND-WRITTEN: .ico and .icns are both trivial archive
 * formats, and writing them here is what buys per-size artwork. electron-builder
 * will happily convert a single icon.png, but it can only downscale — and three
 * hairlines 4.5 units apart turn into one grey smear at 16px. The brand rules
 * (see `art()` below) exist precisely to stop that, and they can only be applied
 * if each size is drawn separately.
 */
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { app, BrowserWindow } = require('electron')

// Rasterize at 1:1 regardless of the display this happens to run on. Without
// it, capturePage on a HiDPI screen returns 2x the pixels asked for.
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'build')

/** Design tokens, duplicated because a Node script cannot read a custom property. */
const GROUND = '#FAFAF9' // --canvas-warm
const EDGE = '#C4C4C4' // --ash
const INK = '#0A0A0A' // --ink
const LADDER = [
  { d: 'M1 12 12 1', stroke: '#1F1F1F', width: 1.5 }, // --ink-soft
  { d: 'M5.5 12 15 2.5', stroke: '#7C8794', width: 1.2 }, // --slate-soft
  { d: 'M10 12 15 7', stroke: '#C4C4C4', width: 1.0 } // --ash
]

/**
 * The mark's tight bounding box in its own 15x13 construction grid, round caps
 * included. The published viewBox is 0 0 15 13, which clips half a cap at each
 * end — invisible in a 15px wordmark, a chewed corner at 1024.
 */
const MARK_BOX = { x: 0.25, y: 0.25, w: 15.5, h: 12.5 }

/**
 * How the mark is drawn at a given pixel size, per the brand rules:
 *
 *   - "Below 15px drop the lightest stroke" (Mark scales).
 *   - "Favicon, print, engraving: one weight, one value" (Margin Logo).
 *
 * So the three-value ladder is used only where all three values are actually
 * resolvable, and the small sizes get the mono variant — two strokes at 16-32,
 * where a third would close up, and three from 48 where it reads.
 */
function art(size) {
  if (size <= 32) return { strokes: LADDER.slice(0, 2).map(mono), fill: 0.7 }
  if (size < 128) return { strokes: LADDER.map(mono), fill: 0.62 }
  return { strokes: LADDER, fill: 0.58 }
}

/** The mono variant: one weight, one value. */
function mono(stroke) {
  return { d: stroke.d, stroke: INK, width: 1.5 }
}

/**
 * One icon, as SVG.
 *
 * `shape` is 'squircle' for macOS — the Big Sur grid, an 824x824 body with a
 * 185.4 corner radius on a 1024 canvas, which is what makes it sit the same size
 * as every other icon in the Dock — and 'square' for Windows, which draws its
 * own container and expects full bleed.
 */
function svg(size, shape) {
  const inset = shape === 'squircle' ? (size * 100) / 1024 : 0
  const body = size - inset * 2
  const radius = shape === 'squircle' ? (body * 185.4) / 824 : 0

  // The edge keeps a paper-white tile from dissolving into a light dock or
  // taskbar. It is a hairline, so it stays 1px until the tile is big enough for
  // a scaled rule to still read as one.
  const edge = Math.max(1, size * 0.008)
  const half = edge / 2

  const { strokes, fill } = art(size)
  const markW = body * fill
  const markH = (markW * MARK_BOX.h) / MARK_BOX.w
  const markX = inset + (body - markW) / 2
  const markY = inset + (body - markH) / 2

  const paths = strokes
    .map((s) => `<path d="${s.d}" stroke="${s.stroke}" stroke-width="${s.width}"/>`)
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${inset + half}" y="${inset + half}" width="${body - edge}" height="${body - edge}"
        rx="${Math.max(0, radius - half)}" fill="${GROUND}" stroke="${EDGE}" stroke-width="${edge}"/>
  <svg x="${markX}" y="${markY}" width="${markW}" height="${markH}"
       viewBox="${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.w} ${MARK_BOX.h}"
       fill="none" stroke-linecap="round">${paths}</svg>
</svg>`
}

/** Rasterizes one icon to a NativeImage of exactly size x size. */
async function render(win, size, shape) {
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}</style>
${svg(size, shape)}`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  const actual = image.getSize()
  if (actual.width !== size || actual.height !== size) {
    throw new Error(`capture was ${actual.width}x${actual.height}, expected ${size}`)
  }
  return image
}

/**
 * A single ICO directory entry in the classic DIB form: a BITMAPINFOHEADER
 * whose height is doubled to cover the (unused, all-transparent) AND mask, then
 * bottom-up BGRA rows. NativeImage#toBitmap already hands back BGRA, which is
 * the byte order a 32-bit DIB wants, so the rows only have to be flipped.
 *
 * PNG entries are legal from Vista on, but only at 256; below that some
 * consumers — including the resource editor NSIS uses — still expect a DIB.
 */
function dib(image, size) {
  const bitmap = image.toBitmap()
  const stride = size * 4
  const xor = Buffer.alloc(stride * size)
  for (let row = 0; row < size; row++) {
    bitmap.copy(xor, row * stride, (size - 1 - row) * stride, (size - row) * stride)
  }
  // 1bpp, rows padded to 4 bytes. Left at zero: the alpha channel above carries
  // the transparency, and every modern consumer reads it.
  const maskStride = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskStride * size)

  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(xor.length + mask.length, 20)
  return Buffer.concat([header, xor, mask])
}

function ico(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = header.length + directory.length
  entries.forEach((entry, i) => {
    const at = i * 16
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at) // 0 means 256
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at + 1)
    directory.writeUInt8(0, at + 2) // palette size, 0 for true colour
    directory.writeUInt8(0, at + 3)
    directory.writeUInt16LE(1, at + 4) // planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(entry.data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.data.length
  })

  return Buffer.concat([header, directory, ...entries.map((e) => e.data)])
}

/**
 * ICNS is `icns` + total length, then a flat list of type/length/PNG chunks.
 * The types are Apple's: icp4/icp5 are the 1x 16 and 32, ic07-ic10 the 1x
 * 128-1024, and ic11-ic14 the @2x variants — which get the artwork drawn at
 * their real pixel size rather than an upscale of the 1x.
 */
function icns(chunks) {
  const body = Buffer.concat(
    chunks.map(({ type, data }) => {
      const head = Buffer.alloc(8)
      head.write(type, 0, 4, 'ascii')
      head.writeUInt32BE(data.length + 8, 4)
      return Buffer.concat([head, data])
    })
  )
  const head = Buffer.alloc(8)
  head.write('icns', 0, 4, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

const WINDOWS_SIZES = [16, 24, 32, 48, 64, 128, 256]
/** type -> the pixel size its artwork is drawn at. */
const MAC_CHUNKS = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32], // 16@2x
  ['ic12', 64], // 32@2x
  ['ic07', 128],
  ['ic13', 256], // 128@2x
  ['ic08', 256],
  ['ic14', 512], // 256@2x
  ['ic09', 512],
  ['ic10', 1024] // 512@2x
]

async function main() {
  await app.whenReady()
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

  const win = new BrowserWindow({
    width: 1200,
    height: 1200,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
  })

  const cache = new Map()
  const at = async (size, shape) => {
    const key = `${shape}:${size}`
    if (!cache.has(key)) cache.set(key, await render(win, size, shape))
    return cache.get(key)
  }

  const winEntries = []
  for (const size of WINDOWS_SIZES) {
    const image = await at(size, 'square')
    winEntries.push({ size, data: size === 256 ? image.toPNG() : dib(image, size) })
  }
  writeFileSync(join(OUT, 'icon.ico'), ico(winEntries))

  const macChunks = []
  for (const [type, size] of MAC_CHUNKS) {
    macChunks.push({ type, data: (await at(size, 'squircle')).toPNG() })
  }
  writeFileSync(join(OUT, 'icon.icns'), icns(macChunks))

  // Linux, and the dev-mode window/taskbar icon on Windows — see createWindow.
  writeFileSync(join(OUT, 'icon.png'), (await at(512, 'square')).toPNG())

  // Not consumed by anything — it is the artwork in a form a human can open,
  // so a change to `svg()` can be reviewed without a hex editor.
  writeFileSync(join(OUT, 'icon.svg'), svg(1024, 'squircle'))

  console.log(`icons written to ${OUT}`)
  win.destroy()
  app.exit(0)
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})

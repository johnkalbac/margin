/**
 * A GIF89a encoder, in plain JavaScript.
 *
 * `npm run demo` needs one and the repository has no image dependency to lean
 * on: plan §1 rules out native modules, ffmpeg is not a build requirement on
 * either supported platform, and a single-use encoder is smaller than the
 * argument for adding either. So the pixels come out of Electron and the file
 * is written here.
 *
 * Two passes, because a shared palette is what makes the file small:
 *
 *   1. `quantize` walks every frame once and median-cuts the colours it saw
 *      into one global table. A screenshot of Margin is nearly monochrome — a
 *      neutral ladder plus antialiasing — so 255 entries land close to exact
 *      and no dithering is needed. Dithering would also be actively harmful
 *      here: it scatters noise across flat regions, and flat regions are what
 *      the delta encoding below depends on.
 *
 *   2. `encode` maps each frame through that table and writes only the
 *      bounding box of what changed, with unchanged pixels inside the box left
 *      transparent over the frame beneath. A run that types one character at a
 *      time is then a few hundred bytes per frame instead of tens of thousands.
 *
 * Frames arrive as BGRA, which is what Electron's `nativeImage.toBitmap()`
 * hands back on a little-endian machine. The alpha channel is ignored: a GIF
 * has one transparent index and this encoder spends it on the delta above.
 */

/**
 * The palette index reserved for "unchanged since the last frame".
 *
 * Holding it back costs one colour out of 256 and is what lets every frame
 * after the first carry only its differences.
 */
const TRANSPARENT = 255

/** Pack a colour the way the histogram and lookup tables key on it. */
function packed(r, g, b) {
  return (r << 16) | (g << 8) | b
}

/**
 * Build one global palette for every frame, plus the lookup that maps a colour
 * to its index.
 *
 * `frames` is walked exactly once, so it may be a generator that reads the
 * capture back off disk rather than an array holding half a gigabyte of pixels.
 *
 * The returned `lookup` is indexed by packed RGB and is exact for every colour
 * that appeared: median cut assigns each colour to a box, and each box is one
 * palette entry, so no nearest-colour search is needed at encode time. Colours
 * it never saw read back as -1, which `encode` resolves the slow way.
 */
export function quantize(frames, { colors = 255 } = {}) {
  // 64MB, and the largest allocation in a demo run. It is reused as the lookup
  // table at the end rather than freed and reallocated.
  const counts = new Int32Array(1 << 24)
  for (const data of frames) {
    for (let i = 0; i < data.length; i += 4) {
      counts[packed(data[i + 2], data[i + 1], data[i])]++
    }
  }

  let seen = 0
  for (let key = 0; key < counts.length; key++) if (counts[key] > 0) seen++
  const keys = new Uint32Array(seen)
  let at = 0
  for (let key = 0; key < counts.length; key++) if (counts[key] > 0) keys[at++] = key

  /** Measure a half-open range of `keys`: extent per channel, and pixel count. */
  const measure = (lo, hi) => {
    let rLo = 255, rHi = 0, gLo = 255, gHi = 0, bLo = 255, bHi = 0, count = 0
    for (let i = lo; i < hi; i++) {
      const key = keys[i]
      const r = (key >> 16) & 255, g = (key >> 8) & 255, b = key & 255
      if (r < rLo) rLo = r
      if (r > rHi) rHi = r
      if (g < gLo) gLo = g
      if (g > gHi) gHi = g
      if (b < bLo) bLo = b
      if (b > bHi) bHi = b
      count += counts[key]
    }
    const spread = Math.max(rHi - rLo, gHi - gLo, bHi - bLo)
    // The widest channel, as a shift: red is 16, green 8, blue 0.
    const shift = rHi - rLo === spread ? 16 : gHi - gLo === spread ? 8 : 0
    // Splitting is worth most where the most pixels sit and the colours are
    // furthest apart. A flat region collapses to spread 0 once it has an entry
    // of its own, which is exactly when it should stop attracting more.
    return { lo, hi, count, spread, shift, priority: count * spread }
  }

  const boxes = [measure(0, seen)]
  while (boxes.length < colors) {
    let pick = -1
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].hi - boxes[i].lo < 2 || boxes[i].spread === 0) continue
      if (pick === -1 || boxes[i].priority > boxes[pick].priority) pick = i
    }
    if (pick === -1) break

    const box = boxes[pick]
    const shift = box.shift
    // subarray shares the buffer, so this sorts the range in place.
    keys.subarray(box.lo, box.hi).sort((a, b) => ((a >> shift) & 255) - ((b >> shift) & 255))

    // Split at the pixel-weighted median rather than the midpoint of the range:
    // the point is to halve how many pixels each side answers for.
    let acc = 0
    let mid = box.lo + 1
    for (let i = box.lo; i < box.hi; i++) {
      acc += counts[keys[i]]
      if (acc * 2 >= box.count) {
        mid = i + 1
        break
      }
    }
    if (mid <= box.lo) mid = box.lo + 1
    if (mid >= box.hi) mid = box.hi - 1

    boxes.splice(pick, 1, measure(box.lo, mid), measure(mid, box.hi))
  }

  const palette = new Uint8Array(256 * 3)
  for (let i = 0; i < boxes.length; i++) {
    let r = 0, g = 0, b = 0, weight = 0
    for (let k = boxes[i].lo; k < boxes[i].hi; k++) {
      const key = keys[k]
      const n = counts[key]
      r += ((key >> 16) & 255) * n
      g += ((key >> 8) & 255) * n
      b += (key & 255) * n
      weight += n
    }
    palette[i * 3] = Math.round(r / weight)
    palette[i * 3 + 1] = Math.round(g / weight)
    palette[i * 3 + 2] = Math.round(b / weight)
  }

  // Repurpose the histogram in place. -1 marks a colour this pass never saw,
  // which only a caller encoding frames it did not quantize can hit.
  counts.fill(-1)
  for (let i = 0; i < boxes.length; i++) {
    for (let k = boxes[i].lo; k < boxes[i].hi; k++) counts[keys[k]] = i
  }
  return { palette, lookup: counts, colors: boxes.length }
}

/** Collect bytes into GIF sub-blocks: a length byte, then up to 255 bytes. */
class Blocks {
  constructor() {
    this.chunks = []
    this.buf = Buffer.alloc(255)
    this.at = 0
  }

  push(byte) {
    this.buf[this.at++] = byte
    if (this.at === 255) {
      this.chunks.push(Buffer.from([255]), this.buf)
      this.buf = Buffer.alloc(255)
      this.at = 0
    }
  }

  end() {
    if (this.at > 0) this.chunks.push(Buffer.from([this.at]), this.buf.subarray(0, this.at))
    this.chunks.push(Buffer.from([0]))
    return Buffer.concat(this.chunks)
  }
}

/**
 * LZW-compress one frame's palette indices, GIF-style.
 *
 * Codes are packed least-significant-bit first and the code width grows as the
 * dictionary fills, resetting on a clear code at 4096. The dictionary is a flat
 * Int32Array keyed by `prefix << 8 | byte` rather than a Map, because this runs
 * over every pixel of every frame.
 */
function lzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  const dict = new Int32Array(1 << 20)
  dict.fill(-1)

  const blocks = new Blocks()
  let shift = 0
  let hold = 0
  const emit = (code, codeWidth) => {
    hold |= code << shift
    shift += codeWidth
    while (shift >= 8) {
      blocks.push(hold & 255)
      hold >>>= 8
      shift -= 8
    }
  }

  let width = minCodeSize + 1
  let next = eoi + 1
  emit(clear, width)

  let prefix = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]
    const key = (prefix << 8) | k
    const found = dict[key]
    if (found !== -1) {
      prefix = found
      continue
    }
    emit(prefix, width)
    if (next === 4096) {
      emit(clear, width)
      dict.fill(-1)
      next = eoi + 1
      width = minCodeSize + 1
    } else {
      if (next >= 1 << width) width++
      dict[key] = next++
    }
    prefix = k
  }
  emit(prefix, width)
  emit(eoi, width)
  if (shift > 0) blocks.push(hold & 255)
  return blocks.end()
}

function u16(value) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(value, 0)
  return b
}

/**
 * Write a GIF.
 *
 * `frames` is an iterable of `{ data, delayCs }`, where `data` is BGRA and
 * `delayCs` is the frame's duration in centiseconds — the only unit GIF has.
 * A frame identical to the one before it is dropped and its time handed to its
 * predecessor, so a driver may capture on a fixed clock without paying for the
 * stretches where nothing moved.
 */
export function encode({ width, height, palette, lookup, frames, loop = 0 }) {
  const out = [
    Buffer.from('GIF89a', 'ascii'),
    u16(width),
    u16(height),
    // Global table present, 8-bit colour resolution, 256 entries.
    Buffer.from([0xf7, 0, 0]),
    Buffer.from(palette),
    // NETSCAPE2.0, the de facto loop extension. 0 means forever.
    Buffer.concat([
      Buffer.from([0x21, 0xff, 0x0b]),
      Buffer.from('NETSCAPE2.0', 'ascii'),
      Buffer.from([0x03, 0x01]),
      u16(loop),
      Buffer.from([0x00])
    ])
  ]

  const pixels = width * height
  const previous = new Uint8Array(pixels)
  const current = new Uint8Array(pixels)
  let lastGce = null
  let written = 0

  for (const frame of frames) {
    const { data } = frame
    const delayCs = Math.max(2, Math.round(frame.delayCs))

    for (let p = 0, i = 0; p < pixels; p++, i += 4) {
      const key = packed(data[i + 2], data[i + 1], data[i])
      let index = lookup[key]
      if (index < 0) {
        // A colour the quantize pass never saw. The nearest entry wins, and it
        // is remembered so the next pixel like it is a lookup again.
        let best = 0
        let bestDistance = Infinity
        for (let c = 0; c < 255; c++) {
          const dr = ((key >> 16) & 255) - palette[c * 3]
          const dg = ((key >> 8) & 255) - palette[c * 3 + 1]
          const db = (key & 255) - palette[c * 3 + 2]
          const distance = dr * dr + dg * dg + db * db
          if (distance < bestDistance) {
            bestDistance = distance
            best = c
          }
        }
        lookup[key] = best
        index = best
      }
      current[p] = index
    }

    // What actually moved. The first frame is the whole canvas by definition.
    let left = 0
    let top = 0
    let right = width
    let bottom = height
    if (written > 0) {
      left = width
      top = height
      right = -1
      bottom = -1
      for (let y = 0; y < height; y++) {
        const row = y * width
        for (let x = 0; x < width; x++) {
          if (current[row + x] === previous[row + x]) continue
          if (x < left) left = x
          if (x >= right) right = x + 1
          if (y < top) top = y
          if (y >= bottom) bottom = y + 1
        }
      }
      if (right < 0) {
        // Nothing changed: give this frame's time to the one already written.
        if (lastGce) lastGce.writeUInt16LE(Math.min(65535, lastGce.readUInt16LE(4) + delayCs), 4)
        continue
      }
    }

    const boxWidth = right - left
    const boxHeight = bottom - top
    const box = new Uint8Array(boxWidth * boxHeight)
    for (let y = 0; y < boxHeight; y++) {
      const from = (top + y) * width + left
      const to = y * boxWidth
      for (let x = 0; x < boxWidth; x++) {
        const index = current[from + x]
        box[to + x] = written > 0 && index === previous[from + x] ? TRANSPARENT : index
      }
    }

    // Disposal 1 ("leave it there") is what the transparent pixels above show
    // through to, so every frame is a patch on the one before it.
    const gce = Buffer.from([0x21, 0xf9, 0x04, written > 0 ? 0x05 : 0x04, 0, 0, TRANSPARENT, 0x00])
    gce.writeUInt16LE(delayCs, 4)
    lastGce = gce
    out.push(
      gce,
      Buffer.concat([
        Buffer.from([0x2c]),
        u16(left),
        u16(top),
        u16(boxWidth),
        u16(boxHeight),
        Buffer.from([0x00, 0x08])
      ]),
      lzw(box, 8)
    )

    previous.set(current)
    written++
  }

  out.push(Buffer.from([0x3b]))
  return Buffer.concat(out)
}

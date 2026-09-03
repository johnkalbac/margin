import iconv from 'iconv-lite'
import jschardet from 'jschardet'

import {
  DEFAULT_ENCODING,
  ICONV_NAMES,
  MIN_CONFIDENCE,
  bomFor,
  fromDetectorName,
  type Encoding
} from './encoding'

/**
 * Byte-level decoding and encoding (plan §6).
 *
 * Node-only: it needs `Buffer`, `iconv-lite` and `jschardet`. Nothing in the
 * renderer may import this module — the identifiers and labels it shares with
 * the UI live in `encoding.ts`, which has no dependencies. It imports nothing
 * from Electron, so it is testable in a plain Node process (§12).
 *
 * The invariant this file exists to hold: for every supported encoding,
 * `encode(decode(bytes, e), e)` returns the original bytes. The round-trip
 * suite in tests/core/codec.test.ts asserts exactly that, because a lost byte
 * here shows up in Phase 6 as a diff where nothing changed.
 */

/** The detector reads only the head of the file, per §6. */
const DETECT_WINDOW_BYTES = 64 * 1024

export type DetectionSource = 'bom' | 'detected' | 'default'

export interface EncodingDetection {
  encoding: Encoding
  /**
   * How the answer was reached. `bom` is certain; `detected` is a guess worth
   * showing; `default` means nothing useful came back and UTF-8 was assumed.
   */
  source: DetectionSource
  /** 1 for a BOM, the detector's own score otherwise. */
  confidence: number
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false
  }
  return true
}

/**
 * A BOM is the only evidence that identifies UTF-16 here.
 *
 * Detectors do guess UTF-16 for BOM-less files, but unreliably — the same byte
 * pattern is common in binaries — and acting on that guess would add a BOM on
 * the next write to a file that never had one. Refusing to guess keeps the
 * round trip byte-identical, which matters more than opening an unusual file
 * correctly on the first try; "Reopen with encoding…" covers that case.
 */
export function detectBom(bytes: Uint8Array): Encoding | null {
  // UTF-8's three-byte mark is tested before the two-byte UTF-16 marks; they do
  // not overlap, but the longer prefix is the safer order to establish.
  for (const encoding of ['utf8bom', 'utf16le', 'utf16be'] as const) {
    if (startsWith(bytes, bomFor(encoding))) return encoding
  }
  return null
}

/** Detect the encoding of a file's bytes: BOM first, then the detector. */
export function detectEncoding(bytes: Uint8Array): EncodingDetection {
  const bom = detectBom(bytes)
  if (bom) return { encoding: bom, source: 'bom', confidence: 1 }

  // An empty file carries no evidence at all; UTF-8 is the sane assumption and
  // writes back as zero bytes regardless.
  if (bytes.length === 0) {
    return { encoding: DEFAULT_ENCODING, source: 'default', confidence: 0 }
  }

  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, DETECT_WINDOW_BYTES))

  let guess: { encoding?: string; confidence?: number } | null = null
  try {
    guess = jschardet.detect(head)
  } catch {
    // A detector throwing is not a reason to fail the open.
    guess = null
  }

  const confidence = guess?.confidence ?? 0
  const mapped = fromDetectorName(guess?.encoding)

  if (mapped && confidence >= MIN_CONFIDENCE) {
    return { encoding: mapped, source: 'detected', confidence }
  }
  return { encoding: DEFAULT_ENCODING, source: 'default', confidence }
}

/** Decode bytes, dropping the BOM the encoding implies. */
export function decode(bytes: Uint8Array, encoding: Encoding): string {
  const bom = bomFor(encoding)
  const body =
    bom.length > 0 && startsWith(bytes, bom)
      ? bytes.subarray(bom.length)
      : bytes

  const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  // stripBOM is off because the BOM was already removed above, and leaving both
  // in play would silently eat a real U+FEFF from the middle of a document.
  return iconv.decode(buffer, ICONV_NAMES[encoding], { stripBOM: false })
}

/** Encode text, prepending the BOM the encoding implies. */
export function encode(text: string, encoding: Encoding): Buffer {
  const body = iconv.encode(text, ICONV_NAMES[encoding], { addBOM: false })
  const bom = bomFor(encoding)
  return bom.length > 0 ? Buffer.concat([Buffer.from(bom), body]) : body
}

/**
 * Encoding identifiers, labels, and byte-order marks (plan §6).
 *
 * This module is deliberately dependency-free. The renderer imports `Encoding`
 * and `ENCODING_LABELS` (through @shared/types) to draw the status bar, and a
 * renderer bundle must not drag `iconv-lite`, `jschardet` or `Buffer` in behind
 * them. The actual decoding lives next door in `codec.ts`, which is Node-only
 * and imported by the main process alone.
 */

/**
 * Encodings supported on read and write. Fixed as a closed set so `DocMeta` does
 * not change shape later.
 *
 * BOM presence is carried by the identifier rather than by a separate flag:
 * `utf8` and `utf8bom` are distinct, and the two UTF-16 encodings always imply a
 * BOM because that is the only way `codec.ts` will identify them (see
 * `detectEncoding`). That keeps a read/write cycle byte-identical without adding
 * a field to `DocMeta`.
 */
export type Encoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'windows1252' | 'iso88591'

export const ENCODINGS: readonly Encoding[] = [
  'utf8',
  'utf8bom',
  'utf16le',
  'utf16be',
  'windows1252',
  'iso88591'
]

/** Status bar and picker labels. */
export const ENCODING_LABELS: Record<Encoding, string> = {
  utf8: 'UTF-8',
  utf8bom: 'UTF-8 BOM',
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE',
  windows1252: 'Windows-1252',
  iso88591: 'ISO-8859-1'
}

/** The encoding a new, never-saved document is written in (plan §6). */
export const DEFAULT_ENCODING: Encoding = 'utf8'

/** iconv-lite's name for each identifier. */
export const ICONV_NAMES: Record<Encoding, string> = {
  utf8: 'utf8',
  utf8bom: 'utf8',
  utf16le: 'utf16-le',
  utf16be: 'utf16-be',
  windows1252: 'windows-1252',
  iso88591: 'iso-8859-1'
}

/** Byte-order marks, by the encoding that carries one. */
export const BOM_BYTES: Partial<Record<Encoding, readonly number[]>> = {
  utf8bom: [0xef, 0xbb, 0xbf],
  utf16le: [0xff, 0xfe],
  utf16be: [0xfe, 0xff]
}

export function bomFor(encoding: Encoding): readonly number[] {
  return BOM_BYTES[encoding] ?? []
}

export function isEncoding(value: unknown): value is Encoding {
  return typeof value === 'string' && (ENCODINGS as readonly string[]).includes(value)
}

/**
 * Below this, a detector result is not worth acting on and UTF-8 is assumed.
 * Detection is a convenience; the manual override is the actual feature (§6).
 */
export const MIN_CONFIDENCE = 0.5

/**
 * Map a detector's encoding name onto the supported set. Pure string work, kept
 * here so it is testable without loading a detector.
 *
 * Returns null when the name is outside the set, which the caller treats as
 * "no useful guess" rather than as an error.
 */
export function fromDetectorName(name: string | null | undefined): Encoding | null {
  if (!name) return null
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '')

  switch (normalized) {
    case 'utf8':
      return 'utf8'
    // ASCII is a UTF-8 subset; decoding it as UTF-8 is byte-identical.
    case 'ascii':
    case 'usascii':
      return 'utf8'
    case 'windows1252':
    case 'cp1252':
      return 'windows1252'
    case 'iso88591':
    case 'latin1':
      return 'iso88591'
    default:
      // Other single-byte western guesses (ISO-8859-2, MacRoman, …) are outside
      // the supported set. Windows-1252 is the closest superset for the bytes a
      // Markdown file is likely to hold, and beats failing the open.
      if (normalized.startsWith('iso8859') || normalized.startsWith('windows12')) {
        return 'windows1252'
      }
      return null
  }
}

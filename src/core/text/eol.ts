/**
 * Line-ending detection and application (plan §6).
 *
 * CodeMirror normalizes every line break to `\n` internally, so the editor
 * document is never the authority on line endings. `DocMeta.eol` is — it is
 * detected once on read and applied once on write. Getting this wrong makes
 * every diff in the compare phase show every line as changed.
 */

export type Eol = 'LF' | 'CRLF'

export const EOL_SEQUENCE: Record<Eol, string> = {
  LF: '\n',
  CRLF: '\r\n'
}

export interface EolDetection {
  eol: Eol
  /** True when the file contains both styles. The majority wins; the status bar flags it. */
  mixed: boolean
  crlf: number
  lf: number
}

/**
 * Detect the dominant line ending. A file with no line break at all is reported
 * as LF with zero counts; callers that care (new files) should use
 * `platformEol` instead of trusting that default.
 */
export function detectEol(text: string): EolDetection {
  let crlf = 0
  let lf = 0

  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue // '\n'
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++ // preceded by '\r'
    else lf++
  }

  return {
    // Ties go to LF: a file with equal counts is already inconsistent, and LF is
    // the normalized form we hold in memory.
    eol: crlf > lf ? 'CRLF' : 'LF',
    mixed: crlf > 0 && lf > 0,
    crlf,
    lf
  }
}

/** Collapse every line-ending style to `\n` for the in-memory buffer. */
export function normalizeToLf(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * Apply a line-ending style on write. Input is normalized first so that a buffer
 * that somehow carries stray `\r` still produces a consistent file.
 */
export function applyEol(text: string, eol: Eol): string {
  const normalized = normalizeToLf(text)
  return eol === 'CRLF' ? normalized.replace(/\n/g, '\r\n') : normalized
}

/** Line ending for new documents. Pure — the platform is passed in, not read. */
export function platformEol(platform: NodeJS.Platform | string): Eol {
  return platform === 'win32' ? 'CRLF' : 'LF'
}

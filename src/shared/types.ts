import type { Flavor } from '@core/markdown/flavors'
import type { Eol } from '@core/text/eol'
import type { Encoding } from '@core/text/encoding'

export type { Flavor, Eol, Encoding }

/**
 * Re-exported from core so the status bar can label an encoding without
 * importing the codec. `@core/text/encoding` is dependency-free for exactly
 * this reason; the Buffer work lives in `@core/text/codec`, which the renderer
 * must never reach (plan §6).
 */
export { ENCODING_LABELS, ENCODINGS, DEFAULT_ENCODING } from '@core/text/encoding'

export type DocId = string

/**
 * Authoritative document state. Owned by the main process from Phase 2 onward;
 * in Phase 1 the renderer holds the single untitled document itself.
 */
export interface DocMeta {
  id: DocId
  /** Absolute path on disk, or null for an untitled document. */
  path: string | null
  /** Display name — the basename, or 'Untitled'. */
  name: string
  dirty: boolean
  encoding: Encoding
  eol: Eol
  /** True when the file mixed line endings on read; the majority was taken. */
  mixedEol: boolean
  flavor: Flavor
  /** Monotonic per-document counter, incremented on every change event. */
  version: number
}

/** Light and dark only. A third `system` value fits here without a migration (plan §4.4). */
export type ThemeMode = 'light' | 'dark'

/** Which pane is maximized. `split` is the default and the resting state. */
export type PaneFocus = 'split' | 'editor' | 'preview'

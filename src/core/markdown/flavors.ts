/**
 * Markdown flavors (plan §3).
 *
 * Flavor is a *rendering* concern only. Switching flavor never modifies the
 * buffer, and the CodeMirror/Lezer syntax highlighting is deliberately not kept
 * in sync with it — the two parsers disagree at the edges and only the preview
 * is authoritative.
 */

export type Flavor = 'commonmark' | 'gfm' | 'gfm-extras'

export const FLAVORS: readonly Flavor[] = ['commonmark', 'gfm', 'gfm-extras'] as const

export const FLAVOR_LABELS: Record<Flavor, string> = {
  commonmark: 'CommonMark',
  gfm: 'GFM',
  'gfm-extras': 'GFM + extras'
}

export const DEFAULT_FLAVOR: Flavor = 'gfm'

export function isFlavor(value: unknown): value is Flavor {
  return typeof value === 'string' && (FLAVORS as readonly string[]).includes(value)
}

export function flavorLabel(flavor: Flavor): string {
  return FLAVOR_LABELS[flavor]
}

/** Cycle order for the status-bar click target and the palette command. */
export function nextFlavor(flavor: Flavor): Flavor {
  const i = FLAVORS.indexOf(flavor)
  return FLAVORS[(i + 1) % FLAVORS.length]!
}

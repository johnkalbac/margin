export {
  FLAVORS,
  FLAVOR_LABELS,
  DEFAULT_FLAVOR,
  flavorLabel,
  isFlavor,
  nextFlavor,
  type Flavor
} from './flavors'
export { renderMarkdown, parserFor } from './render'
export { sanitizeHtml, createSanitizer } from './sanitize'
export { SOURCE_LINE_ATTR, sourceLinePlugin } from './sourceLine'

import { renderMarkdown } from './render'
import { sanitizeHtml } from './sanitize'
import type { Flavor } from './flavors'

/**
 * The only pairing the preview should use: render, then sanitize. Calling
 * `renderMarkdown` alone yields unsanitized HTML.
 */
export function renderAndSanitize(source: string, flavor: Flavor): string {
  return sanitizeHtml(renderMarkdown(source, flavor))
}

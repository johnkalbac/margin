import type { MarkdownIt } from 'markdown-it'

/**
 * Annotate rendered block elements with the source line they came from.
 *
 * This is what makes scroll sync correct (plan §4.2). Percentage-of-height sync
 * is visibly wrong the moment a document contains an image or a code block,
 * because equal source spans do not occupy equal rendered height. markdown-it
 * hands us `token.map` — a `[startLine, endLine)` pair, zero-based — for every
 * block token, so the preview can carry the mapping in the DOM and the sync code
 * can interpolate between real anchors.
 *
 * Emitted as 1-based to match everything the user sees (status bar, gutter).
 */

/** Block tokens rendered through the generic `renderToken` path. */
const TOKEN_RULES = [
  'paragraph_open',
  'heading_open',
  'blockquote_open',
  'bullet_list_open',
  'ordered_list_open',
  'list_item_open',
  'table_open',
  'dl_open',
  'hr'
]

/**
 * Tokens with bespoke renderers that build their own markup string. These do not
 * reliably emit `token.attrs`, so the attribute is injected into the opening tag
 * of the returned HTML instead.
 */
const HTML_RULES = ['fence', 'code_block']

export const SOURCE_LINE_ATTR = 'data-source-line'

export function sourceLinePlugin(md: MarkdownIt): void {
  for (const rule of TOKEN_RULES) {
    const original = md.renderer.rules[rule]
    md.renderer.rules[rule] = (tokens, idx, options, env, self) => {
      const token = tokens[idx]
      if (token?.map) token.attrSet(SOURCE_LINE_ATTR, String(token.map[0] + 1))
      return original
        ? original(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options)
    }
  }

  for (const rule of HTML_RULES) {
    const original = md.renderer.rules[rule]
    md.renderer.rules[rule] = (tokens, idx, options, env, self) => {
      const token = tokens[idx]
      const html = original
        ? original(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options)
      if (!token?.map) return html
      const line = token.map[0] + 1
      // Inject into the first tag only; the value is a number we produced.
      return html.replace(/^(\s*<\w+)/, `$1 ${SOURCE_LINE_ATTR}="${line}"`)
    }
  }
}

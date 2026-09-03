import MarkdownItCallable from 'markdown-it'
import type { MarkdownIt } from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import footnote from 'markdown-it-footnote'
import deflist from 'markdown-it-deflist'
import attrs from 'markdown-it-attrs'

import { sourceLinePlugin } from './sourceLine'
import type { Flavor } from './flavors'

/**
 * The render half of the preview pipeline (plan §3).
 *
 * Output of this module is NOT safe to insert into the DOM. Markdown files are
 * untrusted input (plan §10); every string that leaves here goes through
 * `sanitizeHtml` first. `renderAndSanitize` in ./index.ts is the only pairing
 * callers should use.
 */

function build(flavor: Flavor): MarkdownIt {
  switch (flavor) {
    case 'commonmark': {
      // The commonmark preset turns `html` on; the second argument overrides it.
      // Raw HTML stays off in every flavor — see plan §10.
      return new MarkdownItCallable('commonmark', { html: false })
    }

    case 'gfm': {
      // The default preset already carries tables and strikethrough.
      // `linkify` supplies GFM autolinking.
      return new MarkdownItCallable('default', { html: false, linkify: true, typographer: false }).use(
        taskLists,
        { label: true }
      )
    }

    case 'gfm-extras': {
      return new MarkdownItCallable('default', { html: false, linkify: true, typographer: false })
        .use(taskLists, { label: true })
        .use(footnote)
        .use(deflist)
        // markdown-it-attrs lets the document set arbitrary attributes. That is
        // the point of the plugin, and it is why the DOMPurify pass downstream is
        // not optional: event-handler and style attributes are stripped there.
        .use(attrs)
    }
  }
}

/** markdown-it instances are stateless between renders, so one per flavor is enough. */
const instances = new Map<Flavor, MarkdownIt>()

export function parserFor(flavor: Flavor): MarkdownIt {
  let md = instances.get(flavor)
  if (!md) {
    md = build(flavor)
    md.use(sourceLinePlugin)
    instances.set(flavor, md)
  }
  return md
}

/**
 * Render Markdown to HTML. The result is unsanitized — do not insert it into a
 * document without passing it through `sanitizeHtml`.
 */
export function renderMarkdown(source: string, flavor: Flavor): string {
  return parserFor(flavor).render(source)
}

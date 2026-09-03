import createDOMPurify, {
  type Config,
  type DOMPurify as DOMPurifyInstance,
  type WindowLike
} from 'dompurify'

/**
 * Preview sanitization (plan §10). Markdown files are untrusted input.
 *
 * Nothing renders into the preview without passing through here. `html: false`
 * in markdown-it already keeps raw HTML out of the token stream, but that is one
 * setting away from being wrong, and markdown-it-attrs (the `gfm-extras` flavor)
 * deliberately lets a document set arbitrary attributes. This pass is the
 * boundary that holds regardless.
 */

const SANITIZE_CONFIG: Config = {
  // Restrict to the HTML profile — Markdown never legitimately produces SVG or
  // MathML, and both carry their own script-execution surfaces.
  USE_PROFILES: { html: true },

  FORBID_TAGS: [
    'style',
    'script',
    'iframe',
    'object',
    'embed',
    'form',
    // `input` is NOT forbidden outright: markdown-it emits one per GFM task-list
    // item. The hook below deletes every input that is not such a checkbox.
    'button',
    'textarea',
    'select',
    'link',
    'meta',
    'base'
  ],

  // markdown-it-attrs would otherwise let a document inject arbitrary CSS,
  // including position/opacity tricks that overlay app chrome.
  FORBID_ATTR: ['style'],

  // data-source-line drives scroll sync and must survive sanitization.
  ALLOW_DATA_ATTR: true
}

/** Task-list checkboxes are the one input markdown-it emits; re-allow them, disabled. */
const TASK_LIST_INPUT = /^checkbox$/i

function applyHooks(purifier: DOMPurifyInstance): DOMPurifyInstance {
  purifier.addHook('afterSanitizeAttributes', (node) => {
    const el = node as unknown as {
      tagName?: string
      getAttribute(name: string): string | null
      setAttribute(name: string, value: string): void
      removeAttribute(name: string): void
      remove(): void
    }

    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? ''
      // Clicks are intercepted in the preview and routed to the OS browser via
      // IPC; rel is defence in depth for anything that slips past that handler.
      if (/^https?:/i.test(href)) el.setAttribute('rel', 'noopener noreferrer')
    }

    if (el.tagName === 'INPUT') {
      const type = el.getAttribute('type') ?? ''
      if (!TASK_LIST_INPUT.test(type)) {
        // Anything other than a task-list checkbox is a control surface a
        // document has no business creating.
        el.remove()
        return
      }
      // Rendered task lists are a view of the source, not a control surface.
      // Toggling one would have to edit the buffer; that is not a v1 feature.
      el.setAttribute('disabled', '')
    }
  })

  return purifier
}

let cached: DOMPurifyInstance | null = null

/** Explicit construction, for tests and for any non-`window` document root. */
export function createSanitizer(root: WindowLike): DOMPurifyInstance {
  return applyHooks(createDOMPurify(root))
}

function sanitizer(): DOMPurifyInstance {
  if (cached) return cached
  const root = (globalThis as { window?: WindowLike }).window
  if (!root) {
    throw new Error(
      'sanitizeHtml requires a DOM. In tests, add `// @vitest-environment jsdom` to the file.'
    )
  }
  cached = createSanitizer(root)
  return cached
}

export function sanitizeHtml(html: string): string {
  return sanitizer().sanitize(html, SANITIZE_CONFIG) as unknown as string
}

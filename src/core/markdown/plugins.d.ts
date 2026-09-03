/**
 * Minimal ambient declarations for the markdown-it plugins that ship no types.
 * Each is a plain `MarkdownIt.PluginWithOptions`-shaped function.
 */
declare module 'markdown-it-task-lists' {
  import type { MarkdownIt } from 'markdown-it'
  const plugin: (md: MarkdownIt, options?: { enabled?: boolean; label?: boolean }) => void
  export default plugin
}

declare module 'markdown-it-footnote' {
  import type { MarkdownIt } from 'markdown-it'
  const plugin: (md: MarkdownIt) => void
  export default plugin
}

declare module 'markdown-it-deflist' {
  import type { MarkdownIt } from 'markdown-it'
  const plugin: (md: MarkdownIt) => void
  export default plugin
}

declare module 'markdown-it-attrs' {
  import type { MarkdownIt } from 'markdown-it'
  const plugin: (md: MarkdownIt, options?: Record<string, unknown>) => void
  export default plugin
}

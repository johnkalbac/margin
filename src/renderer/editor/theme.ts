import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'
import type { ThemeMode } from '@shared/types'

/**
 * Editor appearance (plan §4.4, surface 2 of 3).
 *
 * Every colour resolves to a CSS custom property from tokens.css, so the editor
 * moves with the chrome and the preview instead of drifting from them. That also
 * means the light/dark swap is mostly a token swap rather than a second theme.
 */

const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--ink-soft)',
    backgroundColor: 'transparent',
    fontSize: 'var(--editor-font-size)'
  },

  '&.cm-focused': { outline: 'none' },

  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: 'var(--editor-line-height)',
    overflow: 'auto'
  },

  '.cm-content': {
    padding: '0',
    caretColor: 'var(--ink)'
  },

  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--ui-quiet)',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    paddingRight: '14px'
  },

  '.cm-lineNumbers .cm-gutterElement': { minWidth: '2ch' },

  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },

  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--stone)'
  },

  '.cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--editor-selection)'
  },

  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--editor-selection)'
  },

  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--ink)',
    borderLeftWidth: '1.5px'
  }
})

/**
 * Markdown syntax highlighting.
 *
 * The design system introduces no signal colours, so this whole style separates
 * tokens by VALUE and WEIGHT within the neutral ladder — never by hue. That
 * constraint suits a Markdown editor: the prose is the content, and syntax that
 * recedes tonally is easier to read past than syntax in six competing colours.
 */
const markdownHighlight = HighlightStyle.define([
  // Structural markers (`#`, `-`, `>`, `**`, backticks) recede to --slate while
  // the prose stays at full weight, so the source reads as text with the syntax
  // receding rather than as code with the text receding.
  { tag: tags.processingInstruction, color: 'var(--slate)' },
  { tag: tags.heading, color: 'var(--ink)', fontWeight: '600' },
  { tag: tags.heading1, color: 'var(--ink)', fontWeight: '600' },
  { tag: tags.strong, color: 'var(--ink)', fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--slate)' },
  { tag: tags.quote, color: 'var(--slate)' },
  { tag: tags.link, color: 'var(--ink-soft)' },
  { tag: tags.url, color: 'var(--slate)', textDecoration: 'underline' },
  { tag: tags.monospace, color: 'var(--ink-soft)' },
  { tag: tags.contentSeparator, color: 'var(--slate)' },
  { tag: tags.list, color: 'var(--slate)' },

  // Nested languages inside fenced code blocks (@codemirror/lang-markdown's
  // codeLanguages option). The design system introduces NO signal colours, so
  // these separate by value and weight within the neutral ladder rather than by
  // hue — which is also what keeps a fenced block from fighting the prose
  // around it for attention.
  { tag: tags.keyword, color: 'var(--ink)', fontWeight: '500' },
  { tag: tags.string, color: 'var(--graphite)' },
  { tag: tags.comment, color: 'var(--slate)', fontStyle: 'italic' },
  { tag: tags.number, color: 'var(--graphite)' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--ink)' },
  { tag: tags.typeName, color: 'var(--ink-soft)' },
  { tag: tags.propertyName, color: 'var(--graphite)' },
  // No red: an error is marked by a wavy underline, not by a signal colour.
  { tag: tags.invalid, color: 'var(--ink)', textDecoration: 'underline wavy var(--slate)' }
])

const highlight = syntaxHighlighting(markdownHighlight)

/**
 * Tells CodeMirror which way round the theme is.
 *
 * Every colour above is a CSS custom property, so `[data-theme='dark']` in
 * tokens.css repaints the editor without a second theme — that is the whole
 * reason §4.4 insisted on variables from Phase 1. What variables cannot carry is
 * the fact of darkness: CodeMirror keys its own defaults and its `&dark`
 * selectors off this facet, and its selection layer picks a blend mode from it.
 * Left unset, a dark editor gets light-mode selection compositing.
 */
const lightMarker = EditorView.theme({}, { dark: false })
const darkMarker = EditorView.theme({}, { dark: true })

const lightTheme: Extension = [baseTheme, highlight, lightMarker]
const darkTheme: Extension = [baseTheme, highlight, darkMarker]

/**
 * Extensions for a mode.
 *
 * Both modes share one base theme and one highlight style, because the palette
 * is token-driven and the neutral ladder inverts in tokens.css rather than here.
 * If the token approach ever proves insufficient, an editor-specific dark
 * override belongs behind this function and nowhere else.
 */
export function themeFor(mode: ThemeMode): Extension {
  return mode === 'dark' ? darkTheme : lightTheme
}

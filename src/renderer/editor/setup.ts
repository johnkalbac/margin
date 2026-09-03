import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'

import type { DocId, ThemeMode } from '@shared/types'
import { themeFor } from './theme'
import { compareCompartment, compareExtension } from './compare'

/**
 * Runtime theme switching requires a Compartment: extensions are immutable parts
 * of an EditorState, so the theme is swapped with a reconfigure effect rather
 * than by rebuilding state (plan §4.4).
 *
 * A compartment instance is per-state. With one view and N states (plan §11),
 * toggling the theme must reconfigure the *active* state AND the state factory
 * must build new and reactivated states with the current mode — which is why
 * `createEditorState` takes the mode rather than reading a module-level default.
 */
export const themeCompartment = new Compartment()

export interface EditorCallbacks {
  /**
   * Every document change. Wired to a no-op sink in Phase 1 and to
   * HistoryService in Phase 5 — but emitted from day one, because retrofitting
   * change capture is where this project would stall (plan §2).
   */
  onDocChanged(docId: DocId, changes: unknown, content: string): void
  /** Cursor and selection, for the status bar. Throttled by the caller. */
  onSelectionChanged(docId: DocId, position: CursorPosition): void
  /** Buffer content, for the preview. Debounced by the caller. */
  onContentChanged(docId: DocId, content: string): void
}

export interface CursorPosition {
  line: number
  column: number
  /** Characters selected across all ranges; 0 when the selection is empty. */
  selectionLength: number
}

export function cursorPositionOf(state: EditorState): CursorPosition {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  let selectionLength = 0
  for (const range of state.selection.ranges) selectionLength += range.to - range.from

  return {
    line: line.number,
    column: head - line.from + 1,
    selectionLength
  }
}

export interface CreateStateOptions {
  docId: DocId
  content: string
  mode: ThemeMode
  callbacks: EditorCallbacks
}

export function createEditorState({
  docId,
  content,
  mode,
  callbacks
}: CreateStateOptions): EditorState {
  const listener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      // ChangeSet.toJSON() is the journal patch format (plan §9): exact,
      // ordered, and rehydratable with ChangeSet.fromJSON().
      const content = update.state.doc.toString()
      // The journal needs the resulting buffer to snapshot without a round trip
      // back to the renderer (plan §9).
      callbacks.onDocChanged(docId, update.changes.toJSON(), content)
      callbacks.onContentChanged(docId, content)
    }
    if (update.docChanged || update.selectionSet) {
      callbacks.onSelectionChanged(docId, cursorPositionOf(update.state))
    }
  })

  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    rectangularSelection(),
    indentOnInput(),
    bracketMatching(),
    EditorState.allowMultipleSelections.of(true),

    // Mitigates, but does not eliminate, CodeMirror's weak spot with extremely
    // long single lines (plan §1.1).
    EditorView.lineWrapping,

    markdown({
      base: markdownLanguage,
      // Nested highlighting inside fenced code blocks. @codemirror/language-data
      // resolves these by dynamic import, so the grammars are lazy chunks and do
      // not weigh on the renderer bundle budget (plan §11).
      codeLanguages: languages
    }),

    /*
     * Find and replace (plan §5). @codemirror/search provides the panel, regex,
     * case sensitivity and whole-word matching; §5 says not to reimplement any
     * of it, and the palette and menu reach this same panel rather than a
     * parallel one.
     *
     * The panel sits at the top of the editor, over the document, because the
     * status bar below is chrome the design fixes in place.
     */
    search({ top: true }),
    highlightSelectionMatches(),

    themeCompartment.of(themeFor(mode)),

    /*
     * Compare is an extension in a compartment rather than a second view
     * (§13 Phase 6). Every state carries the compartment empty so entering
     * compare is a reconfigure of the live view — no view is constructed, and
     * the document's selection and scroll survive it.
     */
    compareCompartment.of(compareExtension(null)),

    // searchKeymap owns Mod-f and Mod-h. The catalog marks those commands
    // editorOwnedKey so the native menu displays the chord without registering
    // it, leaving exactly one handler (plan §7).
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),

    listener
  ]

  return EditorState.create({ doc: content, extensions })
}

/** Swap the theme on the live view without rebuilding its state. */
export function reconfigureTheme(view: EditorView, mode: ThemeMode): void {
  view.dispatch({ effects: themeCompartment.reconfigure(themeFor(mode)) })
}

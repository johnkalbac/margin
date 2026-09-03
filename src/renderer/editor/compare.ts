import { Compartment, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { unifiedMergeView } from '@codemirror/merge'

/**
 * Compare (plan §13 Phase 6).
 *
 * §13 asks for both options to be evaluated and one picked for v1. The choice is
 * `unifiedMergeView`, and the deciding argument is architectural rather than
 * aesthetic:
 *
 * **`MergeView` constructs two more `EditorView`s.** §11's first design
 * consequence is "One EditorView, N EditorStates — mounting a view per tab is
 * the single biggest memory mistake available here", and the per-tab budget is
 * 5MB. Side-by-side compare would mean either standing up two additional views
 * beside the one this app is built around, or tearing the main view down and
 * rebuilding it on exit, losing the scroll and selection state §11 goes out of
 * its way to preserve.
 *
 * **`unifiedMergeView` is an extension.** It composes into the view that already
 * exists, through the same compartment mechanism the theme uses (§4.4), so
 * entering and leaving compare is a reconfigure: no view is created, no state is
 * rebuilt, and the document's selection and scroll survive untouched.
 *
 * The cost is real and worth stating: an inline diff is harder to read than two
 * columns for a heavily rewritten file. §15 records the escape hatch — if this
 * proves inadequate, a Monaco `DiffEditor` mounted only for compare views is the
 * fallback, not a full editor swap.
 */
export const compareCompartment = new Compartment()

/**
 * Repaint the diff in the neutral ladder.
 *
 * `@codemirror/merge` ships a conventional diff palette — #ee4433 for deletions,
 * #22bb22 for insertions, #e43 and #2a2 in the gutter. The design system admits
 * **no signal colours at all**: no red, no green, no amber, anywhere. That is
 * the same rule that keeps a coloured save indicator out of the status bar and
 * separates syntax tokens by value and weight rather than hue.
 *
 * So the two sides are told apart the way the rest of the app tells state apart
 * — by weight, decoration and a rule:
 *
 *   · a **deletion** recedes to `--slate` and is struck through;
 *   · an **insertion** stays at full ink and is underlined;
 *   · changed lines carry a 1px `--ink` rule in the change gutter, and sit on
 *     `--hairline`, the system's featured infill.
 *
 * Every value is a custom property, so dark mode follows without a second theme.
 */
const neutralDiff = EditorView.theme({
  // Both sides sit on the same surface step; the distinction is not the ground.
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': {
    backgroundColor: 'var(--hairline)'
  },
  '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': {
    backgroundColor: 'var(--hairline)'
  },

  // Inline runs: a 2px rule under the text, in ink rather than in a hue.
  '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText': {
    background: 'none',
    textDecoration: 'line-through',
    textDecorationColor: 'var(--slate)',
    color: 'var(--slate)'
  },
  '&.cm-merge-b .cm-changedText': {
    background: 'none',
    textDecoration: 'underline',
    textDecorationThickness: '2px',
    textUnderlineOffset: '2px',
    textDecorationColor: 'var(--ink)'
  },
  '&.cm-merge-b .cm-deletedText': {
    background: 'var(--hairline)',
    color: 'var(--slate)',
    textDecoration: 'line-through'
  },

  // A removed line reads as removed from its copy, not from its colour.
  '.cm-deletedLine, .cm-deletedLine del': {
    color: 'var(--slate)',
    textDecoration: 'line-through'
  },
  '.cm-insertedLine': {
    textDecoration: 'none'
  },

  // The change gutter is a 1px rule — the system's other depth cue.
  '.cm-changeGutter': { width: '2px', paddingLeft: '1px' },
  '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': {
    background: 'var(--stone)'
  },
  '&.cm-merge-b .cm-changedLineGutter, .cm-insertedLineGutter': {
    background: 'var(--ink)'
  },

  '.cm-collapsedLines': {
    color: 'var(--ui-quiet)',
    background: 'var(--hairline)'
  }
})

export interface CompareSource {
  /** What the buffer is being compared against. */
  content: string
  /** Shown in the chrome so the user knows what "original" means here. */
  label: string
}

/**
 * The extension for a comparison, or nothing when compare is off.
 *
 * `mergeControls` is disabled: accepting or rejecting individual chunks is an
 * editing operation, and v1's compare is for reading. Rejecting a chunk would
 * also write through to the document, which is a surprising thing for a view
 * labelled "compare" to do.
 */
export function compareExtension(source: CompareSource | null): Extension {
  if (!source) return []
  return [
    unifiedMergeView({
      original: source.content,
      mergeControls: false,
      // Deletions are shown with the document's own syntax highlighting so a
      // removed heading still reads as a heading.
      syntaxHighlightDeletions: true,
      gutter: true
    }),
    // After the merge extension, so these rules win over its base theme.
    neutralDiff
  ]
}

/** Enter or leave compare on the live view, without rebuilding its state. */
export function reconfigureCompare(view: EditorView, source: CompareSource | null): void {
  view.dispatch({ effects: compareCompartment.reconfigure(compareExtension(source)) })
}

/**
 * Contents of the untitled document a new window opens with. Long enough to
 * exercise scroll sync and every block type the preview styles, short enough to
 * read.
 *
 * Phase 2 replaces this with a genuine empty untitled buffer once there is a way
 * to open a real file.
 */
export const WELCOME_DOCUMENT = `# Margin

Live two-panel Markdown. Type on the left; the preview keeps pace on the right.

## Panes

- Editor and preview, with a **draggable** divider between them
- Either pane maximizes with \`Cmd+Alt+1\` / \`Cmd+Alt+2\`, and the same chord returns to split
- Drag the divider past a pane's minimum and it snaps to focus
- Double-click the divider to restore 50/50

> Scroll sync maps source lines, not percentages. Scroll past the code block
> below and the two panes stay together — percentage sync would drift here,
> because equal spans of source do not occupy equal rendered height.

## Commands

Press \`Cmd+K\` for the command palette. Every action in the app resolves through
one registry, so the palette, the menu, and the keyboard can never disagree
about what a command does.

## Code

Fenced blocks highlight their nested language:

\`\`\`typescript
export function cursorPositionOf(state: EditorState): CursorPosition {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  return { line: line.number, column: head - line.from + 1 }
}
\`\`\`

\`\`\`python
def render(source: str, flavor: str) -> str:
    return sanitize(markdown(source, flavor))
\`\`\`

## Flavors

| Flavor | Adds |
| --- | --- |
| CommonMark | The baseline |
| GFM | Tables, task lists, strikethrough, autolinks |
| GFM + extras | Footnotes, definition lists, attributes |

Click the flavor in the footer to cycle it. Switching flavor changes only how the
document renders — it never touches the buffer.

- [x] Task lists render in GFM
- [ ] And stay in sync with the source

## What is not here yet

This is Phase 1: the shell. Opening and saving files, encodings, tabs, dark mode,
find and replace, edit history, and file comparison each land in a later phase.
`

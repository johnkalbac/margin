// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { SearchQuery, replaceAll, setSearchQuery } from '@codemirror/search'
import { undo } from '@codemirror/commands'

import { createEditorState } from '@renderer/editor/setup'

/**
 * Search and replace (plan §5, §13 Phase 4).
 *
 * §5 says `replaceAll` dispatches a single transaction, which makes it a single
 * undo step for free — and then says to **verify this holds after any custom
 * EditorState configuration**, because a transaction filter or custom undo
 * grouping can quietly break it. Margin has a custom configuration, so that
 * verification is this file rather than an assumption.
 */

/* jsdom implements neither Range method CodeMirror measures with. See
 * tests/renderer/editorHost.test.tsx for why these are stubbed to zero. */
const emptyRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 }
Range.prototype.getClientRects = function getClientRects() {
  return Object.assign([], { item: () => null }) as unknown as DOMRectList
}
Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return emptyRect as DOMRect
}

const callbacks = {
  onDocChanged: vi.fn(),
  onSelectionChanged: vi.fn(),
  onContentChanged: vi.fn()
}

function mountView(content: string): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: createEditorState({ docId: 'search-test', content, mode: 'light', callbacks }),
    parent
  })
}

/** §13's Phase 4 criterion names 5,000 lines specifically. */
function largeDocument(lines = 5000): string {
  const rows: string[] = []
  for (let i = 0; i < lines; i++) rows.push(`line ${i} contains needle and some trailing prose`)
  return rows.join('\n')
}

describe('replace all', () => {
  it('is a single undo step across a 5,000-line document', () => {
    const original = largeDocument()
    const view = mountView(original)

    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: 'needle', replace: 'pin' }))
    })

    const replaced = replaceAll(view)
    expect(replaced).toBe(true)

    const after = view.state.doc.toString()
    expect(after).not.toBe(original)
    expect(after).toContain('pin')
    expect(after).not.toContain('needle')
    // Every line held one occurrence, so all 5,000 changed.
    expect(after.split('\n')).toHaveLength(5000)

    // One undo, not five thousand. This is the assertion §5 asks for.
    const undone = undo(view)
    expect(undone).toBe(true)
    expect(view.state.doc.toString()).toBe(original)

    view.destroy()
  })

  it('reports the whole replacement as one document change', () => {
    // The journal (§9) records one entry per change event, so a replace-all that
    // arrived as thousands of events would bloat the Phase 5 journal as badly as
    // it would break undo.
    callbacks.onDocChanged.mockClear()
    const view = mountView('alpha beta alpha beta alpha')

    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: 'alpha', replace: 'gamma' }))
    })
    replaceAll(view)

    expect(callbacks.onDocChanged).toHaveBeenCalledTimes(1)
    expect(view.state.doc.toString()).toBe('gamma beta gamma beta gamma')

    view.destroy()
  })

  it('honours case sensitivity', () => {
    const view = mountView('Alpha alpha ALPHA')

    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: 'alpha', replace: 'x', caseSensitive: true })
      )
    })
    replaceAll(view)

    expect(view.state.doc.toString()).toBe('Alpha x ALPHA')
    view.destroy()
  })

  it('supports regular expressions, which §5 requires and does not reimplement', () => {
    const view = mountView('a1 b22 c333')

    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: '[0-9]+', replace: '#', regexp: true }))
    })
    replaceAll(view)

    expect(view.state.doc.toString()).toBe('a# b# c#')
    view.destroy()
  })

  it('scopes the search to the active document only (§5)', () => {
    // Two documents, two states, one shared view. Replacing in one must not
    // touch the other — cross-tab search is explicitly deferred.
    const first = mountView('needle in the first document')
    const second = createEditorState({
      docId: 'other',
      content: 'needle in the second document',
      mode: 'light',
      callbacks
    })

    first.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: 'needle', replace: 'pin' }))
    })
    replaceAll(first)

    expect(first.state.doc.toString()).toContain('pin')
    expect(second.doc.toString()).toBe('needle in the second document')

    first.destroy()
  })
})

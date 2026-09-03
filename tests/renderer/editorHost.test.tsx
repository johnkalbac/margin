// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { useEditorHost } from '@renderer/editor/useEditorHost'

/**
 * One EditorView, N EditorStates (plan §11, §4.4).
 *
 * Two Phase 3 acceptance criteria live here: "switching tabs restores scroll
 * position and selection", and toggling dark mode with several tabs open leaves
 * no light-mode residue on a tab switched to afterwards. Both are properties of
 * this hook, and both are the kind of bug that is invisible until someone opens
 * a second tab.
 *
 * jsdom has no layout, so scroll *offsets* are not meaningful here — that half
 * is asserted by hand in the real app. Selection and theme are pure state and
 * assert cleanly.
 */

/*
 * CodeMirror measures text by asking a Range for its client rects, and jsdom
 * implements neither. Without these stubs the measure pass CodeMirror schedules
 * on an animation frame throws asynchronously, after the assertions have already
 * passed -- noise that would eventually be mistaken for a real failure.
 *
 * The values are deliberately zero: jsdom has no layout, so any number here
 * would be a fiction. Nothing in this file asserts on geometry, which is exactly
 * why the millisecond budgets live in `npm run perf` instead.
 */
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

afterEach(() => {
  vi.clearAllMocks()
})

function mount(mode: 'light' | 'dark' = 'light') {
  const host = renderHook((props: { mode: 'light' | 'dark' }) => useEditorHost({ mode: props.mode, callbacks }), {
    initialProps: { mode }
  })

  const element = document.createElement('div')
  document.body.appendChild(element)
  act(() => {
    host.result.current.attach(element)
  })
  return host
}

describe('document switching', () => {
  it('keeps a separate buffer per document', () => {
    const host = mount()

    act(() => {
      host.result.current.openDocument('a', '# alpha')
      host.result.current.openDocument('b', '# beta')
      host.result.current.activateDocument('a')
    })
    expect(host.result.current.getContent()).toBe('# alpha')

    act(() => {
      host.result.current.activateDocument('b')
    })
    expect(host.result.current.getContent()).toBe('# beta')

    act(() => {
      host.result.current.activateDocument('a')
    })
    expect(host.result.current.getContent()).toBe('# alpha')
  })

  it('restores the selection a document was left with', () => {
    const host = mount()

    act(() => {
      host.result.current.openDocument('a', 'alpha document')
      host.result.current.openDocument('b', 'beta document')
      host.result.current.activateDocument('a')
    })

    // Put the caret somewhere distinctive in A.
    act(() => {
      host.result.current.getView()?.dispatch({ selection: EditorSelection.single(6) })
    })
    expect(host.result.current.getView()?.state.selection.main.head).toBe(6)

    act(() => {
      host.result.current.activateDocument('b')
    })
    // B has its own selection, not A's.
    expect(host.result.current.getView()?.state.selection.main.head).toBe(0)

    act(() => {
      host.result.current.activateDocument('a')
    })
    // Selection lives in EditorState, so it comes back with the document.
    expect(host.result.current.getView()?.state.selection.main.head).toBe(6)
  })

  it('keeps edits made to a document that is switched away from', () => {
    const host = mount()

    act(() => {
      host.result.current.openDocument('a', 'alpha')
      host.result.current.openDocument('b', 'beta')
      host.result.current.activateDocument('a')
    })

    act(() => {
      const view = host.result.current.getView()
      view?.dispatch({ changes: { from: 5, insert: ' edited' } })
    })

    act(() => {
      host.result.current.activateDocument('b')
    })
    act(() => {
      host.result.current.activateDocument('a')
    })

    expect(host.result.current.getContent()).toBe('alpha edited')
  })

  it('drops the state when a document closes, so it can be collected', () => {
    const host = mount()

    act(() => {
      host.result.current.openDocument('a', 'alpha')
      host.result.current.activateDocument('a')
      host.result.current.closeDocument('a')
    })

    // Reopening builds a fresh state rather than resurrecting the old buffer.
    act(() => {
      host.result.current.openDocument('a', 'replaced')
      host.result.current.activateDocument('a')
    })
    expect(host.result.current.getContent()).toBe('replaced')
  })
})

describe('replaceDocument', () => {
  it('swaps the live buffer when the document is active', () => {
    const host = mount()

    act(() => {
      host.result.current.openDocument('a', 'from disk')
      host.result.current.activateDocument('a')
      host.result.current.replaceDocument('a', 'reloaded from disk')
    })

    expect(host.result.current.getContent()).toBe('reloaded from disk')
  })

  it('swaps a background buffer without disturbing the active one', () => {
    const host = mount()

    act(() => {
      host.result.current.openDocument('a', 'alpha')
      host.result.current.openDocument('b', 'beta')
      host.result.current.activateDocument('a')
      host.result.current.replaceDocument('b', 'beta reloaded')
    })

    expect(host.result.current.getContent()).toBe('alpha')

    act(() => {
      host.result.current.activateDocument('b')
    })
    expect(host.result.current.getContent()).toBe('beta reloaded')
  })
})

describe('theme (§4.4)', () => {
  /**
   * A compartment instance is per-state. The residue bug this guards against:
   * toggle to dark with two tabs open, switch to the other tab, and it comes
   * back in light because its state was built with the old compartment
   * contents and never reconfigured.
   */
  it('leaves no light-mode residue on a tab activated after the toggle', () => {
    const host = mount('light')

    act(() => {
      host.result.current.openDocument('a', 'alpha')
      host.result.current.openDocument('b', 'beta')
      host.result.current.activateDocument('a')
    })

    act(() => {
      host.result.current.setTheme('dark')
    })

    expect(isDark(host.result.current)).toBe(true)

    // The tab that was in the background when the theme changed.
    act(() => {
      host.result.current.activateDocument('b')
    })

    // Its state was built before the toggle; activation must have brought it up
    // to date rather than painting it with the old theme.
    expect(isDark(host.result.current)).toBe(true)
  })

  it('builds a document opened after the toggle in the new theme', () => {
    const host = mount('light')

    act(() => {
      host.result.current.openDocument('a', 'alpha')
      host.result.current.activateDocument('a')
      host.result.current.setTheme('dark')
    })

    expect(isDark(host.result.current)).toBe(true)

    act(() => {
      host.result.current.openDocument('c', 'gamma')
      host.result.current.activateDocument('c')
    })

    expect(isDark(host.result.current)).toBe(true)
  })

  it('goes back to light, so the toggle works in both directions', () => {
    const host = mount('light')

    act(() => {
      host.result.current.openDocument('a', 'alpha')
      host.result.current.activateDocument('a')
      host.result.current.setTheme('dark')
    })
    expect(isDark(host.result.current)).toBe(true)

    act(() => {
      host.result.current.setTheme('light')
    })
    expect(isDark(host.result.current)).toBe(false)
  })
})

/**
 * `EditorView.darkTheme` is CodeMirror's own record of which way round the theme
 * is, and it is what its `&dark` selectors and selection compositing read. That
 * makes it the real signal, rather than a generated class name that is not a
 * stable interface.
 */
function isDark(host: ReturnType<typeof useEditorHost>): boolean {
  const view = host.getView()
  return view ? view.state.facet(EditorView.darkTheme) : false
}

describe('compare (§13 Phase 6)', () => {
  /**
   * The reason unifiedMergeView was chosen over MergeView: it is an extension,
   * so entering compare reconfigures the view that already exists rather than
   * constructing two more (§11). These assert the consequence that argument
   * rests on — the document and its selection survive the round trip.
   */
  it('keeps the buffer and selection through entering and leaving compare', () => {
    const host = mount()

    act(() => {
      host.result.current.openDocument('a', 'alpha document here')
      host.result.current.activateDocument('a')
    })
    act(() => {
      host.result.current.getView()?.dispatch({ selection: EditorSelection.single(6) })
    })

    act(() => {
      host.result.current.setCompare({ content: 'alpha original here', label: 'other.md' })
    })

    // Still the same document, still the same caret: no state was rebuilt.
    expect(host.result.current.getContent()).toBe('alpha document here')
    expect(host.result.current.getView()?.state.selection.main.head).toBe(6)

    act(() => {
      host.result.current.setCompare(null)
    })

    expect(host.result.current.getContent()).toBe('alpha document here')
    expect(host.result.current.getView()?.state.selection.main.head).toBe(6)
  })

  it('mounts no additional view for a comparison', () => {
    const host = mount()

    act(() => {
      host.result.current.openDocument('a', 'alpha')
      host.result.current.activateDocument('a')
    })
    const before = document.querySelectorAll('.cm-editor').length

    act(() => {
      host.result.current.setCompare({ content: 'beta', label: 'beta.md' })
    })

    // MergeView would have added two. This is the memory argument from §11,
    // asserted rather than assumed.
    expect(document.querySelectorAll('.cm-editor').length).toBe(before)

    act(() => {
      host.result.current.setCompare(null)
    })
    expect(document.querySelectorAll('.cm-editor').length).toBe(before)
  })

  it('is still editable after leaving compare', () => {
    const host = mount()

    act(() => {
      host.result.current.openDocument('a', 'start')
      host.result.current.activateDocument('a')
      host.result.current.setCompare({ content: 'other', label: 'other.md' })
      host.result.current.setCompare(null)
    })

    act(() => {
      host.result.current.getView()?.dispatch({ changes: { from: 5, insert: ' again' } })
    })
    expect(host.result.current.getContent()).toBe('start again')
  })
})

describe('runCommand (§7)', () => {
  it('undoes through CodeMirror rather than the DOM', () => {
    const host = mount()

    act(() => {
      host.result.current.openDocument('a', 'start')
      host.result.current.activateDocument('a')
    })
    act(() => {
      host.result.current.getView()?.dispatch({ changes: { from: 5, insert: ' more' } })
    })
    expect(host.result.current.getContent()).toBe('start more')

    act(() => {
      host.result.current.runCommand('edit.undo')
    })
    expect(host.result.current.getContent()).toBe('start')
  })

  it('selects all', () => {
    const host = mount()

    act(() => {
      host.result.current.openDocument('a', 'select me')
      host.result.current.activateDocument('a')
      host.result.current.runCommand('edit.selectAll')
    })

    const selection = host.result.current.getView()?.state.selection.main
    expect(selection?.from).toBe(0)
    expect(selection?.to).toBe('select me'.length)
  })

  it('reports an unknown command rather than throwing', () => {
    const host = mount()
    act(() => {
      host.result.current.openDocument('a', 'x')
      host.result.current.activateDocument('a')
    })
    expect(host.result.current.runCommand('edit.notACommand')).toBe(false)
  })
})

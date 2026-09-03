// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { patchBlocks } from '@renderer/preview/patch'

/**
 * Block-level patching (plan §11). The property that matters is that untouched
 * blocks keep their identity — that is what preserves scroll position, decoded
 * images, and text selection across a keystroke.
 */

let target: HTMLElement

beforeEach(() => {
  target = document.createElement('div')
  document.body.append(target)
})

describe('patchBlocks', () => {
  it('renders into an empty container', () => {
    patchBlocks(target, '<p>one</p><p>two</p>')
    expect(target.children).toHaveLength(2)
    expect(target.innerHTML).toBe('<p>one</p><p>two</p>')
  })

  it('leaves unchanged blocks as the very same nodes', () => {
    patchBlocks(target, '<h1>Title</h1><p>one</p><p>two</p>')
    const [heading, first, second] = Array.from(target.children)

    patchBlocks(target, '<h1>Title</h1><p>one EDITED</p><p>two</p>')

    expect(target.children[0]).toBe(heading)
    expect(target.children[2]).toBe(second)
    // Only the edited block is a new node.
    expect(target.children[1]).not.toBe(first)
    expect(target.children[1]!.textContent).toBe('one EDITED')
  })

  it('appends blocks as the document grows', () => {
    patchBlocks(target, '<p>one</p>')
    const first = target.children[0]
    patchBlocks(target, '<p>one</p><p>two</p><p>three</p>')
    expect(target.children).toHaveLength(3)
    expect(target.children[0]).toBe(first)
  })

  it('removes surplus blocks as the document shrinks', () => {
    patchBlocks(target, '<p>one</p><p>two</p><p>three</p>')
    const first = target.children[0]
    patchBlocks(target, '<p>one</p>')
    expect(target.children).toHaveLength(1)
    expect(target.children[0]).toBe(first)
  })

  it('is a no-op when the html is identical', () => {
    patchBlocks(target, '<p>one</p><p>two</p>')
    const nodes = Array.from(target.children)
    patchBlocks(target, '<p>one</p><p>two</p>')
    expect(Array.from(target.children)).toEqual(nodes)
  })

  it('preserves the container scroll offset across an edit to a later block', () => {
    patchBlocks(target, Array.from({ length: 50 }, (_, i) => `<p>line ${i}</p>`).join(''))
    target.scrollTop = 120
    patchBlocks(
      target,
      Array.from({ length: 50 }, (_, i) => `<p>line ${i === 49 ? 'edited' : i}</p>`).join('')
    )
    expect(target.scrollTop).toBe(120)
  })
})

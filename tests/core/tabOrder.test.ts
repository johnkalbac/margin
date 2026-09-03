import { describe, expect, it } from 'vitest'

import { dropIndexAt, isDetachGesture, reorder } from '@core/tabs/order'

/**
 * Tab order (plan §4.1).
 *
 * Reorder arithmetic is exactly the kind of thing that looks right in a
 * screenshot and lands one place off. Separating it from the drag handling is
 * what makes it assertable without a pointer.
 */

const tabs = ['a', 'b', 'c', 'd']

describe('reorder', () => {
  it('moves a tab later in the strip', () => {
    // Dragging 'a' onto where 'c' is: 'a' lifts out, 'c' shifts down, 'a' lands
    // where 'c' was. This is the off-by-one that matters.
    expect(reorder(tabs, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves a tab earlier in the strip', () => {
    expect(reorder(tabs, 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves a tab to the front and to the back', () => {
    expect(reorder(tabs, 2, 0)).toEqual(['c', 'a', 'b', 'd'])
    expect(reorder(tabs, 0, 4)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('is a no-op when the tab is dropped where it started', () => {
    expect(reorder(tabs, 1, 1)).toEqual(tabs)
  })

  it('clamps a drop past the end rather than throwing', () => {
    // Dropping in the filler past the last tab means "put it last".
    expect(reorder(tabs, 0, 99)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('leaves the list alone for an out-of-range source', () => {
    expect(reorder(tabs, -1, 2)).toEqual(tabs)
    expect(reorder(tabs, 9, 2)).toEqual(tabs)
  })

  it('never loses or duplicates a tab', () => {
    // The property that matters most: a reorder is a permutation. A tab lost
    // here is a document with an EditorState and no way to reach it.
    for (let from = 0; from < tabs.length; from++) {
      for (let to = 0; to <= tabs.length; to++) {
        const result = reorder(tabs, from, to)
        expect(result).toHaveLength(tabs.length)
        expect([...result].sort()).toEqual([...tabs].sort())
      }
    }
  })

  it('does not mutate the list it was given', () => {
    const original = [...tabs]
    reorder(tabs, 0, 3)
    expect(tabs).toEqual(original)
  })
})

describe('dropIndexAt', () => {
  // Four 100px tabs starting at x=0.
  const rects = [
    { left: 0, right: 100 },
    { left: 100, right: 200 },
    { left: 200, right: 300 },
    { left: 300, right: 400 }
  ]

  it('reports the tab whose left half the pointer is over', () => {
    expect(dropIndexAt(10, rects)).toBe(0)
    expect(dropIndexAt(120, rects)).toBe(1)
  })

  it('reports the next slot once past a tab midpoint', () => {
    // Past halfway means the dragged tab belongs after this one — which is what
    // makes the indicator follow the pointer instead of snapping late.
    expect(dropIndexAt(60, rects)).toBe(1)
    expect(dropIndexAt(160, rects)).toBe(2)
  })

  it('reports the end when the pointer is past the last tab', () => {
    expect(dropIndexAt(999, rects)).toBe(4)
  })

  it('reports the start for an empty strip', () => {
    expect(dropIndexAt(50, [])).toBe(0)
  })
})

describe('isDetachGesture', () => {
  const strip = { left: 0, right: 800, top: 32, bottom: 72 }

  it('is false for a drag that stayed on the strip', () => {
    expect(isDetachGesture({ x: 400, y: 50 }, strip)).toBe(false)
  })

  it('is false for a drag that wandered slightly off it', () => {
    // Detaching a tab the user meant to reorder is far worse than failing to
    // detach one they meant to pull out, so the tolerance is generous.
    expect(isDetachGesture({ x: 400, y: 100 }, strip)).toBe(false)
    expect(isDetachGesture({ x: -20, y: 50 }, strip)).toBe(false)
  })

  it('is true for a drag pulled well clear of the strip', () => {
    expect(isDetachGesture({ x: 400, y: 500 }, strip)).toBe(true)
    expect(isDetachGesture({ x: 1200, y: 50 }, strip)).toBe(true)
    expect(isDetachGesture({ x: 400, y: -200 }, strip)).toBe(true)
  })

  it('honours an explicit tolerance', () => {
    expect(isDetachGesture({ x: 400, y: 90 }, strip, 5)).toBe(true)
    expect(isDetachGesture({ x: 400, y: 90 }, strip, 100)).toBe(false)
  })
})

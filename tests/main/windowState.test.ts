import { describe, expect, it } from 'vitest'

import { fitToWorkAreas, isWindowState, type WindowState } from '@main/windowState'

/**
 * Restoring window geometry (main/windowState.ts).
 *
 * The failure this guards against is not cosmetic: a window restored onto a
 * display that has since been unplugged has no title bar to grab and no way
 * back short of editing settings.json. Every case below is a monitor that
 * changed between two launches.
 */

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 }
/** A second monitor to the left, as a docked laptop usually has. */
const LEFT = { x: -1920, y: 0, width: 1920, height: 1080 }
const MIN = { width: 900, height: 560 }

function state(patch: Partial<WindowState> = {}): WindowState {
  return { x: 100, y: 80, width: 1280, height: 840, maximized: false, ...patch }
}

describe('isWindowState', () => {
  it('accepts a complete record', () => {
    expect(isWindowState(state())).toBe(true)
  })

  it('rejects hand-edited or half-written records', () => {
    expect(isWindowState(null)).toBe(false)
    expect(isWindowState({ x: 0, y: 0, width: 800, height: 600 })).toBe(false)
    expect(isWindowState({ ...state(), width: 0 })).toBe(false)
    expect(isWindowState({ ...state(), y: Number.NaN })).toBe(false)
    expect(isWindowState({ ...state(), x: '10' })).toBe(false)
  })
})

describe('fitToWorkAreas', () => {
  it('returns bounds unchanged when they still fit on a display', () => {
    expect(fitToWorkAreas(state(), [PRIMARY], MIN)).toEqual(state())
  })

  it('keeps a window on the second display it was left on', () => {
    const onLeft = state({ x: -1500, y: 200 })
    expect(fitToWorkAreas(onLeft, [PRIMARY, LEFT], MIN)).toEqual(onLeft)
  })

  it('centres on the primary when that display is gone', () => {
    // The monitor at -1920 was unplugged, so nothing of the window is on screen.
    const fitted = fitToWorkAreas(state({ x: -1500, y: 200 }), [PRIMARY], MIN)
    expect(fitted).toEqual({ x: 320, y: 100, width: 1280, height: 840, maximized: false })
  })

  it('pulls a partly off-screen window back inside the work area', () => {
    const fitted = fitToWorkAreas(state({ x: 1800, y: 900 }), [PRIMARY], MIN)
    // Flush against the bottom-right of the work area, whole window visible.
    expect(fitted).toEqual({ x: 640, y: 200, width: 1280, height: 840, maximized: false })
  })

  it('shrinks a window too large for the display it lands on', () => {
    const small = { x: 0, y: 0, width: 1024, height: 768 }
    const fitted = fitToWorkAreas(state({ width: 1600, height: 1200 }), [small], MIN)
    expect(fitted).toMatchObject({ x: 0, y: 0, width: 1024, height: 768 })
  })

  it('never returns a window below the usable minimum', () => {
    const tiny = { x: 0, y: 0, width: 600, height: 400 }
    const fitted = fitToWorkAreas(state(), [tiny], MIN)
    // Electron would resize a smaller window up anyway, and then place it
    // somewhere nobody asked for. The top-left corner is what stays reachable.
    expect(fitted).toEqual({ x: 0, y: 0, width: MIN.width, height: MIN.height, maximized: false })
  })

  it('carries the maximized flag through', () => {
    expect(fitToWorkAreas(state({ maximized: true }), [PRIMARY], MIN)?.maximized).toBe(true)
  })

  it('gives up when no display is attached', () => {
    expect(fitToWorkAreas(state(), [], MIN)).toBeNull()
  })
})

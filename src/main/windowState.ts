/**
 * Where the window was last left, so the next launch reopens it there.
 *
 * This lives in main and stays out of `Settings`: it is chrome, not a preference
 * — the renderer neither reads it nor may set it, so it is deliberately absent
 * from the IPC settings payload even though it shares the settings file.
 *
 * Everything here is pure. Electron's `screen` is only reachable after the app
 * is ready and cannot be had in a plain Node test (§12), so the geometry is
 * expressed over plain rectangles and index.ts supplies the real work areas.
 */

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  /**
   * Restored by maximizing a window sized to the bounds above, which is why
   * those bounds are captured with `getNormalBounds()` — the pre-maximize size
   * is what unmaximizing has to give back.
   */
  maximized: boolean
}

/** A display's usable area — its bounds minus the taskbar/dock/menu bar. */
export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface MinimumSize {
  width: number
  height: number
}

export function isWindowState(value: unknown): value is WindowState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Partial<WindowState>
  return (
    isFiniteNumber(state.x) &&
    isFiniteNumber(state.y) &&
    isFiniteNumber(state.width) &&
    isFiniteNumber(state.height) &&
    state.width > 0 &&
    state.height > 0 &&
    typeof state.maximized === 'boolean'
  )
}

/**
 * Fit saved bounds to the displays attached *now*.
 *
 * Monitors come and go — undocking a laptop, or a projector unplugged — and a
 * window restored onto a display that no longer exists is invisible and, with no
 * title bar to reach, unrecoverable without editing the settings file. So the
 * saved rectangle is only ever a request: it is honoured on whichever attached
 * display it overlaps most, clamped inside that display's work area, and
 * re-centred on the primary if it overlaps nothing at all.
 *
 * `areas` must lead with the primary display — the fallback is `areas[0]`.
 * Returns null when there are no displays to fit to, which the caller reads as
 * "use the default size".
 */
export function fitToWorkAreas(
  state: WindowState,
  areas: readonly WorkArea[],
  min: MinimumSize
): WindowState | null {
  const [primary] = areas
  if (!primary) return null

  const target = areas.reduce(
    (best, area) => (overlap(state, area) > overlap(state, best) ? area : best),
    primary
  )

  // A window wider than the display it lands on cannot be moved fully into
  // view, so the size gives way first; the minimums still win, because a window
  // below them would be resized by Electron anyway and land somewhere unasked.
  const width = Math.max(min.width, Math.min(state.width, target.width))
  const height = Math.max(min.height, Math.min(state.height, target.height))

  // Nothing of the window is on any attached display. Centring beats clamping
  // here: clamping would pin it to whichever edge it drifted off, which reads as
  // a glitch rather than a fresh start.
  if (overlap(state, target) <= 0) {
    return {
      x: Math.round(target.x + (target.width - width) / 2),
      y: Math.round(target.y + (target.height - height) / 2),
      width,
      height,
      maximized: state.maximized
    }
  }

  return {
    x: clamp(state.x, target.x, target.x + target.width - width),
    y: clamp(state.y, target.y, target.y + target.height - height),
    width,
    height,
    maximized: state.maximized
  }
}

function overlap(state: WindowState, area: WorkArea): number {
  const width = Math.min(state.x + state.width, area.x + area.width) - Math.max(state.x, area.x)
  const height = Math.min(state.y + state.height, area.y + area.height) - Math.max(state.y, area.y)
  return width > 0 && height > 0 ? width * height : 0
}

function clamp(value: number, low: number, high: number): number {
  // `high` is below `low` when the window is wider than the work area, and the
  // left/top edge is the one worth keeping: the title bar lives there.
  return Math.round(Math.max(low, Math.min(value, Math.max(low, high))))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

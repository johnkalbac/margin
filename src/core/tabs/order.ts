/**
 * Tab order (plan §4.1).
 *
 * "One tab per open document, per window. Drag to reorder; drag out to detach
 * into a new window."
 *
 * The arithmetic is separated from the drag handling because off-by-one errors
 * in a reorder are easy to write, invisible in a screenshot, and produce a tab
 * that lands one place left of where it was dropped. Pure, so it is testable
 * without a pointer.
 */

/**
 * Move the item at `from` so that it sits at index `to` in the resulting list.
 *
 * `to` is interpreted against the list *after* removal, which is what a drop
 * target reports: dropping onto index 3 while dragging item 1 means "put it
 * where item 3 currently is", and item 3 shifts down once item 1 is lifted out.
 */
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to) return [...list]
  if (from < 0 || from >= list.length) return [...list]

  const next = [...list]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return [...list]

  // Clamp rather than throw: a drop past the last tab means "put it last",
  // which is what the user did, not an error.
  const target = Math.max(0, Math.min(to, next.length))
  next.splice(target, 0, moved)
  return next
}

/**
 * Which tab a pointer at `x` is over, given the strip's tab rectangles.
 *
 * Returns an insertion index, so it can report "past the last tab" as
 * `rects.length`. Uses the midpoint of each tab: past halfway means the dragged
 * tab belongs after it, which is what makes a drag feel like it follows the
 * pointer rather than snapping a tab late.
 */
export function dropIndexAt(x: number, rects: ReadonlyArray<{ left: number; right: number }>): number {
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]
    if (!rect) continue
    if (x < rect.left + (rect.right - rect.left) / 2) return i
  }
  return rects.length
}

/**
 * Whether a drag that ended at (x, y) left the tab strip, and so means "detach
 * this into a window of its own" rather than "put it back".
 *
 * A generous vertical tolerance: a drag along the strip wanders a few pixels
 * above and below it, and detaching a tab the user meant to reorder is a much
 * worse outcome than failing to detach one they meant to pull out.
 */
export function isDetachGesture(
  point: { x: number; y: number },
  strip: { left: number; right: number; top: number; bottom: number },
  tolerance = 60
): boolean {
  const withinX = point.x >= strip.left - tolerance && point.x <= strip.right + tolerance
  const withinY = point.y >= strip.top - tolerance && point.y <= strip.bottom + tolerance
  return !(withinX && withinY)
}

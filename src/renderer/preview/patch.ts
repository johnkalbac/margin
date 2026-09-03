/**
 * Block-level DOM patching for the preview (plan §11).
 *
 * Replacing the whole preview DOM on every render loses the scroll position and
 * repaints the world on each keystroke. Comparing at the top-level block
 * granularity is enough: an edit typically touches one paragraph, so one element
 * is replaced and the rest of the tree — along with the scroll offset and any
 * image already decoded — is left alone.
 *
 * The incoming HTML must already be sanitized.
 */
export function patchBlocks(target: HTMLElement, sanitizedHtml: string): void {
  const scratch = target.ownerDocument.createElement('div')
  scratch.innerHTML = sanitizedHtml

  // Snapshot both sides: the loops below move nodes between the two trees.
  const next = Array.from(scratch.children)
  const current = Array.from(target.children)
  const shared = Math.min(next.length, current.length)

  for (let i = 0; i < shared; i++) {
    const before = current[i]!
    const after = next[i]!
    if (before.outerHTML !== after.outerHTML) target.replaceChild(after, before)
  }

  for (let i = shared; i < next.length; i++) {
    target.appendChild(next[i]!)
  }

  for (let i = current.length - 1; i >= shared; i--) {
    target.removeChild(current[i]!)
  }
}

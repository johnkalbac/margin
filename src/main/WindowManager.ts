import { BrowserWindow } from 'electron'

import type { DocId } from '@shared/types'

/**
 * Which documents belong to which window (plan §2).
 *
 * `DocumentRegistry` answers "what documents exist"; this answers "where are
 * they". Both are needed once there is more than one window: an external-change
 * event has to reach the window showing that file and not merely the focused
 * one, and closing a window has to close its documents and no others.
 *
 * Tab *order* lives here rather than in the renderer because it is per-window
 * state that survives a reload, and because Phase 4's drag-out-to-detach moves a
 * document between windows — an operation neither renderer can own alone.
 */
export class WindowManager {
  /** windowId -> ordered docIds. The array order is the tab order. */
  private readonly tabs = new Map<number, DocId[]>()

  register(window: BrowserWindow): void {
    this.tabs.set(window.id, [])
    window.on('closed', () => this.tabs.delete(window.id))
  }

  forget(windowId: number): void {
    this.tabs.delete(windowId)
  }

  /** Append, or insert at a position when a drag supplies one. */
  addTab(windowId: number, docId: DocId, index?: number): void {
    const order = this.tabs.get(windowId)
    if (!order) return
    if (order.includes(docId)) return

    if (index === undefined || index < 0 || index >= order.length) order.push(docId)
    else order.splice(index, 0, docId)
  }

  removeTab(windowId: number, docId: DocId): void {
    const order = this.tabs.get(windowId)
    if (!order) return
    const at = order.indexOf(docId)
    if (at !== -1) order.splice(at, 1)
  }

  tabsOf(windowId: number): DocId[] {
    return [...(this.tabs.get(windowId) ?? [])]
  }

  /** The window holding a document, or null if it is not open anywhere. */
  windowIdOf(docId: DocId): number | null {
    for (const [windowId, order] of this.tabs) {
      if (order.includes(docId)) return windowId
    }
    return null
  }

  /**
   * The live window a message about this document should go to.
   *
   * Falls back to the focused window so that a document main knows about but
   * has not been told the location of still reaches a renderer rather than
   * being dropped silently.
   */
  windowFor(docId?: DocId): BrowserWindow | null {
    if (docId) {
      const windowId = this.windowIdOf(docId)
      if (windowId !== null) {
        const window = BrowserWindow.fromId(windowId)
        if (window && !window.isDestroyed()) return window
      }
    }
    return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  }

  /** Every document open anywhere, for the quit sweep. */
  allDocIds(): DocId[] {
    return [...this.tabs.values()].flat()
  }

  windowIds(): number[] {
    return [...this.tabs.keys()]
  }
}

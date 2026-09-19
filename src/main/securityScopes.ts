/**
 * Sandbox grants for files a Mac App Store build reopens across launches.
 *
 * The App Sandbox lets the process touch a user's file only while it holds a
 * grant for it. A dialog pick carries one for the life of the process; a later
 * launch has to redeem the security-scoped bookmark the dialog minted
 * (SettingsStore keeps them) via `app.startAccessingSecurityScopedResource`,
 * which returns the function that gives the grant back.
 *
 * A grant is held for the DOCUMENT's lifetime, not just the read that opened
 * it: the watcher and every later save touch the same file, and each would
 * fail with EPERM the moment it was released. So a grant is acquired when a
 * path is opened and released when its document closes or moves (Save As).
 *
 * Pure bookkeeping around an injected `start`, so it is testable without
 * Electron; outside a MAS build `start` is null and every call is a no-op.
 */
export type StartAccess = (bookmark: string) => () => void

export class SecurityScopes {
  private readonly held = new Map<string, () => void>()

  constructor(private readonly start: StartAccess | null) {}

  /**
   * Redeem `bookmark` for `path`, unless there is nothing to redeem or the grant
   * is already held (the same file opened twice resolves to one document).
   */
  acquire(path: string, bookmark: string | undefined): void {
    if (!this.start || !bookmark || this.held.has(path)) return
    try {
      this.held.set(path, this.start(bookmark))
    } catch {
      // A stale or corrupt bookmark. Not reported here: the read that follows
      // fails with the real reason, through the same path as any unreadable file.
    }
  }

  release(path: string): void {
    const stop = this.held.get(path)
    if (!stop) return
    this.held.delete(path)
    stop()
  }

  releaseAll(): void {
    for (const path of [...this.held.keys()]) this.release(path)
  }

  holds(path: string): boolean {
    return this.held.has(path)
  }
}

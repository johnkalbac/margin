import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  COALESCE_IDLE_MS,
  KEEP_ROLLED_JOURNALS,
  MAX_JOURNAL_BYTES,
  composePatches,
  parseJournal,
  replayTo,
  serializeEntry,
  snapshotDue,
  versionsOf,
  type JournalEntry,
  type VersionSummary
} from '@core/history/journal'
import type { DocId } from '@shared/types'

/**
 * Edit history on disk (plan §9).
 *
 * `doc:changed` has fired on every edit since Phase 1, sinking to a no-op. This
 * is the body that replaces it — which is exactly why the channel was built
 * first: §2 calls retrofitting change capture "where this project would stall",
 * and there was nothing to retrofit.
 *
 * Layout, per §9:
 *
 *   userData/history/<sha256(canonicalPath)>/journal.jsonl
 *   userData/history/<sha256(canonicalPath)>/meta.json
 *
 * **History is local, unencrypted, and outside the user's file tree.** Opening a
 * sensitive file leaves its content in application data, and deleting the file
 * does not delete that copy. §9 requires this be documented rather than assumed;
 * it is also in the README.
 */

export interface HistoryVersion extends VersionSummary {
  /** ISO string, so the renderer does not have to agree about time zones. */
  iso: string
}

interface DocState {
  /** Directory for this document's journal, or null for an untitled document. */
  dir: string | null
  /** Patches buffered by the idle debounce, oldest first. */
  pending: unknown[]
  timer: NodeJS.Timeout | null
  /** Next version number to write. */
  nextVersion: number
  patchesSinceSnapshot: number
  /**
   * The buffer as the journal currently describes it. Needed to write a
   * snapshot without asking the renderer for content it may not be holding.
   */
  content: string
}

export class HistoryService {
  private readonly docs = new Map<DocId, DocState>()

  constructor(private readonly root: string) {}

  /** userData/history/<sha256(canonicalPath)>. */
  private dirFor(canonicalKey: string): string {
    return join(this.root, createHash('sha256').update(canonicalKey).digest('hex'))
  }

  /**
   * Begin tracking a document, writing the opening snapshot if this is a file
   * the journal has not seen before.
   *
   * Untitled documents are not journalled: they have no canonical path, so
   * there is nowhere stable to key the directory on. They begin a journal at
   * their first save, when a path exists.
   */
  async open(docId: DocId, canonicalKey: string | null, content: string): Promise<void> {
    if (!canonicalKey) {
      this.docs.set(docId, {
        dir: null,
        pending: [],
        timer: null,
        nextVersion: 0,
        patchesSinceSnapshot: 0,
        content
      })
      return
    }

    const dir = this.dirFor(canonicalKey)
    mkdirSync(dir, { recursive: true })

    const entries = await this.readEntries(dir)
    const last = entries[entries.length - 1]

    const state: DocState = {
      dir,
      pending: [],
      timer: null,
      nextVersion: last ? last.v + 1 : 0,
      patchesSinceSnapshot: patchesSince(entries),
      content
    }
    this.docs.set(docId, state)

    // A snapshot on first open (§9). Also whenever the file on disk no longer
    // matches what the journal last described — the file may have been edited
    // by something else, and a patch chain that assumes otherwise would replay
    // to the wrong document.
    const journalled = entries.length > 0 ? safeReplayAll(entries) : null
    if (journalled !== content) {
      this.writeEntry(state, { t: Date.now(), type: 'snapshot', v: state.nextVersion++, content })
      state.patchesSinceSnapshot = 0
    }

    // Sidecar, so history survives a file move (best effort — §9 says detected
    // on next open, not watched).
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ path: canonicalKey }, null, 2), 'utf8')
  }

  /**
   * Record one change. Buffered, then coalesced on a 2s idle debounce.
   *
   * §9: never write per keystroke. A burst of typing becomes one entry, which is
   * what keeps a 30-minute session from producing tens of thousands of lines.
   */
  record(docId: DocId, changes: unknown, content: string): void {
    const state = this.docs.get(docId)
    if (!state) return

    state.pending.push(changes)
    state.content = content

    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => this.flush(docId), COALESCE_IDLE_MS)
    state.timer.unref?.()
  }

  /** Commit buffered changes now. §9 commits on every save. */
  flush(docId: DocId): void {
    const state = this.docs.get(docId)
    if (!state) return

    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (state.pending.length === 0 || !state.dir) {
      state.pending = []
      return
    }

    // A snapshot is cheaper to replay than 50 patches, and bounds the damage a
    // corrupt patch can do to the entries after it.
    if (snapshotDue(state.patchesSinceSnapshot)) {
      this.writeEntry(state, {
        t: Date.now(),
        type: 'snapshot',
        v: state.nextVersion++,
        content: state.content
      })
      state.patchesSinceSnapshot = 0
      state.pending = []
      return
    }

    const composed = composePatches(state.pending)
    if (composed === null) {
      // Composition failed, so the run is written individually rather than
      // dropped. Larger, but history is not lost.
      for (const patch of state.pending) {
        this.writeEntry(state, {
          t: Date.now(),
          type: 'patch',
          v: state.nextVersion++,
          changes: patch
        })
        state.patchesSinceSnapshot++
      }
    } else {
      this.writeEntry(state, {
        t: Date.now(),
        type: 'patch',
        v: state.nextVersion++,
        changes: composed
      })
      state.patchesSinceSnapshot++
    }

    state.pending = []
  }

  /**
   * Attach a journal to a document that has just been given a path.
   *
   * The first save of an untitled document, and Save As. Its edits so far were
   * not journalled — there was nowhere to put them — so this opens a journal
   * with the current buffer as the first snapshot.
   */
  async bind(docId: DocId, canonicalKey: string, content: string): Promise<void> {
    this.flush(docId)
    this.docs.delete(docId)
    await this.open(docId, canonicalKey, content)
  }

  /** Stop tracking; buffered changes are committed first. */
  close(docId: DocId): void {
    this.flush(docId)
    const state = this.docs.get(docId)
    if (state?.timer) clearTimeout(state.timer)
    this.docs.delete(docId)
  }

  closeAll(): void {
    for (const docId of [...this.docs.keys()]) this.close(docId)
  }

  /** Timestamped versions for the sidebar, newest first. */
  async versions(docId: DocId): Promise<HistoryVersion[]> {
    const state = this.docs.get(docId)
    if (!state?.dir) return []
    this.flush(docId)

    const entries = await this.readEntries(state.dir)
    return versionsOf(entries).map((version) => ({
      ...version,
      iso: new Date(version.t).toISOString()
    }))
  }

  /** The document as of a version, for the preview and for restore. */
  async contentAt(docId: DocId, version: number): Promise<string | null> {
    const state = this.docs.get(docId)
    if (!state?.dir) return null
    this.flush(docId)

    const entries = await this.readEntries(state.dir)
    try {
      return replayTo(entries, version)
    } catch {
      return null
    }
  }

  private async readEntries(dir: string): Promise<JournalEntry[]> {
    try {
      return parseJournal(await readFile(join(dir, 'journal.jsonl'), 'utf8'))
    } catch {
      return []
    }
  }

  /**
   * Append one entry.
   *
   * Synchronous on purpose: entries must land in order, and an async queue that
   * can interleave two appends would produce exactly the gap §9 says invalidates
   * everything after it. Appends are small and infrequent — at most one per 2s
   * idle window per document.
   */
  private writeEntry(state: DocState, entry: JournalEntry): void {
    if (!state.dir) return
    const file = join(state.dir, 'journal.jsonl')

    try {
      this.rotateIfLarge(file)
      appendFileSync(file, serializeEntry(entry), 'utf8')
    } catch {
      // History is a convenience layered on the document. Failing to write it
      // must never fail the edit that produced it.
    }
  }

  /** Cap at 20MB, roll to journal.1.jsonl, keep 3 (§9). */
  private rotateIfLarge(file: string): void {
    if (!existsSync(file)) return
    if (statSync(file).size < MAX_JOURNAL_BYTES) return

    const oldest = `${file}.${KEEP_ROLLED_JOURNALS}`
    if (existsSync(oldest)) unlinkSync(oldest)

    for (let n = KEEP_ROLLED_JOURNALS - 1; n >= 1; n--) {
      const from = `${file}.${n}`
      if (existsSync(from)) renameSync(from, `${file}.${n + 1}`)
    }
    renameSync(file, `${file}.1`)
  }
}

function patchesSince(entries: JournalEntry[]): number {
  let count = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (!entry || entry.type === 'snapshot') break
    count++
  }
  return count
}

/** Replay without throwing — a damaged journal must not block an open. */
function safeReplayAll(entries: JournalEntry[]): string | null {
  const last = entries[entries.length - 1]
  if (!last) return null
  try {
    return replayTo(entries, last.v)
  } catch {
    return null
  }
}

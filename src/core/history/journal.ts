import { ChangeSet, Text } from '@codemirror/state'

/**
 * Edit-history journal format (plan §9).
 *
 * Patches are serialized CodeMirror `ChangeSet`s. §9 chose that over a diff
 * library because it is exact, ordered, and already in the editor: the change
 * events the app has published since Phase 1 carry `update.changes.toJSON()`,
 * so nothing had to be retrofitted here.
 *
 * The format's one hard rule: **patches are strictly sequential**. A gap makes
 * everything after it invalid, so writes are append-only and never reordered.
 * `tests/core/journal.test.ts` proves replay against random edit sequences, and
 * proves that a gap fails loudly rather than producing a plausible wrong answer.
 *
 * Pure TypeScript — no Electron, no `fs`. `HistoryService` in main owns the
 * files; this owns what goes in them.
 */

export interface SnapshotEntry {
  /** Epoch ms. */
  t: number
  type: 'snapshot'
  v: number
  content: string
}

export interface PatchEntry {
  t: number
  type: 'patch'
  v: number
  /** `ChangeSet.toJSON()`, rehydrated with `ChangeSet.fromJSON()`. */
  changes: unknown
}

export type JournalEntry = SnapshotEntry | PatchEntry

/** A full snapshot on first open and every 50 patches thereafter (§9). */
export const SNAPSHOT_EVERY = 50

/** Coalesce on a 2s idle debounce. Never write per keystroke (§9). */
export const COALESCE_IDLE_MS = 2000

/** Cap a journal at 20MB, roll to journal.1.jsonl, keep 3 (§9). */
export const MAX_JOURNAL_BYTES = 20 * 1024 * 1024
export const KEEP_ROLLED_JOURNALS = 3

export function isSnapshot(entry: JournalEntry): entry is SnapshotEntry {
  return entry.type === 'snapshot'
}

/** One JSONL line, newline included. */
export function serializeEntry(entry: JournalEntry): string {
  return `${JSON.stringify(entry)}\n`
}

/**
 * Parse a journal file.
 *
 * A truncated final line is expected rather than exceptional: the process can
 * die mid-append, and JSONL is chosen partly because that costs one entry
 * instead of the file. Unparseable lines are dropped, not thrown on.
 */
export function parseJournal(text: string): JournalEntry[] {
  const entries: JournalEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as JournalEntry
      if (isValidEntry(parsed)) entries.push(parsed)
    } catch {
      // A half-written line at the tail. Everything before it is still good.
    }
  }
  return entries
}

function isValidEntry(value: unknown): value is JournalEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<JournalEntry>
  if (typeof entry.t !== 'number' || typeof entry.v !== 'number') return false
  if (entry.type === 'snapshot') return typeof (entry as SnapshotEntry).content === 'string'
  return entry.type === 'patch'
}

/**
 * Rebuild the document as of a version.
 *
 * Starts from the latest snapshot at or before the target, then applies patches
 * in order. Reading backwards to the nearest snapshot is the whole reason
 * snapshots exist — without them, opening history on an old file would replay
 * every edit ever made to it.
 */
export function replayTo(entries: JournalEntry[], version: number): string {
  let startIndex = -1
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry || entry.v > version) break
    if (isSnapshot(entry)) startIndex = i
  }
  if (startIndex === -1) {
    throw new Error(`No snapshot at or before version ${version}`)
  }

  const base = entries[startIndex] as SnapshotEntry
  let doc = Text.of(base.content.split('\n'))

  for (let i = startIndex + 1; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry || entry.v > version) break
    if (isSnapshot(entry)) {
      doc = Text.of(entry.content.split('\n'))
      continue
    }
    doc = ChangeSet.fromJSON(entry.changes).apply(doc)
  }

  return doc.toString()
}

/** The current document, i.e. replay through the last entry. */
export function replayAll(entries: JournalEntry[]): string {
  const last = entries[entries.length - 1]
  if (!last) throw new Error('Empty journal')
  return replayTo(entries, last.v)
}

/**
 * Compose a run of serialized ChangeSets into one.
 *
 * This is the coalescing §9 asks for: a burst of keystrokes becomes one journal
 * entry rather than forty. Composition requires each patch to start where the
 * previous one ended, which holds because they came from consecutive
 * transactions on one document and ChangeSet validates the chain itself.
 */
export function composePatches(patches: unknown[]): unknown | null {
  if (patches.length === 0) return null
  if (patches.length === 1) return patches[0]

  let composed = ChangeSet.fromJSON(patches[0])
  // A malformed or out-of-order patch would throw here. Returning null lets the
  // caller fall back to writing the patches individually, which is correct but
  // larger — a coalescing failure must not lose history.
  try {
    for (let i = 1; i < patches.length; i++) {
      composed = composed.compose(ChangeSet.fromJSON(patches[i]))
    }
  } catch {
    return null
  }
  return composed.toJSON()
}

export interface VersionSummary {
  v: number
  t: number
  type: 'snapshot' | 'patch'
}

/** Timestamped versions, newest first, for the history sidebar. */
export function versionsOf(entries: JournalEntry[]): VersionSummary[] {
  return entries
    .map((entry) => ({ v: entry.v, t: entry.t, type: entry.type }))
    .sort((a, b) => b.v - a.v)
}

/** Whether a snapshot is due, given how many patches followed the last one. */
export function snapshotDue(patchesSinceSnapshot: number): boolean {
  return patchesSinceSnapshot >= SNAPSHOT_EVERY
}

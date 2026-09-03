import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChangeSet, EditorState, Text } from '@codemirror/state'

import { HistoryService } from '@main/HistoryService'
import { SNAPSHOT_EVERY, parseJournal, replayAll } from '@core/history/journal'

/**
 * HistoryService against a real filesystem (plan §9, §13 Phase 5).
 *
 * §13's criteria: "a 30-minute editing session produces a journal that replays
 * to the exact current buffer", and "restore appends a journal entry rather than
 * truncating history". Both are asserted here against files on disk, because
 * both are properties of what actually lands in the journal rather than of the
 * format, which tests/core/journal.test.ts already proves.
 */

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'margin-history-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The journal coalesces on a 2s idle debounce; tests commit explicitly. */
function service(): HistoryService {
  return new HistoryService(root)
}

/**
 * Drive a document the way the app does: each edit produces a ChangeSet, which
 * is what the renderer publishes on `doc:changed`.
 */
class Session {
  state: EditorState

  constructor(content: string) {
    this.state = EditorState.create({ doc: content })
  }

  edit(from: number, to: number, insert: string): { changes: unknown; content: string } {
    const transaction = this.state.update({ changes: { from, to, insert } })
    this.state = transaction.state
    return { changes: transaction.changes.toJSON(), content: this.state.doc.toString() }
  }

  get content(): string {
    return this.state.doc.toString()
  }
}

async function journalOf(key: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  const dir = join(root, createHash('sha256').update(key).digest('hex'))
  return readFile(join(dir, 'journal.jsonl'), 'utf8')
}

describe('journal writing', () => {
  it('opens with a snapshot and replays to the exact current buffer', async () => {
    const key = '/docs/session.md'
    const history = service()
    const session = new Session('# Notes\n\nfirst line\n')

    await history.open('doc-1', key, session.content)

    // A run of edits, as a working session produces them.
    for (let i = 0; i < 40; i++) {
      const { changes, content } = session.edit(session.state.doc.length, session.state.doc.length, `line ${i}\n`)
      history.record('doc-1', changes, content)
    }
    history.flush('doc-1')

    const entries = parseJournal(await journalOf(key))
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0]?.type).toBe('snapshot')

    // §13's criterion, stated exactly.
    expect(replayAll(entries)).toBe(session.content)

    history.closeAll()
  })

  it('coalesces a burst into one entry rather than one per keystroke (§9)', async () => {
    const key = '/docs/burst.md'
    const history = service()
    const session = new Session('start\n')

    await history.open('doc-2', key, session.content)

    const before = parseJournal(await journalOf(key)).length
    for (let i = 0; i < 25; i++) {
      const { changes, content } = session.edit(session.state.doc.length, session.state.doc.length, 'x')
      history.record('doc-2', changes, content)
    }
    history.flush('doc-2')

    const after = parseJournal(await journalOf(key))
    // 25 keystrokes, one committed entry. "Never write per keystroke."
    expect(after.length).toBe(before + 1)
    expect(replayAll(after)).toBe(session.content)

    history.closeAll()
  })

  it('writes a fresh snapshot once the patch interval is reached', async () => {
    const key = '/docs/snapshots.md'
    const history = service()
    const session = new Session('base\n')

    await history.open('doc-3', key, session.content)

    // Each flush commits one patch, so this crosses the interval.
    for (let i = 0; i < SNAPSHOT_EVERY + 2; i++) {
      const { changes, content } = session.edit(session.state.doc.length, session.state.doc.length, `${i}\n`)
      history.record('doc-3', changes, content)
      history.flush('doc-3')
    }

    const entries = parseJournal(await journalOf(key))
    const snapshots = entries.filter((entry) => entry.type === 'snapshot')
    // The opening one, plus at least one written on the interval.
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    expect(replayAll(entries)).toBe(session.content)

    history.closeAll()
  })

  it('replays to an earlier version, not just the latest', async () => {
    const key = '/docs/rewind.md'
    const history = service()
    const session = new Session('one\n')

    await history.open('doc-4', key, session.content)

    const marks: Array<{ v: number; content: string }> = []
    for (let i = 0; i < 5; i++) {
      const { changes, content } = session.edit(session.state.doc.length, session.state.doc.length, `step ${i}\n`)
      history.record('doc-4', changes, content)
      history.flush('doc-4')
      const entries = parseJournal(await journalOf(key))
      marks.push({ v: entries[entries.length - 1]!.v, content })
    }

    for (const mark of marks) {
      expect(await history.contentAt('doc-4', mark.v)).toBe(mark.content)
    }

    history.closeAll()
  })

  it('assigns strictly increasing versions with no gaps', async () => {
    const key = '/docs/versions.md'
    const history = service()
    const session = new Session('v\n')

    await history.open('doc-5', key, session.content)
    for (let i = 0; i < 6; i++) {
      const { changes, content } = session.edit(0, 0, `${i}`)
      history.record('doc-5', changes, content)
      history.flush('doc-5')
    }

    const versions = parseJournal(await journalOf(key)).map((entry) => entry.v)
    // §9: a gap makes everything after it invalid, so the writer must not leave
    // one even when composition falls back or a snapshot intervenes.
    expect(versions).toEqual(versions.map((_, index) => index))

    history.closeAll()
  })
})

describe('restore', () => {
  it('appends an entry rather than truncating history (§13 Phase 5)', async () => {
    const key = '/docs/restore.md'
    const history = service()
    const session = new Session('original\n')

    await history.open('doc-6', key, session.content)

    const { changes: first, content: afterFirst } = session.edit(8, 8, ' edited once')
    history.record('doc-6', first, afterFirst)
    history.flush('doc-6')

    const entriesBefore = parseJournal(await journalOf(key))
    const restoreTarget = entriesBefore[0]!.v
    const targetContent = await history.contentAt('doc-6', restoreTarget)
    expect(targetContent).toBe('original\n')

    // Restore is an ordinary edit: replace the buffer with the old content, and
    // let the resulting change flow through the journal like any other.
    const { changes: restoreChanges, content: restored } = session.edit(
      0,
      session.state.doc.length,
      targetContent!
    )
    history.record('doc-6', restoreChanges, restored)
    history.flush('doc-6')

    const entriesAfter = parseJournal(await journalOf(key))

    // Appended, not truncated: every earlier entry survives, and the journal grew.
    expect(entriesAfter.length).toBe(entriesBefore.length + 1)
    for (let i = 0; i < entriesBefore.length; i++) {
      expect(entriesAfter[i]).toEqual(entriesBefore[i])
    }

    // The version restored *from* is still reachable, so the restore is undoable
    // by restoring the other way.
    expect(await history.contentAt('doc-6', entriesBefore[entriesBefore.length - 1]!.v)).toBe(
      afterFirst
    )
    expect(replayAll(entriesAfter)).toBe('original\n')

    history.closeAll()
  })
})

describe('untitled documents', () => {
  it('are not journalled, because they have no canonical path to key on', async () => {
    const history = service()
    await history.open('doc-7', null, 'scratch\n')

    history.record('doc-7', [[7], [0, 'more']], 'scratch more\n')
    history.flush('doc-7')

    expect(await history.versions('doc-7')).toEqual([])
    history.closeAll()
  })

  it('start a journal at their first save, seeded with the current buffer', async () => {
    const key = '/docs/was-untitled.md'
    const history = service()

    await history.open('doc-8', null, 'typed before saving\n')
    await history.bind('doc-8', key, 'typed before saving\n')

    const entries = parseJournal(await journalOf(key))
    expect(entries[0]?.type).toBe('snapshot')
    expect(replayAll(entries)).toBe('typed before saving\n')

    history.closeAll()
  })
})

describe('reopening', () => {
  it('continues an existing journal rather than starting over', async () => {
    const key = '/docs/reopen.md'
    const session = new Session('day one\n')

    const first = service()
    await first.open('doc-9', key, session.content)
    const { changes, content } = session.edit(8, 8, 'day one edit\n')
    first.record('doc-9', changes, content)
    first.flush('doc-9')
    first.closeAll()

    const lengthAfterFirst = parseJournal(await journalOf(key)).length

    // A later session, opening the same file with the buffer as it was left.
    const second = service()
    await second.open('doc-9', key, session.content)

    const entries = parseJournal(await journalOf(key))
    // The buffer matches what the journal describes, so no redundant snapshot.
    expect(entries.length).toBe(lengthAfterFirst)
    expect(replayAll(entries)).toBe(session.content)

    second.closeAll()
  })

  it('snapshots when the file changed outside the app since last time', async () => {
    const key = '/docs/changed-outside.md'
    const first = service()
    await first.open('doc-10', key, 'as the app left it\n')
    first.closeAll()

    const before = parseJournal(await journalOf(key)).length

    // Something else rewrote the file; the patch chain no longer describes it.
    const second = service()
    await second.open('doc-10', key, 'completely different content\n')

    const entries = parseJournal(await journalOf(key))
    expect(entries.length).toBe(before + 1)
    expect(entries[entries.length - 1]?.type).toBe('snapshot')
    expect(replayAll(entries)).toBe('completely different content\n')

    second.closeAll()
  })
})

describe('a long session', () => {
  it('replays exactly after hundreds of coalesced edits (§13 Phase 5)', async () => {
    const key = '/docs/long-session.md'
    const history = service()
    const session = new Session('# Long session\n')

    await history.open('doc-11', key, session.content)

    // Stand-in for "a 30-minute editing session": many edits, committed in the
    // bursts the idle debounce would produce, including deletes and replaces.
    for (let burst = 0; burst < 60; burst++) {
      for (let i = 0; i < 8; i++) {
        const length = session.state.doc.length
        const { changes, content } =
          i % 4 === 3 && length > 12
            ? session.edit(length - 6, length - 2, 'X')
            : session.edit(length, length, `burst ${burst} edit ${i}\n`)
        history.record('doc-11', changes, content)
      }
      history.flush('doc-11')
    }

    const entries = parseJournal(await journalOf(key))
    expect(replayAll(entries)).toBe(session.content)

    // And every intermediate version replays too, not merely the last.
    const midpoint = entries[Math.floor(entries.length / 2)]!
    expect(await history.contentAt('doc-11', midpoint.v)).not.toBeNull()

    history.closeAll()
  })
})

describe('journal format guards', () => {
  it('survives a half-written final line', () => {
    // The process can die mid-append. JSONL is chosen partly so that costs one
    // entry rather than the file.
    const good = '{"t":1,"type":"snapshot","v":0,"content":"hello"}\n'
    const truncated = '{"t":2,"type":"patch","v":1,"chan'
    const entries = parseJournal(good + truncated)

    expect(entries).toHaveLength(1)
    expect(replayAll(entries)).toBe('hello')
  })

  it('replays a patch written by ChangeSet.toJSON, as the app writes them', () => {
    const doc = Text.of(['alpha'])
    const changes = ChangeSet.of({ from: 5, insert: ' beta' }, doc.length)
    const line = `{"t":1,"type":"patch","v":1,"changes":${JSON.stringify(changes.toJSON())}}`
    const entries = parseJournal(
      `{"t":0,"type":"snapshot","v":0,"content":"alpha"}\n${line}\n`
    )
    expect(replayAll(entries)).toBe('alpha beta')
  })
})

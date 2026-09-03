import { describe, expect, it } from 'vitest'
import { ChangeSet, EditorState, Text } from '@codemirror/state'

/**
 * Journal replay (plan §9, §12).
 *
 * Phase 5 stores edits as serialized CodeMirror ChangeSets rather than as diffs
 * from a third-party library. That decision is only sound if a snapshot plus an
 * ordered run of ChangeSets replays to exactly the final buffer — so the format
 * is proved here, before anything is written to disk in that shape.
 *
 * Uses @codemirror/state only: no view, no DOM.
 */

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const WORDS = ['margin', 'preview', 'editor', 'scroll', '\n', '## heading\n', 'x', '   ']

function randomEdits(seed: number, steps: number): { final: string; patches: unknown[] } {
  const random = rng(seed)
  let state = EditorState.create({ doc: 'initial document\nsecond line\n' })
  const patches: unknown[] = []

  for (let step = 0; step < steps; step++) {
    const length = state.doc.length
    const from = Math.floor(random() * (length + 1))
    const roll = random()

    const transaction =
      roll < 0.6
        ? // insert
          state.update({
            changes: { from, insert: WORDS[Math.floor(random() * WORDS.length)]! }
          })
        : roll < 0.9
          ? // delete
            state.update({
              changes: { from, to: Math.min(length, from + Math.floor(random() * 8)) }
            })
          : // replace
            state.update({
              changes: {
                from,
                to: Math.min(length, from + Math.floor(random() * 5)),
                insert: WORDS[Math.floor(random() * WORDS.length)]!
              }
            })

    patches.push(transaction.changes.toJSON())
    state = transaction.state
  }

  return { final: state.doc.toString(), patches }
}

function replay(snapshot: string, patches: unknown[]): string {
  let doc = Text.of(snapshot.split('\n'))
  for (const patch of patches) {
    doc = ChangeSet.fromJSON(patch).apply(doc)
  }
  return doc.toString()
}

const SNAPSHOT = 'initial document\nsecond line\n'

describe('ChangeSet journal', () => {
  it.each([1, 2, 3, 7, 42, 1337])('replays a random edit sequence exactly (seed %i)', (seed) => {
    const { final, patches } = randomEdits(seed, 120)
    expect(replay(SNAPSHOT, patches)).toBe(final)
  })

  it('survives a round-trip through JSON.stringify, as the journal file will', () => {
    const { final, patches } = randomEdits(99, 60)
    const throughDisk = patches.map((patch) => JSON.parse(JSON.stringify(patch)) as unknown)
    expect(replay(SNAPSHOT, throughDisk)).toBe(final)
  })

  it('is order-dependent — a gap invalidates everything after it', () => {
    const { final, patches } = randomEdits(5, 40)
    const withGap = [...patches.slice(0, 10), ...patches.slice(11)]
    // Either it throws on an out-of-range position or it produces the wrong
    // document. Both are failures; neither may pass silently.
    let result: string | null = null
    try {
      result = replay(SNAPSHOT, withGap)
    } catch {
      result = null
    }
    expect(result).not.toBe(final)
  })

  it('composes patches into one equivalent change, as coalescing will', () => {
    const { final, patches } = randomEdits(11, 50)
    let composed = ChangeSet.fromJSON(patches[0])
    for (const patch of patches.slice(1)) {
      composed = composed.compose(ChangeSet.fromJSON(patch))
    }
    expect(composed.apply(Text.of(SNAPSHOT.split('\n'))).toString()).toBe(final)
  })
})

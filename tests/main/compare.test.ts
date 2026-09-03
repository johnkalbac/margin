import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { diff, presentableDiff } from '@codemirror/merge'

import { readTextFile } from '@main/FileService'
import { encode } from '@core/text/codec'

/**
 * Compare (plan §13 Phase 6).
 *
 * **Done when: diffing two files that differ only in line endings shows no
 * changes.** That criterion is the reason §6 insisted the buffer is normalized
 * to LF on read and the file's own EOL restored on write. If the buffer carried
 * CRLF, every line of a Windows file would diff against the same line of a Unix
 * one — §6 says so directly, and this is where that claim gets checked.
 *
 * The diff itself is `@codemirror/merge`'s, tested through the same read path
 * the app uses. Nothing here needs a view: `diff` is a pure function, which is
 * also why the criterion is assertable without a DOM.
 */

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'margin-compare-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('line endings', () => {
  it('shows no changes between a CRLF file and its LF twin (§13 Phase 6)', async () => {
    const unix = join(dir, 'unix.md')
    const windows = join(dir, 'windows.md')

    const lines = '# Title\n\nfirst paragraph\n\n- one\n- two\n'
    await writeFile(unix, lines)
    await writeFile(windows, lines.replace(/\n/g, '\r\n'))

    const a = await readTextFile(unix)
    const b = await readTextFile(windows)

    // The files genuinely differ on disk...
    expect(a.eol).toBe('LF')
    expect(b.eol).toBe('CRLF')
    expect(a.byteLength).not.toBe(b.byteLength)

    // ...and the buffers do not, so the diff is empty. This is the criterion.
    expect(b.text).toBe(a.text)
    expect(diff(a.text, b.text)).toHaveLength(0)
    expect(presentableDiff(a.text, b.text)).toHaveLength(0)
  })

  it('shows no changes for a mixed-EOL file against a clean one', async () => {
    // The nastier version: a file some tool half-converted.
    const clean = join(dir, 'clean.md')
    const mixed = join(dir, 'mixed.md')

    await writeFile(clean, 'alpha\nbeta\ngamma\n')
    await writeFile(mixed, 'alpha\r\nbeta\ngamma\r\n')

    const a = await readTextFile(clean)
    const b = await readTextFile(mixed)

    expect(b.mixedEol).toBe(true)
    expect(diff(a.text, b.text)).toHaveLength(0)
  })

  it('shows no changes across encodings that hold the same text', async () => {
    // Same characters, different bytes. Compare works on decoded text, so the
    // encoding is not a difference either.
    const utf8 = join(dir, 'utf8.md')
    const cp1252 = join(dir, 'cp1252.md')

    const text = 'café naïve\n'
    await writeFile(utf8, encode(text, 'utf8'))
    await writeFile(cp1252, encode(text, 'windows1252'))

    const a = await readTextFile(utf8)
    const b = await readTextFile(cp1252, 'windows1252')

    expect(a.encoding).toBe('utf8')
    expect(b.encoding).toBe('windows1252')
    expect(diff(a.text, b.text)).toHaveLength(0)
  })

  it('still reports a real edit, so the normalization is not hiding changes', async () => {
    // The guard on the three tests above: if normalization were simply
    // flattening everything, this would pass too, and it must not.
    const before = join(dir, 'before.md')
    const after = join(dir, 'after.md')

    await writeFile(before, 'alpha\r\nbeta\r\ngamma\r\n')
    await writeFile(after, 'alpha\nBETA\ngamma\n')

    const a = await readTextFile(before)
    const b = await readTextFile(after)

    const changes = diff(a.text, b.text)
    expect(changes.length).toBeGreaterThan(0)
    // And only the line that actually changed.
    expect(a.text.split('\n')[0]).toBe(b.text.split('\n')[0])
    expect(a.text.split('\n')[2]).toBe(b.text.split('\n')[2])
  })

  it('reports a trailing-newline difference, which is a real difference', async () => {
    // Not an EOL *style* difference: one file has a final newline and the other
    // does not, which changes the text and should show.
    const withNewline = join(dir, 'with-newline.md')
    const without = join(dir, 'without-newline.md')

    await writeFile(withNewline, 'one line\n')
    await writeFile(without, 'one line')

    const a = await readTextFile(withNewline)
    const b = await readTextFile(without)

    expect(diff(a.text, b.text).length).toBeGreaterThan(0)
  })
})

describe('comparing against a history version', () => {
  it('diffs the replayed text the same way it diffs a file', () => {
    // History replays to a plain string, so compare treats a version and a file
    // identically — there is one diff path, not two.
    const current = '# Notes\n\nrewritten paragraph\n'
    const historical = '# Notes\n\noriginal paragraph\n'

    const changes = diff(historical, current)
    expect(changes.length).toBeGreaterThan(0)
    expect(diff(historical, historical)).toHaveLength(0)
  })
})

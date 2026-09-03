import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FileWatcher, hashOnDisk, readTextFile, writeTextFile } from '@main/FileService'
import { encode } from '@core/text/codec'

/**
 * FileService against a real filesystem (plan §6, §8, §12).
 *
 * The watcher assertions are the ones that matter most: §8 warns that the app's
 * own writes fire the watcher, and that treating them as external changes turns
 * every save into a spurious "this file changed" prompt — and, once Phase 4 adds
 * auto-save, into a loop the app fights itself in.
 */

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'margin-files-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** The watcher debounces and then re-hashes, so assertions have to wait it out. */
function settle(ms = 400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('readTextFile', () => {
  it('normalizes CRLF into the buffer while reporting the file style', async () => {
    const path = join(dir, 'crlf.md')
    await writeFile(path, 'one\r\ntwo\r\nthree\r\n')

    const snapshot = await readTextFile(path)
    // The buffer never carries CR: CodeMirror would strip it anyway, and
    // DocMeta.eol is what restores the file's own style on write.
    expect(snapshot.text).toBe('one\ntwo\nthree\n')
    expect(snapshot.eol).toBe('CRLF')
    expect(snapshot.mixedEol).toBe(false)
  })

  it('flags a mixed-EOL file and takes the majority', async () => {
    const path = join(dir, 'mixed.md')
    await writeFile(path, 'a\r\nb\r\nc\nd\r\n')

    const snapshot = await readTextFile(path)
    expect(snapshot.eol).toBe('CRLF')
    expect(snapshot.mixedEol).toBe(true)
  })

  it('reports how the encoding was decided, so the UI can admit to a guess', async () => {
    const bom = join(dir, 'bom.md')
    await writeFile(bom, encode('# with a mark\n', 'utf8bom'))
    expect((await readTextFile(bom)).encodingSource).toBe('bom')

    const plain = join(dir, 'plain.md')
    await writeFile(plain, '# ordinary ascii prose\n')
    // ASCII resolves to UTF-8 with no ambiguity worth warning about.
    expect((await readTextFile(plain)).encoding).toBe('utf8')
  })

  it('honours an explicit override instead of detecting', async () => {
    const path = join(dir, 'override.md')
    // 0xE9 is e-acute in Windows-1252 and invalid on its own in UTF-8.
    await writeFile(path, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))

    const forced = await readTextFile(path, 'windows1252')
    expect(forced.text).toBe('café\n')
    expect(forced.encodingSource).toBe('override')
  })
})

describe('writeTextFile', () => {
  it('reapplies the document EOL rather than the buffer LF', async () => {
    const path = join(dir, 'written.md')
    await writeTextFile(path, 'one\ntwo\n', 'utf8', 'CRLF')

    // Read raw: the point is the bytes, not what a decoder makes of them.
    expect(await readFile(path, 'utf8')).toBe('one\r\ntwo\r\n')
  })

  it('writes no BOM for utf8 and one for utf8bom', async () => {
    const plain = join(dir, 'nobom.md')
    const marked = join(dir, 'yesbom.md')
    await writeTextFile(plain, 'x\n', 'utf8', 'LF')
    await writeTextFile(marked, 'x\n', 'utf8bom', 'LF')

    expect((await readFile(plain))[0]).not.toBe(0xef)
    expect([...(await readFile(marked)).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })

  it('reports a hash that matches what is actually on disk', async () => {
    const path = join(dir, 'hashed.md')
    const result = await writeTextFile(path, 'content\n', 'utf8', 'LF')
    expect(await hashOnDisk(path)).toBe(result.hash)
  })
})

describe('FileWatcher', () => {
  it('stays silent for the application writing the file itself (§8)', async () => {
    const path = join(dir, 'selfwrite.md')
    await writeFile(path, 'original\n')

    const seen: string[] = []
    const watcher = new FileWatcher((changed) => seen.push(changed), 20)
    const initial = await readTextFile(path)
    watcher.watchFile(path, initial.hash)

    // Exactly what a save does: write, then tell the watcher what was written.
    const result = await writeTextFile(path, 'edited by the app\n', 'utf8', 'LF')
    watcher.noteOwnWrite(path, result.hash)

    await settle()
    watcher.dispose()

    expect(seen).toEqual([])
  })

  it('reports a change made by something else', async () => {
    const path = join(dir, 'external.md')
    await writeFile(path, 'original\n')

    const seen: string[] = []
    const watcher = new FileWatcher((changed) => seen.push(changed), 20)
    watcher.watchFile(path, (await readTextFile(path)).hash)

    // Another program writes; the app was never told.
    await writeFile(path, 'edited by someone else\n')

    await settle()
    watcher.dispose()

    expect(seen).toEqual([path])
  })

  it('ignores a write that leaves the bytes identical', async () => {
    const path = join(dir, 'noop-write.md')
    await writeFile(path, 'same\n')

    const seen: string[] = []
    const watcher = new FileWatcher((changed) => seen.push(changed), 20)
    watcher.watchFile(path, (await readTextFile(path)).hash)

    // A touch, or a tool that rewrites a file with the content it already had.
    // Suppression is by hash rather than by event, so this is not news.
    await writeFile(path, 'same\n')

    await settle()
    watcher.dispose()

    expect(seen).toEqual([])
  })

  it('stops reporting once unwatched', async () => {
    const path = join(dir, 'unwatched.md')
    await writeFile(path, 'original\n')

    const seen: string[] = []
    const watcher = new FileWatcher((changed) => seen.push(changed), 20)
    watcher.watchFile(path, (await readTextFile(path)).hash)
    watcher.unwatch(path)

    await writeFile(path, 'changed after unwatch\n')

    await settle()
    watcher.dispose()

    expect(seen).toEqual([])
  })

  it('stays silent through a run of auto-saves (§13 Phase 4)', async () => {
    // "Auto-save does not trigger the external-change prompt for its own
    // writes." Auto-save writes repeatedly and unattended, so one suppressed
    // write is not enough -- a race between the debounce and the watcher would
    // show up here and not in the single-write case.
    const path = join(dir, 'autosave.md')
    await writeFile(path, 'draft\n')

    const seen: string[] = []
    const watcher = new FileWatcher((changed) => seen.push(changed), 20)
    watcher.watchFile(path, (await readTextFile(path)).hash)

    for (let pass = 1; pass <= 5; pass++) {
      const result = await writeTextFile(path, `draft revision ${pass}\n`, 'utf8', 'LF')
      watcher.noteOwnWrite(path, result.hash)
      await settle(60)
    }

    await settle()
    watcher.dispose()

    expect(seen).toEqual([])
    expect(await readFile(path, 'utf8')).toBe('draft revision 5\n')
  })

  it('still reports an outside edit made between two auto-saves', async () => {
    // The suppression must not be a blanket mute: a file edited elsewhere while
    // auto-save is running is exactly when the user most needs to be told.
    const path = join(dir, 'autosave-interleaved.md')
    await writeFile(path, 'draft\n')

    const seen: string[] = []
    const watcher = new FileWatcher((changed) => seen.push(changed), 20)
    watcher.watchFile(path, (await readTextFile(path)).hash)

    const own = await writeTextFile(path, 'app wrote this\n', 'utf8', 'LF')
    watcher.noteOwnWrite(path, own.hash)
    await settle(60)

    await writeFile(path, 'someone else wrote this\n')
    await settle()
    watcher.dispose()

    expect(seen).toEqual([path])
  })

  it('does not throw on a path that cannot be watched', () => {
    const watcher = new FileWatcher(() => {})
    // A missing file is not a reason to fail an open.
    expect(() => watcher.watchFile(join(dir, 'does-not-exist.md'), 'abc')).not.toThrow()
    watcher.dispose()
  })
})

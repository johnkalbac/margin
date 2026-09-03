import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DocumentRegistry, resolveKey } from '@main/DocumentRegistry'
import { canonicalKey, isCaseInsensitive } from '@core/files/canonicalPath'
import { readTextFile, writeTextFile } from '@main/FileService'

/**
 * Registry invariants (plan §2, §12).
 *
 * "Opening the same path twice never yields two docIds, including through
 * symlinks and case-variant paths." Two tabs over one file is how an editor
 * loses a user's work, so this runs against a real filesystem rather than a
 * mocked one.
 */

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'margin-registry-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** The open path, condensed: reuse the document at this key or adopt a new one. */
async function adopt(registry: DocumentRegistry, path: string): Promise<string> {
  const key = await resolveKey(path)
  const existing = registry.findByKey(key)
  if (existing) return existing.meta.id

  const snapshot = await readTextFile(path)
  return registry.adopt({
    path,
    key,
    text: snapshot.text,
    encoding: snapshot.encoding,
    eol: snapshot.eol,
    mixedEol: snapshot.mixedEol,
    hash: snapshot.hash,
    mtimeMs: snapshot.mtimeMs
  }).id
}

describe('canonical keys', () => {
  it('collapses a path reached through . and ..', async () => {
    const path = join(dir, 'notes.md')
    await writeFile(path, '# notes\n')

    const direct = await resolveKey(path)
    const indirect = await resolveKey(join(dir, 'sub', '..', 'notes.md'))
    expect(indirect).toBe(direct)
  })

  it('collapses a symlink onto its target', async () => {
    const target = join(dir, 'target.md')
    const link = join(dir, 'link.md')
    await writeFile(target, '# target\n')

    try {
      await symlink(target, link)
    } catch {
      // Windows refuses symlink creation without developer mode or elevation.
      // The invariant still holds there; it just cannot be demonstrated here.
      return
    }

    expect(await resolveKey(link)).toBe(await resolveKey(target))
  })

  it('folds case only where the filesystem folds it', () => {
    expect(canonicalKey('C:\\Notes\\A.MD', 'win32')).toBe(canonicalKey('c:/notes/a.md', 'win32'))

    // Linux distinguishes these, and collapsing them there would be wrong.
    expect(canonicalKey('/home/me/A.md', 'linux')).not.toBe(canonicalKey('/home/me/a.md', 'linux'))
    expect(isCaseInsensitive('linux')).toBe(false)
    expect(isCaseInsensitive('win32')).toBe(true)
    expect(isCaseInsensitive('darwin')).toBe(true)
  })

  it('ignores a trailing separator without eating the root', () => {
    expect(canonicalKey('/home/me/notes.md/', 'linux')).toBe('/home/me/notes.md')
    expect(canonicalKey('/', 'linux')).toBe('/')
  })
})

describe('one document per file', () => {
  it('returns the same docId for the same path opened twice', async () => {
    const registry = new DocumentRegistry()
    const path = join(dir, 'twice.md')
    await writeFile(path, '# twice\n')

    expect(await adopt(registry, path)).toBe(await adopt(registry, path))
    expect(registry.all()).toHaveLength(1)
  })

  it('returns the same docId through a case variant where case is folded', async () => {
    if (!isCaseInsensitive(process.platform)) return // On Linux these are two files.

    const registry = new DocumentRegistry()
    const path = join(dir, 'CaseTest.md')
    await writeFile(path, '# case\n')

    const first = await adopt(registry, path)
    expect(await adopt(registry, join(dir, 'casetest.md'))).toBe(first)
    expect(registry.all()).toHaveLength(1)
  })

  it('keeps distinct files distinct', async () => {
    const registry = new DocumentRegistry()
    const a = join(dir, 'a.md')
    const b = join(dir, 'b.md')
    await writeFile(a, '# a\n')
    await writeFile(b, '# b\n')

    expect(await adopt(registry, a)).not.toBe(await adopt(registry, b))
    expect(registry.all()).toHaveLength(2)
  })

  it('frees the key when a document is closed, so the file can reopen', async () => {
    const registry = new DocumentRegistry()
    const path = join(dir, 'reopen.md')
    await writeFile(path, '# reopen\n')

    const first = await adopt(registry, path)
    registry.remove(first)
    expect(registry.all()).toHaveLength(0)

    const second = await adopt(registry, path)
    expect(second).not.toBe(first)
    expect(registry.all()).toHaveLength(1)
  })
})

describe('untitled documents', () => {
  it('never collapse into each other', () => {
    const registry = new DocumentRegistry()
    const first = registry.createUntitled()
    const second = registry.createUntitled()

    expect(first.id).not.toBe(second.id)
    expect(first.name).toBe('Untitled')
    expect(second.name).toBe('Untitled 2')
    expect(registry.all()).toHaveLength(2)
  })

  it('take a key once bound to a path, and collide from then on', async () => {
    const registry = new DocumentRegistry()
    const path = join(dir, 'bound.md')
    await writeFile(path, '# bound\n')

    const untitled = registry.createUntitled()
    const key = await resolveKey(path)
    registry.bindPath(untitled.id, path, key)

    expect(registry.findByKey(key)?.meta.id).toBe(untitled.id)
    expect(registry.meta(untitled.id)?.name).toBe('bound.md')
  })

  it('releases the old key on Save As to a different path', async () => {
    const registry = new DocumentRegistry()
    const from = join(dir, 'from.md')
    const to = join(dir, 'to.md')
    await writeFile(from, '# from\n')
    await writeFile(to, '# to\n')

    const id = await adopt(registry, from)
    const fromKey = await resolveKey(from)
    const toKey = await resolveKey(to)

    registry.bindPath(id, to, toKey)

    // The original path is free again; the document answers to the new one.
    expect(registry.findByKey(fromKey)).toBeUndefined()
    expect(registry.findByKey(toKey)?.meta.id).toBe(id)
  })
})

describe('read and write through the registry', () => {
  it('preserves encoding and EOL across a save the user did not retype', async () => {
    const registry = new DocumentRegistry()
    const path = join(dir, 'preserve.md')

    // A CRLF Windows-1252 file, written as the raw bytes it would hold on disk.
    await writeFile(path, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a]))

    const id = await adopt(registry, path)
    const meta = registry.meta(id)
    expect(meta?.encoding).toBe('windows1252')
    expect(meta?.eol).toBe('CRLF')

    const snapshot = await readTextFile(path)
    await writeTextFile(path, snapshot.text, meta!.encoding, meta!.eol)

    // Byte-identical: same hash as before the save.
    expect((await readTextFile(path)).hash).toBe(snapshot.hash)
  })

  it('keys a path that does not exist yet, for Save As to a new file', async () => {
    const missing = join(dir, 'not-created-yet.md')
    expect(await resolveKey(missing)).toBe(canonicalKey(missing, process.platform))
  })
})

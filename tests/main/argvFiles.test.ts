import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OPENABLE_EXTENSIONS, pathsFromArgv } from '@main/argvFiles'

/**
 * argv → the files to open (the Windows 'Open with > Margin' plumbing).
 *
 * The filter is the only thing standing between whatever the OS or a shell put
 * in argv and FileService reading it, so its rejects matter more than its
 * accepts: a directory, the dev-mode app dir, or a gone-between-click-and-read
 * path reaching openPath is how a double-click turns into an error dialog.
 * This runs against a real temp filesystem — a mocked `statSync` would only
 * test that we call it.
 */

let dir: string
let note: string
let readme: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'margin-argv-'))
  note = join(dir, 'note.md')
  readme = join(dir, 'README.markdown')
  await writeFile(note, '# note\n')
  await writeFile(readme, '# readme\n')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('pathsFromArgv', () => {
  it('keeps a markdown file the OS appended to the executable', () => {
    // Windows launches `'...Margin.exe' C:\Users\me\note.md` for 'Open with'
    // and double-clicks; argv[0] itself must never be mistaken for a document.
    expect(pathsFromArgv(['C:\\Program Files\\Margin\\Margin.exe', note])).toEqual([note])
  })

  it('keeps every openable path, in argv order', () => {
    expect(pathsFromArgv(['Margin.exe', readme, note])).toEqual([readme, note])
  })

  it('accepts every registered extension, case-insensitively', async () => {
    for (const ext of OPENABLE_EXTENSIONS) {
      await writeFile(join(dir, `doc.${ext}`), 'x')
      await writeFile(join(dir, `DOC.${ext.toUpperCase()}`), 'x')
    }
    const accepted = OPENABLE_EXTENSIONS.flatMap((ext) => [
      join(dir, `doc.${ext}`),
      join(dir, `DOC.${ext.toUpperCase()}`)
    ])
    expect(pathsFromArgv(['electron', ...accepted])).toEqual(accepted)
  })

  it('drops tokens with no openable extension', () => {
    expect(pathsFromArgv(['Margin.exe', join(dir, 'archive.zip')])).toEqual([])
    // Exists, but no extension at all — a pipe through the shell, not a document.
    expect(pathsFromArgv(['Margin.exe', dir])).toEqual([])
  })

  it('drops a directory named like a document', async () => {
    // The association could point at a folder, and someone will make one:
    // `mkdir looks.md` is exactly the trap the isFile() check exists for.
    const mdDir = join(dir, 'looks.md')
    await mkdir(mdDir)
    expect(pathsFromArgv(['electron', mdDir])).toEqual([])
  })

  it('drops the dev-mode app directory at argv[1]', () => {
    // `npm run dev` runs `electron . path/to/file.md`: argv[1] is the project
    // directory (or a relative `.`), and neither may reach FileService.
    expect(pathsFromArgv([process.execPath, process.cwd(), note])).toEqual([note])
    expect(pathsFromArgv([process.execPath, process.cwd()])).toEqual([])
  })

  it('drops flags and bare separators', () => {
    expect(pathsFromArgv(['Margin.exe', '--inspect', '--no-sandbox', '--', note])).toEqual([note])
    expect(pathsFromArgv(['electron', '-e', 'console.log(1)'])).toEqual([])
  })

  it('drops URLs, even ones ending in a markdown extension', () => {
    // `https://x/readme.md` passes the extension check on its face; resolving
    // it would produce a nonsense relative path, so the scheme is rejected first.
    expect(pathsFromArgv(['Margin.exe', 'https://example.com/readme.md'])).toEqual([])
    expect(pathsFromArgv(['Margin.exe', 'file:///home/user/note.md'])).toEqual([])
    expect(pathsFromArgv(['Margin.exe', 'margin://open/thing'])).toEqual([])
  })

  it('drops paths that do not exist', () => {
    // Deleted between the click and the launch, or a stale recent entry.
    expect(pathsFromArgv(['Margin.exe', join(dir, 'gone.md')])).toEqual([])
  })

  it('handles an empty argv and a bare executable', () => {
    expect(pathsFromArgv([])).toEqual([])
    expect(pathsFromArgv(['Margin.exe'])).toEqual([])
    expect(pathsFromArgv(['electron', ''])).toEqual([])
  })
})

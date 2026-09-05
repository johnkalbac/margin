// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import { droppedPaths } from '@renderer/files/drop'

/**
 * The drop filter, pure.
 *
 * jsdom's File constructor makes a real File with a name but no disk backing,
 * which is exactly the shape the pathless guard exists for — so pathForFile is
 * injected and the tests decide which Files "have" a path. The rules that
 * matter to the user: right types only, case-insensitively; drops of text or
 * pathless junk open nothing; and a double-dropped file is one tab.
 */

function file(name: string): File {
  return new File(['x'], name, { type: 'text/markdown' })
}

describe('droppedPaths', () => {
  it('keeps openable files in drop order', () => {
    const paths = new Map([
      ['a.md', '/tmp/a.md'],
      ['b.txt', '/tmp/b.txt'],
      ['notes.markdown', '/tmp/notes.markdown']
    ])
    const files = [file('notes.markdown'), file('b.txt'), file('a.md')]

    expect(droppedPaths(files, (f) => paths.get(f.name) ?? '')).toEqual([
      '/tmp/notes.markdown',
      '/tmp/b.txt',
      '/tmp/a.md'
    ])
  })

  it('matches extensions case-insensitively (macOS writes README.MD)', () => {
    const paths = droppedPaths([file('README.MD'), file('notes.Txt')], (f) => `/tmp/${f.name}`)
    expect(paths).toEqual(['/tmp/README.MD', '/tmp/notes.Txt'])
  })

  it('drops files with no disk backing — text drags, pasted clipboard files', () => {
    const files = [file('image.png'), file('a.md')]
    // webUtils yields '' for a synthetic File; the bridge yields '' when it throws.
    expect(droppedPaths(files, (f) => (f.name === 'a.md' ? '/tmp/a.md' : ''))).toEqual(['/tmp/a.md'])
  })

  it('drops the wrong types and extensionless names', () => {
    const paths = droppedPaths(
      [file('image.png'), file('script.ts'), file('archive.zip'), file('Makefile'), file('.md')],
      (f) => `/x/${f.name}`
    )
    // '.md' is a dotfile, not a Markdown file: no extension after the dot.
    expect(paths).toEqual([])
  })

  it('collapses a file dropped twice into one path, keeping first position', () => {
    const paths = droppedPaths(
      [file('b.md'), file('a.md'), file('b.md')],
      (f) => `/tmp/${f.name}`
    )
    expect(paths).toEqual(['/tmp/b.md', '/tmp/a.md'])
  })

  it('takes the extension set from the caller, defaulting to @shared/openable', () => {
    const pathFor = (f: File): string => `/tmp/${f.name}`
    expect(droppedPaths([file('a.rst')], pathFor, ['rst'])).toEqual(['/tmp/a.rst'])
    expect(droppedPaths([file('a.rst')], pathFor)).toEqual([])
    // mkn/mdown-style variants live in the shared list, not a copy here.
    const spy = vi.fn(pathFor)
    droppedPaths([file('a.mkd')], spy)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

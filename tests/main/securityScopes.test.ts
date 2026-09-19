import { describe, expect, it, vi } from 'vitest'

import { SecurityScopes } from '@main/securityScopes'

/**
 * Sandbox grants for the Mac App Store build. The rule under test is the one
 * that keeps a document writable: a grant is taken once per path, held until
 * released, and given back exactly once — never while its document is open.
 */

function scopes(): { scopes: SecurityScopes; start: ReturnType<typeof vi.fn>; stops: string[] } {
  const stops: string[] = []
  const start = vi.fn((bookmark: string) => () => stops.push(bookmark))
  return { scopes: new SecurityScopes(start), start, stops }
}

describe('SecurityScopes', () => {
  it('redeems a bookmark once per path, however often the path is opened', () => {
    const { scopes: s, start } = scopes()
    s.acquire('/a.md', 'bm-a')
    s.acquire('/a.md', 'bm-a')

    expect(start).toHaveBeenCalledTimes(1)
    expect(s.holds('/a.md')).toBe(true)
  })

  it('holds the grant until released, then gives it back once', () => {
    const { scopes: s, stops } = scopes()
    s.acquire('/a.md', 'bm-a')
    expect(stops).toEqual([])

    s.release('/a.md')
    s.release('/a.md')
    expect(stops).toEqual(['bm-a'])
    expect(s.holds('/a.md')).toBe(false)
  })

  it('does nothing without a bookmark — a dialog pick needs no redeeming', () => {
    const { scopes: s, start } = scopes()
    s.acquire('/a.md', undefined)
    expect(start).not.toHaveBeenCalled()
    expect(s.holds('/a.md')).toBe(false)
  })

  it('is inert outside a Mac App Store build', () => {
    const s = new SecurityScopes(null)
    s.acquire('/a.md', 'bm-a')
    expect(s.holds('/a.md')).toBe(false)
    expect(() => s.release('/a.md')).not.toThrow()
  })

  it('swallows a stale bookmark, leaving the read to report the failure', () => {
    const s = new SecurityScopes(() => {
      throw new Error('stale')
    })
    expect(() => s.acquire('/a.md', 'old')).not.toThrow()
    expect(s.holds('/a.md')).toBe(false)
  })

  it('releases everything on shutdown', () => {
    const { scopes: s, stops } = scopes()
    s.acquire('/a.md', 'bm-a')
    s.acquire('/b.md', 'bm-b')
    s.releaseAll()
    expect(stops.sort()).toEqual(['bm-a', 'bm-b'])
  })
})

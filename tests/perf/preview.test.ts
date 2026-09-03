// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { renderAndSanitize } from '@core/markdown'
import { patchBlocks } from '@renderer/preview/patch'
import { buildFixture } from '../../perf/fixture'

/**
 * Preview efficiency, on the same 2,000-line fixture the Chromium benchmark uses.
 *
 * The 40ms keystroke-to-preview budget (plan §11) is NOT asserted here. jsdom's
 * HTML parsing and serialization are several times slower than Chromium's, so a
 * wall-clock budget enforced in this environment would be measuring an engine
 * the app does not ship. `npm run perf` measures that budget in Chromium.
 *
 * What this file asserts is the property that makes the budget reachable and
 * that a refactor could silently break: an edit patches a handful of blocks
 * rather than rebuilding the document.
 */

/** Catches catastrophic regressions only — an order of magnitude, not a budget. */
const JSDOM_GUARD_MS = 600

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

describe('preview update', () => {
  const source = buildFixture()

  it('exercises a document of at least 2,000 lines', () => {
    expect(source.split('\n').length).toBeGreaterThanOrEqual(2000)
  })

  it('patches only the blocks an edit touches', () => {
    const host = document.createElement('div')
    document.body.append(host)
    patchBlocks(host, renderAndSanitize(source, 'gfm'))

    const before = Array.from(host.children)
    expect(before.length).toBeGreaterThan(100)

    patchBlocks(host, renderAndSanitize(source.replace('Section 50', 'Section fifty'), 'gfm'))
    const after = Array.from(host.children)

    const replaced = after.filter((node, index) => node !== before[index]).length
    expect(replaced).toBeGreaterThan(0)
    // Editing one heading must not rebuild the document — that is what preserves
    // preview scroll position, decoded images, and the user's text selection.
    expect(replaced).toBeLessThan(5)
  })

  it('leaves the document untouched when nothing changed', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const html = renderAndSanitize(source, 'gfm')
    patchBlocks(host, html)

    const before = Array.from(host.children)
    patchBlocks(host, html)
    expect(Array.from(host.children)).toEqual(before)
  })

  it('completes a full update without pathological slowdown', () => {
    const host = document.createElement('div')
    document.body.append(host)
    patchBlocks(host, renderAndSanitize(source, 'gfm'))

    const samples: number[] = []
    for (let run = 0; run < 5; run++) {
      const edited = source.replace('# Performance fixture', `# Performance fixture ${run}`)
      const start = performance.now()
      patchBlocks(host, renderAndSanitize(edited, 'gfm'))
      samples.push(performance.now() - start)
    }

    const result = median(samples)
    console.log(`  jsdom preview update: median ${result.toFixed(1)}ms (Chromium budget: npm run perf)`)
    expect(result).toBeLessThan(JSDOM_GUARD_MS)
  })
})

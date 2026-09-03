/**
 * Preview benchmark, run inside the real renderer.
 *
 * Measures the whole path a keystroke triggers — markdown-it parse, DOMPurify
 * sanitize, block-level patch — against a 2,000-line document. Excludes the
 * 40ms debounce ahead of it, which is a deliberate delay rather than work.
 */
import { renderAndSanitize } from '@core/markdown'
import { patchBlocks } from '@renderer/preview/patch'
import { buildFixture } from './fixture'

const source = buildFixture()

export interface BenchResult {
  lines: number
  samples: number[]
  median: number
  min: number
  max: number
}

function runBench(runs = 15): BenchResult {
  const host = document.getElementById('host') as HTMLElement

  // Warm up: the first pass pays for parser construction and JIT.
  for (let i = 0; i < 3; i++) patchBlocks(host, renderAndSanitize(source, 'gfm'))

  const samples: number[] = []
  for (let run = 0; run < runs; run++) {
    // One character differs, as with a keystroke; everything else is stable.
    const edited = source.replace('# Performance fixture', `# Performance fixture ${run}`)
    const start = performance.now()
    patchBlocks(host, renderAndSanitize(edited, 'gfm'))
    samples.push(performance.now() - start)
  }

  const sorted = [...samples].sort((a, b) => a - b)
  return {
    lines: source.split('\n').length,
    samples,
    median: sorted[Math.floor(sorted.length / 2)]!,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!
  }
}

declare global {
  interface Window {
    runBench: typeof runBench
  }
}

window.runBench = runBench

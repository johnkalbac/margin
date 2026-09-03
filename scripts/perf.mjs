#!/usr/bin/env node
/**
 * Preview performance budget, measured in the shipping engine (plan §11).
 *
 * Builds perf/ as a standalone page, loads it in an offscreen Electron window,
 * and asserts the median keystroke-to-preview update against the budget. jsdom
 * cannot stand in for this: its HTML parsing and serialization are far slower
 * than Chromium's, so a budget enforced there would measure the wrong engine.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BUDGET_MS = 40
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'

console.log('Building benchmark page…')
execFileSync('npx', ['vite', 'build', '--config', 'perf/vite.config.ts', '--logLevel', 'warn'], {
  cwd: root,
  stdio: 'inherit',
  shell: isWindows
})

console.log('Measuring in Chromium…')
const result = spawnSync('npx', ['electron', 'scripts/perf-runner.cjs'], {
  cwd: root,
  encoding: 'utf8',
  shell: isWindows,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
})

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
const match = output.match(/BENCH_RESULT (\{.*\})/)

if (!match) {
  console.error(output)
  console.error('Benchmark produced no result.')
  process.exit(1)
}

const bench = JSON.parse(match[1])

console.log(`\n  document        ${bench.lines.toLocaleString()} lines`)
console.log(`  median          ${bench.median.toFixed(1)}ms`)
console.log(`  fastest         ${bench.min.toFixed(1)}ms`)
console.log(`  slowest         ${bench.max.toFixed(1)}ms`)
console.log(`  budget          ${BUDGET_MS}ms`)

if (bench.median >= BUDGET_MS) {
  console.error(`\n✗ Over budget: ${bench.median.toFixed(1)}ms >= ${BUDGET_MS}ms`)
  process.exit(1)
}

console.log(`\n✓ Within budget (${((bench.median / BUDGET_MS) * 100).toFixed(0)}% of ${BUDGET_MS}ms)`)

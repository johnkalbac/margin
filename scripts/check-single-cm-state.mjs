#!/usr/bin/env node
/**
 * Plan §1.1 / §12: assert exactly one copy of the CodeMirror packages that use
 * cross-package `instanceof` checks.
 *
 * Two copies of @codemirror/state in the tree make every extension fail with
 * "Unrecognized extension value in extension set" and cost a day to diagnose.
 * This check is cheap; run it in CI and after every dependency change.
 */
import { execFileSync } from 'node:child_process'

const PACKAGES = ['@codemirror/state', '@codemirror/view', '@lezer/common']

/** Walk an `npm ls --json` tree and collect every resolved version of `name`. */
function collectVersions(node, name, found = new Set()) {
  const deps = node?.dependencies
  if (!deps) return found
  for (const [depName, dep] of Object.entries(deps)) {
    if (depName === name && dep.version) found.add(dep.version)
    collectVersions(dep, name, found)
  }
  return found
}

let failed = false

for (const pkg of PACKAGES) {
  let raw
  try {
    raw = execFileSync('npm', ['ls', pkg, '--all', '--json'], {
      encoding: 'utf8',
      shell: process.platform === 'win32'
    })
  } catch (err) {
    // `npm ls` exits non-zero when a package is absent or the tree is invalid,
    // but still writes usable JSON to stdout.
    raw = err.stdout
    if (!raw) {
      console.error(`✗ ${pkg}: could not read dependency tree`)
      failed = true
      continue
    }
  }

  const versions = collectVersions(JSON.parse(raw), pkg)

  if (versions.size === 0) {
    console.error(`✗ ${pkg}: not installed`)
    failed = true
  } else if (versions.size > 1) {
    console.error(`✗ ${pkg}: ${versions.size} versions in the tree — ${[...versions].join(', ')}`)
    console.error(`  CodeMirror will fail with opaque extension errors. Dedupe before continuing.`)
    failed = true
  } else {
    console.log(`✓ ${pkg}: ${[...versions][0]}`)
  }
}

process.exit(failed ? 1 : 0)

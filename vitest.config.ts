import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = process.cwd()

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(root, 'src/core'),
      '@shared': resolve(root, 'src/shared'),
      '@main': resolve(root, 'src/main'),
      '@renderer': resolve(root, 'src/renderer')
    },
    dedupe: ['@codemirror/state', '@codemirror/view', '@lezer/common', '@lezer/highlight']
  },
  test: {
    // `core/` is pure TypeScript with no DOM dependency — see plan §12.
    // Files that genuinely need a DOM opt in per-file with:
    //   // @vitest-environment jsdom
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: false
  }
})

import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = process.cwd()

/**
 * Builds the preview benchmark as a standalone page so it can be measured in
 * Chromium rather than jsdom. Mirrors the renderer's aliases and dedupe so the
 * code under measurement is the code that ships.
 */
export default defineConfig({
  root: resolve(root, 'perf'),
  base: './',
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@core': resolve(root, 'src/core'),
      '@renderer': resolve(root, 'src/renderer')
    },
    dedupe: ['@codemirror/state', '@codemirror/view', '@lezer/common', '@lezer/highlight']
  },
  build: {
    outDir: resolve(root, 'out-perf'),
    emptyOutDir: true,
    target: 'esnext'
  }
})

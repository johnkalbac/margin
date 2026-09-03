import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const root = process.cwd()
const at = (p: string) => resolve(root, p)

/**
 * Aliases are declared once here and mirrored in tsconfig.*.json and
 * vitest.config.ts. Keep the three in sync.
 */
const alias = {
  '@shared': at('src/shared'),
  '@core': at('src/core'),
  '@main': at('src/main'),
  '@renderer': at('src/renderer')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: at('src/main/index.ts') },
        // Emitted as CommonJS. Electron's `electron` module is CJS and exposes
        // no named ESM exports, so an ESM main fails at load with
        // "does not provide an export named 'BrowserWindow'". This package is
        // "type": "module", hence the explicit .cjs extension.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: at('src/preload/index.ts') },
        // `sandbox: true` renderers cannot load an ESM preload, and this package
        // is `"type": "module"`, so the preload must be emitted as CommonJS with
        // an explicit .cjs extension. main/index.ts references out/preload/index.cjs.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },

  renderer: {
    root: at('src/renderer'),
    plugins: [react()],
    resolve: {
      alias,
      /**
       * See implementation plan §1.1. CodeMirror 6 uses `instanceof` checks across
       * package boundaries; two copies of @codemirror/state in the graph produce
       * "Unrecognized extension value in extension set" and nothing works.
       * `npm run check:deps` asserts the same invariant at the dependency-tree level.
       */
      dedupe: [
        '@codemirror/state',
        '@codemirror/view',
        '@lezer/common',
        '@lezer/highlight',
        'react',
        'react-dom'
      ]
    },
    build: {
      rollupOptions: {
        input: { index: at('src/renderer/index.html') }
      }
    }
  }
})

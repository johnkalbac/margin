/// <reference types="vite/client" />

import type { MarginBridge } from '@shared/ipc'

declare global {
  interface Window {
    /**
     * The entire main-process surface available to the renderer, installed by
     * the preload via contextBridge. There is no other route out of this
     * process — in particular, no `fs` and no `ipcRenderer`.
     */
    readonly margin: MarginBridge
  }
}

export {}

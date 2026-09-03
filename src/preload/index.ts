import { contextBridge, ipcRenderer } from 'electron'

import {
  IPC,
  type DocChangedPayload,
  type DocDirtyPayload,
  type DocumentPayload,
  type ExternalChangePayload,
  type FileResult,
  type ComparisonSource,
  type HistoryVersion,
  type MarginBridge,
  type RecentFile,
  type Settings
} from '@shared/ipc'
import type { DocId, DocMeta, Encoding } from '@shared/types'
import { PRODUCT_NAME } from '@shared/branding'

/**
 * The entire renderer-visible surface (plan §2, §10).
 *
 * Only the channels declared in @shared/ipc cross this boundary. There is no
 * `ipcRenderer` passthrough, no `require`, and no way for the renderer to reach
 * `fs` — every file operation goes through FileService in main, with no
 * exceptions for "just reading the file once".
 *
 * Subscriptions hand back an unsubscribe function rather than exposing
 * `removeListener`, so a renderer cannot reach the emitter itself and cannot
 * strip a listener it did not add.
 */

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const bridge: MarginBridge = {
  platform: process.platform as MarginBridge['platform'],

  productName: PRODUCT_NAME,

  versions: Object.freeze({
    app: process.env.npm_package_version ?? '0.1.0',
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? ''
  }),

  doc: {
    changed(payload: DocChangedPayload): void {
      ipcRenderer.send(IPC.docChanged, payload)
    },
    setDirty(payload: DocDirtyPayload): void {
      ipcRenderer.send(IPC.docSetDirty, payload)
    },
    create(): Promise<DocumentPayload> {
      return ipcRenderer.invoke(IPC.docNew)
    },
    open(path?: string): Promise<FileResult<DocumentPayload[]>> {
      return ipcRenderer.invoke(IPC.docOpen, path ?? null)
    },
    save(docId: DocId, content: string): Promise<FileResult<DocMeta>> {
      return ipcRenderer.invoke(IPC.docSave, docId, content)
    },
    saveAs(docId: DocId, content: string): Promise<FileResult<DocMeta>> {
      return ipcRenderer.invoke(IPC.docSaveAs, docId, content)
    },
    close(docId: DocId): Promise<void> {
      return ipcRenderer.invoke(IPC.docClose, docId)
    },
    reload(docId: DocId): Promise<FileResult<DocumentPayload>> {
      return ipcRenderer.invoke(IPC.docReload, docId)
    },
    reopenAs(docId: DocId, encoding: Encoding): Promise<FileResult<DocumentPayload>> {
      return ipcRenderer.invoke(IPC.docReopenAs, docId, encoding)
    },
    reportTabs(docIds: DocId[]): void {
      ipcRenderer.send(IPC.windowTabs, docIds)
    },
    detach(docId: DocId, content: string): Promise<void> {
      return ipcRenderer.invoke(IPC.docMoveTab, docId, content)
    }
  },

  window: {
    create(): Promise<void> {
      return ipcRenderer.invoke(IPC.windowNew)
    },
    openInNew(): Promise<FileResult<DocumentPayload[]>> {
      return ipcRenderer.invoke(IPC.docOpen, null, true)
    }
  },

  settings: {
    get(): Promise<Settings> {
      return ipcRenderer.invoke(IPC.settingsGet)
    },
    set(
      patch: Partial<
        Pick<Settings, 'theme' | 'defaultFlavor' | 'autoSave' | 'autoSaveDelayMs' | 'saveOnExit'>
      >
    ): Promise<Settings> {
      return ipcRenderer.invoke(IPC.settingsSet, patch)
    },
    onChanged(handler: (settings: Settings) => void): () => void {
      return subscribe<Settings>(IPC.settingsChanged, handler)
    }
  },

  commands: {
    onInvoke(handler: (commandId: string) => void): () => void {
      return subscribe<string>(IPC.commandInvoke, handler)
    },
    onOpened(handler: (payloads: DocumentPayload[]) => void): () => void {
      return subscribe<DocumentPayload[]>(IPC.docOpened, handler)
    },
    reportEnablement(disabledIds: string[]): void {
      ipcRenderer.send(IPC.commandEnablement, disabledIds)
    }
  },

  files: {
    recent(): Promise<RecentFile[]> {
      return ipcRenderer.invoke(IPC.recentFiles)
    },
    clearRecent(): Promise<RecentFile[]> {
      return ipcRenderer.invoke(IPC.clearRecentFiles)
    }
  },

  compare: {
    chooseFile(): Promise<FileResult<ComparisonSource | null>> {
      return ipcRenderer.invoke(IPC.compareRead)
    }
  },

  history: {
    versions(docId: DocId): Promise<HistoryVersion[]> {
      return ipcRenderer.invoke(IPC.historyVersions, docId)
    },
    contentAt(docId: DocId, version: number): Promise<string | null> {
      return ipcRenderer.invoke(IPC.historyContent, docId, version)
    }
  },

  app: {
    resolveQuit(proceed: boolean): void {
      ipcRenderer.send(IPC.quitVerdict, proceed)
    },
    onBeforeQuit(handler: () => void): () => void {
      return subscribe<void>(IPC.beforeQuit, () => handler())
    },
    onExternalChange(handler: (payload: ExternalChangePayload) => void): () => void {
      return subscribe<ExternalChangePayload>(IPC.externalChange, handler)
    }
  },

  shell: {
    openExternal(url: string): Promise<boolean> {
      return ipcRenderer.invoke(IPC.openExternal, url)
    }
  }
}

contextBridge.exposeInMainWorld('margin', bridge)

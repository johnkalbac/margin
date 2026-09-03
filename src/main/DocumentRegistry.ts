import { basename, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'

import { canonicalKey } from '@core/files/canonicalPath'
import { DEFAULT_ENCODING } from '@core/text/encoding'
import { DEFAULT_FLAVOR } from '@core/markdown/flavors'
import { platformEol } from '@core/text/eol'
import type { DocId, DocMeta, Encoding, Eol, Flavor } from '@shared/types'

/**
 * The authoritative set of open documents (plan §2).
 *
 * Main owns `DocMeta`; renderers own views of it. The invariant this class
 * exists for is the one §2 calls out first: **a document is open in exactly one
 * tab, application-wide.** Opening a file that is already open focuses the
 * existing document instead of making a second copy, which removes the entire
 * class of two-views-one-file write conflicts rather than trying to resolve
 * them later.
 *
 * That is enforced by keying on a canonical path — symlinks resolved, case
 * folded where the filesystem folds it — so `./notes.md`, `/home/me/notes.md`
 * and a symlink pointing at it are one document.
 */

/** Main-only state that never crosses the IPC boundary. */
export interface DocRecord {
  meta: DocMeta
  /** Canonical key; null while the document is untitled. */
  key: string | null
  /** sha256 of the bytes last read or written, for external-change detection. */
  hash: string | null
  mtimeMs: number | null
}

export interface AdoptOptions {
  path: string
  key: string
  text: string
  encoding: Encoding
  eol: Eol
  mixedEol: boolean
  hash: string
  mtimeMs: number
  flavor?: Flavor
}

/**
 * Resolve a path to its registry key. Separated from the class because it needs
 * the filesystem and the class does not.
 *
 * `realpath` fails for a path that does not exist yet — Save As to a new file —
 * so the fallback is a plain resolve. That is correct rather than merely
 * tolerant: a file that does not exist cannot already be open in another tab.
 */
export async function resolveKey(
  path: string,
  platform: NodeJS.Platform | string = process.platform
): Promise<string> {
  const absolute = resolve(path)
  try {
    return canonicalKey(await realpath(absolute), platform)
  } catch {
    return canonicalKey(absolute, platform)
  }
}

export class DocumentRegistry {
  private readonly records = new Map<DocId, DocRecord>()
  /** Canonical key -> docId. The uniqueness invariant lives here. */
  private readonly byKey = new Map<string, DocId>()
  private sequence = 0

  constructor(private readonly platform: NodeJS.Platform | string = process.platform) {}

  private nextId(): DocId {
    this.sequence += 1
    return `doc-${this.sequence}`
  }

  get(id: DocId): DocRecord | undefined {
    return this.records.get(id)
  }

  meta(id: DocId): DocMeta | undefined {
    return this.records.get(id)?.meta
  }

  all(): DocMeta[] {
    return [...this.records.values()].map((record) => record.meta)
  }

  allRecords(): DocRecord[] {
    return [...this.records.values()]
  }

  /** The document already open at this canonical key, if any. */
  findByKey(key: string): DocRecord | undefined {
    const id = this.byKey.get(key)
    return id ? this.records.get(id) : undefined
  }

  /** Find by on-disk path, for routing a watcher event back to its document. */
  findByPath(path: string): DocRecord | undefined {
    return this.allRecords().find((record) => record.meta.path === path)
  }

  /**
   * A new, never-saved document. Untitled documents have no path and therefore
   * no key: two of them are two documents, and never collapse into one.
   */
  createUntitled(flavor: Flavor = DEFAULT_FLAVOR): DocMeta {
    const id = this.nextId()
    const untitledCount = this.allRecords().filter((r) => r.meta.path === null).length
    const meta: DocMeta = {
      id,
      path: null,
      name: untitledCount === 0 ? 'Untitled' : `Untitled ${untitledCount + 1}`,
      dirty: false,
      encoding: DEFAULT_ENCODING,
      eol: platformEol(this.platform),
      mixedEol: false,
      flavor,
      version: 0
    }
    this.records.set(id, { meta, key: null, hash: null, mtimeMs: null })
    return meta
  }

  /** Register a file read from disk under its canonical key. */
  adopt(options: AdoptOptions): DocMeta {
    const id = this.nextId()
    const meta: DocMeta = {
      id,
      path: options.path,
      name: basename(options.path),
      dirty: false,
      encoding: options.encoding,
      eol: options.eol,
      mixedEol: options.mixedEol,
      flavor: options.flavor ?? DEFAULT_FLAVOR,
      version: 0
    }
    this.records.set(id, {
      meta,
      key: options.key,
      hash: options.hash,
      mtimeMs: options.mtimeMs
    })
    this.byKey.set(options.key, id)
    return meta
  }

  /**
   * Attach a path to a document, for Save As and for the first save of an
   * untitled document. Releases any key the document held before.
   */
  bindPath(id: DocId, path: string, key: string): DocMeta | undefined {
    const record = this.records.get(id)
    if (!record) return undefined

    if (record.key && record.key !== key) this.byKey.delete(record.key)
    record.key = key
    record.meta = { ...record.meta, path, name: basename(path) }
    this.byKey.set(key, id)
    return record.meta
  }

  /** Record the bytes now on disk after a successful read or write. */
  noteDisk(id: DocId, hash: string, mtimeMs: number): void {
    const record = this.records.get(id)
    if (!record) return
    record.hash = hash
    record.mtimeMs = mtimeMs
  }

  patch(id: DocId, changes: Partial<Omit<DocMeta, 'id'>>): DocMeta | undefined {
    const record = this.records.get(id)
    if (!record) return undefined
    record.meta = { ...record.meta, ...changes }
    return record.meta
  }

  remove(id: DocId): DocRecord | undefined {
    const record = this.records.get(id)
    if (!record) return undefined
    if (record.key) this.byKey.delete(record.key)
    this.records.delete(id)
    return record
  }

  /** Every document with unsaved changes, for the quit prompt (§8). */
  dirtyDocuments(): DocMeta[] {
    return this.all().filter((meta) => meta.dirty)
  }
}

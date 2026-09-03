import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'

import { decode, detectEncoding, encode } from '@core/text/codec'
import { applyEol, detectEol, normalizeToLf, type Eol } from '@core/text/eol'
import type { Encoding } from '@core/text/encoding'

/**
 * All file access in the application (plan §2, §6, §8).
 *
 * The renderer never touches `fs` — it reaches this through IPC, with no
 * exceptions for "just reading the file once". Everything below is byte-aware:
 * the encoding and the line ending detected on read are what get applied on
 * write, so a file the user did not edit comes back byte-identical.
 */

export interface FileSnapshot {
  /** Buffer text, always LF. `eol` is what restores the file's own style. */
  text: string
  encoding: Encoding
  eol: Eol
  /** The file mixed line endings and the majority was taken (§6). */
  mixedEol: boolean
  /** How the encoding was arrived at, so the UI can be honest about a guess. */
  encodingSource: 'bom' | 'detected' | 'default' | 'override'
  mtimeMs: number
  /** sha256 of the bytes on disk. Drives self-write suppression (§8). */
  hash: string
  byteLength: number
}

export interface WriteResult {
  mtimeMs: number
  hash: string
  byteLength: number
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Read a file and decide how to interpret its bytes.
 *
 * `override` skips detection entirely — that is "Reopen with encoding…", which
 * §6 calls the actual feature: heuristic detection is wrong often enough that
 * the manual path has to exist and has to win.
 */
export async function readTextFile(path: string, override?: Encoding): Promise<FileSnapshot> {
  const bytes = await readFile(path)
  const stats = await stat(path)

  const detection = override
    ? { encoding: override, source: 'override' as const }
    : detectEncoding(bytes)

  const raw = decode(bytes, detection.encoding)
  const eol = detectEol(raw)

  return {
    // CodeMirror normalizes to LF internally anyway; doing it here means the
    // buffer and the editor never disagree about what the document contains.
    text: normalizeToLf(raw),
    encoding: detection.encoding,
    eol: eol.eol,
    mixedEol: eol.mixed,
    encodingSource: detection.source,
    mtimeMs: stats.mtimeMs,
    hash: hashBytes(bytes),
    byteLength: bytes.byteLength
  }
}

/**
 * Write buffer text back in the document's own encoding and line ending.
 *
 * `DocMeta.eol` is authoritative, never the editor document — CodeMirror holds
 * LF regardless of what the file uses, so reading line endings back off the
 * editor would silently convert every CRLF file to LF on first save (§6).
 */
export async function writeTextFile(
  path: string,
  text: string,
  encoding: Encoding,
  eol: Eol
): Promise<WriteResult> {
  const bytes = encode(applyEol(text, eol), encoding)
  await writeFile(path, bytes)
  const stats = await stat(path)

  return { mtimeMs: stats.mtimeMs, hash: hashBytes(bytes), byteLength: bytes.byteLength }
}

/** Current bytes' hash, or null if the file is gone. Used to confirm a change is real. */
export async function hashOnDisk(path: string): Promise<string | null> {
  try {
    return hashBytes(await readFile(path))
  } catch {
    return null
  }
}

/**
 * Watches open files for external modification (§13 Phase 2).
 *
 * Two things make a naive `fs.watch` useless here, and both are handled:
 *
 *  · **The app's own writes fire the watcher.** Every save would prompt the user
 *    that the file changed underneath them. §8 calls this out because auto-save
 *    in Phase 4 turns it from an annoyance into a loop the app fights itself in.
 *    Suppression is by content hash rather than by a time window, because a
 *    timer races on a slow disk and a hash does not.
 *  · **Editors write in bursts.** Save-to-temp-then-rename, or a truncate
 *    followed by a write, arrive as several events for one logical change, so
 *    events are debounced and then confirmed by re-hashing.
 */
export class FileWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** Hash the app last wrote or read — anything matching it is not news. */
  private readonly known = new Map<string, string>()

  constructor(
    private readonly onExternalChange: (path: string) => void,
    private readonly debounceMs = 150
  ) {}

  /** Begin watching, treating `hash` as the content the app already knows about. */
  watchFile(path: string, hash: string): void {
    this.known.set(path, hash)
    if (this.watchers.has(path)) return

    let watcher: FSWatcher
    try {
      watcher = watch(path, () => this.schedule(path))
    } catch {
      // An unwatchable path (a network share, a file removed between the read
      // and this call) is not worth failing the open over.
      return
    }
    // A watch error must not take the process down.
    watcher.on('error', () => this.unwatch(path))
    this.watchers.set(path, watcher)
  }

  /** Record what the app just wrote, so the resulting event is not reported back. */
  noteOwnWrite(path: string, hash: string): void {
    this.known.set(path, hash)
  }

  unwatch(path: string): void {
    this.watchers.get(path)?.close()
    this.watchers.delete(path)
    const timer = this.timers.get(path)
    if (timer) clearTimeout(timer)
    this.timers.delete(path)
    this.known.delete(path)
  }

  dispose(): void {
    for (const path of [...this.watchers.keys()]) this.unwatch(path)
  }

  private schedule(path: string): void {
    const existing = this.timers.get(path)
    if (existing) clearTimeout(existing)
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path)
        void this.confirm(path)
      }, this.debounceMs)
    )
  }

  private async confirm(path: string): Promise<void> {
    const current = await hashOnDisk(path)
    // Deleted, or unreadable for the moment: nothing useful to tell the user,
    // and the save path will surface a real error when they next write.
    if (current === null) return
    if (current === this.known.get(path)) return

    this.known.set(path, current)
    this.onExternalChange(path)
  }
}

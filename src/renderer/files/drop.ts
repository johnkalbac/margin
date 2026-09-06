import { OPENABLE_EXTENSIONS } from '@shared/openable'

/**
 * Which dropped Files are documents Margin can open, as disk paths.
 *
 * Deliberately pure — pathForFile is injected — so the filtering rules are
 * unit-testable without Electron: only the preload's webUtils can turn a File
 * into a path, and jsdom Files have none. Everything here is a decision the
 * drop handler must not make inline, under an event:
 *
 *   · Extension filter, case-insensitive — macOS writes `README.MD`, and the
 *     set is @shared/openable, the same list argv and the Open dialog use.
 *   · Pathless Files are dropped before the extension check — a text selection
 *     or an image pasted from the clipboard drags as a File with no backing
 *     path, and webUtils yields '' for it.
 *   · Input order is kept, and a file named twice collapses to one entry —
 *     dropping x.md twice in one batch is one tab, but the batch must not
 *     silently reorder: the drop order decides which file activates last.
 */
export function droppedPaths(
  files: readonly File[],
  pathForFile: (file: File) => string,
  extensions: readonly string[] = OPENABLE_EXTENSIONS
): string[] {
  const seen = new Set<string>()
  const paths: string[] = []

  for (const file of files) {
    const path = pathForFile(file)
    // '' for synthetic Files (no disk backing) — nothing to open.
    if (!path) continue

    const dot = file.name.lastIndexOf('.')
    const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : ''
    if (!extensions.includes(extension)) continue

    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }

  return paths
}

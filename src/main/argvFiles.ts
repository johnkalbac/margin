import { statSync } from 'node:fs'
import { extname, resolve } from 'node:path'

/**
 * The files a launch was asked to open (Windows "Open with > Margin", double-
 * clicking a .md file, `margin.exe README.md`).
 *
 * Windows appends the chosen file to argv when it starts (or re-activates, via
 * `second-instance`) the app, and macOS does the same for a file double-clicked
 * after launch. Until now both were dropped on the floor: the second-instance
 * callback ignored its argv, and the first launch never read process.argv at all.
 *
 * This lives in its own module for two reasons: it is pure enough to unit-test
 * against a real temp filesystem without dragging in electron (ipc.ts imports
 * the electron module top-level), and the extension set it filters on is the
 * same set the Open dialog uses — so it is *defined* here and imported by
 * ipc.ts, rather than copied, which is what a second list always becomes.
 */

/** The document types Margin registers itself for and opens from the CLI. */
export const OPENABLE_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'txt']

/**
 * A token that looks like a URL scheme rather than a path: `file://…`, `margin://…`.
 * Windows hands `file:///C:/x/y.md` to some handlers; Electron itself starts on a
 * `chrome://`-style URL in debugging flows. Either way it is not an fs path and
 * must not reach FileService, which would try to read a path containing `:`.
 */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Pull the openable file paths out of an argv.
 *
 * `argv[0]` is the executable and, in dev (`electron . path/to.md`), `argv[1]`
 * is the app directory — so nothing is positionally trusted. Each token is
 * judged on its own: flags, URLs, directories, the app dir itself, and paths
 * that do not exist (or vanished between the shell's glob and our read) are all
 * filtered out. The result is in argv order, and a file named twice stays twice:
 * openPath deduplicates through the registry, so dropping it here would only
 * hide a caller's bug.
 */
export function pathsFromArgv(argv: readonly string[]): string[] {
  const found: string[] = []

  for (const token of argv) {
    // Chromium/Electron flags (`--inspect`, `--no-sandbox`) and bare `--`.
    if (!token || token.startsWith('-')) continue
    if (URL_LIKE.test(token)) continue

    const extension = extname(token).slice(1).toLowerCase()
    if (!OPENABLE_EXTENSIONS.includes(extension)) continue

    // The extension check makes a URL like `https://x/y.md` reach here, and
    // relative paths need cwd — resolve once, then stat the absolute path.
    const path = resolve(token)
    try {
      // isFile(), not exists(): a directory named `notes.md` — or the dev-mode
      // app dir if someone pointed the association at it — must not be opened.
      if (!statSync(path).isFile()) continue
    } catch {
      // Missing or unreadable: the user moved it between click and launch.
      continue
    }

    found.push(path)
  }

  return found
}

/**
 * Canonical path keys (plan §2).
 *
 * "A document is open in exactly one tab, application-wide" is enforced by
 * keying `DocumentRegistry` on the value this module produces. Two paths that
 * name the same file — a symlink and its target, `C:\Notes\a.md` and
 * `c:\notes\A.MD` — must collapse to one key, or the user gets two tabs over one
 * file and the whole class of write-conflict bugs the rule exists to remove.
 *
 * Symlink resolution needs the filesystem and so belongs to the caller in main;
 * the case and separator rules are pure, and live here to stay testable.
 */

/**
 * Whether the platform's filesystem is case-insensitive.
 *
 * macOS volumes can be formatted either way, and asking the filesystem per
 * volume is a syscall on a path that may not exist yet. Folding case on darwin
 * unconditionally matches the default format (APFS, case-insensitive) and errs
 * toward the safe failure: on a case-sensitive volume, two files differing only
 * in case collapse to one tab, which is confusing but harmless. Not folding
 * would risk two tabs writing one file, which is data loss.
 */
export function isCaseInsensitive(platform: NodeJS.Platform | string): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * Derive the registry key for an already symlink-resolved absolute path.
 *
 * Pure: the caller resolves `..`, `.` and symlinks first (`fs.realpath`), and
 * this applies only the rules that do not need the disk.
 */
export function canonicalKey(resolvedPath: string, platform: NodeJS.Platform | string): string {
  // Windows accepts both separators for the same file; normalize so a path that
  // arrived from a drag-and-drop matches one that came from a dialog.
  const separated = platform === 'win32' ? resolvedPath.replace(/\//g, '\\') : resolvedPath

  // Trailing separators never distinguish a file.
  const trimmed =
    separated.length > 1 ? separated.replace(/[\\/]+$/, '') : separated

  return isCaseInsensitive(platform) ? trimmed.toLowerCase() : trimmed
}

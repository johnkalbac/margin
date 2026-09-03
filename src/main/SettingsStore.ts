import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { RecentFile } from '@shared/ipc'
import type { Flavor, ThemeMode } from '@shared/types'
import { isWindowState, type WindowState } from './windowState'

/**
 * The single settings file in userData (plan §2).
 *
 * Phase 2 stores only the recent files list. Theme, default flavor and the
 * auto-save settings land here in Phases 3 and 4 — the shape is a plain object
 * with defaults merged on read, so adding a key needs no migration.
 *
 * `app.getPath('userData')` resolves from the appId, which §15 flags as a
 * decision to make before Phase 5: changing it after history journals exist
 * orphans them. It orphans this file too, but a lost recent-files list is a far
 * cheaper mistake than a lost journal.
 */

export interface Settings {
  recent: RecentFile[]
  /**
   * Light and dark only, and light is the default (§4.4). A two-value enum
   * rather than a boolean so a third `system` value fits later without a
   * migration — following the OS appearance is explicitly not in v1.
   */
  theme: ThemeMode
  /** The flavor new documents start in. Per-document switching is not persisted. */
  defaultFlavor: Flavor
  /**
   * Auto-save and save-on-exit are independent settings, and neither implies the
   * other (§8). Both are opt-in and off by default: an editor that writes to
   * disk without being asked has to be chosen, not inherited.
   */
  autoSave: boolean
  /** Idle delay before an auto-save fires. §8 fixes the range at 5-60 seconds. */
  autoSaveDelayMs: number
  saveOnExit: boolean
}

const AUTOSAVE_MIN_MS = 5_000
const AUTOSAVE_MAX_MS = 60_000

const DEFAULTS: Settings = {
  recent: [],
  theme: 'light',
  defaultFlavor: 'gfm',
  autoSave: false,
  autoSaveDelayMs: 15_000,
  saveOnExit: false
}

/** Long enough to be useful in the palette, short enough to stay scannable. */
const MAX_RECENT = 12

/**
 * The window geometry key, stored beside the settings but not part of them.
 *
 * `Settings` is the object the renderer receives from `settings:get` and may
 * patch through `settings:set`. Window bounds are main's business only — nothing
 * in the renderer can move a window — so they get their own key and their own
 * accessors rather than widening that contract.
 */
const WINDOW_KEY = 'window'

export class SettingsStore {
  private data: Settings = { ...DEFAULTS }
  private window: WindowState | null = null
  private readonly file: string

  constructor(file?: string) {
    this.file = file ?? join(app.getPath('userData'), 'settings.json')
    this.load()
  }

  private load(): void {
    try {
      const { [WINDOW_KEY]: savedWindow, ...parsed } = JSON.parse(
        readFileSync(this.file, 'utf8')
        // Split off before the spread below: `all()` is sent to the renderer, so
        // an unknown key from the file must not ride along into it.
      ) as Partial<Settings> & { [WINDOW_KEY]?: unknown }
      this.window = isWindowState(savedWindow) ? savedWindow : null
      this.data = {
        ...DEFAULTS,
        ...parsed,
        // A corrupt or hand-edited file must not crash the launch, so every
        // field is validated rather than trusted.
        recent: Array.isArray(parsed.recent) ? parsed.recent.filter(isRecentFile) : [],
        theme: parsed.theme === 'dark' ? 'dark' : 'light',
        defaultFlavor: isFlavor(parsed.defaultFlavor)
          ? parsed.defaultFlavor
          : DEFAULTS.defaultFlavor,
        autoSave: parsed.autoSave === true,
        autoSaveDelayMs: clampDelay(parsed.autoSaveDelayMs),
        saveOnExit: parsed.saveOnExit === true
      }
    } catch {
      // No file yet, or unreadable. Defaults are correct in both cases.
      this.data = { ...DEFAULTS }
      this.window = null
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const contents = { ...this.data, [WINDOW_KEY]: this.window }
      writeFileSync(this.file, JSON.stringify(contents, null, 2), 'utf8')
    } catch {
      // Settings are a convenience. Failing to persist them must never fail the
      // operation the user actually asked for.
    }
  }

  recent(): RecentFile[] {
    return [...this.data.recent]
  }

  all(): Settings {
    return { ...this.data, recent: [...this.data.recent] }
  }

  /**
   * Update one or more settings. Returns the merged result so the caller can
   * broadcast it — the theme applies to every window at once, and a per-window
   * theme is explicitly not a feature (§4.4).
   */
  update(patch: Partial<Omit<Settings, 'recent'>>): Settings {
    this.data = { ...this.data, ...patch }
    // A delay outside the documented range is clamped rather than rejected: the
    // caller asked for auto-save, and refusing the whole update would leave it
    // off without saying so.
    this.data.autoSaveDelayMs = clampDelay(this.data.autoSaveDelayMs)
    this.persist()
    return this.all()
  }

  /** Where the last window was left, or null if nothing has been recorded. */
  windowState(): WindowState | null {
    return this.window ? { ...this.window } : null
  }

  /**
   * Remember a window's geometry.
   *
   * One record for all windows, updated by whichever was last moved or closed:
   * a per-window memory would need an identity that survives a relaunch, and
   * windows have none. Unchanged geometry is dropped rather than rewritten —
   * this is called behind a debounce on resize and move, and `persist()` writes
   * synchronously.
   */
  rememberWindow(state: WindowState): void {
    if (this.window && sameWindowState(this.window, state)) return
    this.window = { ...state }
    this.persist()
  }

  /** Record an open. Most recent first, de-duplicated by path. */
  noteOpened(path: string, name: string): void {
    const without = this.data.recent.filter((entry) => entry.path !== path)
    this.data.recent = [{ path, name, openedAt: Date.now() }, ...without].slice(0, MAX_RECENT)
    this.persist()
  }

  /**
   * Forget every entry.
   *
   * Nothing on disk is touched: the list is a record of what was opened, not of
   * the files themselves. History journals (§9) are a separate store and are
   * deliberately not cleared here — this is the recent list, not a privacy
   * sweep, and conflating the two would silently discard edit history.
   */
  clearRecent(): void {
    if (this.data.recent.length === 0) return
    this.data.recent = []
    this.persist()
  }

  /** Drop an entry — a file that has since been deleted or renamed. */
  forget(path: string): void {
    const next = this.data.recent.filter((entry) => entry.path !== path)
    if (next.length === this.data.recent.length) return
    this.data.recent = next
    this.persist()
  }
}

function sameWindowState(a: WindowState, b: WindowState): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.maximized === b.maximized
  )
}

function clampDelay(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULTS.autoSaveDelayMs
  return Math.min(AUTOSAVE_MAX_MS, Math.max(AUTOSAVE_MIN_MS, value))
}

function isFlavor(value: unknown): value is Flavor {
  return value === 'commonmark' || value === 'gfm' || value === 'gfm-extras'
}

function isRecentFile(value: unknown): value is RecentFile {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<RecentFile>
  return typeof entry.path === 'string' && typeof entry.name === 'string'
}

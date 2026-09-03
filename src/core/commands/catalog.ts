import type { Accelerator, Platform } from './registry'

/**
 * The command catalog (plan §7).
 *
 * §7's requirement is that the palette, the native menu and the keyboard resolve
 * through one definition. Phase 1 met that with a registry built in the
 * renderer, which was enough while the palette was the only surface. Phase 3
 * adds a native menu, and the menu is built in **main** — which cannot import
 * the renderer, and must not hold a second copy of the command list.
 *
 * So the metadata lives here, in core, as plain data: id, label, group,
 * accelerator, and where the command sits in the menu. The renderer attaches the
 * `run` and `when` behaviour to these ids; main builds the menu from the same
 * array and sends `command:invoke` back. Neither side can invent a command the
 * other does not have, which is what makes the parity test structural rather
 * than a list someone maintains by hand.
 */

/** Top-level menu sections, in menu-bar order. */
export const MENU_SECTIONS = ['File', 'Edit', 'View', 'Format'] as const
export type MenuSection = (typeof MENU_SECTIONS)[number]

export interface CommandSpec {
  /** Dotted and stable, e.g. 'view.toggleEditorFocus'. Never renamed casually. */
  id: string
  label: string
  /** Section heading in the palette, and the menu section when `inMenu` is set. */
  group: string
  /** Secondary text in the palette. */
  detail?: string
  accelerator?: Accelerator
  /**
   * True when CodeMirror owns the key.
   *
   * §7 offers two ways to avoid Electron and CodeMirror both handling one chord:
   * keep the command out of the menu, or give the menu item a `run` that
   * delegates into the focused view. Margin takes the second, because a native
   * Edit menu without Undo is a worse app than one with it — and Electron's
   * `registerAccelerator: false` makes it safe: the shortcut is *displayed*
   * beside the item but never registered, so the key still reaches CodeMirror
   * and exactly one handler runs.
   */
  editorOwnedKey?: boolean
  /**
   * Deliberate platform asymmetry. `because` is required so parity gaps are a
   * documented decision rather than an oversight.
   */
  platformOnly?: { platforms: Platform[]; because: string }
  /** Menu placement. Absent means the command is reachable only from the palette. */
  inMenu?: { section: MenuSection; order: number; separatorBefore?: boolean }
  /**
   * A native Electron menu role, for actions the OS already implements.
   *
   * Cut, Copy and Paste are clipboard operations rather than editor commands:
   * the chord is handled by the contenteditable natively, and a renderer-side
   * implementation would need clipboard-read permission, which §10's permission
   * handler denies outright. A role does the right thing on click and needs no
   * behaviour on the renderer side.
   *
   * Commands with a role are menu-only — they carry no palette entry and no
   * handler, because typing "Paste" into a palette is not how anyone pastes.
   */
  role?: 'cut' | 'copy' | 'paste'
}

/**
 * Flavor and encoding commands are generated rather than typed out: the source
 * lists live in core already, and hand-copying them is how a new flavor ends up
 * in the palette but not the menu.
 */
export const FLAVOR_IDS = ['commonmark', 'gfm', 'gfm-extras'] as const
export const ENCODING_IDS = [
  'utf8',
  'utf8bom',
  'utf16le',
  'utf16be',
  'windows1252',
  'iso88591'
] as const

export const COMMAND_CATALOG: readonly CommandSpec[] = [
  // ── File ──────────────────────────────────────────────────────────────────
  {
    id: 'file.new',
    label: 'New',
    group: 'File',
    detail: 'An empty untitled document',
    accelerator: { default: 'CmdOrCtrl+N' },
    inMenu: { section: 'File', order: 10 }
  },
  {
    id: 'file.newWindow',
    label: 'New Window',
    group: 'File',
    detail: 'A second window with its own tabs',
    accelerator: { default: 'CmdOrCtrl+Shift+N' },
    inMenu: { section: 'File', order: 20 }
  },
  {
    id: 'file.open',
    label: 'Open…',
    group: 'File',
    detail: 'Choose a file to open',
    accelerator: { default: 'CmdOrCtrl+O' },
    inMenu: { section: 'File', order: 30, separatorBefore: true }
  },
  {
    id: 'file.openInNewWindow',
    label: 'Open in New Window…',
    group: 'File',
    detail: 'Open a file in a second window',
    accelerator: { default: 'CmdOrCtrl+Alt+O' },
    inMenu: { section: 'File', order: 40 }
  },
  {
    id: 'file.save',
    label: 'Save',
    group: 'File',
    detail: 'Write the document to disk',
    accelerator: { default: 'CmdOrCtrl+S' },
    inMenu: { section: 'File', order: 50, separatorBefore: true }
  },
  {
    id: 'file.saveAs',
    // The ellipsis is load-bearing: the design system reserves it for commands
    // that open a dialog rather than acting immediately.
    label: 'Save As…',
    group: 'File',
    detail: 'Write the document to a new file',
    accelerator: { default: 'CmdOrCtrl+Shift+S' },
    inMenu: { section: 'File', order: 60 }
  },
  {
    id: 'file.closeTab',
    label: 'Close Tab',
    group: 'File',
    detail: 'Close the active document',
    accelerator: { default: 'CmdOrCtrl+W' },
    inMenu: { section: 'File', order: 70, separatorBefore: true }
  },

  // ── Edit ──────────────────────────────────────────────────────────────────
  //
  // Every one of these is editor-owned: the chord reaches CodeMirror, and the
  // menu item delegates into the focused view rather than registering the key.
  {
    id: 'edit.undo',
    label: 'Undo',
    group: 'Edit',
    accelerator: { default: 'CmdOrCtrl+Z' },
    editorOwnedKey: true,
    inMenu: { section: 'Edit', order: 10 }
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    group: 'Edit',
    accelerator: { default: 'CmdOrCtrl+Shift+Z', win32: 'Ctrl+Y' },
    editorOwnedKey: true,
    inMenu: { section: 'Edit', order: 20 }
  },
  {
    id: 'edit.cut',
    label: 'Cut',
    group: 'Edit',
    accelerator: { default: 'CmdOrCtrl+X' },
    editorOwnedKey: true,
    role: 'cut',
    inMenu: { section: 'Edit', order: 30, separatorBefore: true }
  },
  {
    id: 'edit.copy',
    label: 'Copy',
    group: 'Edit',
    accelerator: { default: 'CmdOrCtrl+C' },
    editorOwnedKey: true,
    role: 'copy',
    inMenu: { section: 'Edit', order: 40 }
  },
  {
    id: 'edit.paste',
    label: 'Paste',
    group: 'Edit',
    accelerator: { default: 'CmdOrCtrl+V' },
    editorOwnedKey: true,
    role: 'paste',
    inMenu: { section: 'Edit', order: 50 }
  },
  {
    id: 'edit.selectAll',
    label: 'Select All',
    group: 'Edit',
    accelerator: { default: 'CmdOrCtrl+A' },
    editorOwnedKey: true,
    inMenu: { section: 'Edit', order: 60 }
  },
  {
    id: 'edit.find',
    label: 'Find…',
    group: 'Edit',
    detail: 'Search the active document',
    accelerator: { default: 'CmdOrCtrl+F' },
    editorOwnedKey: true,
    inMenu: { section: 'Edit', order: 70, separatorBefore: true }
  },
  {
    id: 'edit.replace',
    label: 'Replace…',
    group: 'Edit',
    detail: 'Search and replace in the active document',
    accelerator: { default: 'CmdOrCtrl+H', darwin: 'Cmd+Alt+F' },
    editorOwnedKey: true,
    inMenu: { section: 'Edit', order: 80 }
  },

  // ── View ──────────────────────────────────────────────────────────────────
  {
    id: 'view.toggleEditorFocus',
    label: 'Focus Editor',
    group: 'View',
    detail: 'Maximize the editor pane, or return to split',
    accelerator: { default: 'CmdOrCtrl+Alt+1' },
    inMenu: { section: 'View', order: 10 }
  },
  {
    id: 'view.togglePreviewFocus',
    label: 'Focus Preview',
    group: 'View',
    detail: 'Maximize the preview pane, or return to split',
    accelerator: { default: 'CmdOrCtrl+Alt+2' },
    inMenu: { section: 'View', order: 20 }
  },
  {
    id: 'view.splitView',
    label: 'Split',
    group: 'View',
    detail: 'Show both panes',
    accelerator: { default: 'CmdOrCtrl+Alt+0' },
    inMenu: { section: 'View', order: 30 }
  },
  {
    id: 'view.resetSplit',
    label: 'Reset Split',
    group: 'View',
    detail: 'Restore the panes to 50/50',
    // A literal backslash, not the word: `matchesAccelerator` compares the last
    // token against `event.key`, which is "\" for this key.
    accelerator: { default: 'CmdOrCtrl+Alt+\\' },
    inMenu: { section: 'View', order: 40 }
  },
  {
    id: 'view.nextTab',
    label: 'Next Tab',
    group: 'View',
    accelerator: { default: 'Ctrl+Tab' },
    inMenu: { section: 'View', order: 50, separatorBefore: true }
  },
  {
    id: 'view.previousTab',
    label: 'Previous Tab',
    group: 'View',
    accelerator: { default: 'Ctrl+Shift+Tab' },
    inMenu: { section: 'View', order: 60 }
  },
  {
    id: 'view.compareWithFile',
    label: 'Compare With File…',
    group: 'View',
    detail: 'Show an inline diff against another file on disk',
    accelerator: { default: 'CmdOrCtrl+Shift+C' },
    inMenu: { section: 'View', order: 72, separatorBefore: true }
  },
  {
    id: 'view.exitCompare',
    label: 'Exit Compare',
    group: 'View',
    detail: 'Return to the ordinary editor',
    inMenu: { section: 'View', order: 73 }
  },
  {
    id: 'view.toggleHistory',
    label: 'Toggle History',
    group: 'View',
    detail: 'Timestamped versions of this document',
    accelerator: { default: 'CmdOrCtrl+Shift+H' },
    inMenu: { section: 'View', order: 75, separatorBefore: true }
  },
  {
    id: 'settings.toggleAutoSave',
    label: 'Toggle Auto-Save',
    group: 'Settings',
    detail: 'Save idle changes automatically. Off by default.',
    inMenu: { section: 'View', order: 80, separatorBefore: true }
  },
  {
    id: 'settings.toggleSaveOnExit',
    label: 'Toggle Save on Exit',
    group: 'Settings',
    detail: 'Save every document on quit without prompting. Off by default.',
    inMenu: { section: 'View', order: 90 }
  },
  {
    id: 'view.toggleTheme',
    label: 'Toggle Dark Mode',
    group: 'View',
    detail: 'Light and dark are the only two modes',
    accelerator: { default: 'CmdOrCtrl+Shift+D' },
    inMenu: { section: 'View', order: 70, separatorBefore: true }
  },

  // ── Application ───────────────────────────────────────────────────────────
  {
    id: 'app.commandPalette',
    label: 'Command Palette',
    group: 'Application',
    detail: 'Everything the app can do',
    accelerator: { default: 'CmdOrCtrl+K' },
    inMenu: { section: 'View', order: 5 }
  },

  // ── Format ────────────────────────────────────────────────────────────────
  {
    id: 'format.cycleFlavor',
    label: 'Next Markdown Flavor',
    group: 'Format',
    accelerator: { default: 'CmdOrCtrl+Alt+M' },
    inMenu: { section: 'Format', order: 10 }
  },

  ...FLAVOR_IDS.map((flavor, index) => ({
    id: `format.flavor.${flavor}`,
    label: `Flavor: ${flavorTitle(flavor)}`,
    group: 'Format',
    inMenu: { section: 'Format' as const, order: 20 + index, separatorBefore: index === 0 }
  })),

  ...ENCODING_IDS.map((encoding, index) => ({
    id: `file.reopenAs.${encoding}`,
    label: `Reopen as ${encodingTitle(encoding)}`,
    group: 'File',
    detail: 'Re-read the file, discarding unsaved changes',
    inMenu: { section: 'File' as const, order: 100 + index, separatorBefore: index === 0 }
  }))
]

/**
 * Titles are duplicated here rather than imported from `markdown/flavors` and
 * `text/encoding` to keep this module a leaf: main imports it to build a menu
 * before any document exists, and pulling the markdown pipeline in for two
 * strings would be the wrong dependency.
 */
function flavorTitle(flavor: string): string {
  if (flavor === 'commonmark') return 'CommonMark'
  if (flavor === 'gfm') return 'GitHub'
  return 'GitHub + Extras'
}

function encodingTitle(encoding: string): string {
  switch (encoding) {
    case 'utf8':
      return 'UTF-8'
    case 'utf8bom':
      return 'UTF-8 BOM'
    case 'utf16le':
      return 'UTF-16 LE'
    case 'utf16be':
      return 'UTF-16 BE'
    case 'windows1252':
      return 'Windows-1252'
    default:
      return 'ISO-8859-1'
  }
}

/** Commands the palette shows and the renderer must implement. */
export function behaviouralCommands(): CommandSpec[] {
  return COMMAND_CATALOG.filter((spec) => spec.role === undefined)
}

export function specById(id: string): CommandSpec | undefined {
  return COMMAND_CATALOG.find((spec) => spec.id === id)
}

/** Command ids exposed on a platform — the menu tree's set, for the parity test. */
export function catalogIdsForPlatform(platform: Platform): string[] {
  return COMMAND_CATALOG.filter(
    (spec) => !spec.platformOnly || spec.platformOnly.platforms.includes(platform)
  )
    .map((spec) => spec.id)
    .sort()
}

/** The menu tree as data: sections in bar order, each with its items in order. */
export function menuTree(): Array<{ section: MenuSection; items: CommandSpec[] }> {
  return MENU_SECTIONS.map((section) => ({
    section,
    items: COMMAND_CATALOG.filter((spec) => spec.inMenu?.section === section).sort(
      (a, b) => (a.inMenu?.order ?? 0) - (b.inMenu?.order ?? 0)
    )
  }))
}

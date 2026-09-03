import { CommandRegistry, type CommandDefinition } from '@core/commands/registry'
import { behaviouralCommands, type CommandSpec } from '@core/commands/catalog'
import { FLAVORS, nextFlavor, type Flavor } from '@core/markdown'
import { ENCODINGS } from '@shared/types'
import type { DocId, Encoding, PaneFocus, ThemeMode } from '@shared/types'

/**
 * Behaviour for the command catalog (plan §7).
 *
 * The catalog in `@core/commands/catalog` owns *what* the commands are — id,
 * label, group, accelerator, menu placement. This file owns *what they do*. Main
 * builds the native menu from the same catalog and sends `command:invoke` back
 * here, so a command cannot exist in the menu without existing in the palette,
 * or vice versa.
 *
 * Every id in the catalog must have a handler below or `createCommandRegistry`
 * throws at startup. That is deliberate: a menu item that silently does nothing
 * is worse than a failure at boot.
 */

export interface AppContext {
  paneFocus: PaneFocus
  setPaneFocus: (focus: PaneFocus) => void
  resetSplit: () => void
  flavor: Flavor
  setFlavor: (flavor: Flavor) => void
  focusEditor: () => void
  paletteOpen: boolean
  openPalette: () => void
  closePalette: () => void

  // ── File ──────────────────────────────────────────────────────────────────
  newDocument: () => void
  newWindow: () => void
  openDocument: () => void
  openInNewWindow: () => void
  saveDocument: () => void
  saveAsDocument: () => void
  closeTab: (docId?: DocId) => void
  /** Re-read the file under a different encoding — §6's manual override. */
  reopenAs: (encoding: Encoding) => void
  /** False for an untitled document, which has no file to reinterpret. */
  hasFile: boolean
  encoding: Encoding

  // ── Edit ──────────────────────────────────────────────────────────────────
  /** Delegates into the focused CodeMirror view. Returns false if it had no view. */
  runEditorCommand: (id: string) => void

  // ── View ──────────────────────────────────────────────────────────────────
  theme: ThemeMode
  setTheme: (mode: ThemeMode) => void
  nextTab: () => void
  previousTab: () => void
  /** More than one document is open, so tab cycling means something. */
  manyTabs: boolean

  /** The history sidebar (§9). */
  historyOpen: boolean
  setHistoryOpen: (open: boolean) => void

  /** Compare (§13 Phase 6). */
  comparing: boolean
  compareWithFile: () => void
  exitCompare: () => void

  // ── Settings (§8) ─────────────────────────────────────────────────────────
  autoSave: boolean
  setAutoSave: (on: boolean) => void
  saveOnExit: boolean
  setSaveOnExit: (on: boolean) => void
}

export type AppCommand = CommandDefinition<AppContext>

/** The behaviour half of a command: everything the catalog does not describe. */
type Behaviour = Pick<AppCommand, 'run' | 'when'>

/**
 * Focus is a toggle, per the design: ⌘⌥1 maximizes the editor and the same chord
 * returns to split. The pane's "Focus" link is the same command.
 */
function toggleFocus(ctx: AppContext, pane: 'editor' | 'preview'): void {
  ctx.setPaneFocus(ctx.paneFocus === pane ? 'split' : pane)
}

function behaviours(): Record<string, Behaviour> {
  const table: Record<string, Behaviour> = {
    // ── File ────────────────────────────────────────────────────────────────
    'file.new': { run: (ctx) => ctx.newDocument() },
    'file.newWindow': { run: (ctx) => ctx.newWindow() },
    'file.open': { run: (ctx) => ctx.openDocument() },
    'file.openInNewWindow': { run: (ctx) => ctx.openInNewWindow() },
    'file.save': { run: (ctx) => ctx.saveDocument() },
    'file.saveAs': { run: (ctx) => ctx.saveAsDocument() },
    'file.closeTab': { run: (ctx) => ctx.closeTab() },

    // ── Edit ────────────────────────────────────────────────────────────────
    //
    // All six delegate into the focused view. The catalog marks them
    // editorOwnedKey, so main shows the shortcut beside the menu item without
    // registering it and the chord still reaches CodeMirror (§7).
    // Cut, Copy and Paste are absent: the catalog gives them native menu roles,
    // so they never reach the renderer and carry no palette entry.
    'edit.undo': { run: (ctx) => ctx.runEditorCommand('edit.undo') },
    'edit.redo': { run: (ctx) => ctx.runEditorCommand('edit.redo') },
    'edit.selectAll': { run: (ctx) => ctx.runEditorCommand('edit.selectAll') },
    // §5: wire Find and Replace to the panel @codemirror/search already
    // provides, so the palette and menu reach it rather than a parallel UI.
    'edit.find': { run: (ctx) => ctx.runEditorCommand('edit.find') },
    'edit.replace': { run: (ctx) => ctx.runEditorCommand('edit.replace') },

    // ── View ────────────────────────────────────────────────────────────────
    'view.toggleEditorFocus': { run: (ctx) => toggleFocus(ctx, 'editor') },
    'view.togglePreviewFocus': { run: (ctx) => toggleFocus(ctx, 'preview') },
    'view.splitView': {
      when: (ctx) => ctx.paneFocus !== 'split',
      run: (ctx) => ctx.setPaneFocus('split')
    },
    'view.resetSplit': {
      run: (ctx) => {
        ctx.setPaneFocus('split')
        ctx.resetSplit()
      }
    },
    'view.nextTab': { when: (ctx) => ctx.manyTabs, run: (ctx) => ctx.nextTab() },
    'view.previousTab': { when: (ctx) => ctx.manyTabs, run: (ctx) => ctx.previousTab() },
    'view.toggleTheme': {
      run: (ctx) => ctx.setTheme(ctx.theme === 'dark' ? 'light' : 'dark')
    },
    'view.toggleHistory': { run: (ctx) => ctx.setHistoryOpen(!ctx.historyOpen) },
    'view.compareWithFile': { run: (ctx) => ctx.compareWithFile() },
    'view.exitCompare': { when: (ctx) => ctx.comparing, run: (ctx) => ctx.exitCompare() },

    // ── Application ─────────────────────────────────────────────────────────
    'app.commandPalette': {
      // Registered so the menu can expose it, but never a palette result.
      when: (ctx) => !ctx.paletteOpen,
      run: (ctx) => ctx.openPalette()
    },

    // ── Settings (§8) ───────────────────────────────────────────────────────
    'settings.toggleAutoSave': { run: (ctx) => ctx.setAutoSave(!ctx.autoSave) },
    'settings.toggleSaveOnExit': { run: (ctx) => ctx.setSaveOnExit(!ctx.saveOnExit) },

    // ── Format ──────────────────────────────────────────────────────────────
    'format.cycleFlavor': { run: (ctx) => ctx.setFlavor(nextFlavor(ctx.flavor)) }
  }

  // One command per flavor, so the palette and menu can jump straight to a named
  // flavor instead of making the user cycle. Same registry, same run path.
  for (const flavor of FLAVORS) {
    table[`format.flavor.${flavor}`] = {
      when: (ctx) => ctx.flavor !== flavor,
      run: (ctx) => ctx.setFlavor(flavor)
    }
  }

  /**
   * One command per encoding (§6). Detection is a guess and is wrong often
   * enough that this manual path is the actual feature, not a fallback — so
   * every supported encoding is reachable by name rather than through a cycle.
   */
  for (const encoding of ENCODINGS) {
    table[`file.reopenAs.${encoding}`] = {
      when: (ctx) => ctx.hasFile && ctx.encoding !== encoding,
      run: (ctx) => ctx.reopenAs(encoding)
    }
  }

  return table
}

export function createCommandRegistry(): CommandRegistry<AppContext> {
  const registry = new CommandRegistry<AppContext>()
  const table = behaviours()

  for (const spec of behaviouralCommands()) {
    const behaviour = table[spec.id]
    if (!behaviour) {
      // A catalog entry with no handler would render as a menu item that does
      // nothing. Failing here makes that impossible to ship.
      throw new Error(`Command ${spec.id} is in the catalog but has no behaviour`)
    }
    registry.register(toDefinition(spec, behaviour))
  }

  return registry
}

function toDefinition(spec: CommandSpec, behaviour: Behaviour): AppCommand {
  return {
    id: spec.id,
    label: spec.label,
    group: spec.group,
    ...(spec.detail === undefined ? {} : { detail: spec.detail }),
    ...(spec.accelerator === undefined ? {} : { accelerator: spec.accelerator }),
    ...(spec.editorOwnedKey === undefined ? {} : { editorOwnedKey: spec.editorOwnedKey }),
    ...(spec.platformOnly === undefined ? {} : { platformOnly: spec.platformOnly }),
    ...(behaviour.when === undefined ? {} : { when: behaviour.when }),
    run: behaviour.run
  }
}

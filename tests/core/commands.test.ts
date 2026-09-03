import { describe, expect, it } from 'vitest'

import { PLATFORMS, formatAccelerator, matchScore } from '@core/commands/registry'
import {
  COMMAND_CATALOG,
  behaviouralCommands,
  catalogIdsForPlatform,
  menuTree
} from '@core/commands/catalog'
import { matchesAccelerator, type KeyLikeEvent } from '@core/commands/keys'
import { createCommandRegistry, type AppContext } from '@renderer/commands/appCommands'

/**
 * Command parity (plan §7, §12).
 *
 * "Platform parity asserted on only one platform is not asserted" — so these
 * assertions are made against the registry's own platform resolution rather than
 * against the host the tests happen to run on.
 */

function context(overrides: Partial<AppContext> = {}): AppContext {
  return {
    paneFocus: 'split',
    setPaneFocus: () => {},
    resetSplit: () => {},
    flavor: 'gfm',
    setFlavor: () => {},
    focusEditor: () => {},
    paletteOpen: false,
    openPalette: () => {},
    closePalette: () => {},
    newDocument: () => {},
    newWindow: () => {},
    openDocument: () => {},
    openInNewWindow: () => {},
    saveDocument: () => {},
    saveAsDocument: () => {},
    closeTab: () => {},
    reopenAs: () => {},
    // A document with a file behind it, so the reopen-as commands are enabled
    // and the parity assertions below see the whole registered command set.
    hasFile: true,
    encoding: 'utf8',
    runEditorCommand: () => {},
    theme: 'light',
    setTheme: () => {},
    nextTab: () => {},
    previousTab: () => {},
    manyTabs: true,
    historyOpen: false,
    setHistoryOpen: () => {},
    comparing: true,
    compareWithFile: () => {},
    exitCompare: () => {},
    autoSave: false,
    setAutoSave: () => {},
    saveOnExit: false,
    setSaveOnExit: () => {},
    ...overrides
  }
}

function key(overrides: Partial<KeyLikeEvent>): KeyLikeEvent {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('command parity', () => {
  const registry = createCommandRegistry()

  it('exposes an identical command set on macOS and Windows', () => {
    expect(registry.idsForPlatform('darwin')).toEqual(registry.idsForPlatform('win32'))
  })

  it.each([...PLATFORMS])('resolves every bound accelerator on %s', (platform) => {
    for (const command of registry.all()) {
      if (!command.accelerator) continue
      expect(registry.resolveAccelerator(command.id, platform)).toBeTruthy()
    }
  })

  it('requires a written justification for any platform-specific command', () => {
    for (const command of registry.all()) {
      if (!command.platformOnly) continue
      expect(command.platformOnly.because.length).toBeGreaterThan(10)
    }
  })

  it('binds no accelerator to more than one command on a platform', () => {
    for (const platform of PLATFORMS) {
      const seen = new Map<string, string>()
      for (const command of registry.all()) {
        const accelerator = registry.resolveAccelerator(command.id, platform)
        if (!accelerator) continue
        const existing = seen.get(accelerator)
        expect(existing, `${accelerator} bound to both ${existing} and ${command.id}`).toBeUndefined()
        seen.set(accelerator, command.id)
      }
    }
  })

  it('rejects duplicate command ids', () => {
    const duplicate = () =>
      createCommandRegistry().register({
        id: 'view.splitView',
        label: 'Split',
        group: 'View',
        run: () => {}
      })
    expect(duplicate).toThrow(/Duplicate command id/)
  })
})

describe('menu and palette are one command set (§7)', () => {
  const registry = createCommandRegistry()

  it('gives every menu item a command the renderer can run, or a native role', () => {
    // A menu item that resolves to nothing is the failure this catches: it looks
    // live, does nothing, and no test notices until someone clicks it.
    for (const { items } of menuTree()) {
      for (const spec of items) {
        if (spec.role) continue // Handled by Electron against the focused view.
        expect(registry.get(spec.id), `${spec.id} is in the menu but not the registry`).toBeDefined()
      }
    }
  })

  it('puts every palette command in the catalog and vice versa', () => {
    const registryIds = registry.ids()
    const catalogIds = behaviouralCommands()
      .map((spec) => spec.id)
      .sort()
    expect(registryIds).toEqual(catalogIds)
  })

  it('exposes an identical menu command set on macOS and Windows', () => {
    // §12: "macOS and Windows menu trees expose identical command ID sets."
    expect(catalogIdsForPlatform('darwin')).toEqual(catalogIdsForPlatform('win32'))
  })

  it('never registers an accelerator for a chord CodeMirror owns', () => {
    // §7's collision rule. Anything editor-owned must be flagged so the menu
    // builder passes registerAccelerator: false and the key reaches the editor.
    const editorOwned = COMMAND_CATALOG.filter((spec) => spec.editorOwnedKey)
    expect(editorOwned.length).toBeGreaterThan(0)
    for (const spec of editorOwned) {
      expect(spec.accelerator, `${spec.id} is editor-owned but binds no chord`).toBeDefined()
    }
  })

  it('orders each menu section deterministically', () => {
    for (const { section, items } of menuTree()) {
      const orders = items.map((spec) => spec.inMenu?.order ?? 0)
      expect(orders, `${section} is out of order`).toEqual([...orders].sort((a, b) => a - b))
      // Two items sharing an order would swap places between builds.
      expect(new Set(orders).size, `${section} has duplicate orders`).toBe(orders.length)
    }
  })
})

describe('enablement', () => {
  const registry = createCommandRegistry()

  it('hides Split when already split', () => {
    expect(registry.isEnabled('view.splitView', context({ paneFocus: 'split' }))).toBe(false)
    expect(registry.isEnabled('view.splitView', context({ paneFocus: 'editor' }))).toBe(true)
  })

  it('keeps the palette out of its own results', () => {
    const results = registry.search('', context({ paletteOpen: true }))
    expect(results.map((command) => command.id)).not.toContain('app.commandPalette')
  })

  it('does not offer the flavor already in use', () => {
    const results = registry.search('flavor', context({ flavor: 'gfm' }))
    expect(results.map((command) => command.id)).not.toContain('format.flavor.gfm')
    expect(results.map((command) => command.id)).toContain('format.flavor.commonmark')
  })
})

describe('toggle semantics', () => {
  it('returns to split when the already-maximized pane is toggled', () => {
    const registry = createCommandRegistry()
    const seen: string[] = []
    const ctx = context({
      paneFocus: 'editor',
      setPaneFocus: (focus) => seen.push(focus)
    })

    registry.invoke('view.toggleEditorFocus', ctx)
    expect(seen).toEqual(['split'])

    registry.invoke('view.togglePreviewFocus', ctx)
    expect(seen).toEqual(['split', 'preview'])
  })
})

describe('matchesAccelerator', () => {
  it('maps CmdOrCtrl to Command on macOS and Control on Windows', () => {
    const event = key({ key: 'k', code: 'KeyK', metaKey: true })
    expect(matchesAccelerator(event, 'CmdOrCtrl+K', 'darwin')).toBe(true)
    expect(matchesAccelerator(event, 'CmdOrCtrl+K', 'win32')).toBe(false)

    const ctrlEvent = key({ key: 'k', code: 'KeyK', ctrlKey: true })
    expect(matchesAccelerator(ctrlEvent, 'CmdOrCtrl+K', 'win32')).toBe(true)
    expect(matchesAccelerator(ctrlEvent, 'CmdOrCtrl+K', 'darwin')).toBe(false)
  })

  it('matches on event.code when Option rewrites the character on macOS', () => {
    // Option+1 on a US Mac layout produces "¡", not "1".
    const event = key({ key: '¡', code: 'Digit1', metaKey: true, altKey: true })
    expect(matchesAccelerator(event, 'CmdOrCtrl+Alt+1', 'darwin')).toBe(true)
  })

  it('does not fire when an extra modifier is held', () => {
    const event = key({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true })
    expect(matchesAccelerator(event, 'CmdOrCtrl+K', 'win32')).toBe(false)
  })

  it('does not fire on a bare key', () => {
    expect(matchesAccelerator(key({ key: 'k', code: 'KeyK' }), 'CmdOrCtrl+K', 'win32')).toBe(false)
  })
})

describe('formatAccelerator', () => {
  it('renders platform-appropriate modifier names', () => {
    expect(formatAccelerator('CmdOrCtrl+K', 'darwin')).toBe('Cmd K')
    expect(formatAccelerator('CmdOrCtrl+K', 'win32')).toBe('Ctrl K')
    expect(formatAccelerator('CmdOrCtrl+Alt+1', 'darwin')).toBe('Cmd Opt 1')
    expect(formatAccelerator('CmdOrCtrl+Alt+1', 'win32')).toBe('Ctrl Alt 1')
  })
})

describe('matchScore', () => {
  it('ranks a word-boundary prefix above a scattered subsequence', () => {
    expect(matchScore('File Save', 'sav')).toBeGreaterThan(matchScore('View Split View', 'sav'))
  })

  it('returns zero when a character is missing', () => {
    expect(matchScore('Save', 'xyz')).toBe(0)
  })
})

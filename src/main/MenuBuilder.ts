import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

import { menuTree, type CommandSpec } from '@core/commands/catalog'
import type { Platform } from '@core/commands/registry'
import { IPC, type RecentFile } from '@shared/ipc'
import { PRODUCT_NAME } from '@shared/branding'

/**
 * The native menu (plan §7).
 *
 * Built entirely from the command catalog, so the menu and the palette cannot
 * drift: adding a command in one place adds it to both, and the parity test
 * compares this tree's ids against the catalog's rather than against a
 * hand-written list.
 *
 * The subtle rule is §7's: **Electron accelerators fire before the renderer sees
 * the key.** For a chord CodeMirror owns — undo, cut, select all — registering
 * it here would mean the editor binding silently never runs. Those items are
 * built with `registerAccelerator: false`, which displays the shortcut beside
 * the item without claiming the key, so the chord still reaches CodeMirror and
 * exactly one handler runs. Clicking the item delegates into the focused view
 * through `command:invoke`.
 */

export interface MenuDeps {
  /** The window a menu click should be routed to. */
  focusedWindow: () => BrowserWindow | null
  recentFiles: () => RecentFile[]
  openRecent: (path: string) => void
  /** Command ids the renderer currently reports as unavailable. */
  disabledIds: () => ReadonlySet<string>
}

let deps: MenuDeps | null = null

function invoke(id: string): void {
  deps?.focusedWindow()?.webContents.send(IPC.commandInvoke, id)
}

function itemFor(spec: CommandSpec, platform: Platform): MenuItemConstructorOptions {
  const accelerator = spec.accelerator?.[platform] ?? spec.accelerator?.default

  // A role item is handled by Electron against the focused webContents; giving
  // it a click as well would run the action twice.
  if (spec.role) {
    return {
      id: spec.id,
      label: spec.label,
      role: spec.role,
      ...(accelerator ? { accelerator } : {}),
      registerAccelerator: false
    }
  }

  return {
    id: spec.id,
    label: spec.label,
    enabled: !deps?.disabledIds().has(spec.id),
    ...(accelerator ? { accelerator } : {}),
    // The whole point of the editorOwnedKey flag: show the chord, do not take it.
    ...(spec.editorOwnedKey ? { registerAccelerator: false } : {}),
    click: () => invoke(spec.id)
  }
}

function recentSubmenu(): MenuItemConstructorOptions {
  const recent = deps?.recentFiles() ?? []
  return {
    label: 'Open Recent',
    submenu:
      recent.length === 0
        ? [{ label: 'Nothing yet', enabled: false }]
        : recent.map((entry) => ({
            label: entry.name,
            // The full path is the useful disambiguator when two files share a
            // name, and a menu item has nowhere else to put it.
            toolTip: entry.path,
            click: () => deps?.openRecent(entry.path)
          }))
  }
}

export function buildMenu(next: MenuDeps, platform: Platform = process.platform as Platform): void {
  deps = next

  const sections = menuTree().map<MenuItemConstructorOptions>(({ section, items }) => {
    const children: MenuItemConstructorOptions[] = []

    for (const spec of items) {
      // A command excluded on this platform is excluded from its menu too.
      if (spec.platformOnly && !spec.platformOnly.platforms.includes(platform)) continue
      if (spec.inMenu?.separatorBefore && children.length > 0) children.push({ type: 'separator' })
      children.push(itemFor(spec, platform))
    }

    // Recent files sit under Open, which is where every editor puts them.
    if (section === 'File') {
      const openIndex = children.findIndex((child) => child.id === 'file.openInNewWindow')
      children.splice(openIndex + 1, 0, recentSubmenu())
    }

    return { label: section, submenu: children }
  })

  const template: MenuItemConstructorOptions[] = []

  // macOS puts application-level items in a menu named for the app, and expects
  // Quit to live there rather than under File (§7).
  if (platform === 'darwin') {
    template.push({
      label: PRODUCT_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push(...sections)

  if (platform !== 'darwin') {
    // Windows keeps Quit under File; macOS already has it in the app menu.
    const file = template.find((entry) => entry.label === 'File')
    if (Array.isArray(file?.submenu)) {
      file.submenu.push({ type: 'separator' }, { role: 'quit', label: 'Exit' })
    }
  }

  template.push({
    label: 'Window',
    submenu:
      platform === 'darwin'
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }]
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Rebuild after the recent list or the renderer's enablement set changes. */
export function refreshMenu(platform: Platform = process.platform as Platform): void {
  if (deps) buildMenu(deps, platform)
}

/** Used by the parity test: every command id this tree exposes, sorted. */
export function menuCommandIds(platform: Platform): string[] {
  const ids: string[] = []
  for (const { items } of menuTree()) {
    for (const spec of items) {
      if (spec.platformOnly && !spec.platformOnly.platforms.includes(platform)) continue
      ids.push(spec.id)
    }
  }
  return ids.sort()
}

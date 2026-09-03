import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// SettingsStore reaches for `app.getPath('userData')` only to default the file
// path, and every test here passes one explicitly. The mock exists so the
// import resolves outside Electron at all (plan §12: main logic stays testable
// in a plain Node process).
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const { SettingsStore } = await import('@main/SettingsStore')

/**
 * The settings file (plan §2), and specifically the recent-files list the home
 * screen reads and clears.
 *
 * Clearing is the one recent-list operation with no way back, so what it does —
 * and, just as importantly, what it leaves alone — is asserted against a real
 * file rather than an in-memory double.
 */

let dir: string
let counter = 0

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'margin-settings-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A store over its own file, so tests cannot see each other's writes. */
function store(): InstanceType<typeof SettingsStore> {
  return new SettingsStore(join(dir, `settings-${counter++}.json`))
}

describe('recent files', () => {
  it('records opens most-recent-first, de-duplicated by path', () => {
    const settings = store()
    settings.noteOpened('/a/one.md', 'one.md')
    settings.noteOpened('/b/two.md', 'two.md')
    settings.noteOpened('/a/one.md', 'one.md')

    expect(settings.recent().map((entry) => entry.path)).toEqual(['/a/one.md', '/b/two.md'])
  })

  it('clears every entry and persists the empty list', async () => {
    const file = join(dir, `settings-${counter++}.json`)
    const settings = new SettingsStore(file)
    settings.noteOpened('/a/one.md', 'one.md')
    settings.noteOpened('/b/two.md', 'two.md')

    settings.clearRecent()

    expect(settings.recent()).toEqual([])
    // Persisted, not just forgotten in memory: the next launch reads this file.
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { recent: unknown[] }
    expect(onDisk.recent).toEqual([])
    expect(new SettingsStore(file).recent()).toEqual([])
  })

  it('leaves the other settings untouched when the list is cleared', () => {
    const settings = store()
    settings.update({ theme: 'dark', autoSave: true })
    settings.noteOpened('/a/one.md', 'one.md')

    settings.clearRecent()

    const all = settings.all()
    expect(all.recent).toEqual([])
    expect(all.theme).toBe('dark')
    expect(all.autoSave).toBe(true)
  })

  it('is a no-op on an already empty list', async () => {
    const file = join(dir, `settings-${counter++}.json`)
    const settings = new SettingsStore(file)

    settings.clearRecent()

    // Nothing to persist, so nothing was written.
    await expect(readFile(file, 'utf8')).rejects.toThrow()
    expect(settings.recent()).toEqual([])
  })
})

describe('window geometry', () => {
  const bounds = { x: 120, y: 60, width: 1440, height: 900, maximized: false }

  it('survives a relaunch', () => {
    const file = join(dir, `settings-${counter++}.json`)
    new SettingsStore(file).rememberWindow(bounds)

    expect(new SettingsStore(file).windowState()).toEqual(bounds)
  })

  it('starts empty, so the first launch takes the default size', () => {
    expect(store().windowState()).toBeNull()
  })

  it('stays out of the settings the renderer receives', async () => {
    const file = join(dir, `settings-${counter++}.json`)
    const settings = new SettingsStore(file)
    settings.rememberWindow(bounds)

    // Nothing in the renderer can move a window, so `all()` — the settings:get
    // payload — must not carry the geometry, on a fresh store or a reloaded one.
    expect(settings.all()).not.toHaveProperty('window')
    expect(new SettingsStore(file).all()).not.toHaveProperty('window')
    // But it is in the file, alongside the settings rather than in a second one.
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(onDisk.window).toEqual(bounds)
    expect(onDisk.theme).toBe('light')
  })

  it('ignores a corrupt or half-written record', () => {
    const file = join(dir, `settings-${counter++}.json`)
    writeFileSync(file, JSON.stringify({ theme: 'dark', window: { x: 10, y: 10 } }), 'utf8')

    const settings = new SettingsStore(file)

    // A bad record costs the position, not the launch.
    expect(settings.windowState()).toBeNull()
    expect(settings.all().theme).toBe('dark')
  })

  it('does not rewrite the file when the geometry has not moved', async () => {
    const file = join(dir, `settings-${counter++}.json`)
    const settings = new SettingsStore(file)
    settings.rememberWindow(bounds)
    await rm(file)

    // Called behind a debounce on every resize and move, and each write is
    // synchronous, so an unchanged record has to fall through. The deleted file
    // makes that visible: a write would put it back.
    settings.rememberWindow({ ...bounds })
    await expect(readFile(file, 'utf8')).rejects.toThrow()

    // A real change still writes.
    settings.rememberWindow({ ...bounds, maximized: true })
    await expect(readFile(file, 'utf8')).resolves.toContain('"maximized": true')
    expect(settings.windowState()?.maximized).toBe(true)
  })
})

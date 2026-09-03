/**
 * CommandRegistry (plan §7) — the single source of truth for every user action.
 *
 * The command palette, the native menu, and the keyboard all resolve through
 * this registry. No action is implemented twice. Platform differences live in
 * the `accelerator` field and nowhere else; a command that exists on one
 * platform and not the other must say why in `platformOnly.because`.
 *
 * Pure TypeScript, no Electron import — so the parity test runs in plain Node.
 */

export type Platform = 'darwin' | 'win32' | 'linux'

export const PLATFORMS: readonly Platform[] = ['darwin', 'win32'] as const

export interface Accelerator {
  /** Electron accelerator syntax, e.g. 'CmdOrCtrl+K'. Used when no override applies. */
  default: string
  darwin?: string
  win32?: string
  linux?: string
}

export interface CommandDefinition<Ctx> {
  /** Dotted and stable, e.g. 'view.toggleEditorFocus'. Never renamed casually. */
  id: string
  label: string
  /** Section heading in the palette and the menu, e.g. 'File', 'View'. */
  group: string
  /** Secondary text in the palette. */
  detail?: string
  accelerator?: Accelerator
  /**
   * Set when CodeMirror owns the key. Such commands are kept out of the native
   * menu entirely — Electron accelerators fire before the renderer sees the key,
   * so registering both means the editor binding silently never runs (plan §7).
   */
  editorOwnedKey?: boolean
  /**
   * Deliberate platform asymmetry. `because` is required so parity gaps are a
   * documented decision rather than an oversight.
   */
  platformOnly?: { platforms: Platform[]; because: string }
  /** Enablement. Absent means always enabled. */
  when?: (ctx: Ctx) => boolean
  run: (ctx: Ctx, args?: unknown) => void
}

export class CommandRegistry<Ctx> {
  readonly #commands = new Map<string, CommandDefinition<Ctx>>()

  register(...commands: CommandDefinition<Ctx>[]): this {
    for (const command of commands) {
      if (this.#commands.has(command.id)) {
        throw new Error(`Duplicate command id: ${command.id}`)
      }
      this.#commands.set(command.id, command)
    }
    return this
  }

  get(id: string): CommandDefinition<Ctx> | undefined {
    return this.#commands.get(id)
  }

  all(): CommandDefinition<Ctx>[] {
    return [...this.#commands.values()]
  }

  ids(): string[] {
    return [...this.#commands.keys()].sort()
  }

  /** Commands exposed on a given platform — i.e. the menu tree's command set. */
  idsForPlatform(platform: Platform): string[] {
    return this.all()
      .filter((c) => !c.platformOnly || c.platformOnly.platforms.includes(platform))
      .map((c) => c.id)
      .sort()
  }

  isEnabled(id: string, ctx: Ctx): boolean {
    const command = this.#commands.get(id)
    if (!command) return false
    return command.when ? command.when(ctx) : true
  }

  invoke(id: string, ctx: Ctx, args?: unknown): boolean {
    const command = this.#commands.get(id)
    if (!command) throw new Error(`Unknown command: ${id}`)
    if (command.when && !command.when(ctx)) return false
    command.run(ctx, args)
    return true
  }

  /** The Electron accelerator string for a platform, or null if unbound. */
  resolveAccelerator(id: string, platform: Platform): string | null {
    const accelerator = this.#commands.get(id)?.accelerator
    if (!accelerator) return null
    return accelerator[platform] ?? accelerator.default
  }

  /** Ranked palette results. Higher score first; ties keep registration order. */
  search(query: string, ctx: Ctx): CommandDefinition<Ctx>[] {
    const available = this.all().filter((c) => !c.when || c.when(ctx))
    if (!query.trim()) return available

    const scored: Array<{ command: CommandDefinition<Ctx>; score: number }> = []
    for (const command of available) {
      const score = matchScore(`${command.group} ${command.label}`, query)
      if (score > 0) scored.push({ command, score })
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.command)
  }
}

/**
 * Subsequence match with a bonus for contiguous runs and word-boundary hits, so
 * typing "sav" ranks "Save", where the letters start a word, above a label that
 * merely contains them scattered. Deliberately small — this is a command list,
 * not a fuzzy file finder.
 */
export function matchScore(haystack: string, needle: string): number {
  const target = haystack.toLowerCase()
  const query = needle.toLowerCase().replace(/\s+/g, '')
  if (!query) return 1

  let score = 0
  let cursor = 0
  let previousIndex = -1

  for (const char of query) {
    const index = target.indexOf(char, cursor)
    if (index === -1) return 0
    score += 1
    if (index === previousIndex + 1) score += 2 // contiguous
    if (index === 0 || target[index - 1] === ' ') score += 3 // word boundary
    previousIndex = index
    cursor = index + 1
  }

  // Prefer shorter labels when scores are otherwise equal.
  return score + Math.max(0, 20 - target.length) / 100
}

const DISPLAY_TOKENS: Record<string, Record<Platform, string>> = {
  cmdorctrl: { darwin: 'Cmd', win32: 'Ctrl', linux: 'Ctrl' },
  commandorcontrol: { darwin: 'Cmd', win32: 'Ctrl', linux: 'Ctrl' },
  cmd: { darwin: 'Cmd', win32: 'Ctrl', linux: 'Ctrl' },
  command: { darwin: 'Cmd', win32: 'Ctrl', linux: 'Ctrl' },
  alt: { darwin: 'Opt', win32: 'Alt', linux: 'Alt' },
  option: { darwin: 'Opt', win32: 'Alt', linux: 'Alt' }
}

/**
 * Human-readable accelerator for the footer chip and palette rows —
 * 'CmdOrCtrl+Alt+1' becomes 'Cmd Opt 1' on macOS, 'Ctrl Alt 1' on Windows.
 */
export function formatAccelerator(accelerator: string, platform: Platform): string {
  return accelerator
    .split('+')
    .map((token) => {
      const mapped = DISPLAY_TOKENS[token.toLowerCase()]
      if (mapped) return mapped[platform]
      return token.length === 1 ? token.toUpperCase() : token
    })
    .join(' ')
}

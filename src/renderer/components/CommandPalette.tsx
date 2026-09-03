import { useEffect, useMemo, useRef, useState } from 'react'

import { formatAccelerator, type CommandRegistry, type Platform } from '@core/commands/registry'
import type { AppContext } from '../commands/appCommands'

/**
 * ⌘K command palette (design 3d).
 *
 * The palette renders the registry; it holds no command logic of its own. Rows
 * are grouped by the command's `group`, which is the same grouping the native
 * menu will use in Phase 3.
 */

interface CommandPaletteProps {
  registry: CommandRegistry<AppContext>
  context: AppContext
  platform: Platform
  /**
   * Text the palette opens pre-typed with, for surfaces that stand for one
   * group of commands — the footer's encoding field opens it on the reopen
   * commands. Read once, at mount: the palette owns the query after that.
   */
  initialQuery?: string
  onClose: () => void
}

export function CommandPalette({
  registry,
  context,
  platform,
  initialQuery = '',
  onClose
}: CommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState(initialQuery)
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const results = useMemo(() => registry.search(query, context), [registry, context, query])

  // Keep the selection in range as the result set narrows.
  const index = Math.min(selected, Math.max(0, results.length - 1))

  useEffect(() => {
    inputRef.current?.focus()
    // Seeded text is selected, so typing a different command replaces it
    // rather than appending to a query the user never wrote.
    if (initialQuery) inputRef.current?.select()
    // Mount only: re-running would fight the user's own typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('.palette__row--selected')
    row?.scrollIntoView({ block: 'nearest' })
  }, [index, results.length])

  const run = (commandIndex: number): void => {
    const command = results[commandIndex]
    if (!command) return
    // Close first: several commands move focus, and a palette still mounted
    // would take it straight back.
    onClose()
    registry.invoke(command.id, context)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setSelected((current) => (results.length === 0 ? 0 : (current + 1) % results.length))
        break
      case 'ArrowUp':
        event.preventDefault()
        setSelected((current) =>
          results.length === 0 ? 0 : (current - 1 + results.length) % results.length
        )
        break
      case 'Enter':
        event.preventDefault()
        run(index)
        break
      case 'Escape':
        event.preventDefault()
        onClose()
        break
      default:
        break
    }
  }

  let lastGroup: string | null = null

  return (
    <div
      className="palette__scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette__field">
          <input
            ref={inputRef}
            className="palette__input"
            value={query}
            placeholder="Type a command…"
            spellCheck={false}
            aria-label="Command"
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
            onKeyDown={onKeyDown}
          />
          <span className="palette__esc">Esc to close</span>
        </div>

        <div className="palette__list" ref={listRef}>
          {results.length === 0 ? (
            <div className="palette__empty">No matching commands.</div>
          ) : (
            results.map((command, position) => {
              const heading = command.group !== lastGroup ? command.group : null
              lastGroup = command.group
              const accelerator = registry.resolveAccelerator(command.id, platform)

              return (
                <div key={command.id}>
                  {heading ? <div className="palette__group">{heading}</div> : null}
                  <button
                    type="button"
                    className={
                      position === index ? 'palette__row palette__row--selected' : 'palette__row'
                    }
                    onMouseEnter={() => setSelected(position)}
                    onClick={() => run(position)}
                  >
                    <span>{command.label}</span>
                    {command.detail ? (
                      <span className="palette__detail">{command.detail}</span>
                    ) : null}
                    {accelerator ? (
                      <span className="palette__accel">
                        {formatAccelerator(accelerator, platform)}
                      </span>
                    ) : null}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

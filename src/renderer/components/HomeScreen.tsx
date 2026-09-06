import { useEffect, useState } from 'react'

import type { RecentFile } from '@shared/ipc'
import { LogoMark } from './Logo'

/**
 * The window's empty state (§4.1), and also its whole startup.
 *
 * "Closing the last tab in a window leaves an empty-state window, not a closed
 * window." That empty state is what a launch lands on too: boot does not seed a
 * welcome buffer, so the first thing a window shows is this, not an unnamed
 * document with someone else's prose in it.
 *
 * Three things, in the order someone actually wants them: open a file, return
 * to one recently open, or — for a first run, where the recent list is empty and
 * says so — read the sample. The sample sits last and quietest: it is the start
 * that shows the product rather than naming it, but it is not what a returning
 * user came for.
 *
 * Bare verbs, no encouragement, no colour. Rows separated by hairlines, never
 * filled buttons — the system has one filled surface and this is not it. The
 * mark is the only graphic the product ships.
 */

/**
 * The containing folder, as a disambiguator.
 *
 * Recent files are listed by name, and several projects will happily each have
 * a `notes.md`. The design system's metadata voice is lowercase and plain
 * ("~/Documents"), so the parent folder goes beside the name rather than the
 * full path, which would wrap and bury the name it is meant to qualify.
 */
function parentFolder(path: string): string | null {
  // Both separators: a Windows path never splits on "/" alone.
  const parts = path.split(/[\\/]+/).filter(Boolean)
  // parts[-1] is the file itself.
  return parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null
}

/** How many recents fit before the block competes with the rest of the screen. */
const SHOWN = 5

interface HomeScreenProps {
  /** Raises the open dialog — the same path the File menu and Cmd+O take. */
  onOpen: () => void
  /** Opens one recent entry by its absolute path. */
  onOpenPath: (path: string) => void
  /** Opens the sample markdown — the WELCOME_DOCUMENT text — as an untitled document. */
  onOpenSample: () => void
  /** The Open accelerator label, so the row teaches its own shortcut. */
  openAccelerator: string | null
}

export function HomeScreen({
  onOpen,
  onOpenPath,
  onOpenSample,
  openAccelerator
}: HomeScreenProps): React.JSX.Element {
  /**
   * `null` until main answers, which is not the same as "no recent files": the
   * empty line would otherwise flash on every mount before the list arrives.
   */
  const [recent, setRecent] = useState<RecentFile[] | null>(null)
  /**
   * Clearing is not undoable, and the control sits one careless click from the
   * files themselves — so it arms first and acts on the second click. Not a
   * dialog: §8 bans the native one, and the in-app prompt is the shape reserved
   * for unsaved work, which this is not.
   */
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.margin.files.recent().then((list) => {
      if (!cancelled) setRecent(list.slice(0, SHOWN))
    })
    return () => {
      cancelled = true
    }
  }, [])

  function clearRecent(): void {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    // Main returns the emptied list rather than a void, so what is rendered is
    // what was stored — no optimistic guess that a failed write would falsify.
    void window.margin.files.clearRecent().then(setRecent)
  }

  return (
    <div className="home">
      <div className="home__inner">
        <div className="home__mark">
          <LogoMark width={44} />
        </div>

        <h1 className="home__wordmark">margin</h1>

        <div className="home__actions">
          <button type="button" className="home__action" onClick={onOpen}>
            <span>Open File…</span>
            {openAccelerator ? <span className="kbd">{openAccelerator}</span> : null}
          </button>
        </div>

        <div className="home__recent">
          <div className="home__recentHead">
            <span className="home__recentLabel">Recent</span>
            {recent && recent.length > 0 ? (
              <button
                type="button"
                className="home__recentClear"
                data-armed={armed ? '' : undefined}
                onClick={clearRecent}
                onBlur={() => setArmed(false)}
                aria-label={armed ? 'Confirm clearing recent files' : 'Clear recent files'}
              >
                {armed ? 'Confirm' : 'Clear'}
              </button>
            ) : null}
          </div>

          {recent === null ? null : recent.length === 0 ? (
            <p className="home__recentEmpty">No recent history.</p>
          ) : (
            <ul className="home__recentList">
              {recent.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="home__recentItem"
                    onClick={() => onOpenPath(entry.path)}
                    title={entry.path}
                  >
                    <span className="home__recentName">{entry.name}</span>
                    {parentFolder(entry.path) ? (
                      <span className="home__recentWhere">{parentFolder(entry.path)}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button type="button" className="home__sample" onClick={onOpenSample}>
          Open the sample document
        </button>
      </div>
    </div>
  )
}

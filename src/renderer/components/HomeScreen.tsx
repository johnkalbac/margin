import { useEffect, useState } from 'react'

import type { RecentFile } from '@shared/ipc'
import { LogoMark } from './Logo'

/**
 * The empty-state window (plan §4.1).
 *
 * "Closing the last tab in a window leaves an empty-state window, not a closed
 * window." Until now that empty state was a fresh untitled document, which is a
 * reasonable reading but a poor one: it puts an unnamed buffer in front of
 * someone who just said they were finished with a document.
 *
 * So: the mark, and the two things there are to do. The design system's voice
 * throughout — bare verbs, no encouragement, no illustration, no colour. The
 * mark is the only graphic the product ships, and it is not decorated here
 * either.
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

interface HomeScreenProps {
  onNew: () => void
  onOpen: () => void
  onOpenPath: (path: string) => void
  /** Accelerator labels, so the two actions teach their own shortcuts. */
  newAccelerator: string | null
  openAccelerator: string | null
}

export function HomeScreen({
  onNew,
  onOpen,
  onOpenPath,
  newAccelerator,
  openAccelerator
}: HomeScreenProps): React.JSX.Element {
  const [recent, setRecent] = useState<RecentFile[]>([])
  /**
   * Clearing is not undoable, and the list sits one careless click from the
   * files themselves — so the control arms first and acts on the second click.
   * Not a dialog: §8 bans the native one, and the in-app prompt is the shape
   * reserved for unsaved work, which this is not.
   */
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.margin.files.recent().then((list) => {
      if (!cancelled) setRecent(list.slice(0, 5))
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
        <p className="home__line">No document open.</p>

        <div className="home__actions">
          <button type="button" className="home__action" onClick={onNew}>
            <span>New Document</span>
            {newAccelerator ? <span className="kbd">{newAccelerator}</span> : null}
          </button>
          <button type="button" className="home__action" onClick={onOpen}>
            <span>Open File…</span>
            {openAccelerator ? <span className="kbd">{openAccelerator}</span> : null}
          </button>
        </div>

        {recent.length > 0 ? (
          <div className="home__recent">
            <div className="home__recentHead">
              <span className="home__recentLabel">Recent</span>
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
            </div>
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
          </div>
        ) : null}
      </div>
    </div>
  )
}

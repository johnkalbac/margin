import { LogoMark } from './Logo'

/**
 * The window's empty state (§4.1), and now its whole startup.
 *
 * "Closing the last tab in a window leaves an empty-state window, not a closed
 * window." That empty state is also what a launch lands on: boot no longer
 * seeds a welcome buffer, so the first thing a window shows is this, not an
 * unnamed document with someone else's prose in it.
 *
 * The mark, the name, and one way in. New Document, Open File, and the recent
 * list are gone from here — they stay reachable through the menu, the tab
 * strip's +, and Cmd+N / Cmd+O, which were always the real controls; the home
 * rows only taught chords that the palette already carries. What is left is a
 * link to the sample document, the one start that shows the product instead of
 * naming it.
 *
 * Bare verbs, no encouragement, no colour. The mark is the only graphic the
 * product ships.
 */

interface HomeScreenProps {
  /** Opens the sample markdown — the WELCOME_DOCUMENT text — as an untitled document. */
  onOpenSample: () => void
}

export function HomeScreen({ onOpenSample }: HomeScreenProps): React.JSX.Element {
  return (
    <div className="home">
      <div className="home__inner">
        <div className="home__mark">
          <LogoMark width={44} />
        </div>

        <h1 className="home__wordmark">margin</h1>

        <div className="home__actions">
          <button type="button" className="home__action" onClick={onOpenSample}>
            <span>Open the sample document</span>
          </button>
        </div>
      </div>
    </div>
  )
}

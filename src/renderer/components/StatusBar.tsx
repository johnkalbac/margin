import { ENCODING_LABELS, type Encoding, type Eol, type Flavor, type ThemeMode } from '@shared/types'
import { flavorLabel } from '@core/markdown'
import type { CursorPosition } from '../editor/setup'

/**
 * The footer (plan §4.5, design 3e): commands on the left, document state on the
 * right. No colour signals — save state is carried by weight, per the system.
 */

interface StatusBarProps {
  cursor: CursorPosition
  wordCount: number
  /** In preview focus the caret is not the useful measure; word count is. */
  showWordCount: boolean
  flavor: Flavor
  eol: Eol
  mixedEol: boolean
  encoding: Encoding
  dirty: boolean
  /** Null for an untitled document, which can never be in a saved state. */
  path: string | null
  paletteOpen: boolean
  paletteAccelerator: string
  onOpenPalette: () => void
  onCycleFlavor: () => void
  /** Encoding is clickable per §4.5; an untitled document has none to change. */
  onPickEncoding: () => void
  canPickEncoding: boolean
  theme: ThemeMode
  onToggleTheme: () => void
  /**
   * False on the home screen. Cursor position, flavor, EOL, encoding and save
   * state all describe a document; reporting them when none is open would be
   * inventing facts about nothing.
   */
  hasDocument: boolean
}

function formatCount(value: number): string {
  return value.toLocaleString()
}

export function StatusBar({
  cursor,
  wordCount,
  showWordCount,
  flavor,
  eol,
  mixedEol,
  encoding,
  dirty,
  path,
  paletteOpen,
  paletteAccelerator,
  onOpenPalette,
  onCycleFlavor,
  onPickEncoding,
  canPickEncoding,
  theme,
  onToggleTheme,
  hasDocument
}: StatusBarProps): React.JSX.Element {
  // An untitled document has never been written, so "Saved" would be a lie.
  const saveState = path === null ? 'Unsaved' : dirty ? 'Unsaved' : 'Saved'

  return (
    <footer className="footer">
      <button
        type="button"
        className="footer__commands"
        onClick={onOpenPalette}
        aria-expanded={paletteOpen}
      >
        <span className="kbd">{paletteAccelerator}</span>
        <span>Commands</span>
      </button>

      <div className="footer__state">
        {!hasDocument ? (
          // Appearance is application state, not document state, so it is the
          // one field that survives an empty window.
          <button
            type="button"
            className="footer__item"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? 'Dark' : 'Light'}
          </button>
        ) : null}

        {hasDocument ? (
          <>
        {showWordCount ? (
          <span className="footer__item">{formatCount(wordCount)} words</span>
        ) : (
          <span className="footer__item">
            Ln {cursor.line}, Col {cursor.column}
          </span>
        )}

        {cursor.selectionLength > 0 ? (
          <span className="footer__item">{formatCount(cursor.selectionLength)} selected</span>
        ) : null}

        {/*
          The appearance toggle reads as one more field of document state, in
          the same voice as the others: a plain noun for what is in effect, not
          a switch or an icon. The system has no colour to signal a mode with,
          and it forbids icons here.
        */}
        <button
          type="button"
          className="footer__item"
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={`Appearance: ${theme}. Activate to switch.`}
        >
          {theme === 'dark' ? 'Dark' : 'Light'}
        </button>

        <button
          type="button"
          className="footer__item"
          onClick={onCycleFlavor}
          title="Change Markdown flavor"
        >
          {flavorLabel(flavor)}
        </button>

        {/*
          EOL is reported, not chosen: it is preserved from the file on read and
          reapplied on write (§6), so there is nothing here for a picker to set.
        */}
        <span className="footer__item" title={mixedEol ? 'File contains mixed line endings' : undefined}>
          {eol}
          {mixedEol ? ' (mixed)' : ''}
        </span>

        {/*
          Encoding opens the palette rather than a menu of its own: the reopen
          commands are already in the registry, and §7 allows exactly one
          implementation of an action.
        */}
        {canPickEncoding ? (
          <button
            type="button"
            className="footer__item"
            onClick={onPickEncoding}
            title="Reopen with a different encoding"
          >
            {ENCODING_LABELS[encoding]}
          </button>
        ) : (
          <span className="footer__item">{ENCODING_LABELS[encoding]}</span>
        )}

        <span className="footer__item footer__save">{saveState}</span>
          </>
        ) : null}
      </div>
    </footer>
  )
}

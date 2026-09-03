import { Brand } from './Logo'

/**
 * Title bar (design 4a).
 *
 * The window's own top row, above the tab strip. The native controls are drawn
 * over it — traffic lights on the left on macOS, the minimize/maximize/close
 * overlay on the right on Windows — so this is the drag region and it reserves
 * whichever side the platform uses. Both the reserve and the row's height come
 * from --titlebar-* in tokens.css, keyed off the data-platform attribute that
 * main.tsx stamps on the root element; nothing here branches on the platform.
 *
 * The wordmark lives here rather than in the tab strip so the tabs keep the full
 * width on both platforms. The document name beside it is the window title, and
 * is deliberately quiet: the active tab is where the document is identified.
 */

interface TitleBarProps {
  /** The active document's name — the same string the OS window title carries. */
  title: string
}

export function TitleBar({ title }: TitleBarProps): React.JSX.Element {
  return (
    <div className="titlebar">
      <Brand />
      <span className="titlebar__divider" aria-hidden="true" />
      <span className="titlebar__doc">{title}</span>
    </div>
  )
}

import { PaneHeader } from './PaneHeader'

/**
 * Host for the single EditorView (plan §11).
 *
 * There is exactly one of these in a window and exactly one EditorView inside
 * it, regardless of how many documents are open — see editor/useEditorHost.ts.
 * Collapsing this pane hides it; it never unmounts, so editor state and scroll
 * position survive (plan §4.2).
 */

interface EditorPaneProps {
  attach: (element: HTMLDivElement | null) => void
  maximized: boolean
  hidden: boolean
  accelerator: string | null
  onToggle: () => void
  onInteract: () => void
  style?: React.CSSProperties
}

export function EditorPane({
  attach,
  maximized,
  hidden,
  accelerator,
  onToggle,
  onInteract,
  style
}: EditorPaneProps): React.JSX.Element {
  // The wrapper is always present and only its class changes. Toggling the
  // element structure here would unmount the host div, and with it the
  // EditorView — collapsing is not unmounting (plan §4.2).
  return (
    <section
      className="pane"
      style={style}
      hidden={hidden}
      aria-label="Editor"
      onPointerEnter={onInteract}
      onFocusCapture={onInteract}
    >
      <PaneHeader
        label="Editor"
        maximized={maximized}
        accelerator={accelerator}
        onToggle={onToggle}
      />
      <div className={maximized ? 'pane__measure pane__measure--active' : 'pane__measure'}>
        <div className="editor__host" ref={attach} />
      </div>
    </section>
  )
}

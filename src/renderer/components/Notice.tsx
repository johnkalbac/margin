/**
 * A one-line notice above the panes (design system, "feedback/Banner").
 *
 * Two things put a notice on screen in Phase 2: a file that changed on disk
 * under a dirty buffer, and a file operation that failed. Neither is allowed a
 * colour — the system has no red, green or amber anywhere, and state is carried
 * by weight, a rule and copy instead. This is why a failed save looks like a
 * sentence rather than an alert.
 */

export interface NoticeAction {
  label: string
  onClick: () => void
}

interface NoticeProps {
  message: string
  detail?: string
  actions?: NoticeAction[]
  onDismiss?: () => void
}

export function Notice({ message, detail, actions = [], onDismiss }: NoticeProps): React.JSX.Element {
  return (
    <div className="notice" role="status">
      <span className="notice__message">{message}</span>
      {detail ? <span className="notice__detail">{detail}</span> : null}

      <span className="notice__actions">
        {actions.map((action) => (
          <button key={action.label} type="button" className="notice__action" onClick={action.onClick}>
            {action.label}
          </button>
        ))}
        {onDismiss ? (
          <button type="button" className="notice__action notice__action--quiet" onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </span>
    </div>
  )
}

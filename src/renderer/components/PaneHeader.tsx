import { CollapseIcon, ExpandIcon } from './icons'

/**
 * The label and focus link at the top of each pane (design 3e).
 *
 * The link sits top-right, baseline-aligned with the label, and reads "Focus"
 * at rest / "Split" while maximized. Header and footer never change between the
 * two states.
 */

interface PaneHeaderProps {
  label: string
  maximized: boolean
  accelerator: string | null
  onToggle: () => void
}

export function PaneHeader({
  label,
  maximized,
  accelerator,
  onToggle
}: PaneHeaderProps): React.JSX.Element {
  const action = maximized ? 'Split' : 'Focus'
  return (
    <div className="pane__head">
      <span className="pane__label">{label}</span>
      <button
        type="button"
        className="pane__focus"
        onClick={onToggle}
        title={accelerator ? `${action} (${accelerator})` : action}
      >
        {maximized ? <CollapseIcon /> : <ExpandIcon />}
        {action}
      </button>
    </div>
  )
}

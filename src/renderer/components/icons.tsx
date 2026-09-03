/** Line icons from the design mockups: 16×16 grid, 1.5 stroke, round caps and joins. */

const shared = {
  width: 13,
  height: 13,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: 'false'
} as const

/** Arrows pointing outward — "maximize this pane". */
export function ExpandIcon(): React.JSX.Element {
  return (
    <svg {...shared}>
      <path d="M9.5 2.5h4v4" />
      <path d="M13.5 2.5 9 7" />
      <path d="M6.5 13.5h-4v-4" />
      <path d="M2.5 13.5 7 9" />
    </svg>
  )
}

/** Arrows pointing inward — "return to split". */
export function CollapseIcon(): React.JSX.Element {
  return (
    <svg {...shared}>
      <path d="M2.5 6.5v-4h4" />
      <path d="M2.5 2.5 7 7" />
      <path d="M13.5 9.5v4h-4" />
      <path d="M13.5 13.5 9 9" />
    </svg>
  )
}

/**
 * The Margin mark (see design/Margin Logo.dc.html).
 *
 * Three 45° hairlines in descending weight and value. Construction is fixed: a
 * 15 × 13 viewBox, strokes 4.5 units apart at weights 1.5 / 1.2 / 1.0 and values
 * ink-soft / slate-soft / ash. The mark scales by changing the rendered size, not
 * by transform, and never rotates, gains colour, or takes a container.
 */

interface LogoMarkProps {
  /** Rendered width in px. Below 15px the lightest stroke is dropped, per the spec. */
  width?: number
}

export function LogoMark({ width = 15 }: LogoMarkProps): React.JSX.Element {
  const height = Math.round((width * 13) / 15)
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 15 13"
      fill="none"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1 12 12 1" stroke="var(--ink-soft)" strokeWidth="1.5" />
      <path d="M5.5 12 15 2.5" stroke="var(--slate-soft)" strokeWidth="1.2" />
      {width >= 15 ? <path d="M10 12 15 7" stroke="var(--ash)" strokeWidth="1" /> : null}
    </svg>
  )
}

/** Mark plus wordmark. The wordmark is always lowercase — never title case. */
export function Brand(): React.JSX.Element {
  return (
    <span className="brand">
      <LogoMark width={15} />
      <span>margin</span>
    </span>
  )
}

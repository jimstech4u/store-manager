import type { SVGProps } from 'react';

/**
 * The Store Manager mark and wordmark.
 *
 * The mark is the same three shapes as the favicon (src/app/icon.svg) — a crate, a lid line, and
 * a tally — kept identical on purpose so the tab icon and the header read as the same thing.
 *
 * Two colour modes rather than one:
 *  · `onLight` (default) draws the crate in the brand teal, for a white or pale surface
 *  · `inverse` draws it in white on a solid teal tile, for a coloured header or a dark surface
 *
 * A single-colour mark that relies on a fixed background is the usual reason a logo looks broken
 * in dark mode, and this app has a real dark theme.
 */

export function LogoMark({
  size = 32,
  inverse = false,
  ...rest
}: SVGProps<SVGSVGElement> & { size?: number | string; inverse?: boolean }) {
  const crate = inverse ? '#ffffff' : 'currentColor';
  const tally = inverse ? '#8fcbbe' : '#0f7a66';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {inverse && <rect width="64" height="64" rx="14" fill="#0b6252" />}
      <path
        d="M16 22h32v24a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V22Z"
        stroke={crate}
        strokeWidth={4}
        strokeLinejoin="round"
      />
      <path d="M13 22h38" stroke={crate} strokeWidth={4} strokeLinecap="round" />
      <path d="M25 32v10M32 32v10M39 32v10" stroke={tally} strokeWidth={4} strokeLinecap="round" />
    </svg>
  );
}

/** Mark plus name, for headers and the marketplace bar. */
export function Logo({
  size = 28,
  inverse = false,
  showName = true,
  /**
   * Class applied to the wordmark, so a caller can hide it responsively.
   *
   * On a phone the mark alone identifies the site and the space is better spent on the way in —
   * a dropped button costs a route into the product, a dropped wordmark costs nothing.
   */
  nameClassName,
}: {
  size?: number;
  inverse?: boolean;
  showName?: boolean;
  nameClassName?: string;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5rem',
        color: inverse ? '#ffffff' : 'var(--primary)',
      }}
    >
      <LogoMark size={size} inverse={inverse} />
      {showName && (
        <span
          className={nameClassName}
          style={{
            fontWeight: 700,
            fontSize: '1.0625rem',
            letterSpacing: '-0.01em',
            // The name takes the surrounding text colour so it stays legible in either theme;
            // only the mark carries the brand colour.
            color: 'var(--text)',
            whiteSpace: 'nowrap',
          }}
        >
          Store Manager
        </span>
      )}
    </span>
  );
}

import type { ReactNode, SVGProps } from 'react';

/* =====================================================================================
   Icons — real SVG, no emoji and no icon font.

   Emoji were wrong here for three reasons that all matter for this product:
     · they render differently on every device, so a warning can look playful on one phone
       and severe on another when the meaning is fixed
     · they carry their own colour, which cannot follow the theme or a contrast preference
     · screen readers announce them with names nobody chose ("white heavy check mark")

   These are stroke-based on a 24px grid, drawn in `currentColor` so they inherit text colour
   and adapt to light, dark and high-contrast automatically. Default size is 1.25em rather than
   a fixed pixel value, so an icon scales with the text it sits beside — including when the
   user has enlarged text at the OS level, which this audience frequently has.
   ===================================================================================== */

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Any CSS length. Defaults to 1.25em so icons scale with surrounding text. */
  size?: string | number;
  /**
   * Accessible name. Omit it for icons that merely decorate text already saying the same
   * thing — a labelled icon next to the word "Warning" is repetition a screen reader must
   * then read twice.
   */
  title?: string;
}

function Svg({ size = '1.25em', title, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      /*
       * Marks every icon for the one global rule that takes it off the text baseline.
       *
       * An <svg> defaults to `display: inline`, which sits it on the baseline and leaves descender
       * space underneath — so beside a label it renders a couple of pixels high. Fixing that per
       * container was tried and missed cases: the rule was written for buttons and the icons in
       * rows, headers and list items kept the fault. An attribute on the icon itself cannot be
       * missed by a consumer that composes icons somewhere new.
       */
      data-icon=""
      {...rest}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

export const InfoIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </Svg>
);

export const HelpIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.2 9.2a2.8 2.8 0 1 1 3.8 2.6c-.7.3-1 .9-1 1.6v.3" />
    <path d="M12 17h.01" />
  </Svg>
);

export const WarningIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 3.9 2.4 17.3A2 2 0 0 0 4.1 20.3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Svg>
);

export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6" />
    <path d="M12 16h.01" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

export const CheckCircleIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.3l2.4 2.4 4.6-4.9" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const ChevronUpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m18 15-6-6-6 6" />
  </Svg>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m15 18-6-6 6-6" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Svg>
);

export const MinusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
);

/** Stock / inventory. */
export const BoxIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 8.5v7a2 2 0 0 1-1 1.7l-7 3.9a2 2 0 0 1-2 0l-7-3.9a2 2 0 0 1-1-1.7v-7a2 2 0 0 1 1-1.7l7-3.9a2 2 0 0 1 2 0l7 3.9a2 2 0 0 1 1 1.7Z" />
    <path d="m3.3 7.3 8.7 4.8 8.7-4.8" />
    <path d="M12 21v-8.9" />
  </Svg>
);

/** Sales / receipt. */
export const ReceiptIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 3v18l2.5-1.6L10 21l2-1.6L14 21l2.5-1.6L19 21V3H5Z" />
    <path d="M9 8h6" />
    <path d="M9 12h6" />
  </Svg>
);

/** Customers / debtors. */
export const PeopleIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20a6 6 0 0 1 12 0" />
    <path d="M16.5 5.2a3.2 3.2 0 0 1 0 5.6" />
    <path d="M18 14.4a6 6 0 0 1 3 5.6" />
  </Svg>
);

/** Money / payments. */
export const CashIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.6" />
    <path d="M6 10v4" />
    <path d="M18 10v4" />
  </Svg>
);

/** Stock count / reconciliation. */
export const ClipboardCheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
    <rect x="9" y="2.5" width="6" height="3.5" rx="1" />
    <path d="m9 13.5 2.2 2.2 4-4.4" />
  </Svg>
);

/** Empties / returnable containers. */
export const ReturnIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 11a8 8 0 1 1 2.3 5.7" />
    <path d="M3 7v4h4" />
  </Svg>
);

/** Settings / more. Sliders rather than a cog: easier to read at 22px than a toothed circle. */
export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6h10" />
    <path d="M18 6h2" />
    <circle cx="16" cy="6" r="2" />
    <path d="M4 12h4" />
    <path d="M12 12h8" />
    <circle cx="10" cy="12" r="2" />
    <path d="M4 18h10" />
    <path d="M18 18h2" />
    <circle cx="16" cy="18" r="2" />
  </Svg>
);

export const OfflineIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3l18 18" />
    <path d="M8.5 16.4a5 5 0 0 1 7 0" />
    <path d="M5 12.9a10 10 0 0 1 3.4-2.2" />
    <path d="M15.6 10.7A10 10 0 0 1 19 12.9" />
    <path d="M2 9.5A15 15 0 0 1 7 6.3" />
    <path d="M17 6.3a15 15 0 0 1 5 3.2" />
    <path d="M12 20h.01" />
  </Svg>
);

export const CameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2l1.2-2h8.2l1.2 2h2.2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
    <circle cx="12" cy="13" r="3.4" />
  </Svg>
);

export const ImageIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.6" />
    <path d="m4 17 4.5-4.5a1.6 1.6 0 0 1 2.2 0L15 17" />
    <path d="m14 15 1.6-1.6a1.6 1.6 0 0 1 2.2 0L20 15.6" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V5h6v2" />
    <path d="M6 7v12a1.6 1.6 0 0 0 1.6 1.6h8.8A1.6 1.6 0 0 0 18 19V7" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
);

export const StarIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3.6 2.6 5.3 5.8.85-4.2 4.1 1 5.8-5.2-2.75L6.8 19.65l1-5.8-4.2-4.1 5.8-.85z" />
  </Svg>
);

export const EditIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z" />
    <path d="M14.5 6.5 17.5 9.5" />
  </Svg>
);

export const BankIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 10 12 4l9 6" />
    <path d="M5 10v9M19 10v9M9 10v9M15 10v9" />
    <path d="M3 20h18" />
  </Svg>
);

export const ShieldIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);

export const HistoryIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3 4v4h4" />
    <path d="M12 8v4.5l3 1.8" />
  </Svg>
);

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
    <path d="M21 3v5h-5" />
  </Svg>
);

export const PrinterIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 9V4h10v5" />
    <path d="M7 19H5.6A1.6 1.6 0 0 1 4 17.4v-6.8A1.6 1.6 0 0 1 5.6 9h12.8A1.6 1.6 0 0 1 20 10.6v6.8a1.6 1.6 0 0 1-1.6 1.6H17" />
    <rect x="7" y="15" width="10" height="5" rx="1" />
  </Svg>
);

export const ChartIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h16" />
    <path d="M7 20v-7M12 20V6M17 20v-4" />
  </Svg>
);

/**
 * Show / hide a password.
 *
 * The struck-through eye is the SHOWN state — tapping it hides. That reads the right way round to
 * most people: the icon shows what will happen, not what is happening.
 */
export function EyeIcon({ size = '1.25em' }: { size?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function EyeOffIcon({ size = '1.25em' }: { size?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.6-7 10-7c1.6 0 3 .4 4.3 1M22 12s-3.6 7-10 7c-1.6 0-3-.4-4.3-1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m4 4 16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

/**
 * Attach somebody to a sale, and take them off it again.
 *
 * A person with a plus and a person with a minus, rather than a pencil and a bin: the thing being
 * changed is WHO this sale is for, and a bin next to a customer's name reads as deleting the
 * customer.
 */
export const PersonPlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c0-3.3 2.9-5.5 6.5-5.5 1.2 0 2.3.2 3.2.7" />
    <path d="M17 14v6M14 17h6" />
  </Svg>
);

export const PersonMinusIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c0-3.3 2.9-5.5 6.5-5.5 1.2 0 2.3.2 3.2.7" />
    <path d="M14 17h6" />
  </Svg>
);

/** Hand something to somebody else — the platform's own share gesture. */
export const ShareIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v12M12 3l-4 4M12 3l4 4" />
    <path d="M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13" />
  </Svg>
);

/**
 * WhatsApp.
 *
 * Drawn rather than pulled from a brand pack: it inherits `currentColor` like every other icon
 * here, so it sits correctly on a green button and in dark mode without a second asset.
 */
export const WhatsAppIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 20.5l1.3-4a8 8 0 1 1 3 2.9l-4.3 1.1Z" />
    <path d="M9 9.5c0 3 2.5 5.5 5.5 5.5.6 0 1-.4 1-1v-.8l-1.8-.7-.9.9a5.6 5.6 0 0 1-2.2-2.2l.9-.9-.7-1.8H10c-.6 0-1 .4-1 1Z" />
  </Svg>
);

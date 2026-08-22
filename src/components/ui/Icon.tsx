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

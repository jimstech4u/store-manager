'use client';

import { useId, useState, type ReactNode } from 'react';
import styles from './Explain.module.css';
import { AlertIcon, CheckCircleIcon, HelpIcon, InfoIcon, WarningIcon } from './Icon';

/* =====================================================================================
   Help, in three weights. See Explain.module.css for why there are three.
   ===================================================================================== */

/** Always-visible guidance under a field. Use for what everyone needs every time. */
export function InlineHint({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <span className={styles.hint} id={id}>
      {children}
    </span>
  );
}

/**
 * A tappable explanation that opens in place.
 *
 * Deliberately not a tooltip: tooltips need hover, which does not exist on a phone, and they
 * vanish the moment you look away — useless when the point is to read something while filling
 * in the field it belongs to.
 */
export function Explain({
  label = "What's this?",
  children,
  defaultOpen = false,
}: {
  label?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <div className={styles.explainWrap}>
      <button
        type="button"
        className={styles.explainTrigger}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
      >
        <span className={styles.explainIcon} aria-hidden="true">
          <HelpIcon size="1em" />
        </span>
        {open ? 'Hide explanation' : label}
      </button>

      {open && (
        <div className={styles.explainBody} id={id}>
          {children}
        </div>
      )}
    </div>
  );
}

type PanelTone = 'info' | 'warning' | 'danger' | 'success';

const TONE_ICON: Record<PanelTone, typeof InfoIcon> = {
  info: InfoIcon,
  warning: WarningIcon,
  danger: AlertIcon,
  success: CheckCircleIcon,
};

/**
 * A persistent explanation block, usually at the top of a screen or beside a result.
 *
 * `title` is required rather than optional: a panel whose meaning depends on its colour fails
 * for colour-blind users and in bright sunlight, which is most of this product's working
 * conditions. The words have to carry it — the icon and colour only reinforce.
 */
export function InfoPanel({
  tone = 'info',
  title,
  children,
}: {
  tone?: PanelTone;
  title: string;
  children?: ReactNode;
}) {
  const toneClass = {
    info: styles.panelInfo,
    warning: styles.panelWarning,
    danger: styles.panelDanger,
    success: styles.panelSuccess,
  }[tone];

  const ToneIcon = TONE_ICON[tone];

  return (
    <div
      className={`${styles.panel} ${toneClass}`}
      // Warnings and errors are announced when they appear; informational panels are not, so a
      // screen reader is not interrupted by something merely explanatory.
      role={tone === 'danger' || tone === 'warning' ? 'alert' : undefined}
    >
      <span className={styles.panelIcon}>
        <ToneIcon />
      </span>
      <div className={styles.panelContent}>
        <p className={styles.panelTitle}>{title}</p>
        {children && <div className={styles.panelText}>{children}</div>}
      </div>
    </div>
  );
}

export interface ExampleRow {
  label: string;
  value: string;
  /** Highlights the line that carries the point — usually the result. */
  emphasis?: boolean;
}

/**
 * A worked example with real numbers.
 *
 * The most valuable help this product can give. "Landed cost" is an abstraction; "₦320,000 of
 * drinks plus ₦20,000 delivery is ₦283.33 a bottle, not ₦266.67" is a thing a distributor
 * recognises immediately, because it is their own arithmetic.
 */
export function WorkedExample({
  label = 'Example',
  rows,
  note,
}: {
  label?: string;
  rows: ExampleRow[];
  note?: ReactNode;
}) {
  return (
    <div className={styles.example}>
      <span className={styles.exampleLabel}>{label}</span>
      {rows.map((row) => (
        <div className={styles.exampleRow} key={row.label}>
          <span>{row.label}</span>
          <span
            className={`${styles.exampleValue} ${row.emphasis ? styles.exampleEmphasis : ''}`}
          >
            {row.value}
          </span>
        </div>
      ))}
      {note && <p className={styles.hint}>{note}</p>}
    </div>
  );
}

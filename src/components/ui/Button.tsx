'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'small' | 'medium' | 'large';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  /** Shows a spinner and blocks further presses. */
  busy?: boolean;
  /** Announced to screen readers while busy — say what is happening, not just "loading". */
  busyLabel?: string;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'medium',
  fullWidth = false,
  busy = false,
  busyLabel = 'Working',
  disabled,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    styles[variant],
    size !== 'medium' ? styles[size] : '',
    fullWidth ? styles.fullWidth : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      // Disabled while busy so a slow network cannot be double-submitted by an impatient second
      // press. The RPCs are idempotent as well (C2) — this is the first of two defences, because
      // a double-posted sale is the failure that would destroy trust in the tool fastest.
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <span className={styles.spinner} aria-hidden="true" />}
      {/*
        The label is its own flex row.

        `children` is usually an icon followed by text, and this span was a plain one — so the two
        sat in normal inline flow, where the icon rides the text baseline and reads as misaligned.
        The button's own `align-items: center` could not help, because from its point of view this
        span is a single item.
      */}
      <span className={styles.label}>{busy ? busyLabel : children}</span>
    </button>
  );
}

'use client';

import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import styles from './Field.module.css';
import { InlineHint } from './Explain';
import { AlertIcon } from './Icon';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: string;
  /** Always-visible guidance. Prefer this over a placeholder for anything that matters. */
  hint?: ReactNode;
  /** Deeper explanation, rendered by the caller (usually <Explain> or <WorkedExample>). */
  help?: ReactNode;
  error?: string | null;
  /** Shown before the input: '₦' for money. */
  prefix?: string;
  /** Shown after the input: 'kg', 'pieces', 'packs'. */
  suffix?: string;
  /** Tabular figures, right-aligned, numeric keypad. Use for money and quantities. */
  numeric?: boolean;
  /** Marks the field as not required, in words. */
  optional?: boolean;
}

export function Field({
  label,
  hint,
  help,
  error,
  prefix,
  suffix,
  numeric = false,
  optional = false,
  required,
  className,
  id: idProp,
  inputMode,
  ...rest
}: FieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  const inputClasses = [
    styles.input,
    numeric ? styles.numeric : '',
    error ? styles.inputError : '',
    prefix ? styles.hasPrefix : '',
    suffix ? styles.hasSuffix : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}{' '}
        {optional ? (
          <span className={styles.optional}>(optional)</span>
        ) : required ? (
          <span className={styles.required}>(required)</span>
        ) : null}
      </label>

      <div className={styles.inputWrap}>
        {prefix && (
          <span className={`${styles.affix} ${styles.prefix}`} aria-hidden="true">
            {prefix}
          </span>
        )}

        <input
          id={id}
          className={inputClasses}
          // 'decimal' rather than 'numeric' for quantities: bulk goods are genuinely fractional
          // (1.4 kg), and a keypad with no decimal point makes that impossible to type.
          inputMode={inputMode ?? (numeric ? 'decimal' : undefined)}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
          {...rest}
        />

        {suffix && (
          <span className={`${styles.affix} ${styles.suffix}`} aria-hidden="true">
            {suffix}
          </span>
        )}
      </div>

      {/* The unit is decoration for a sighted user and essential context for a screen reader,
          so it is repeated here rather than left in the aria-hidden affix. */}
      {(prefix || suffix) && (
        <span className="sr-only">
          {prefix ? `Amount in ${prefix === '₦' ? 'naira' : prefix}. ` : ''}
          {suffix ? `Measured in ${suffix}.` : ''}
        </span>
      )}

      {hint && <InlineHint id={hintId}>{hint}</InlineHint>}

      {error && (
        <p className={styles.error} id={errorId} role="alert">
          <span className={styles.errorIcon}>
            <AlertIcon size="1.1em" />
          </span>
          {error}
        </p>
      )}

      {help}
    </div>
  );
}

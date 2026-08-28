'use client';

import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { EyeIcon, EyeOffIcon } from './Icon';
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
    rest.type === 'password' ? styles.hasReveal : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  /*
   * A password field reveals itself; everything else is untouched.
   *
   * Detected from `type` rather than added as a prop, so every password field in the product gets
   * it without each one remembering to ask.
   */
  const isPassword = rest.type === 'password';
  const [revealed, setRevealed] = useState(false);

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
          // After the spread, so a caller cannot accidentally pin the type and defeat the reveal.
          type={isPassword ? (revealed ? 'text' : 'password') : rest.type}
        />

        {/*
          Show the password.

          A password typed blind on a phone keyboard is guesswork, and the alternative people reach
          for is a shorter, simpler password. Being able to check what was typed is a security
          feature, not a convenience.

          `type="button"` matters: inside a form, a button with no type submits it — so tapping the
          eye would try to sign you in with a half-typed password.
        */}
        {isPassword && (
          <button
            type="button"
            className={styles.reveal}
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            aria-pressed={revealed}
            // Never a tab stop between the field and the submit button — somebody using a keyboard
            // is typing a password, not looking for this.
            tabIndex={-1}
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        )}

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

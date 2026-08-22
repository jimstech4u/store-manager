'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import styles from './Sheet.module.css';
import { CloseIcon } from './Icon';

/**
 * A bottom sheet — the app's modal surface.
 *
 * Bottom-anchored on a phone because that is where a thumb reaches, and centred on a wide screen
 * where a bottom sheet would be a phone idiom out of place.
 *
 * Modal behaviour is done properly rather than approximated: focus moves in on open and returns
 * to whatever opened it on close, Escape dismisses, focus is trapped while open, and the page
 * behind cannot scroll. Skipping any of these produces a dialog that a keyboard or screen-reader
 * user can fall out of without noticing — which, on a screen that takes money, is not acceptable.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  /** Blocks backdrop and Escape dismissal — for a step that must not be lost by a stray tap. */
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  dismissible?: boolean;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;

    restoreFocusTo.current = document.activeElement as HTMLElement | null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus the sheet itself rather than its first control: announcing the title before the
    // first field gives a screen-reader user the context for what they are about to fill in.
    sheetRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key !== 'Tab') return;

      // Focus trap. Without it, tabbing walks into the page behind the backdrop, where the user
      // is interacting with controls they cannot see.
      const focusable = sheetRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
          ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusTo.current?.focus?.();
    };
  }, [open, onClose, dismissible]);

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      onClick={dismissible ? onClose : undefined}
      role="presentation"
    >
      <div
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        // Stops a tap inside the sheet reaching the backdrop and closing it.
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.grabber} aria-hidden="true" />
        <div className={styles.head}>
          <h2 className={styles.title} id={titleId}>
            {title}
          </h2>
          {dismissible && (
            <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
              <CloseIcon size="1.4em" />
            </button>
          )}
        </div>

        <div className={styles.body}>{children}</div>

        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );
}

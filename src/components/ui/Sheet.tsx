'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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

  /*
   * Rendered into document.body, not where it is written.
   *
   * A sheet declared inside a navigation-stack page sits under that page's slide transform, and a
   * transformed ancestor becomes the containing block for `position: fixed`. The backdrop
   * therefore covered the PAGE rather than the viewport: it stopped short of the tab bar, taps
   * there went straight through to the app behind an open dialog, and the sheet was trapped in
   * the page's stacking context underneath it. It looked like the sheet was ignoring touch; it
   * was being drawn in the wrong box.
   *
   * This is what @academix-admin/modal-sheet does for the same reason.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const titleId = useId();

  /**
   * Make the platform back gesture close the sheet instead of leaving the app.
   *
   * On Android — and with an iOS edge-swipe — back is how people dismiss anything that covers the
   * screen. Without this, pressing back with the payment sheet open navigates away from the whole
   * app and loses a half-entered sale, which is the single worst moment for that to happen.
   *
   * Implemented by pushing one history entry when the sheet opens and popping it when it closes.
   * The entry is marked so a popstate can be recognised as ours: another sheet, or the app's own
   * navigation stack, may also be writing history, and closing on somebody else's popstate would
   * dismiss a sheet the user never dismissed.
   */
  // onClose is almost always an inline arrow at the call site, so its identity changes on every
  // render of the parent. Held in a ref so the history effect below can depend on `open` ALONE.
  //
  // Depending on onClose directly is what broke this the first time: every parent re-render tore
  // the effect down, the cleanup called history.back(), and the sheet dismissed itself about
  // 400ms after opening. It looked like a rendering glitch and was a dependency-array bug.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;

    const marker = `sheet-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    window.history.pushState({ ...(window.history.state ?? {}), smSheet: marker }, '');

    /*
     * How deep the history was once this sheet's entry existed.
     *
     * A GUARD AGAINST A LIBRARY BUG, and it comes out when the fix ships. navigation-stack 0.13.0
     * pushes with `{ ...history.state, navStack }`, which copies THIS MARKER onto the entry it
     * creates — so a sheet closing in the same tick as a page push saw its own id on the pushed
     * entry, decided the entry was its own, and popped the page. That is what made the receipt
     * vanish after settling a sale.
     *
     * Fixed in navigation-stack 0.13.1 (packages/navigation-stack, changeset
     * navstack-push-state-isolation): a push no longer inherits the previous entry's state. Once
     * 0.13.1 is published and this app depends on it, `depthAtPush` and its half of the condition
     * below should be deleted — the marker alone is then sufficient, and this was verified against
     * a local 0.13.1 build.
     */
    const depthAtPush = window.history.length;


    const onPop = () => {
      // Whatever we landed on, this sheet's entry is gone — so the sheet must close. Guarding on
      // `dismissible` would strand a non-dismissible sheet over a page it no longer belongs to.
      closeRef.current();
    };

    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed by a button rather than by back: our entry is still on the stack, so take it off.
      // Otherwise the next back press appears to do nothing at all.
      //
      // Both conditions, until 0.13.1 ships. The marker says the top entry is a sheet's; the
      // unchanged depth says nothing has been pushed on top of it since.
      const state = window.history.state as { smSheet?: string } | null;
      if (state?.smSheet === marker && window.history.length === depthAtPush) {
        window.history.back();
      }
    };
  }, [open]);

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

  if (!open || !mounted) return null;

  return createPortal(
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
    </div>,
    document.body,
  );
}

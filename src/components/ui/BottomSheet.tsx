'use client';

import { useId, type ReactNode } from 'react';
import { BottomViewer } from '@academix-admin/bottom-viewer';
import { useOverlayRoute } from '@/hooks/useOverlayRoute';
import styles from './BottomSheet.module.css';
import { CloseIcon } from './Icon';

/**
 * The app's modal surface: a titled panel over `@academix-admin/bottom-viewer`.
 *
 * This file is only chrome — a title bar, a scrolling body, a pinned footer. Everything that makes
 * a modal a modal now lives in the package: it portals itself out of the page's transform (a
 * transformed ancestor becomes the containing block for `position: fixed`, which is what once left
 * the backdrop stopping short of the tab bar with taps falling straight through it), it announces
 * itself as `role="dialog" aria-modal="true"`, it closes on Escape, it traps Tab, and it drags to
 * dismiss with keyboard avoidance that the hand-rolled version never had.
 *
 * The predecessor reimplemented all of that in the app, which meant every fix had to be made here
 * and benefited nothing else. It is in `_unused/store-manager/` for reference.
 *
 * `zIndex` is 1000 deliberately: the tab bar sits at 50 and is a sibling of the page, so anything
 * lower is a sheet the tabs punch through — drawn in front of it and still taking taps.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
  footer,
  /** Blocks backdrop and drag dismissal — for a step that must not be lost by a stray tap. */
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  dismissible?: boolean;
}) {
  const titleId = useId();

  // The sheet portals itself and does not register with the navigation stack, so without this the
  // back gesture would walk straight past an open sheet and out of the screen behind it.
  useOverlayRoute(`sheet:${titleId}`, open, onClose);

  return (
    <BottomViewer
      isOpen={open}
      onClose={onClose}
      // The visible title is the sheet's name. Left unset, a screen reader announces only "dialog":
      // something has taken over the screen, and nothing about what.
      ariaLabel={title}
      zIndex={1000}
      // A sheet that must not be lost to a stray tap keeps its backdrop — it still dims the page
      // and blocks what is behind — but neither the backdrop nor a downward drag dismisses it.
      backDrop
      disableDrag={!dismissible}
      closeThreshold={dismissible ? undefined : 1}
      layoutProp={{
        backgroundColor: 'var(--surface)',
        handleColor: 'var(--border-strong)',
        maxWidth: '640px',
        maxHeight: '92dvh',
      }}
    >
      <div className={styles.panel}>
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
    </BottomViewer>
  );
}

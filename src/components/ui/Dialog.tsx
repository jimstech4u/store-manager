'use client';

import { useEffect, useRef } from 'react';
import { useDialog } from '@academix-admin/dialog-viewer';
import { useTheme } from '@/context/ThemeContext';

/**
 * The app's dialog: a centred question with buttons, over `@academix-admin/dialog-viewer`.
 *
 * A DIALOG, NOT A SHEET, and the difference is what is being asked. A sheet is a surface you act
 * ON — a picker, a preview, the result of something that already happened. A dialog interrupts to
 * ask a question that must be answered before anything else continues: is this the customer you
 * meant, do you want to merge or replace, are you sure you want to lose this.
 *
 * Same shape academix-web uses for the same job, colours aside — its `layoutProp` is where the
 * theme is handed over, because the package is app-agnostic by charter and has no business
 * reading store-manager's CSS variables.
 */
export function useConfirm() {
  const { theme } = useTheme();
  const dialog = useDialog();

  const dark = theme === 'dark';

  /** The theme, handed to the package rather than assumed by it. */
  const layoutProp = {
    backgroundColor: dark ? '#141a19' : '#ffffff',
    titleColor: dark ? '#f2f5f4' : '#12201d',
    margin: '16px',
    maxWidth: '420px',
    borderRadius: '16px',
  };

  return { ...dialog, layoutProp };
}

/**
 * A question with a destructive answer.
 *
 * `danger` on the confirming button and the cancel always present: the two together are what stop
 * a tap landing on "yes" out of habit. `closeOnBackdrop` stays on — dismissing by tapping outside
 * is the SAFE outcome here, because the safe outcome is that nothing happens.
 */
export function ConfirmDialog({
  controller,
  title,
  message,
  confirmText,
  onConfirm,
  cancelText = 'Cancel',
  tone = 'danger',
  onDismiss,
}: {
  controller: ReturnType<typeof useConfirm>;
  title: string;
  message?: string;
  confirmText: string;
  onConfirm: () => void;
  cancelText?: string;
  tone?: 'danger' | 'primary';
  /** Called whenever this dialog is finished with — confirmed, cancelled or dismissed. */
  onDismiss?: () => void;
}) {
  const { DialogViewer, close, open, layoutProp } = controller;

  /*
   * Mounted means asked.
   *
   * The caller decides whether this is on the page at all, so opening on mount is what makes the
   * two agree — without it a dialog could be mounted and invisible, which is a question nobody can
   * answer and nothing can dismiss.
   */
  useEffect(() => {
    open();
  }, [open]);

  /*
   * Unmount when the package closes it — but only once it has actually been open.
   *
   * Cancel and the backdrop are handled inside the package and report nothing back: the viewer it
   * hands out has no `onClose`. Left mounted after such a dismissal its overlay stays on the page
   * and keeps swallowing taps, so the caller's flag has to come down when `isOpen` does.
   *
   * THE GUARD IS THE WHOLE POINT. `open()` above takes a render to land, so on the first render
   * `isOpen` is still false — and without `seenOpen` this fired immediately, telling the caller to
   * unmount a dialog that had not appeared yet. Remove and Close looked broken: three or four taps
   * before one happened to catch a render where the flag had already flipped. Waiting until it has
   * genuinely been open makes one tap enough.
   */
  const seenOpen = useRef(false);

  useEffect(() => {
    if (controller.isOpen) {
      seenOpen.current = true;
      return;
    }
    if (seenOpen.current) onDismiss?.();
  }, [controller.isOpen, onDismiss]);

  const finish = () => {
    close();
    onDismiss?.();
  };

  return (
    <DialogViewer
      title={title}
      message={message}
      buttons={[
        {
          text: confirmText,
          variant: tone,
          onClick: () => {
            finish();
            onConfirm();
          },
        },
      ]}
      showCancel
      cancelText={cancelText}
      /*
       * Gone from the page when it is closed, not merely invisible.
       *
       * Left mounted, the overlay stays in the DOM and swallows taps meant for what is behind it —
       * the sell screen quietly stopped responding, which is the worst possible failure on a till.
       */
      unmountOnClose
      closeOnBackdrop
      zIndex={1100}
      layoutProp={layoutProp}
    />
  );
}

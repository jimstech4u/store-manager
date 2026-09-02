'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

  /*
   * The theme, handed to the package rather than assumed by it.
   *
   * The BUTTONS matter as much as the background. Left to the package's defaults the confirming
   * button is iOS blue and the destructive one iOS red, on a screen where every other button is the
   * shop's deep teal — it reads as another app's dialog, and a seller hesitates before pressing a
   * button they do not recognise. dialog-viewer 0.4.0 takes these; every one defaults to its old
   * colour, so nothing else that uses the package changed.
   */
  const layoutProp = {
    backgroundColor: dark ? '#141a19' : '#ffffff',
    titleColor: dark ? '#f2f5f4' : '#12201d',
    messageColor: dark ? '#b9c6c2' : '#4a5c57',
    primaryColor: dark ? '#3fa08a' : '#0b6252',
    primaryTextColor: dark ? '#08201b' : '#ffffff',
    secondaryColor: dark ? '#25302d' : '#eef2f1',
    secondaryTextColor: dark ? '#e6edea' : '#12201d',
    dangerColor: '#c0392b',
    dangerTextColor: '#ffffff',
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

/**
 * Something failed, and the shop must be told before it presses the button again.
 *
 * `useProblem()` returns a controller and a `<ProblemDialog />` to render. Call `show(message)`
 * from a catch block; the dialog opens with one OK button and closes on the backdrop, because
 * there is nothing to decide — only something to know.
 *
 * WHY NOT AN InfoPanel. A failure is an EVENT: it happened once, at a moment, in response to
 * something the shop just did. A panel is a place, and a place gets scrolled past — the seller
 * presses Save, the page does not visibly change, and they press it again. Measured on the
 * delivery screen, where the failure panel sits above a form long enough to push it off a phone.
 *
 * A CONDITION still belongs on the page. "Some of this can come in but never go out" is true
 * before the press and after it, and a dialog would let it be dismissed with the problem intact.
 * The test is whether it would still be true after pressing OK.
 */
export function useProblem() {
  const controller = useConfirm();
  const [message, setMessage] = useState<string | null>(null);

  const show = useCallback((text: string) => setMessage(text), []);
  const clear = useCallback(() => setMessage(null), []);

  /*
   * NOT STABLE, and no longer pretending to be.
   *
   * A first version wrapped this in `useMemo` so callers could safely list it as a dependency. It
   * could not deliver that: `controller` comes from `useDialog`, which returns a fresh object every
   * render, so the memo changed every render too — and an effect depending on it re-ran constantly.
   * On the return-units page that effect FETCHED, so every keystroke reloaded from the server and
   * overwrote the row just added. The composer cleared, the list stayed empty, and nothing saved.
   *
   * A memo that quietly does nothing is worse than none, because it invites exactly the dependency
   * that breaks. So: DEPEND ON `problem.show`, bound to a local const — it is
   * `useCallback(..., [])` and genuinely never changes.
   */
  return { controller, message, show, clear };
}

export function ProblemDialog({
  problem,
  title = 'That did not work',
}: {
  problem: ReturnType<typeof useProblem>;
  title?: string;
}) {
  const { controller, message, clear } = problem;
  const { DialogViewer, close, open, layoutProp } = controller;

  /*
   * Opened when there IS one, and only then — this component is rendered unconditionally by its
   * page, so the message is what decides. Rendering it always is what keeps the caller from having
   * to hold a second "is the dialog up" flag, which is the thing that went wrong with ConfirmDialog
   * and cost three taps per press.
   */
  useEffect(() => {
    if (message) open();
  }, [message, open]);

  if (!message) return null;

  return (
    <DialogViewer
      title={title}
      message={message}
      buttons={[
        {
          text: 'OK',
          variant: 'primary',
          onClick: () => {
            close();
            clear();
          },
        },
      ]}
      showCancel={false}
      unmountOnClose
      closeOnBackdrop
      zIndex={1200}
      layoutProp={layoutProp}
    />
  );
}

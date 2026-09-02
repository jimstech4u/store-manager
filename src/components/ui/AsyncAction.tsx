'use client';

import { useCallback, useState, type ReactNode } from 'react';
import styles from './AsyncAction.module.css';
import { messageOf } from '@/lib/format';

/**
 * A control that goes to the shop, and says so.
 *
 * Almost every button on a till now does something over the network — adding an item, taking
 * payment, putting a balance on account, changing who a sale is for. Each of those can be slow,
 * and each can fail. Left unsaid, both look identical to a button that does not work: the seller
 * taps again, and again, with a customer watching.
 *
 * THREE STATES IN ONE FOOTPRINT. The control, a spinner, and a failure with a way to try again all
 * occupy the same box, and the box does not change size between them. A spinner that pushes the
 * page down, or an error message that appears below and shifts everything, moves the thing being
 * tapped at the exact moment somebody is tapping it.
 *
 * The control does not disappear while it works — it fades and stops taking touches. Somebody who
 * has just tapped "Take payment" should still be able to see that is what they tapped.
 */

export type AsyncState = 'idle' | 'busy' | 'failed';

/**
 * Runs an action, reporting what it is doing.
 *
 * Returns the state and a runner; a component holds one of these per control rather than one
 * shared flag, because two controls in a row that both go busy when only one was pressed is a
 * worse lie than no feedback at all.
 */
export function useAsyncAction() {
  const [state, setState] = useState<AsyncState>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);

  const run = useCallback((action: () => void | Promise<void>) => {
    const attempt = async () => {
      setState('busy');
      setProblem(null);
      try {
        await action();
        setState('idle');
      } catch (e) {
        setProblem(messageOf(e, 'That did not go through.'));
        // Held so Retry runs the same action, not a fresh closure over stale values.
        setRetry(() => attempt);
        setState('failed');
      }
    };
    void attempt();
  }, []);

  const dismiss = useCallback(() => {
    setState('idle');
    setProblem(null);
  }, []);

  return { state, problem, run, retry, dismiss };
}

export function AsyncAction({
  state,
  problem,
  onRetry,
  onDismiss,
  /** What the spinner and the failure are about, for a screen reader. */
  label,
  children,
}: {
  state: AsyncState;
  problem?: string | null;
  onRetry?: (() => void) | null;
  onDismiss?: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.wrap}>
      {/*
        Faded and untouchable while busy, rather than removed.

        `visibility` is deliberately not used: it would collapse nothing, but `pointer-events` is
        what actually stops the second and third taps of an impatient hand, and opacity is what
        says the control is not currently listening.
      */}
      <div className={`${styles.control} ${state === 'idle' ? '' : styles.inert}`} aria-hidden={state !== 'idle'}>
        {children}
      </div>

      {state === 'busy' && (
        <div className={styles.overlay} role="status" aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          <span className="sr-only">{label}</span>
        </div>
      )}

      {state === 'failed' && (
        <div className={styles.overlay} role="alert">
          <span className={styles.problem}>{problem ?? 'That did not go through.'}</span>
          <span className={styles.failActions}>
            {onRetry && (
              <button type="button" className={styles.retry} onClick={onRetry}>
                Try again
              </button>
            )}
            {onDismiss && (
              <button type="button" className={styles.dismiss} onClick={onDismiss}>
                Not now
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

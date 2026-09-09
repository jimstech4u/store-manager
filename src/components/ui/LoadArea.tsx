'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RefreshIcon } from '@/components/ui/Icon';
import { messageOf } from '@/lib/format';
import styles from './LoadArea.module.css';

/**
 * A PART of a page that fetches its own data, and says so in its own footprint.
 *
 * `AsyncAction` is this for a control that WRITES — a button that goes to the shop and comes back.
 * There was no equivalent for a READ, so a page with three things to fetch had one answer for all
 * of them: `if (loading) return <FullPageMessage/>`, the whole screen replaced by a spinner because
 * one section had not arrived. The settle screen did it for the receipt, and then swallowed the
 * failure of a second read entirely — `catch { found[id] = [] }` — so a pool whose shapes could not
 * be read looked exactly like a pool with no shapes declared, and the seller was quietly offered a
 * free-text box instead of the crate and bottle they were meant to count into.
 *
 * Three things, and the reason for each:
 *
 *   LOADING sits where the content will be, so the eye is already in the right place, and it does
 *   not resize the page around it when the content lands.
 *
 *   A FAILURE INTERRUPTS ONCE. The message goes to a dialog, per the standing rule — a save or a
 *   read that failed is an event, and an `InfoPanel` two screens down gets scrolled past. Reported
 *   once per failure, not once per render, or a screen that cannot reach the server reopens its own
 *   dialog for ever.
 *
 *   AND THE RETRY STAYS ON THE PAGE. After the dialog is dismissed the area still has nothing in it,
 *   and "try again" has to be reachable without a reload — so it is a control, in place, where the
 *   thing that failed was going to be.
 *
 * IT NEVER BLANKS BEFORE IT FETCHES. A refresh that fails keeps what is already on screen and sets
 * only the error, because a pushed-under page has not remounted and a section that empties itself
 * on the way back looks exactly like data that was lost.
 */

export interface Area<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Reads something, once, and again on demand.
 *
 * `onFail` is called with the message so the page can open its dialog. It is fired from the fetch,
 * not from a render, which is what stops a failed read reopening the dialog on every keystroke
 * elsewhere on the page.
 */
export function useLoadArea<T>(
  read: () => Promise<T>,
  deps: readonly unknown[],
  options: { onFail?: (message: string) => void; whenNot?: boolean } = {},
): Area<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  /*
   * Held in refs so they are not dependencies.
   *
   * `read` is a fresh closure every render and `onFail` usually comes from a hook that returns a
   * new object each time — listing either would refetch on every render, which is the loop that
   * cleared the return-units composer on every keystroke.
   */
  const readRef = useRef(read);
  readRef.current = read;
  const failRef = useRef(options.onFail);
  failRef.current = options.onFail;

  const held = options.whenNot === true;

  useEffect(() => {
    if (held) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const got = await readRef.current();
        if (cancelled) return;
        setData(got);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // The cached value is KEPT. Only the error is set.
        const said = messageOf(e, 'That could not be read.');
        setError(said);
        failRef.current?.(said);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, held, ...deps]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return { data, loading, error, reload };
}

/**
 * What that area shows while it is working, and when it could not.
 *
 * `what` names the thing in the shop's words — "that receipt", "what each pool comes back in" — so
 * both the spinner and the failure say which part of the page is affected. A page with three of
 * these must not show three identical "Could not load" lines.
 */
export function LoadArea<T>({
  area,
  what,
  children,
  compact = false,
}: {
  area: Area<T>;
  what: string;
  /** Rendered with the data once there is any. Kept on screen through a failed refresh. */
  children: (data: T) => ReactNode;
  /** A single line rather than a block, for an area that sits inside a row. */
  compact?: boolean;
}) {
  if (area.data !== null) {
    return (
      <>
        {children(area.data)}
        {/*
          A refresh that failed over data already on screen. The rows stay — they are the last
          thing known to be true — and this says the newer answer did not arrive.
        */}
        {area.error && !area.loading && (
          <p className={styles.stale}>
            Could not refresh {what}.{' '}
            <button type="button" className={styles.retryLink} onClick={area.reload}>
              <RefreshIcon /> Try again
            </button>
          </p>
        )}
      </>
    );
  }

  if (area.loading) {
    return (
      <div className={compact ? styles.frameCompact : styles.frame}>
        <span className={styles.spinner} aria-hidden="true" />
        <p className={styles.text} role="status">
          Reading {what}
        </p>
      </div>
    );
  }

  if (area.error) {
    return (
      <div className={compact ? styles.frameCompact : styles.frame}>
        <p className={styles.text}>Could not read {what}.</p>
        {/*
          The way back, in place. The message itself went to the dialog when it happened; repeating
          it here would put a wall of server text in the middle of the page, and the one thing
          somebody wants at this point is to try again.
        */}
        <button type="button" className={styles.retry} onClick={area.reload}>
          <RefreshIcon /> Try again
        </button>
      </div>
    );
  }

  return null;
}

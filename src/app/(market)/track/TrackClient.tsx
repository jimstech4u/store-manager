'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MarketShell } from '../MarketShell';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { getSupabase } from '@/lib/supabase/client';
import { formatMoney, formatQty } from '@/lib/format';
import styles from './track.module.css';

/**
 * Follow an order while it is being rung up, with no account.
 *
 * The seller reads out the code the order already has; the customer types it here and watches
 * every line appear on their own phone. It is the difference between "trust me, that comes to
 * ₦86,600" and a customer who saw each item go on — which is worth more at a counter than any
 * amount of paperwork afterwards.
 *
 * The code stops working the moment the sale is settled, and the page says so rather than going
 * blank. A five-character code is short enough to read across a counter, which means it is short
 * enough to guess, so nothing behind it may be worth guessing for: the order's lines and total,
 * the shop's name, and nothing about the customer at all.
 */

interface TrackedOrder {
  code: string;
  /** 'open' while it is being built, 'settled' once paid for, 'cancelled' if it was abandoned. */
  status: string;
  shop: string;
  updated_at: string;
  /** Present once settled — the sale the order became. */
  sale_id?: string | null;
  paid?: string;
  lines: {
    name: string;
    qty: string;
    unit: string;
    unit_price: string;
    line_total: string;
  }[];
  charges: { label: string; amount: string }[];
  total: string;
}

/** How often to re-check while an order is open. */
const POLL_MS = 4000;

export function TrackClient({ initialToken }: { initialToken?: string } = {}) {
  const router = useRouter();
  const params = useSearchParams();
  const initial = (params.get('code') ?? '').toUpperCase();

  const [code, setCode] = useState(initial);
  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [state, setState] = useState<'idle' | 'looking' | 'found' | 'gone'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so the poll always reads the code currently being tracked, without the interval
  // being torn down and restarted on every keystroke.
  const tracking = useRef<string | null>(initial || null);

  /*
   * The token, when this page was reached by a shared link.
   *
   * A different question from the code and asked of a different function: the code answers only
   * while an order is open, because it is recycled and may already belong to somebody else. The
   * token answers for the life of the order — and afterwards, as the receipt.
   */
  const lookByToken = useCallback(async (token: string, quiet = false) => {
    if (!quiet) setState('looking');
    setError(null);
    try {
      const { data, error: e } = await getSupabase().rpc('public_track_token', {
        p_token: token,
      });
      if (e) throw e;
      if (!data) {
        setState('gone');
        if (!quiet) setError('That link does not point at an order any more.');
        return;
      }
      setOrder(data as TrackedOrder);
      setState('found');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that link.');
      if (!quiet) setState('idle');
    }
  }, []);

  const look = useCallback(async (raw: string, quiet = false) => {
    const trimmed = raw.trim().toUpperCase();
    if (!trimmed) return;
    if (!quiet) setState('looking');
    setError(null);
    try {
      const { data, error: e } = await getSupabase().rpc('public_track_order', {
        p_code: trimmed,
      });
      if (e) throw e;
      if (!data) {
        /*
         * Genuinely unknown now, rather than "finished".
         *
         * A settled or cancelled order used to land here too, which is why the message had to
         * hedge. The code follows its order through to the end now, so nothing coming back means
         * exactly one thing: no order in this shop has that code.
         */
        setState((prev) => (prev === 'found' ? 'gone' : 'idle'));
        if (!quiet) setError('No order has that code. Check it with the shop.');
        return;
      }
      setOrder(data as TrackedOrder);
      setState('found');
      tracking.current = trimmed;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check that code.');
      if (!quiet) setState('idle');
    }
  }, []);

  /*
   * The ONE place in this codebase that polls, and it is deliberate.
   *
   * Inside the app, screens never poll: state-stack hydrates the last value and navigation-stack's
   * `onResume` says when to refresh it, which is both cheaper and more correct — a resume fires at
   * the moment someone actually looks.
   *
   * Neither applies here. This is the PUBLIC tracking page: an anonymous shopper watching a seller
   * build their order, on no navigation stack, with no state-stack scope, who never leaves and so
   * never resumes. The only thing that changes is on the server, and nothing on this page can know
   * it has. Polling rather than a realtime subscription because the window is minutes long and a
   * socket per curious shopper is a cost with nothing to show for it at this scale.
   */
  useEffect(() => {
    if (state !== 'found') return;
    const id = setInterval(() => {
      if (tracking.current) void look(tracking.current, true);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [state, look]);

  useEffect(() => {
    if (initialToken) {
      void lookByToken(initialToken);
      return;
    }
    if (initial) void look(initial);
  }, [initial, initialToken, look, lookByToken]);

  return (
    <MarketShell>
      <div className={styles.wrap}>
        <h1 className={styles.title}>Follow your order</h1>
        <p className={styles.lede}>
          Ask the seller for the order code and type it here. You will see each item as it is added
          up, on your own phone.
        </p>

        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            router.replace(`/track?code=${encodeURIComponent(code.trim().toUpperCase())}`);
            void look(code);
          }}
        >
          <Field
            label="Order code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCDE"
            autoCapitalize="characters"
            autoCorrect="off"
            hint="Five letters and numbers, from the seller's screen."
          />
          <Button type="submit" size="large" fullWidth busy={state === 'looking'}>
            Follow it
          </Button>
        </form>

        {error && (
          <InfoPanel tone="info" title="Nothing to show">
            {error}
          </InfoPanel>
        )}

        {state === 'gone' && (
          <InfoPanel tone="success" title="This order has been paid for">
            The seller has finished it. Ask them for the receipt link if you would like a copy —
            that one keeps working.
          </InfoPanel>
        )}

        {state === 'found' && order && (
          <section className={styles.order} aria-live="polite">
            <div className={styles.head}>
              <p className={styles.shop}>{order.shop}</p>
              <p className={styles.code}>{order.code}</p>
            </div>

            {/*
              The same code, whatever became of the order.

              A buyer was handed one link while their order was being built. Sending a second one
              for the receipt means two links for one purchase, and the first dying in their hand
              without explanation. It follows the order through instead — and when the order was
              abandoned, says so plainly rather than behaving like a code that never existed.
            */}
            {order.status === 'cancelled' ? (
              <p className={styles.cancelled}>
                This order was cancelled and nothing was charged. If you think that is wrong, speak
                to the shop and quote {order.code}.
              </p>
            ) : order.lines.length === 0 ? (
              <p className={styles.empty}>Nothing on it yet — watch this space.</p>
            ) : (
              <ul className={styles.lines}>
                {order.lines.map((l, i) => (
                  <li className={styles.line} key={`${l.name}-${i}`}>
                    <span className={styles.lineName}>
                      {l.name}
                      <span className={styles.lineQty}>
                        {formatQty(l.qty)} {l.unit} × {formatMoney(l.unit_price)}
                      </span>
                    </span>
                    <span className={styles.lineTotal}>{formatMoney(l.line_total)}</span>
                  </li>
                ))}
              </ul>
            )}

            {order.charges.map((c, i) => (
              <div className={styles.line} key={`${c.label}-${i}`}>
                <span className={styles.lineName}>{c.label}</span>
                <span className={styles.lineTotal}>{formatMoney(c.amount)}</span>
              </div>
            ))}

            {order.status !== 'cancelled' && (
              <div className={styles.grand}>
                <span>{order.status === 'settled' ? 'Total' : 'Total so far'}</span>
                <span className={styles.grandValue}>{formatMoney(order.total)}</span>
              </div>
            )}

            {/*
              Once paid for, this IS the receipt.

              What is outstanding matters more here than anywhere: somebody who paid part of it in
              cash and left the rest on account should be able to see that from the link they were
              already given.
            */}
            {order.status === 'settled' && (
              <>
                <div className={styles.paidRow}>
                  <span>Paid</span>
                  <span>{formatMoney(order.paid ?? '0')}</span>
                </div>
                {Number(order.total) - Number(order.paid ?? 0) > 0 && (
                  <div className={styles.owingRow}>
                    <span>On account</span>
                    <span>{formatMoney(Number(order.total) - Number(order.paid ?? 0))}</span>
                  </div>
                )}
                <p className={styles.settled}>
                  Paid for on {new Date(order.updated_at).toLocaleDateString()}. This is your
                  receipt — keep the link.
                </p>
              </>
            )}

            {order.status === 'open' && (
              <p className={styles.live}>
                Updating as the seller adds things. This becomes your receipt once you have paid.
              </p>
            )}
          </section>
        )}
      </div>
    </MarketShell>
  );
}

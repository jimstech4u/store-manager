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
  status: string;
  shop: string;
  updated_at: string;
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

export function TrackClient() {
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
        // Two different situations, one answer from the server: never existed, or already
        // settled. Said as one sentence rather than guessing which, because guessing wrong at a
        // counter is worse than being vague.
        setState((prev) => (prev === 'found' ? 'gone' : 'idle'));
        if (!quiet) setError('That code is not open. It may have been paid for already.');
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

  // Poll while an order is being followed. Polling rather than a realtime subscription: this is
  // an anonymous page, the window is minutes long, and a socket per curious shopper is a cost
  // with nothing to show for it at this scale.
  useEffect(() => {
    if (state !== 'found') return;
    const id = setInterval(() => {
      if (tracking.current) void look(tracking.current, true);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [state, look]);

  useEffect(() => {
    if (initial) void look(initial);
  }, [initial, look]);

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

            {order.lines.length === 0 ? (
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

            <div className={styles.grand}>
              <span>Total so far</span>
              <span className={styles.grandValue}>{formatMoney(order.total)}</span>
            </div>

            <p className={styles.live}>
              Updating as the seller adds things. This stops when you have paid.
            </p>
          </section>
        )}
      </div>
    </MarketShell>
  );
}

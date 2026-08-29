'use client';

import { useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { Explain } from '@/components/ui/Explain';
import { ChevronRightIcon } from '@/components/ui/Icon';
import { getSupabase } from '@/lib/supabase/client';
import { formatQty } from '@/lib/format';
import styles from './StockHistory.module.css';

/**
 * Everything that has ever happened to this item's stock.
 *
 * The ledger has been there since the beginning — `stock_movements` is append-only, a correction
 * appends a reversal rather than editing anything — and nothing in the app ever showed it. So the
 * question a shopkeeper actually asks about a shelf, "we had seven, there are five, where did two
 * go", had no answer in the product they were holding.
 *
 * EVERY ROW SAYS WHAT WAS LEFT, not just what moved. "-2" is the movement; "5 left" is the thing
 * being checked against the shelf. The database computes the running balance so every reader gets
 * the same number rather than each adding it up their own way.
 *
 * AND EVERY ROW SAYS WHO. An audit trail whose entries could have been anybody is a list of
 * changes, not an account of them — and the reason this exists at all is that stock going missing
 * is a question about people.
 */

interface Movement {
  at: string;
  kind: string;
  qty_delta: number;
  balance: number;
  note: string | null;
  actor_name: string | null;
  reverses_id: string | null;
}

/** What each kind of movement is called in the shop, rather than in the schema. */
const WHAT_HAPPENED: Record<string, string> = {
  opening: 'Opening balance',
  receive: 'Delivery received',
  sale: 'Sold',
  return_in: 'Customer brought it back',
  damage: 'Damaged or spoiled',
  repack_loss: 'Lost breaking bulk',
  adjustment: 'Count adjustment',
  transfer_in: 'Transferred in',
  transfer_out: 'Transferred out',
};

function when(iso: string) {
  const at = new Date(iso);
  const today = new Date();
  const sameDay = at.toDateString() === today.toDateString();
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  // Today is by far the commonest thing being checked, and a date on it is noise.
  return sameDay ? time : `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

export function StockHistory({ productId, unit }: { productId: string; unit: string }) {
  const [history, demandHistory] = useDemandState<Movement[]>([], {
    key: `product-history:${productId}`,
    scope: 'catalog_flow',
    /*
     * Kept, because a ledger's past does not change.
     *
     * Every row here already happened; re-reading them on the way back in is a request that can
     * only return what is already on screen. New movements arrive by loading again, and the rows
     * that were there stay there — so the page opens instantly and fills in.
     */
    persist: true,
    deps: [productId],
    revalidateOnMount: false,
  });

  useEffect(() => {
    if (!productId) return;
    demandHistory(async ({ set }) => {
      const { data } = await getSupabase().rpc('product_history', {
        p_product_id: productId,
        p_limit: 60,
      });
      set((data ?? []) as Movement[], { override: true });
    });
  }, [productId, demandHistory]);

  if (history.length === 0) return null;

  return (
    <section className={styles.section}>
      <Explain label="Why does this matter?">
        Every change to this item is written down and never edited — a correction is added as its
        own line, so nothing quietly disappears. If the shelf disagrees with the records, this is
        where the difference happened.
      </Explain>

      <ol className={styles.list}>
        {history.map((row, index) => {
          const up = row.qty_delta > 0;
          return (
            <li className={styles.row} key={`${row.at}-${index}`}>
              <span className={`${styles.delta} ${up ? styles.up : styles.down}`}>
                {up ? '+' : ''}
                {formatQty(row.qty_delta)}
              </span>

              <span className={styles.body}>
                <span className={styles.what}>
                  {WHAT_HAPPENED[row.kind] ?? row.kind}
                  {/* A reversal is not a separate event — it is this one being undone. */}
                  {row.reverses_id && <span className={styles.correction}>correction</span>}
                </span>
                <span className={styles.who}>
                  {when(row.at)} · {row.actor_name ?? 'Someone'}
                </span>
                {row.note && <span className={styles.note}>{row.note}</span>}
              </span>

              {/* What was on the shelf after this — the number being checked against. */}
              <span className={styles.balance}>
                {formatQty(row.balance)} {unit}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * When this item's stock last changed, as a row that opens the full history.
 *
 * Sits with "On the shelf" and "What it cost you", because it answers the same kind of question at
 * the same glance — those say what is true now, this says when that last became true. The history
 * itself is a page: hundreds of rows under three facts buries the facts.
 */
export function StockHistoryCard({
  productId,
  onOpen,
}: {
  productId: string;
  onOpen: () => void;
}) {
  const [history, demandHistory] = useDemandState<Movement[]>([], {
    // One row is all this needs, but it shares the history's key so opening the page is instant
    // rather than fetching the same thing twice.
    key: `product-history:${productId}`,
    scope: 'catalog_flow',
    // Shares the history's key, so opening the page after seeing the card is instant.
    persist: true,
    deps: [productId],
    revalidateOnMount: false,
  });

  useEffect(() => {
    if (!productId) return;
    demandHistory(async ({ set }) => {
      const { data } = await getSupabase().rpc('product_history', {
        p_product_id: productId,
        p_limit: 60,
      });
      set((data ?? []) as Movement[], { override: true });
    });
  }, [productId, demandHistory]);

  const last = history[0];

  return (
    <button type="button" className={styles.card} onClick={onOpen}>
      <span className={styles.cardBody}>
        <span className={styles.cardLabel}>Stock history</span>
        <span className={styles.cardValue}>
          {last ? `Last changed ${when(last.at)}` : 'Nothing recorded yet'}
        </span>
        {last && (
          <span className={styles.cardDetail}>
            {WHAT_HAPPENED[last.kind] ?? last.kind} · {last.actor_name ?? 'Someone'}
          </span>
        )}
      </span>
      <ChevronRightIcon />
    </button>
  );
}

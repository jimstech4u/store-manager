'use client';

import { useResource } from '@/lib/stacks/resource';
import { DERIVED_SCOPE } from '@/lib/stacks/catalog-stack';
import { PageState, type PageStatus } from '@/components/ui/PageState';
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
  /**
   * The record this movement came from — a sale, a delivery, a count.
   *
   * The database has returned these all along and nothing read them, so the history said "Sold, 3"
   * and stopped there. "Sold to whom, on what receipt?" is the next question every single time,
   * and it was a dead end: the answer existed one join away and the screen would not take you.
   */
  ref_table: string | null;
  ref_id: string | null;
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

/*
 * THE ITEM'S LEDGER, as a resource.
 *
 * It was kept with `revalidateOnMount: false` and no invalidation, on the grounds that a ledger's
 * past does not change — true, but its PRESENT does: a sale or a delivery adds a row, and the page
 * never learned of it, so the newest movement was missing until the cache was cleared. A failed
 * read also wrote an empty list over the rows, and the card said "Nothing recorded yet" before the
 * first answer. Now it re-reads when stock moves (here or on another till), keeps its rows through a
 * failure, and says when it does not know yet.
 */
function useProductHistory(productId: string) {
  return useResource<Movement[]>({
    key: `product-history:v2:${productId}`,
    scope: DERIVED_SCOPE,
    enabled: Boolean(productId),
    read: async () => {
      const { data, error } = await getSupabase().rpc('product_history', {
        p_product_id: productId,
        p_limit: 60,
      });
      if (error) throw error;
      return (data ?? []) as Movement[];
    },
  });
}

export function StockHistory({
  productId,
  unit,
  onOpenRecord,
}: {
  productId: string;
  unit: string;
  /**
   * Open whatever a movement came from — the receipt for a sale, the delivery for a purchase.
   *
   * Handed over rather than pushed from here: this component is rendered from more than one stack
   * and a component reaching for a route by name breaks the moment it is reused somewhere that
   * route does not exist.
   */
  onOpenRecord?: (refTable: string | null, refId: string) => void;
}) {
  const res = useProductHistory(productId);
  const history = res.data ?? [];

  // Not read yet, or could not be: said inside the page, under its header — never a blank page.
  const status: PageStatus = res.loaded
    ? history.length === 0
      ? {
          state: 'empty',
          title: 'Nothing recorded yet',
          body: 'Deliveries, sales and counts of this item will be listed here as they happen.',
        }
      : { state: 'ready' }
    : res.error
      ? { state: 'error', what: 'the history', error: res.error, onRetry: res.reload }
      : { state: 'loading', what: 'the history' };
  if (status.state !== 'ready') return <PageState status={status}>{() => null}</PageState>;

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

          /*
           * Only where there is something to open, and somebody to open it.
           *
           * A count or an adjustment has no other record behind it, and a row that looks tappable
           * and does nothing is worse than one that plainly is not.
           */
          const opens = onOpenRecord && row.ref_id ? () => onOpenRecord(row.ref_table, row.ref_id!) : null;

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

              {opens && (
                <button type="button" className={styles.open} onClick={opens}>
                  {row.ref_table === 'sales' ? 'See the receipt' : 'See the record'}
                </button>
              )}
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
  // The same read as the page, so opening it after seeing the card is instant.
  const res = useProductHistory(productId);
  const last = res.data?.[0];

  return (
    <button type="button" className={styles.card} onClick={onOpen}>
      <span className={styles.cardBody}>
        <span className={styles.cardLabel}>Stock history</span>
        <span className={styles.cardValue}>
          {res.data === null
            ? res.error
              ? 'Could not load'
              : 'Loading…'
            : last
              ? `Last changed ${when(last.at)}`
              : 'Nothing recorded yet'}
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

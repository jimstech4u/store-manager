'use client';

import { useMemo, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/format';
import {
  lineTotal,
  makeDraftLine,
  useDraftOrders,
  type DraftLine,
} from '@/lib/stacks/draft-orders';
import styles from './claim-page.module.css';

/**
 * Taking over a colleague's order, and settling what happens to both sets of items.
 *
 * A PAGE, not a dialog, and that is the whole point of it. The old version asked "merge or
 * replace?" in a box with two buttons — a question about items nobody could see while answering
 * it. Two sellers who have each been adding to a tab for the same customer do not need a verdict
 * on the whole order; they need to look at both lists and decide line by line, the way a merge is
 * actually resolved.
 *
 * SO IT WORKS LIKE A MERGE. Both sides are laid out, every line has a switch, and the total at the
 * bottom is what will exist when Accept is pressed. Nothing is applied until then: backing out
 * leaves both orders exactly as they were, which is what makes it safe to open and look.
 *
 * ONLINE-FIRST, so the code is only ever a way to FIND an order that already exists on the server.
 * Nothing here is reconstructed from this device: the lines shown are the ones the shop holds, and
 * the resolution is written back to the shop before this page closes.
 */

interface FoundOrder {
  id: string;
  code: string;
  label: string | null;
  customerId: string | null;
  customerName: string | null;
  lines: DraftLine[];
}

export default function ClaimPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { activeOrder, updateOrder, addLine, removeLine, push } = useDraftOrders(store?.id ?? null);

  const [code, setCode] = useState('');
  const [looking, setLooking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [found, setFound] = useState<FoundOrder | null>(null);

  /*
   * One switch per line, on both sides.
   *
   * Keyed by line key rather than held as two arrays, so a line keeps its decision while the two
   * lists are re-sorted or re-read. Everything starts ON: the safe default when combining two
   * people's work is to lose none of it.
   */
  const [keep, setKeep] = useState<Record<string, boolean>>({});

  // Memoised because the total depends on them, and a fresh [] every render would recompute it
  // every render.
  const mine = useMemo(() => activeOrder?.lines ?? [], [activeOrder]);
  const theirs = useMemo(() => found?.lines ?? [], [found]);

  const isKept = (key: string) => keep[key] !== false;
  const toggle = (key: string) => setKeep((prev) => ({ ...prev, [key]: prev[key] === false }));

  const resultingTotal = useMemo(
    () =>
      [...mine, ...theirs]
        // Inlined rather than calling `isKept`: the total is a function of the switches, and
        // reading `keep` here is what says so to anything checking the dependencies.
        .filter((l) => keep[l.key] !== false)
        .reduce((sum, l) => sum + lineTotal(l), 0),
    [mine, theirs, keep],
  );

  const find = async () => {
    if (!store) return;
    setLooking(true);
    setProblem(null);
    try {
      const supabase = getSupabase();
      const wanted = code.trim().toUpperCase();

      /*
       * `draft_order_by_code`, not `search_draft_orders`.
       *
       * The search RPC lists orders with totals for browsing and deliberately carries no lines —
       * a list of fifty does not want them. This page needs exactly one order and needs its lines,
       * which is a different question and now has its own answer.
       */
      const { data: rows, error } = await supabase.rpc('draft_order_by_code', {
        p_store_id: store.id,
        p_code: wanted,
      });
      if (error) throw error;

      const row = (rows as Record<string, unknown>[] | null)?.[0];
      if (!row) {
        setProblem('No open order has that code. Check it with your colleague.');
        return;
      }

      const rawLines = (row.lines ?? []) as Record<string, unknown>[];
      setFound({
        id: String(row.id),
        code: wanted,
        label: (row.label as string | null) ?? null,
        customerId: (row.customer_id as string | null) ?? null,
        customerName: (row.customer_name as string | null) ?? null,
        lines: rawLines.map((l) =>
          makeDraftLine({
            productId: String(l.product_id),
            productName: String(l.product_name ?? 'Item'),
            qty: String(l.qty ?? ''),
            unitPrice: String(l.unit_price ?? ''),
            packId: (l.pack_id as string | null) ?? null,
          }),
        ),
      });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That order could not be looked up.');
    } finally {
      setLooking(false);
    }
  };

  /*
   * Apply the resolution, then leave.
   *
   * Written to the tab that is already open rather than opening a third one: the seller came here
   * from a receipt they were building and expects to go back to it, holding whatever they just
   * agreed to keep.
   */
  const accept = async () => {
    if (!activeOrder || !found) return;
    setLooking(true);
    setProblem(null);
    try {
      // Drop the lines of mine that were switched off.
      for (const line of mine) {
        if (!isKept(line.key)) removeLine(activeOrder.clientUuid, line.key);
      }
      // Bring across the ones of theirs that were switched on.
      for (const line of theirs) {
        if (isKept(line.key)) addLine(activeOrder.clientUuid, { ...line, key: makeDraftLine().key });
      }

      // Their customer comes too, when this tab has none of its own — the point of taking over an
      // order is usually that somebody has already asked who it is for.
      if (found.customerId && !activeOrder.customerId) {
        updateOrder(activeOrder.clientUuid, {
          customerId: found.customerId,
          customerName: found.customerName ?? '',
        });
      }

      /*
       * Close THEIRS, so one order and one code survive.
       *
       * Cancelling releases the code back to the shop's pool — the partial unique index only holds
       * a code while an order is open — and leaves no second tab that could be sold again.
       */
      const { error } = await getSupabase().rpc('cancel_draft_order', { p_draft_id: found.id });
      if (error) throw error;

      await push({
        ...activeOrder,
        lines: [
          ...mine.filter((l) => isKept(l.key)),
          ...theirs.filter((l) => isKept(l.key)),
        ],
      });

      await nav.pop();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That could not be applied.');
    } finally {
      setLooking(false);
    }
  };

  if (!store) return null;

  const row = (line: DraftLine, side: 'mine' | 'theirs') => (
    <label key={line.key} className={`${styles.row} ${isKept(line.key) ? '' : styles.dropped}`}>
      <input type="checkbox" checked={isKept(line.key)} onChange={() => toggle(line.key)} />
      <span className={styles.rowBody}>
        <span className={styles.rowName}>{line.productName}</span>
        <span className={styles.rowDetail}>
          {line.qty || 0} × {formatMoney(Number(line.unitPrice) || 0)}
        </span>
      </span>
      <span className={styles.rowTotal}>{formatMoney(lineTotal(line))}</span>
      <span className={styles.rowSide}>{side === 'mine' ? 'here' : 'theirs'}</span>
    </label>
  );

  return (
    <PageScaffold
      onBack={goBack}
      title="Take over an order"
      subtitle={found ? `Order ${found.code}` : 'Using the code your colleague read out'}
      footer={
        found ? (
          <div className={styles.footer}>
            <span className={styles.footerTotal}>
              <span className={styles.footerLabel}>This tab becomes</span>
              <strong>{formatMoney(resultingTotal)}</strong>
            </span>
            <Button busy={looking} onClick={() => void accept()}>
              Accept
            </Button>
          </div>
        ) : undefined
      }
    >
      {problem && (
        <InfoPanel tone="danger" title="Not taken over">
          {problem}
        </InfoPanel>
      )}

      {!found ? (
        <>
          <Explain label="What is an order code?">
            Every order being built gets a short code. Read it out to a colleague and they can pick
            the same order up on their own phone — useful when one of you is at the counter and the
            other is at the shelves.
            <br />
            <br />
            The code belongs to that order until it is paid for or cancelled, and then goes back
            for the next one to use.
          </Explain>

          <Field
            label="Order code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCDE"
            hint="Ask your colleague for the code shown on their order."
            autoCapitalize="characters"
            autoCorrect="off"
            autoFocus
          />

          <Button
            size="large"
            fullWidth
            busy={looking}
            disabled={code.trim().length < 4}
            onClick={() => void find()}
          >
            Find this order
          </Button>
        </>
      ) : (
        <>
          <InfoPanel tone="info" title="Decide what to keep">
            Both lists are below. Everything is kept unless you switch it off — untick anything
            that is on both sides or is no longer wanted, then press Accept.
          </InfoPanel>

          {mine.length > 0 && (
            <section className={styles.side}>
              <h2 className={styles.sideTitle}>Already on this tab</h2>
              {mine.map((l) => row(l, 'mine'))}
            </section>
          )}

          <section className={styles.side}>
            <h2 className={styles.sideTitle}>
              Coming from {found.customerName || `order ${found.code}`}
            </h2>
            {theirs.length === 0 ? (
              <p className={styles.empty}>That order has no items on it yet.</p>
            ) : (
              theirs.map((l) => row(l, 'theirs'))
            )}
          </section>

          {found.customerId && !activeOrder?.customerId && (
            <InfoPanel tone="info" title="The customer comes too">
              This sale will be recorded for {found.customerName}.
            </InfoPanel>
          )}
        </>
      )}
    </PageScaffold>
  );
}

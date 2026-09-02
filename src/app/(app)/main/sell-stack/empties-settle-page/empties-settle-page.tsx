'use client';

import { useEffect, useMemo, useState } from 'react';
import styles from './empties-settle-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useLocation, useNav, useObject } from '@academix-admin/navigation-stack';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { formatMoney, messageOf } from '@/lib/format';
import {
  returnIsAllowed,
  returnUnitsFor,
  settleEmpties,
  suggestedDeposit,
  type ReceiptEmpties,
  type ReturnUnit,
} from '@/lib/stacks/empties';

/**
 * Recording what came back.
 *
 * A PAGE, not a sheet, and the first version got this wrong. The rule is written down —
 * *"a form is a page, a choice is a sheet"* — and `account-action-page` spells out the reason for
 * exactly this family of screen: a page has a title, a back arrow, the whole screen and a URL, and
 * it survives a rotation and a reload, which a sheet's local state does not. **These forms record
 * money.** Four fields of it, here.
 *
 * The counter-argument — "there is a customer waiting with crates in their hands" — is the same one
 * that produced the quick-add sheet, and it is wrong for the same reason: the till is not popped,
 * it is pushed under, so nothing is lost by using the whole screen.
 */
export default function EmptiesSettlePage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const problem = useProblem();
  // See useProblem: the object is not stable, `show` is. Depend on the callback.
  const showProblem = problem.show;

  const saleId = (location?.params?.id as string | undefined) ?? null;

  /*
   * The receipt travels as an OBJECT, with a database fallback.
   *
   * `nav.push` carries an id and an intent, never a record — so the list hands this row over
   * through `provideObject`, and `isProvided` is false on a cold start and on a deep link. The
   * fallback below is not belt-and-braces; it is the only path that works when somebody reloads
   * this page or opens it from a link.
   */
  const provided = useObject<ReceiptEmpties>('receiptEmpties', { global: true, scope: 'sell' });

  const [receipt, setReceipt] = useState<ReceiptEmpties | null>(
    provided.isProvided ? (provided.getter() ?? null) : null,
  );
  const [loading, setLoading] = useState(!receipt);

  useEffect(() => {
    if (receipt || !saleId || !store) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await getSupabase().rpc('empties_by_receipt', {
          p_store_id: store.id,
          p_customer_id: null,
          p_limit: 1,
          p_sale_id: saleId,
        });
        if (error) throw error;
        if (!cancelled) setReceipt(((data ?? [])[0] as ReceiptEmpties) ?? null);
      } catch (e) {
        if (!cancelled) showProblem(messageOf(e, 'Could not read that receipt.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [receipt, saleId, store, showProblem]);

  /*
   * What each pool comes back in.
   *
   * Loaded per pool because the rule lives on the pool. A pool with none declared keeps today's
   * behaviour — any quantity — which is right: a shop that has not said "whole crates only" has not
   * said anything, and refusing its returns would be inventing a rule it never made.
   */
  const [shapes, setShapes] = useState<Record<string, ReturnUnit[]>>({});

  useEffect(() => {
    if (!receipt) return;
    let cancelled = false;
    void (async () => {
      const found: Record<string, ReturnUnit[]> = {};
      for (const e of receipt.expected) {
        try {
          found[e.category_id] = await returnUnitsFor(e.category_id);
        } catch {
          // A pool whose shapes cannot be read is treated as having none: the server still checks,
          // and a screen that refuses everything because a read failed is worse than one that asks.
          found[e.category_id] = [];
        }
      }
      if (!cancelled) setShapes(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [receipt]);

  const [busy, setBusy] = useState(false);
  const [back, setBack] = useState<Record<string, string>>({});
  const [apply, setApply] = useState('');
  const [refund, setRefund] = useState('');
  const [mode, setMode] = useState<'cash' | 'credit' | 'none'>('cash');

  const returned = useMemo(
    () =>
      (receipt?.expected ?? [])
        .map((e) => ({ category_id: e.category_id, qty: Number(back[e.category_id] ?? 0) }))
        .filter((r) => r.qty > 0),
    [back, receipt],
  );

  if (loading) return <FullPageMessage title="Reading that receipt" tone="loading" />;

  if (!receipt) {
    return (
      <PageScaffold onBack={goBack} title="Nothing to settle">
        <InfoPanel tone="info" title="That receipt has nothing out">
          Everything on it has already come back, or it never carried returnables.
        </InfoPanel>
        <ProblemDialog problem={problem} title="Could not read that receipt" />
      </PageScaffold>
    );
  }

  const held = Number(receipt.held);
  /*
   * SHORT IS NORMAL, and the arithmetic says so rather than warning about it.
   * Nine of twelve bottles is an ordinary Tuesday.
   */
  const stillOut = Number(receipt.outstanding_units) - returned.reduce((t, r) => t + r.qty, 0);
  /*
   * Told BEFORE the button, not after the server refuses.
   *
   * The rule is enforced in `settle_empties` and must be — a stale screen must not get round it —
   * but a counter finding out by way of a red dialog has already counted the bottles out onto the
   * table. Two checks of one rule; the server's is the one that counts.
   */
  const wrongShape = receipt.expected.filter((e) => {
    const qty = Number(back[e.category_id] ?? 0);
    return qty > 0 && !returnIsAllowed(shapes[e.category_id] ?? [], qty);
  });

  const accounted = (Number(apply) || 0) + (Number(refund) || 0);
  const overspent = accounted > held;
  const suggestion = suggestedDeposit(receipt.expected);

  const save = async () => {
    setBusy(true);
    try {
      await settleEmpties({
        storeId: store!.id,
        saleId: receipt.sale_id,
        returned,
        applyAmount: Number(apply) || 0,
        refundAmount: Number(refund) || 0,
        refundMode: mode,
      });
      await nav.pop();
    } catch (e) {
      showProblem(messageOf(e, 'That could not be recorded. Nothing has changed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="What came back?"
      subtitle={`${receipt.customer_name} · ${new Date(receipt.occurred_at).toLocaleDateString()}`}
    >
      <ProblemDialog problem={problem} title="Not recorded" />

      {receipt.expected.map((e) => (
        <div className={styles.poolRow} key={e.category_id}>
          <div>
            <p className={styles.poolName}>{e.category}</p>
            <p className={styles.poolOut}>
              {Number(e.units)} went out
              {Number(e.suggested_deposit) > 0
                ? ` · you usually hold ${formatMoney(Number(e.suggested_deposit))} each`
                : ''}
            </p>
            {(shapes[e.category_id] ?? []).length > 0 && (
              <p className={styles.poolShapes}>
                Comes back in{' '}
                {(shapes[e.category_id] ?? [])
                  .map((u) => `${u.name.toLowerCase()} of ${Number(u.base_qty)}`)
                  .join(' or ')}
              </p>
            )}
          </div>
          <div className={styles.qtyBox}>
            <Field
              label="Back"
              numeric
              value={back[e.category_id] ?? ''}
              onChange={(ev) => setBack((p) => ({ ...p, [e.category_id]: ev.target.value }))}
              placeholder="0"
            />
          </div>
        </div>
      ))}

      <div className={styles.summary}>
        <div className={styles.sumRow}>
          <span>Still out after this</span>
          <span className={styles.sumTotal}>{stillOut}</span>
        </div>

        {/*
          A CONDITION, so it stays on the page rather than interrupting: it is still true after any
          acknowledgement, and it is being fixed in the box above it.
        */}
        {wrongShape.length > 0 && (
          <InfoPanel tone="warning" title="That is not a shape these come back in">
            {wrongShape.map((e) => (
              <p key={e.category_id}>
                <strong>{e.category}</strong> comes back in{' '}
                {(shapes[e.category_id] ?? [])
                  .map((u) => `${u.name.toLowerCase()} of ${Number(u.base_qty)}`)
                  .join(' or ')}
                . {Number(back[e.category_id])} does not make one.
              </p>
            ))}
          </InfoPanel>
        )}

        {held > 0 ? (
          <>
            <div className={styles.sumRow}>
              <span>You are holding</span>
              <span className={styles.sumTotal}>{formatMoney(held)}</span>
            </div>

            <Field
              label="Keep for what did not come back"
              optional
              numeric
              prefix="₦"
              value={apply}
              onChange={(e) => setApply(e.target.value)}
              placeholder="0"
              hint="You decide this. There is no fixed rate, because none was agreed."
            />

            <Field
              label="Give back"
              optional
              numeric
              prefix="₦"
              value={refund}
              onChange={(e) => setRefund(e.target.value)}
              placeholder="0"
              hint={
                overspent
                  ? `That is more than the ${formatMoney(held)} you are holding.`
                  : `${formatMoney(held - accounted)} would stay on deposit.`
              }
            />

            <div className={styles.sumRow}>
              <span>How it goes back</span>
              <select
                className={styles.mode}
                value={mode}
                onChange={(e) => setMode(e.target.value as 'cash' | 'credit' | 'none')}
              >
                <option value="cash">Cash, over the counter</option>
                <option value="credit">Off what they owe</option>
                <option value="none">Leave it on deposit</option>
              </select>
            </div>
          </>
        ) : (
          <InfoPanel tone="info" title="Nothing was held for these">
            They went out on trust, so there is no deposit to settle — only the containers.
            {suggestion > 0 && (
              <> Your usual rate for this lot would have been {formatMoney(suggestion)}.</>
            )}
          </InfoPanel>
        )}
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" fullWidth onClick={goBack} disabled={busy}>
          Cancel
        </Button>
        <Button
          fullWidth
          busy={busy}
          busyLabel="Recording"
          disabled={overspent || wrongShape.length > 0 || (returned.length === 0 && accounted === 0)}
          onClick={() => void save()}
        >
          Record it
        </Button>
      </div>
    </PageScaffold>
  );
}

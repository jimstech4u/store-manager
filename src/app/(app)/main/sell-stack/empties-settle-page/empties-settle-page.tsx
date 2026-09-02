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
import { settleEmpties, suggestedDeposit, type ReceiptEmpties } from '@/lib/stacks/empties';

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
        if (!cancelled) problem.show(messageOf(e, 'Could not read that receipt.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [receipt, saleId, store, problem]);

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
      problem.show(messageOf(e, 'That could not be recorded. Nothing has changed.'));
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
          disabled={overspent || (returned.length === 0 && accounted === 0)}
          onClick={() => void save()}
        >
          Record it
        </Button>
      </div>
    </PageScaffold>
  );
}

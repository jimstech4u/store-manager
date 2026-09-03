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
  /*
   * COUNTED IN SHAPES: keyed by pool, then by the shape it came back in.
   *
   * This was one box per pool, in the pool's smallest unit. Nobody counts that way — a shop counts
   * five crates and three loose bottles — so the seller had to multiply by twelve and add, at a
   * counter, with a warning underneath telling them the figure they worked out was not a shape the
   * pool accepts. The arithmetic is the app's job.
   *
   * A pool with no declared shapes keeps one free box under the key `''`, because a shop that never
   * said "whole crates only" has not said anything and its returns must not be refused.
   */
  const [back, setBack] = useState<Record<string, Record<string, string>>>({});
  /** What is being written off per pool, and the money taken for it. */
  const [gone, setGone] = useState<Record<string, string>>({});
  const [goneMoney, setGoneMoney] = useState('');
  const [apply, setApply] = useState('');
  const [refund, setRefund] = useState('');
  const [mode, setMode] = useState<'cash' | 'credit' | 'none'>('cash');

  /** Each pool's shapes multiplied out and added up — the arithmetic nobody should do standing up. */
  const countedBack = useMemo(() => {
    const out: Record<string, number> = {};
    for (const e of receipt?.expected ?? []) {
      const entered = back[e.category_id] ?? {};
      const units = shapes[e.category_id] ?? [];
      let total = 0;
      for (const [key, value] of Object.entries(entered)) {
        const n = Number(value);
        if (!Number.isFinite(n) || n === 0) continue;
        const unit = units.find((u) => u.id === key);
        // The free box on a pool that declares no shapes counts as itself.
        total += n * (unit ? Number(unit.base_qty) : 1);
      }
      out[e.category_id] = total;
    }
    return out;
  }, [back, shapes, receipt]);

  const returned = useMemo(
    () =>
      (receipt?.expected ?? [])
        .map((e) => ({ category_id: e.category_id, qty: countedBack[e.category_id] ?? 0 }))
        .filter((r) => r.qty > 0),
    [countedBack, receipt],
  );

  /** Written off — agreed gone, whether paid for or forgiven. */
  const paidFor = useMemo(() => {
    const rows = (receipt?.expected ?? [])
      .map((e) => ({ category_id: e.category_id, qty: Number(gone[e.category_id] ?? 0) }))
      .filter((r) => r.qty > 0);
    const money = Number(goneMoney) || 0;
    const units = rows.reduce((t, r) => t + r.qty, 0);
    /*
     * The money is one figure for the whole conversation — "give me two thousand for the broken
     * ones" — so it is split across the pools by count. The last row takes the rounding, because a
     * forfeit that does not add back to the cash taken is a figure nobody can reconcile.
     */
    let left = money;
    return rows.map((r, i) => {
      const share = i === rows.length - 1 ? left : Math.round((money * r.qty) / units * 100) / 100;
      left = Math.round((left - share) * 100) / 100;
      return { ...r, amount: share };
    });
  }, [gone, goneMoney, receipt]);

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
  const stillOut =
    Number(receipt.outstanding_units) -
    returned.reduce((t, r) => t + r.qty, 0) -
    paidFor.reduce((t, r) => t + r.qty, 0);
  /*
   * Told BEFORE the button, not after the server refuses.
   *
   * The rule is enforced in `settle_empties` and must be — a stale screen must not get round it —
   * but a counter finding out by way of a red dialog has already counted the bottles out onto the
   * table. Two checks of one rule; the server's is the one that counts.
   */
  /*
   * Still checked, and it should almost never fire now.
   *
   * A box per shape cannot produce a quantity the pool refuses — that is the point of it. What can
   * still fail is a pool whose shapes were read after the boxes were filled, or a rule changed on
   * another device mid-count. The server checks too, and its check is the one that counts.
   */
  const wrongShape = receipt.expected.filter((e) => {
    const qty = countedBack[e.category_id] ?? 0;
    return qty > 0 && !returnIsAllowed(shapes[e.category_id] ?? [], qty);
  });

  /*
   * MORE THAN THEY OWE, told before the button.
   *
   * The server refuses this and must — a stale screen must not get round it — but a seller finding
   * out from a red dialog has already counted the bottles onto the counter. Usually it means the
   * customer has brought back another receipt's worth as well, which is a real thing that happens
   * and is settled receipt by receipt.
   */
  const overReturned = receipt.expected.filter(
    (e) => (countedBack[e.category_id] ?? 0) + (Number(gone[e.category_id]) || 0) > Number(e.units),
  );

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
        paidFor,
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
          </div>

          {/*
            A BOX PER SHAPE, because that is how the counting happens.

            "Five crates and three bottles" is what somebody says while stacking them by the door.
            One box in the pool's smallest unit made them multiply by twelve and add — at a counter,
            with a customer waiting — and then told them the answer was not a shape the pool takes.

            A pool that has declared no shapes keeps one plain box. A shop that never said "whole
            crates only" has not said anything, and refusing its returns would be inventing a rule
            it never made.
          */}
          <div className={styles.shapeBoxes}>
            {(shapes[e.category_id] ?? []).length > 0 ? (
              (shapes[e.category_id] ?? []).map((u) => (
                <div className={styles.qtyBox} key={u.id}>
                  <Field
                    label={u.name}
                    numeric
                    value={back[e.category_id]?.[u.id] ?? ''}
                    onChange={(ev) =>
                      setBack((p) => ({
                        ...p,
                        [e.category_id]: { ...(p[e.category_id] ?? {}), [u.id]: ev.target.value },
                      }))
                    }
                    placeholder="0"
                    hint={Number(u.base_qty) > 1 ? `one is ${Number(u.base_qty)}` : undefined}
                  />
                </div>
              ))
            ) : (
              <div className={styles.qtyBox}>
                <Field
                  label="Back"
                  numeric
                  value={back[e.category_id]?.[''] ?? ''}
                  onChange={(ev) =>
                    setBack((p) => ({
                      ...p,
                      [e.category_id]: { ...(p[e.category_id] ?? {}), '': ev.target.value },
                    }))
                  }
                  placeholder="0"
                />
              </div>
            )}
          </div>

          {/* The arithmetic said back, so nobody has to trust it silently. */}
          {(countedBack[e.category_id] ?? 0) > 0 && (
            <p className={styles.poolCounted}>
              That is {countedBack[e.category_id]} of {Number(e.units)} back
            </p>
          )}
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
        {overReturned.length > 0 && (
          <InfoPanel tone="warning" title="That is more than this receipt has out">
            {overReturned.map((e) => (
              <p key={e.category_id}>
                <strong>{e.category}</strong>: {Number(e.units)} went out on this receipt, and{' '}
                {(countedBack[e.category_id] ?? 0) + (Number(gone[e.category_id]) || 0)} are
                accounted for here.
              </p>
            ))}
            <p>
              If they have brought back another load as well, settle that receipt on its own — each
              one is settled against what IT sent out.
            </p>
          </InfoPanel>
        )}

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

        {/*
          WHERE ARE THE OTHERS?

          «then we get asked for where the 9 pieces so we can enter money paid for it or on trust»

          Short is normal — nine of twelve bottles is an ordinary Tuesday — so this is a question and
          not a warning. Three answers, and until now the screen could record one of them: it came
          back, it is still owed, or it is gone. Gone had nowhere to go unless the shop happened to
          be holding a deposit, so containers stayed outstanding for ever against customers who had
          already settled.

          Leaving it blank IS the third answer. Still owed, on trust, come back next week — which is
          what most of these are, and it must not take a tap to say so.
        */}
        {(stillOut > 0 || paidFor.length > 0) && (
          <div className={styles.missing}>
            {/*
              STAYS ONCE SOMETHING IS WRITTEN OFF.

              Gated on `stillOut > 0` alone, this section deleted itself the moment the write-off
              box balanced the count — taking the money box with it, so the one thing it exists to
              ask could never be answered. A section that vanishes as you fill it in is not a form.
            */}
            <p className={styles.missingHead}>
              {stillOut > 0
                ? `${stillOut} did not come back. Where are they?`
                : 'All of it is accounted for.'}
            </p>
            <p className={styles.missingNote}>
              {stillOut > 0
                ? 'Leave this alone if they are still owed — that is the usual answer.'
                : 'Say what was paid for the ones that are not coming back, if anything was.'}
            </p>

            {receipt.expected.map((e) => {
              const shortHere =
                Number(e.units) -
                (countedBack[e.category_id] ?? 0) -
                (Number(gone[e.category_id]) || 0);
              if (shortHere <= 0 && !gone[e.category_id]) return null;
              return (
                <div className={styles.qtyBox} key={`gone-${e.category_id}`}>
                  <Field
                    label={`${e.category} — not coming back`}
                    optional
                    numeric
                    value={gone[e.category_id] ?? ''}
                    onChange={(ev) =>
                      setGone((p) => ({ ...p, [e.category_id]: ev.target.value }))
                    }
                    placeholder="0"
                    hint={
                      shortHere > 0
                        ? `${shortHere} still unaccounted for`
                        : 'All of this pool is accounted for'
                    }
                  />
                </div>
              );
            })}

            {paidFor.length > 0 && (
              <Field
                label="Paid for them"
                optional
                numeric
                prefix="₦"
                value={goneMoney}
                onChange={(e) => setGoneMoney(e.target.value)}
                placeholder="0"
                hint={
                  Number(goneMoney) > 0
                    ? 'Recorded against the containers, not against what they owe'
                    : 'Leave blank if you are letting it go'
                }
              />
            )}
          </div>
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
          disabled={
            overspent ||
            overReturned.length > 0 ||
            wrongShape.length > 0 ||
            // Writing containers off IS a settlement. Nothing came back and no deposit moved, but
            // an obligation was closed and money may have changed hands for it.
            (returned.length === 0 && paidFor.length === 0 && accounted === 0)
          }
          onClick={() => void save()}
        >
          Record it
        </Button>
      </div>
    </PageScaffold>
  );
}

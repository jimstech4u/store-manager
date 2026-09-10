'use client';

import { useCallback } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { CashIcon } from '@/components/ui/Icon';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { getSupabase } from '@/lib/supabase/client';
import { supplierEmptiesSent, type SupplierEmptiesRow } from '@/lib/stacks/suppliers';
import { saidAsPart } from '@/lib/empties-rollup';
import { formatMoney } from '@/lib/format';
import styles from './supplier-account-page.module.css';

interface HistoryRow {
  kind: string;
  label: string;
  amount: number | null;
  detail: string | null;
  occurredAt: string;
  refId: string;
}

/**
 * One supplier's account — the mirror of a customer's.
 *
 * THREE THINGS, kept apart because they settle apart:
 *
 *   MONEY      what the loads came to, less what has been paid. Positive means the shop owes them,
 *              the same way round a customer's balance reads, so nobody has to remember which
 *              screen inverts the sign.
 *   CONTAINERS what has gone back on their lorries, in the product's own shape.
 *   THE STORY  deliveries and money on ONE timeline, because that is the order a person remembers
 *              them in — the load came Tuesday and was paid for on Friday. Two lists make somebody
 *              do the interleaving in their head.
 */
export default function SupplierAccountPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const problem = useProblem();
  const showProblem = problem.show;

  const supplierId = (location?.params?.id as string | undefined) ?? null;

  const readAccount = useCallback(async () => {
    const supabase = getSupabase();
    const [{ data: balance, error: be }, { data: rows, error: he }] = await Promise.all([
      supabase.rpc('supplier_balance', { p_supplier_id: supplierId }),
      supabase.rpc('supplier_history', { p_supplier_id: supplierId }),
    ]);
    if (be) throw be;
    if (he) throw he;
    return {
      owed: Number(balance) || 0,
      history: ((rows ?? []) as Record<string, unknown>[]).map((r) => ({
        kind: String(r.kind),
        label: String(r.label ?? ''),
        amount: r.amount === null ? null : Number(r.amount),
        detail: (r.detail as string | null) ?? null,
        occurredAt: String(r.occurred_at),
        refId: String(r.ref_id),
      })) as HistoryRow[],
    };
  }, [supplierId]);

  const account = useLoadArea(readAccount, [supplierId], {
    onFail: showProblem,
    whenNot: !supplierId,
  });

  const empties = useLoadArea<SupplierEmptiesRow[]>(
    () => supplierEmptiesSent(supplierId!),
    [supplierId],
    { onFail: showProblem, whenNot: !supplierId },
  );

  useLiveRefresh(nav, () => {
    account.reload();
    empties.reload();
  });

  const owed = account.data?.owed ?? 0;

  return (
    <PageScaffold onBack={goBack} title="Supplier" subtitle="What you owe, and what went back">
      <ProblemDialog problem={problem} title="Could not read this account" />

      <LoadArea area={account} what="this account">
        {(data) => (
          <>
            <div className={styles.headline}>
              <span className={styles.headlineLabel}>
                {owed > 0 ? 'You owe them' : owed < 0 ? 'They owe you' : 'Settled'}
              </span>
              <span className={styles.headlineValue}>{formatMoney(Math.abs(owed))}</span>
            </div>

            {/*
              THREE ACTIONS, and each says which direction the money goes.

              A payment is money out. A charge is something owed that no delivery carried — haulage,
              a levy, a shortfall settled later. A credit is the supplier owing the shop: a rebate,
              a load sent back. Recording any of them as a delivery would invent stock.
            */}
            <div className={styles.actions}>
              <Button
                size="large"
                fullWidth
                onClick={() =>
                  void nav.push('supplier_payment_page', { id: supplierId, kind: 'paid' })
                }
              >
                <CashIcon /> Record a payment
              </Button>
              <Button
                variant="secondary"
                fullWidth
                onClick={() =>
                  void nav.push('supplier_payment_page', { id: supplierId, kind: 'charge' })
                }
              >
                Record a charge
              </Button>
              <Button
                variant="secondary"
                fullWidth
                onClick={() =>
                  void nav.push('supplier_payment_page', { id: supplierId, kind: 'credit' })
                }
              >
                Record what they owe you
              </Button>
            </div>

            <h2 className={styles.section}>Containers sent back</h2>
            <LoadArea area={empties} what="what has gone back">
              {(shapes) =>
                shapes.length === 0 ? (
                  <p className={styles.none}>
                    Nothing has gone back to them yet. Record it on the delivery it went with.
                  </p>
                ) : (
                  <>
                    {/*
                      SPLIT BY WHOSE THEY ARE, because they are two obligations.

                      Their crates standing in the yard are a thing the shop must hand back; ours
                      gone out with a load are a thing the shop is waiting for. Netting them gives a
                      figure neither party would recognise.
                    */}
                    {(['we_hold', 'they_hold'] as const).map((side) => {
                      const onSide = shapes.filter((sh) => sh.side === side);
                      if (onSide.length === 0) return null;
                      return (
                        <div key={side}>
                          <h3 className={styles.sideTitle}>
                            {side === 'we_hold' ? 'Theirs, in your yard' : 'Yours, out with them'}
                          </h3>
                          <ul className={styles.shapes}>
                            {onSide.map((sh) => (
                              <li key={sh.productUnitId} className={styles.shapeRow}>
                                <span className={styles.shapeName}>
                                  {sh.productName}
                                  {sh.moved > 0 && (
                                    <span className={styles.shapeMoved}>
                                      {saidAsPart(sh.moved)} already settled
                                    </span>
                                  )}
                                </span>
                                <span className={styles.shapeQty}>
                                  {saidAsPart(Math.abs(sh.outstanding))}{' '}
                                  {Math.abs(sh.outstanding) === 1
                                    ? sh.unitName.toLowerCase()
                                    : sh.unitPlural.toLowerCase()}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </>
                )
              }
            </LoadArea>

            <h2 className={styles.section}>Everything that has happened</h2>
            {data.history.length === 0 ? (
              <p className={styles.none}>Nothing recorded yet.</p>
            ) : (
              <ul className={styles.timeline}>
                {data.history.map((h, i) => (
                  <li key={`${h.kind}-${h.refId}-${i}`} className={styles.event}>
                    <span className={`${styles.dot} ${styles[h.kind] ?? ''}`} aria-hidden="true" />
                    <span className={styles.eventBody}>
                      <span className={styles.eventLabel}>{h.label}</span>
                      {h.detail ? <span className={styles.eventDetail}>{h.detail}</span> : null}
                    </span>
                    <span className={styles.eventRight}>
                      {h.amount !== null && (
                        <span className={styles.eventAmount}>{formatMoney(h.amount)}</span>
                      )}
                      <span className={styles.eventWhen}>
                        {new Date(h.occurredAt).toLocaleDateString()}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {owed < 0 && (
              <InfoPanel tone="info" title="They owe you">
                A rebate or an overpayment. It comes off the next load rather than being handed
                back, which is why it sits here rather than in your takings.
              </InfoPanel>
            )}
          </>
        )}
      </LoadArea>
    </PageScaffold>
  );
}

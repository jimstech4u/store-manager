'use client';

import { useMemo, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { combineReceipts, uncombineReceipt, useCombinableReceipts } from '@/lib/stacks/combine';
import { swapTo } from '@/lib/finish-flow';
import { formatDateTime, formatMoney, messageOf } from '@/lib/format';
import styles from './combine-page.module.css';

/**
 * COMBINE RECEIPTS — one customer's receipts, sent and printed as one.
 *
 * "I have done one for the customer and then another one; sending two that both carry the balance
 * and still with you makes the customer think it is more than it is." Choose the receipts; the
 * NEWEST is the one that stays, and the others print and share as part of it — every line, charge
 * and payment, with what they owe and what is still with them said once. Each sale is still recorded
 * as it was: nothing goes back on the shelf, no payment moves, no day's takings change. Taken apart
 * again, every receipt reads as it did.
 *
 * Reached from a receipt (`id`), which arrives ticked. Receipts that still owe are listed first,
 * because those are the ones a customer is being asked to pay against twice.
 */
export default function CombinePage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const problem = useProblem();
  const saleId = (location?.params?.id as string | undefined) ?? null;

  const receipts = useCombinableReceipts(saleId);
  const rows = useMemo(() => receipts.data ?? [], [receipts.data]);
  const mine = rows.find((r) => r.saleId === saleId) ?? null;
  // The group this receipt is in now, if any: its head and everything under it.
  const groupHead = mine?.headId ?? saleId;
  const inGroup = useMemo(
    () => rows.filter((r) => r.headId === groupHead).map((r) => r.saleId),
    [rows, groupHead],
  );

  const [picked, setPicked] = useState<Set<string> | null>(null);
  const chosen = picked ?? new Set([...(saleId ? [saleId] : []), ...inGroup]);
  const [busy, setBusy] = useState<'combine' | 'apart' | null>(null);

  const ordered = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const owe = Number(b.outstanding > 0.005) - Number(a.outstanding > 0.005);
        return owe !== 0 ? owe : b.occurredAt.localeCompare(a.occurredAt);
      }),
    [rows],
  );
  const newest = rows
    .filter((r) => chosen.has(r.saleId))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
  const owedOnChosen = rows.filter((r) => chosen.has(r.saleId)).reduce((s, r) => s + r.outstanding, 0);

  const status: PageStatus = !saleId
    ? { state: 'empty', title: 'Open a receipt first', body: 'Receipts are combined from one of them.' }
    : receipts.data
      ? rows.length === 0
        ? {
            state: 'empty',
            title: 'Only a named customer’s receipts combine',
            body: 'This receipt has no customer on it. Name the customer on it first (Something on this is wrong).',
          }
        : { state: 'ready' }
      : receipts.error
        ? { state: 'error', what: 'their receipts', error: String(receipts.error), onRetry: receipts.reload }
        : { state: 'loading', what: 'their receipts' };

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  return (
    <PageScaffold onBack={goBack} title="Combine receipts" subtitle="Send and print them as one">
      <ProblemDialog problem={problem} title="Not combined" />
      <PageState status={status}>
        {() => (
          <>
            <Explain label="What does combining do?">
              The receipts you tick print and share as one, under the newest of them. Every item,
              charge and payment from each is on it, and what the customer owes and what is still
              with them is said once. Nothing about the sales themselves changes — the stock, the
              payments and each day&rsquo;s takings stay as they were — and the older receipts&rsquo;
              links open the combined one. You can take them apart again at any time.
            </Explain>

            <ul className={styles.list}>
              {ordered.map((r) => {
                const elsewhere = r.headId !== r.saleId && r.headId !== groupHead;
                return (
                  <li key={r.saleId}>
                    <label className={styles.row}>
                      <input
                        type="checkbox"
                        checked={chosen.has(r.saleId)}
                        onChange={() => toggle(r.saleId)}
                      />
                      <span className={styles.body}>
                        <span className={styles.name}>
                          #{r.saleId.slice(0, 8).toUpperCase()}
                          {r.saleId === saleId ? ' · this receipt' : ''}
                        </span>
                        <span className={styles.meta}>
                          {formatDateTime(r.occurredAt)} · {r.lineCount} {r.lineCount === 1 ? 'item' : 'items'}
                          {r.outstanding > 0.005 ? ` · owes ${formatMoney(r.outstanding)}` : ' · paid'}
                        </span>
                        {elsewhere && (
                          <span className={styles.meta}>
                            Already combined into #{r.headId.slice(0, 8).toUpperCase()} — ticking it moves it here
                          </span>
                        )}
                      </span>
                      <span className={styles.amount}>{formatMoney(r.total)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>

            {chosen.size >= 2 && newest && (
              <InfoPanel tone="info" title={`${chosen.size} receipts as one`}>
                They will print and share as #{newest.saleId.slice(0, 8).toUpperCase()}, the newest
                {owedOnChosen > 0.005 ? `, with ${formatMoney(owedOnChosen)} still owed on them` : ''}.
              </InfoPanel>
            )}

            <div className={styles.actions}>
              <Button
                fullWidth
                disabled={chosen.size < 2}
                busy={busy === 'combine'}
                busyLabel="Combining"
                onClick={async () => {
                  setBusy('combine');
                  try {
                    const head = await combineReceipts([...chosen]);
                    if (head === saleId) await nav.pop();
                    else await swapTo(nav, 'receipt_page', { id: head });
                  } catch (e) {
                    problem.show(messageOf(e, 'Could not combine those receipts.'));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {chosen.size < 2 ? 'Tick at least two receipts' : `Combine ${chosen.size} receipts`}
              </Button>

              {inGroup.length > 1 && (
                <Button
                  variant="secondary"
                  fullWidth
                  busy={busy === 'apart'}
                  busyLabel="Taking apart"
                  onClick={async () => {
                    setBusy('apart');
                    try {
                      // From the head the whole group comes apart; from a part, just that receipt.
                      await uncombineReceipt(saleId === groupHead ? groupHead! : saleId!);
                      await nav.pop();
                    } catch (e) {
                      problem.show(messageOf(e, 'Could not take them apart.'));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {saleId === groupHead ? 'Take them all apart' : 'Take this receipt out'}
                </Button>
              )}
            </div>
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}

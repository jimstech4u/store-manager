'use client';

import { useCallback, useEffect, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { PlusIcon } from '@/components/ui/Icon';
import { FilterBar } from '@/components/ui/FilterBar';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { customPeriod, resolvePeriod, type Period, type PeriodKind } from '@/lib/stacks/periods';
import {
  expensesByCategory,
  listExpenses,
  moneySummary,
  reverseExpense,
  type CategoryTotal,
  type Expense,
  type MoneySummary,
} from '@/lib/stacks/expenses';
import { formatMoney, messageOf } from '@/lib/format';
import styles from './expenses-page.module.css';

interface Loaded {
  rows: Expense[];
  byCategory: CategoryTotal[];
  summary: MoneySummary | null;
}

/**
 * What the shop spent, and what it kept.
 *
 * The figure an owner means by "how did we do" is what CAME IN less what WENT OUT, and until now
 * the second half had nowhere to be recorded — so takings read as profit and the arithmetic was
 * wrong by exactly the cost of running the place.
 *
 * BILLED AND CAME IN ARE BOTH SHOWN, because they answer different questions on the same day. A
 * good month on paper with nothing in the drawer is precisely the thing a shop needs to see.
 */
export default function ExpensesPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();
  const problem = useProblem();
  const showProblem = problem.show;
  const confirm = useConfirm();

  const [period, setPeriod] = useState<Period | null>(null);
  /** Which row the question is about, AND whether it is being asked — see the dialog below. */
  const [pending, setPending] = useState<Expense | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async (): Promise<Loaded> => {
    const w = { storeId: store!.id, from: period!.fromAt, to: period!.toAt };
    const [rows, byCategory, summary] = await Promise.all([
      listExpenses(w),
      expensesByCategory(w),
      moneySummary(w),
    ]);
    return { rows, byCategory, summary };
  }, [store, period]);

  const area = useLoadArea<Loaded>(read, [store?.id ?? '', period?.label ?? ''], {
    onFail: showProblem,
    whenNot: !store || !period,
  });

  useLiveRefresh(nav, area.reload);

  /*
   * The window is resolved before anything is read, and by the SHOP's clock — a till phone a day
   * out would otherwise quietly summarise the wrong month.
   *
   * An EFFECT, not a lazy `useState` initialiser. A first draft used the latter, which fires a
   * network call during render and gives React nothing to clean up if the page leaves first.
   */
  useEffect(() => {
    if (!store) return;
    let alive = true;
    void resolvePeriod(store.id, 'this_month')
      .then((p) => alive && setPeriod(p))
      .catch((e) => showProblem(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [store, showProblem]);

  if (!store) return null;

  const takeBack = async (row: Expense) => {
    setBusy(true);
    try {
      await reverseExpense(row.id, 'keyed wrong');
      area.reload();
    } catch (e) {
      showProblem(messageOf(e, 'Could not take that back.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="Money going out"
      subtitle="Rent, fuel, transport — what the shop spends"
      actions={
        can('expenses.record')
          ? [
              {
                key: 'add',
                icon: <PlusIcon />,
                onClick: () => void nav.push('expense_page'),
                ariaLabel: 'Record money going out',
              },
            ]
          : []
      }
    >
      <ProblemDialog problem={problem} title="Could not read this" />

      {/*
        MOUNTED ONLY WHILE THE QUESTION IS BEING ASKED.
        `ConfirmDialog` opens itself on mount — "mounted means asked" — so rendering it
        unconditionally puts an undismissable empty dialog over the page.
      */}
      {pending && (
        <ConfirmDialog
          controller={confirm}
          title="Take this back?"
          message={
            `${formatMoney(pending.amount)} for "${pending.note}". It stays on the list with a ` +
            `matching entry against it, so the trail shows the money out and then back — nothing ` +
            `is deleted.`
          }
          confirmText="Take it back"
          onDismiss={() => setPending(null)}
          onConfirm={() => {
            const row = pending;
            setPending(null);
            void takeBack(row);
          }}
        />
      )}

      {period && (
        <FilterBar
          period={period}
          onPeriod={(kind: PeriodKind) => {
            void resolvePeriod(store.id, kind)
              .then(setPeriod)
              .catch((e) => showProblem(String(e?.message ?? e)));
          }}
          onCustom={(from, to) => {
            void customPeriod(store.id, from, to)
              .then(setPeriod)
              .catch((e) => showProblem(String(e?.message ?? e)));
          }}
        />
      )}

      <LoadArea area={area} what="what the shop spent">
        {(data) => (
          <>
            {data.summary && (
              <div className={styles.totals}>
                <div className={styles.fig}>
                  <span className={styles.figLabel}>Came in</span>
                  <span className={styles.figValue}>{formatMoney(data.summary.cameIn)}</span>
                </div>
                <div className={styles.fig}>
                  <span className={styles.figLabel}>Went out</span>
                  <span className={styles.figValue}>{formatMoney(data.summary.spent)}</span>
                </div>
                <div className={styles.fig}>
                  <span className={styles.figLabel}>Kept</span>
                  <span
                    className={`${styles.figValue} ${
                      data.summary.kept < 0 ? styles.short : styles.kept
                    }`}
                  >
                    {formatMoney(data.summary.kept)}
                  </span>
                </div>
              </div>
            )}

            {can('expenses.record') && (
              <Button size="large" fullWidth onClick={() => void nav.push('expense_page')}>
                <PlusIcon /> Record money going out
              </Button>
            )}

            {data.byCategory.length > 0 && (
              <>
                <h2 className={styles.section}>What it went on</h2>
                <ul className={styles.rows}>
                  {data.byCategory.map((c) => (
                    <li key={c.categoryId ?? 'none'} className={styles.row}>
                      <span className={styles.what}>
                        {c.category}
                        <span className={styles.detail}>
                          {c.entries} {c.entries === 1 ? 'entry' : 'entries'}
                        </span>
                      </span>
                      <span className={styles.money}>{formatMoney(c.total)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h2 className={styles.section}>Everything, one by one</h2>
            {data.rows.length === 0 ? (
              <p className={styles.none}>
                Nothing recorded in this period. Rent, fuel, transport and wages all belong here —
                without them your takings read as profit.
              </p>
            ) : (
              <ul className={styles.rows}>
                {data.rows.map((r) => (
                  <li key={r.id} className={styles.row}>
                    <span
                      className={`${styles.what} ${r.reversed ? styles.undone : ''} ${
                        r.reversesId ? styles.reversal : ''
                      }`}
                    >
                      {r.note}
                      <span className={styles.detail}>
                        {r.category ? `${r.category} · ` : ''}
                        {r.method === 'pos' ? 'card' : r.method}
                        {r.paidTo ? ` · to ${r.paidTo}` : ''}
                      </span>
                      <span className={styles.detail}>
                        {new Date(r.occurredAt).toLocaleDateString()}
                        {r.actor ? ` · ${r.actor}` : ''}
                      </span>
                      {can('expenses.record') && !r.reversed && !r.reversesId && (
                        <button
                          type="button"
                          className={styles.undo}
                          disabled={busy}
                          onClick={() => setPending(r)}
                        >
                          Take this back
                        </button>
                      )}
                    </span>
                    <span
                      className={`${styles.money} ${r.reversed ? styles.undone : ''}`}
                    >
                      {r.reversesId ? '−' : ''}
                      {formatMoney(r.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {data.summary && data.summary.kept < 0 && (
              <InfoPanel tone="warning" title="More went out than came in">
                Over this period the shop spent more than it took. That is worth knowing rather than
                worth hiding — it is often a month with a big delivery in it.
              </InfoPanel>
            )}
          </>
        )}
      </LoadArea>
    </PageScaffold>
  );
}

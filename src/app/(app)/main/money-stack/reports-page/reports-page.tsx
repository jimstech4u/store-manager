'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Explain } from '@/components/ui/Explain';
import { PrinterIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import {
  debtorReport,
  salesReport,
  stockReport,
  type DebtorReport,
  type SalesReport,
  type StockReport,
} from '@/lib/stacks/reports';
import { formatDateTime, formatMoney, formatQty, messageOf } from '@/lib/format';
import styles from './reports-page.module.css';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';

/**
 * The three reports a shop actually asks for, on paper or as a PDF.
 *
 * Printed through the browser's own dialog rather than a generated file. That dialog has "Save as
 * PDF" on every platform this runs on, so one action covers both — and the PDF it makes is real
 * text: selectable, searchable, and a fraction of the size of the image-based receipt PDFs, which
 * are images because a thermal receipt genuinely is one.
 *
 * The page size is set on <html> before printing because `@page` cannot be varied per element. A
 * receipt prints on the configured roll; these print on A4. Without the switch a debtors table
 * lands on 80mm thermal paper three characters wide.
 */

type Which = 'stock' | 'debtors' | 'sales';

const REPORTS: { id: Which; name: string; blurb: string }[] = [
  {
    id: 'stock',
    name: 'What is on the shelf',
    blurb: 'Every item, what you have left, and what it cost you — with the total your stock is worth.',
  },
  {
    id: 'debtors',
    name: 'Who owes you',
    blurb: 'Everyone carrying a balance, largest first, with the total outstanding.',
  },
  {
    id: 'sales',
    name: 'What you sold',
    blurb: 'Every receipt over the last 30 days, with what has been paid and what has not.',
  },
];

export default function ReportsPage() {
  const goBack = useStackBack();
  const { store } = useAuth();

  const [which, setWhich] = useState<Which>('stock');
  const [stock, setStock] = useState<StockReport | null>(null);
  const [debtors, setDebtors] = useState<DebtorReport | null>(null);
  const [sales, setSales] = useState<SalesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const error = useProblem();
  /*
   * Bound to a local, because a dependency array needs a value the linter can reason about.
   *
   * `show` never changes; the controller object does, as soon as a message appears. Depending on
   * the object would rebuild this callback after every failure — and the effect that calls it would
   * fire again, fail again, and loop. Depending on the member expression satisfies nobody: the rule
   * cannot prove a property is stable and asks for the whole object back. A local const is the one
   * form that is both honest and safe.
   */
  const showError = error.show;

  const load = useCallback(async () => {
    if (!store) return;
    setLoading(true);
    try {
      if (which === 'stock') setStock(await stockReport(store.id));
      else if (which === 'debtors') setDebtors(await debtorReport(store.id));
      else setSales(await salesReport(store.id, 30));
    } catch (e) {
      showError(messageOf(e, 'Could not build that report.'));
    } finally {
      setLoading(false);
    }
  }, [store, which, showError]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Print on A4, then put the page size back.
   *
   * Restored in a `finally` and after the dialog closes, because leaving `--print-size` set to A4
   * would make the NEXT receipt print on a sheet of paper instead of the roll — a bug that would
   * only ever show up at a counter with a customer waiting.
   */
  const print = () => {
    const root = document.documentElement;
    root.style.setProperty('--print-size', 'A4 portrait');
    root.style.setProperty('--print-margin', '12mm');
    const restore = () => {
      root.style.removeProperty('--print-size');
      root.style.removeProperty('--print-margin');
    };
    window.addEventListener('afterprint', restore, { once: true });
    try {
      window.print();
    } finally {
      // `afterprint` does not fire everywhere; this is the belt to its braces.
      setTimeout(restore, 1500);
    }
  };

  if (!store) return null;

  const active = REPORTS.find((r) => r.id === which)!;
  const today = formatDateTime(new Date().toISOString());

  return (
    <PageScaffold
      onBack={goBack}
      title="Reports"
      subtitle={store.name}
      actions={[
        { key: 'print', icon: <PrinterIcon />, onClick: print, ariaLabel: 'Print or save as PDF' },
      ]}
    >
      <Explain label="How do I save one of these as a PDF?">
        Tap the printer at the top. In the dialog your phone or computer opens, choose
        <strong> Save as PDF</strong> instead of a printer — that is the same button on Android, on
        iPhone and on a laptop.
        <br />
        <br />
        The file it makes is real text, so you can search it and a bank or a supplier can copy
        figures straight out of it.
      </Explain>

      <div className={styles.picker} role="group" aria-label="Which report">
        {REPORTS.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`${styles.tab} ${which === r.id ? styles.tabActive : ''}`}
            aria-pressed={which === r.id}
            onClick={() => setWhich(r.id)}
          >
            {r.name}
          </button>
        ))}
      </div>

      <p className={styles.blurb}>{active.blurb}</p>

      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={error} title="Could not build that report" />

      {loading ? (
        <FullPageMessage title="Working it out" tone="loading" />
      ) : (
        /* Everything inside here is what reaches the paper. */
        <div className={styles.sheet} data-print-root="page">
          <header className={styles.head}>
            <h2 className={styles.reportTitle}>{active.name}</h2>
            <p className={styles.reportMeta}>
              {store.name} · {today}
            </p>
          </header>

          {which === 'stock' && stock && (
            <>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Left</th>
                    <th>Cost each</th>
                    <th>Worth</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.lines.map((l) => (
                    <tr key={l.name}>
                      <td>
                        {l.name}
                        {l.category && <span className={styles.dim}> · {l.category}</span>}
                        {l.estimated && <span className={styles.dim}> · estimated cost</span>}
                      </td>
                      <td>
                        {formatQty(l.onHand)} {l.unit}
                      </td>
                      <td>{formatMoney(l.unitCost, 2)}</td>
                      <td>{formatMoney(l.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className={styles.total}>
                Stock is worth <strong>{formatMoney(stock.total)}</strong> at what it cost you
              </p>
              {stock.estimatedCount > 0 && (
                <p className={styles.footnote}>
                  {stock.estimatedCount}{' '}
                  {stock.estimatedCount === 1 ? 'item uses' : 'items use'} an estimated cost from
                  setup. Recording a delivery replaces it with what you really paid.
                </p>
              )}
            </>
          )}

          {which === 'debtors' && debtors && (
            <>
              {debtors.lines.length === 0 ? (
                <p className={styles.footnote}>Nobody owes you anything.</p>
              ) : (
                <>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Customer</th>
                        <th>Phone</th>
                        <th>Owes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {debtors.lines.map((l) => (
                        <tr key={l.phone + l.name}>
                          <td>{l.name}</td>
                          <td>{l.phone}</td>
                          <td>{formatMoney(l.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className={styles.total}>
                    {debtors.lines.length}{' '}
                    {debtors.lines.length === 1 ? 'customer owes' : 'customers owe'}{' '}
                    <strong>{formatMoney(debtors.total)}</strong>
                  </p>
                </>
              )}
            </>
          )}

          {which === 'sales' && sales && (
            <>
              {sales.lines.length === 0 ? (
                <p className={styles.footnote}>No sales in the last 30 days.</p>
              ) : (
                <>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Customer</th>
                        <th>Items</th>
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sales.lines.map((l, i) => (
                        <tr key={`${l.when}-${i}`}>
                          <td>{formatDateTime(l.when)}</td>
                          <td>
                            {l.customer}
                            {l.outstanding > 0 && (
                              <span className={styles.dim}>
                                {' '}
                                · {formatMoney(l.outstanding)} unpaid
                              </span>
                            )}
                          </td>
                          <td>{l.items}</td>
                          <td>{formatMoney(l.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className={styles.total}>
                    {sales.lines.length} {sales.lines.length === 1 ? 'sale' : 'sales'} totalling{' '}
                    <strong>{formatMoney(sales.total)}</strong>
                    {sales.outstanding > 0 && (
                      <>
                        {' '}
                        · <strong>{formatMoney(sales.outstanding)}</strong> still unpaid
                      </>
                    )}
                  </p>
                </>
              )}
            </>
          )}
        </div>
      )}

      <div className={styles.printRow}>
        <Button size="large" fullWidth variant="secondary" onClick={print}>
          <PrinterIcon /> Print or save as PDF
        </Button>
      </div>
    </PageScaffold>
  );
}

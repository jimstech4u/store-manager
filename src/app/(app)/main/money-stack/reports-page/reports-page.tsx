'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { PrinterIcon } from '@/components/ui/Icon';
import { FilterBar } from '@/components/ui/FilterBar';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { customPeriod, resolvePeriod, type Period, type PeriodKind } from '@/lib/stacks/periods';
import {
  debtorsAged,
  downloadCsv,
  priceList,
  salesByDay,
  salesByProduct,
  salesSummary,
  staffActivity,
  takingsByMethod,
  toCsv,
  type AgedRow,
  type DayRow,
  type MethodRow,
  type PriceRow,
  type ProductRow,
  type SalesSummary,
  type StaffRow,
} from '@/lib/stacks/report-readers';
import { stockReport, type StockReport } from '@/lib/stacks/reports';
import { formatDateTime, formatMoney, formatQty } from '@/lib/format';
import styles from './reports-page.module.css';

/**
 * The reports a shop asks for, over a window it chooses, on paper or as a PDF.
 *
 * PRINTED THROUGH THE BROWSER'S OWN DIALOG rather than a generated file. That dialog has "Save as
 * PDF" on every platform this runs on, so one action covers both — and the PDF it makes is real
 * text: selectable, searchable, and a fraction of the size of the image-based receipt PDFs, which
 * are images because a thermal receipt genuinely is one.
 *
 * THE WINDOW IS RESOLVED ON THE SERVER. This page used to pull a thousand rows and filter them to
 * thirty days in JavaScript — and PostgREST caps a response at 1,000 rows, so a shop with more than
 * a thousand receipts got a document quietly missing the rest. Every report here is aggregated in
 * SQL over the whole period, in the shop's own timezone.
 *
 * THREE PAGE SHAPES. A receipt prints on the configured roll; these print on A4; the price list
 * prints as an A1 poster, which is its own layout rather than a scaled A4.
 */

type Which =
  | 'sales'
  | 'days'
  | 'products'
  | 'takings'
  | 'debtors'
  | 'stock'
  | 'staff'
  | 'prices';

const REPORTS: { id: Which; name: string; blurb: string; windowed: boolean }[] = [
  { id: 'sales', name: 'What you sold', blurb: 'Receipts, what was billed, what came in, what is still owed.', windowed: true },
  { id: 'days', name: 'Day by day', blurb: 'Every trading day in the period, with its takings.', windowed: true },
  { id: 'products', name: 'By item', blurb: 'What sold, what it made, and what it cost you.', windowed: true },
  { id: 'takings', name: 'How you were paid', blurb: 'Cash, transfer and card, side by side.', windowed: true },
  { id: 'debtors', name: 'Who owes you', blurb: 'Everyone carrying a balance, oldest debt first.', windowed: false },
  { id: 'stock', name: 'What is on the shelf', blurb: 'Every item, what is left, and what your stock is worth.', windowed: false },
  { id: 'staff', name: 'Who did what', blurb: 'Receipts, deliveries, counts and corrections, per person.', windowed: true },
  { id: 'prices', name: 'Price list', blurb: 'Every item and price — prints as a poster for the wall.', windowed: false },
];

interface Loaded {
  /*
   * WHICH REPORT THIS IS AN ANSWER TO.
   *
   * `useLoadArea` keeps the previous value while it refetches — correct for a refresh, because the
   * rows on screen are the last thing known to be true. Switching REPORT is not a refresh: it is a
   * different question, and the old object's empty slice for the new one rendered as the new one's
   * result. The price list showed "Nothing has a price on it yet" over thirty-seven prices that had
   * already come back down the wire.
   */
  for: Which;
  summary: SalesSummary | null;
  days: DayRow[];
  products: ProductRow[];
  methods: MethodRow[];
  debtors: AgedRow[];
  stock: StockReport | null;
  staff: StaffRow[];
  prices: PriceRow[];
}

export default function ReportsPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();
  const problem = useProblem();
  const showProblem = problem.show;

  const [which, setWhich] = useState<Which>('sales');
  const [period, setPeriod] = useState<Period | null>(null);

  /*
   * The window is resolved before anything is read.
   *
   * Not defaulted in the browser: "this month" has to mean the shop's calendar month in the shop's
   * timezone, and a phone that is a day out would silently produce a report for the wrong month.
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

  const read = useCallback(async (): Promise<Loaded> => {
    const w = { storeId: store!.id, from: period!.fromAt, to: period!.toAt };
    const base = { ...empty, for: which };
    switch (which) {
      case 'sales':
        return { ...base, summary: await salesSummary(w), days: await salesByDay(w) };
      case 'days':
        return { ...base, days: await salesByDay(w), summary: await salesSummary(w) };
      case 'products':
        return { ...base, products: await salesByProduct(w) };
      case 'takings':
        return { ...base, methods: await takingsByMethod(w) };
      case 'debtors':
        return { ...base, debtors: await debtorsAged(store!.id) };
      case 'stock':
        return { ...base, stock: await stockReport(store!.id) };
      case 'staff':
        return { ...base, staff: await staffActivity(w) };
      case 'prices':
        return { ...base, prices: await priceList(store!.id) };
    }
  }, [store, period, which]);

  const area = useLoadArea<Loaded>(read, [store?.id ?? '', which, period?.label ?? ''], {
    onFail: showProblem,
    whenNot: !store || !period,
  });

  const active = REPORTS.find((r) => r.id === which)!;
  const printedAt = formatDateTime(new Date().toISOString());

  /**
   * Print at the right paper size, then put it back.
   *
   * Restored in a `finally` AND on `afterprint`, because leaving `--print-size` set would make the
   * NEXT receipt print on a sheet instead of the roll — a bug that would only ever show up at a
   * counter with a customer waiting.
   */
  const print = (shape: 'a4' | 'poster') => {
    const root = document.documentElement;
    root.style.setProperty('--print-size', shape === 'poster' ? 'A1 portrait' : 'A4 portrait');
    root.style.setProperty('--print-margin', shape === 'poster' ? '18mm' : '12mm');
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

  const exportCsv = (data: Loaded) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `${active.name.toLowerCase().replace(/\s+/g, '-')}-${stamp}.csv`;
    switch (which) {
      case 'days':
      case 'sales':
        return downloadCsv(
          name,
          toCsv(
            [
              { key: 'day', head: 'Day' },
              { key: 'receipts', head: 'Receipts' },
              { key: 'billed', head: 'Billed' },
              { key: 'paid', head: 'Paid' },
            ],
            data.days as unknown as Record<string, unknown>[],
          ),
        );
      case 'products':
        return downloadCsv(
          name,
          toCsv(
            [
              { key: 'productName', head: 'Item' },
              { key: 'soldBase', head: 'Sold' },
              { key: 'receipts', head: 'Receipts' },
              { key: 'revenue', head: 'Revenue' },
              { key: 'cost', head: 'Cost' },
              { key: 'margin', head: 'Margin' },
            ],
            data.products as unknown as Record<string, unknown>[],
          ),
        );
      case 'debtors':
        return downloadCsv(
          name,
          toCsv(
            [
              { key: 'customerName', head: 'Customer' },
              { key: 'phone', head: 'Phone' },
              { key: 'balance', head: 'Balance' },
              { key: 'daysOld', head: 'Days' },
              { key: 'bucket', head: 'Age' },
            ],
            data.debtors as unknown as Record<string, unknown>[],
          ),
        );
      case 'prices':
        return downloadCsv(
          name,
          toCsv(
            [
              { key: 'groupName', head: 'Maker' },
              { key: 'productName', head: 'Item' },
              { key: 'unitName', head: 'Sold in' },
              { key: 'price', head: 'Price' },
            ],
            data.prices as unknown as Record<string, unknown>[],
          ),
        );
      default:
        return downloadCsv(
          name,
          toCsv(
            [
              { key: 'method', head: 'Method' },
              { key: 'payments', head: 'Payments' },
              { key: 'amount', head: 'Amount' },
            ],
            (data.methods.length ? data.methods : data.staff) as unknown as Record<
              string,
              unknown
            >[],
          ),
        );
    }
  };

  if (!store) return null;

  if (!can('reports.view')) {
    return (
      <PageScaffold onBack={goBack} title="Reports">
        <InfoPanel tone="info" title="Not part of your job here">
          Reports are for whoever runs the shop. Ask them if you need one.
        </InfoPanel>
      </PageScaffold>
    );
  }

  return (
    <PageScaffold onBack={goBack} title="Reports" subtitle="On paper, or as a PDF">
      <ProblemDialog problem={problem} title="Could not build that report" />

      <Explain label="How do I get a PDF?">
        Press Print and choose &ldquo;Save as PDF&rdquo; in the dialog your device opens. It is real
        text, so it can be searched and copied — and it is a fraction of the size of a photograph of
        a receipt.
      </Explain>

      {/* Which report. A list of eight, so a scrolling row of tabs rather than a wall of cards. */}
      <div className={styles.picker} role="tablist" aria-label="Which report">
        {REPORTS.map((r) => (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={which === r.id}
            className={`${styles.tab} ${which === r.id ? styles.tabActive : ''}`}
            onClick={() => setWhich(r.id)}
          >
            {r.name}
          </button>
        ))}
      </div>
      <p className={styles.blurb}>{active.blurb}</p>

      {/*
        THE WINDOW, and only where one means anything.

        "What is on the shelf" and "who owes you" are positions as at NOW — a date range on either
        would be a control that changes nothing, which is worse than a missing one because it looks
        answered.
      */}
      {active.windowed && period && (
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

      <LoadArea area={area} what="this report">
        {(data) =>
          /*
           * The previous report's object is not an answer to this one.
           *
           * Shown as "reading" rather than as an empty result, because an empty result is a claim
           * and this one has not been made yet.
           */
          data.for !== which ? (
            <p className={styles.footnote}>Reading this report…</p>
          ) : (
          <>
            <div className={styles.printRow}>
              <Button onClick={() => print(which === 'prices' ? 'poster' : 'a4')} fullWidth>
                <PrinterIcon /> {which === 'prices' ? 'Print the poster' : 'Print'}
              </Button>
              <Button variant="secondary" onClick={() => exportCsv(data)} fullWidth>
                Save as CSV
              </Button>
            </div>

            {which === 'prices' ? (
              <PricePoster
                rows={data.prices}
                shopName={store.name}
                printedAt={printedAt}
              />
            ) : (
              <div className={styles.sheet} data-print-root="page">
                <div className={styles.head}>
                  <p className={styles.reportTitle}>
                    {store.name} — {active.name}
                  </p>
                  {/*
                    THE DOCUMENT NAMES ITS OWN WINDOW.

                    A report on a desk that cannot say what it covers is not evidence of anything —
                    and the words come from the server, so the paper and the screen agree.
                  */}
                  <p className={styles.reportMeta}>
                    {active.windowed && period ? `${period.label} · ` : ''}
                    Printed {printedAt}
                  </p>
                </div>

                {which === 'sales' && <SalesReport summary={data.summary} days={data.days} />}
                {which === 'days' && <DaysReport days={data.days} />}
                {which === 'products' && <ProductsReport rows={data.products} />}
                {which === 'takings' && <TakingsReport rows={data.methods} />}
                {which === 'debtors' && <DebtorsReport rows={data.debtors} />}
                {which === 'stock' && <StockTable report={data.stock} />}
                {which === 'staff' && <StaffReport rows={data.staff} />}
              </div>
            )}
          </>
          )
        }
      </LoadArea>
    </PageScaffold>
  );
}

const empty: Loaded = {
  for: 'sales',
  summary: null,
  days: [],
  products: [],
  methods: [],
  debtors: [],
  stock: null,
  staff: [],
  prices: [],
};

/* ── The reports themselves ─────────────────────────────────────────────────────── */

function SalesReport({ summary, days }: { summary: SalesSummary | null; days: DayRow[] }) {
  if (!summary) return <p className={styles.footnote}>Nothing in this period.</p>;
  return (
    <>
      <table className={styles.table}>
        <tbody>
          <tr><td>Receipts</td><td className={styles.total}>{summary.receipts}</td></tr>
          <tr><td>Customers served</td><td className={styles.total}>{summary.customers}</td></tr>
          <tr><td>Billed</td><td className={styles.total}>{formatMoney(summary.billed)}</td></tr>
          <tr><td>Paid</td><td className={styles.total}>{formatMoney(summary.paid)}</td></tr>
          <tr><td>Still owed</td><td className={styles.total}>{formatMoney(summary.owing)}</td></tr>
          {summary.busiestDay && (
            <tr>
              <td>Best day</td>
              <td className={styles.total}>
                {new Date(summary.busiestDay).toLocaleDateString()}
              </td>
            </tr>
          )}
          {/*
            CANCELLED AND CORRECTED ARE ON THE FACE OF IT, not buried.
            A month with forty corrections in it is telling somebody something, and a report that
            only shows the clean total lets that go unnoticed for as long as it keeps happening.
          */}
          {summary.voided > 0 && (
            <tr><td>Cancelled</td><td className={styles.dim}>{summary.voided}</td></tr>
          )}
          {summary.corrected > 0 && (
            <tr><td>Corrected afterwards</td><td className={styles.dim}>{summary.corrected}</td></tr>
          )}
        </tbody>
      </table>
      <DaysReport days={days} />
    </>
  );
}

function DaysReport({ days }: { days: DayRow[] }) {
  if (days.length === 0) return <p className={styles.footnote}>No trading in this period.</p>;
  const billed = days.reduce((s, d) => s + d.billed, 0);
  const paid = days.reduce((s, d) => s + d.paid, 0);
  return (
    <table className={styles.table}>
      <thead>
        <tr><th>Day</th><th>Receipts</th><th>Billed</th><th>Paid</th></tr>
      </thead>
      <tbody>
        {days.map((d) => (
          <tr key={d.day}>
            <td>{new Date(d.day).toLocaleDateString()}</td>
            <td>{d.receipts}</td>
            <td>{formatMoney(d.billed)}</td>
            <td>{formatMoney(d.paid)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td className={styles.total}>Total</td>
          <td className={styles.total}>{days.reduce((s, d) => s + d.receipts, 0)}</td>
          <td className={styles.total}>{formatMoney(billed)}</td>
          <td className={styles.total}>{formatMoney(paid)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function ProductsReport({ rows }: { rows: ProductRow[] }) {
  if (rows.length === 0) return <p className={styles.footnote}>Nothing sold in this period.</p>;
  return (
    <table className={styles.table}>
      <thead>
        <tr><th>Item</th><th>Sold</th><th>Revenue</th><th>Margin</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.productId}>
            <td>{r.productName}</td>
            <td>{formatQty(r.soldBase)}</td>
            <td>{formatMoney(r.revenue)}</td>
            <td>{formatMoney(r.margin)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td className={styles.total}>Total</td>
          <td />
          <td className={styles.total}>
            {formatMoney(rows.reduce((s, r) => s + r.revenue, 0))}
          </td>
          <td className={styles.total}>
            {formatMoney(rows.reduce((s, r) => s + r.margin, 0))}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function TakingsReport({ rows }: { rows: MethodRow[] }) {
  if (rows.length === 0) return <p className={styles.footnote}>No money came in.</p>;
  return (
    <table className={styles.table}>
      <thead>
        <tr><th>How</th><th>Payments</th><th>Amount</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.method}>
            <td>{r.method === 'pos' ? 'Card' : r.method[0].toUpperCase() + r.method.slice(1)}</td>
            <td>{r.payments}</td>
            <td>{formatMoney(r.amount)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td className={styles.total}>Total</td>
          <td className={styles.total}>{rows.reduce((s, r) => s + r.payments, 0)}</td>
          <td className={styles.total}>
            {formatMoney(rows.reduce((s, r) => s + r.amount, 0))}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function DebtorsReport({ rows }: { rows: AgedRow[] }) {
  if (rows.length === 0) return <p className={styles.footnote}>Nobody owes you anything.</p>;
  /*
   * GROUPED BY AGE, because that is what the report is FOR.
   *
   * A list sorted by size answers "who owes most"; a shop chasing debt needs "who has owed longest",
   * and the buckets are what turn a column of dates into a decision.
   */
  const buckets = ['0–7 days', '8–30 days', '31–60 days', 'over 60 days', 'no unpaid receipt'];
  return (
    <>
      {buckets.map((b) => {
        const inB = rows.filter((r) => r.bucket === b);
        if (inB.length === 0) return null;
        return (
          <div key={b}>
            <p className={styles.reportTitle}>
              {b} — {formatMoney(inB.reduce((s, r) => s + r.balance, 0))}
            </p>
            <table className={styles.table}>
              <thead>
                <tr><th>Customer</th><th>Phone</th><th>Owes</th></tr>
              </thead>
              <tbody>
                {inB.map((r) => (
                  <tr key={r.storeCustomerId}>
                    <td>{r.customerName}</td>
                    <td className={styles.dim}>{r.phone ?? ''}</td>
                    <td>{formatMoney(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <p className={styles.footnote}>
        Total outstanding: {formatMoney(rows.reduce((s, r) => s + r.balance, 0))}
      </p>
    </>
  );
}

function StaffReport({ rows }: { rows: StaffRow[] }) {
  if (rows.length === 0) return <p className={styles.footnote}>Nothing recorded in this period.</p>;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Who</th><th>Receipts</th><th>Sold</th><th>Deliveries</th><th>Counts</th>
          <th>Corrections</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.userId}>
            <td>{r.who}</td>
            <td>{r.receipts}</td>
            <td>{formatMoney(r.sold)}</td>
            <td>{r.deliveries}</td>
            <td>{r.counts}</td>
            <td>{r.corrections}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StockTable({ report }: { report: StockReport | null }) {
  if (!report) return <p className={styles.footnote}>Nothing on the shelf.</p>;
  return (
    <>
      <table className={styles.table}>
        <thead>
          <tr><th>Item</th><th>Left</th><th>Cost each</th><th>Worth</th></tr>
        </thead>
        <tbody>
          {report.lines.map((l) => (
            // Keyed on the NAME: `StockLine` carries no id, and inventing one from the index would
            // reorder rows under React on the next read.
            <tr key={l.name}>
              <td>{l.name}</td>
              <td>
                {formatQty(l.onHand)} {l.unit}
              </td>
              <td>{formatMoney(l.unitCost)}</td>
              <td>{formatMoney(l.value)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className={styles.total}>Total</td>
            <td /><td />
            <td className={styles.total}>{formatMoney(report.total)}</td>
          </tr>
        </tfoot>
      </table>
      {report.estimatedCount > 0 && (
        <p className={styles.footnote}>
          {report.estimatedCount} of these are still carrying an estimated cost.
        </p>
      )}
    </>
  );
}

/**
 * The price list, as a poster.
 *
 * Its own layout rather than a scaled A4: type sized to be read across a shop, balanced columns,
 * and the maker's name repeated at the head of each block. It carries the date it was printed
 * LARGE, because a price list on a wall with no date is how a customer argues a six-month-old
 * price.
 */
function PricePoster({
  rows,
  shopName,
  printedAt,
}: {
  rows: PriceRow[];
  shopName: string;
  printedAt: string;
}) {
  const groups = useMemo(() => {
    const out = new Map<string, PriceRow[]>();
    for (const r of rows) {
      if (!out.has(r.groupName)) out.set(r.groupName, []);
      out.get(r.groupName)!.push(r);
    }
    return [...out.entries()];
  }, [rows]);

  if (rows.length === 0) {
    return <p className={styles.footnote}>Nothing has a price on it yet.</p>;
  }

  return (
    <div className={styles.sheet} data-print-root="poster">
      <div className="posterHead">
        <p className="posterShop">{shopName}</p>
        <p className="posterWhen">Prices as at {printedAt}</p>
      </div>

      {groups.map(([group, items]) => (
        <section key={group}>
          <h2>{group}</h2>
          {items.map((r) => (
            <div className="posterRow" key={`${r.productId}-${r.unitName}`}>
              <span>
                {r.productName}
                {r.baseQty > 1 ? ` · ${r.unitName.toLowerCase()} of ${r.baseQty}` : ` · ${r.unitName.toLowerCase()}`}
              </span>
              <span className="posterPrice">{formatMoney(r.price)}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

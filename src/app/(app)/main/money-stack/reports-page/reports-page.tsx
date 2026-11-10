'use client';

import { ACCOUNT_DERIVED_SCOPE } from '@/lib/stacks/customer-account';
import { useCallback, useMemo, useState } from 'react';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { PrinterIcon } from '@/components/ui/Icon';
import { FilterBar } from '@/components/ui/FilterBar';
import { LoadArea } from '@/components/ui/LoadArea';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { DocumentActions } from '@/components/ui/DocumentActions';
import { useDebounced } from '@/components/ui/SearchField';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useResource } from '@/lib/stacks/resource';
import { customPeriod, resolvePeriod, usePeriod, type PeriodKind } from '@/lib/stacks/periods';
import { useSayInShapes, useSellingUnits } from '@/lib/stacks/selling-units';
import {
  loadReport,
  REPORT_GROUPS,
  REPORTS,
  type LoadedReport,
  type ReportGroup,
  type ReportId,
} from '@/lib/stacks/export-reports';
import { keepColumns, renderReportPages, reportToCsv, reportToRoll } from '@/lib/report-doc';
import { shareCsv } from '@/lib/export-csv';
import type { PriceRow } from '@/lib/stacks/report-readers';
import { formatDateTime, formatMoney } from '@/lib/format';
import { QrCode } from '@/components/ui/QrCode';
import { appUrl } from '@/lib/app-url';
import styles from './reports-page.module.css';

/**
 * THE SHOP'S REPORTING TOOL — choose the question, set its window, pick the lines, take it away.
 *
 * "report page needs a reconstruction and a well defined, proper professional reporting tool …
 * we should have a checkbox for a line to exist in the report … stock in its shape, American Cola
 * is 300 packs 10 pieces, not just pieces" (9 Nov). Laid out the way a bank statement is:
 *
 *   1. WHICH REPORT — four groups (Money, Stock, People, Team), the reports of one group at a time.
 *   2. ITS WINDOW — the shop's own days, resolved on the server; only on reports that have one.
 *   3. WHAT IT COMES TO — the totals, as figures at the top.
 *   4. ITS COLUMNS — each with a tick box ("product name and quantity and not the price"). Rows are
 *      NOT chosen: every line the question matches is on it, so nobody can hand over a report with
 *      the awkward lines left out. A column left out takes its totals with it.
 *   5. TAKE IT AWAY — PDF on A4, a picture, the receipt printer, a page printer, share, or CSV.
 *
 * It replaces two pages that each did half: Reports had the figures and printed through the
 * browser; Export had the lists and every way out. One list of reports now (`export-reports.ts`),
 * and one way of drawing each (`report-doc.ts`).
 *
 * THE WINDOW IS RESOLVED ON THE SERVER, and every report is read whole: PostgREST caps a response
 * at 1,000 rows, so the lists page through to the end rather than trusting one answer.
 */

export default function ReportsPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();
  const problem = useProblem();
  const showProblem = problem.show;
  const say = useSayInShapes(store?.id ?? null);
  /*
   * THE SHOP'S SHAPES FIRST. A report read before they arrive says stock in its smallest unit —
   * "300 pieces" where the shop says "25 packs" — and nothing read it again when they came. So a
   * report waits for them, and is read again if they change.
   */
  const shapes = useSellingUnits(store?.id ?? null);
  const shapesReady = shapes.loaded || Boolean(shapes.error);
  const shapesKey = shapes.units.length;

  const [which, setWhich] = useState<ReportId>('days');
  const spec = REPORTS.find((r) => r.id === which)!;
  const [group, setGroup] = useState<ReportGroup>(spec.group);
  const { period, setPeriod, error: periodError, reload: reloadPeriod } = usePeriod(store?.id ?? null);

  /* An amount range, for the reports that take one — read once the typing stops. */
  const [minText, setMinText] = useState('');
  const [maxText, setMaxText] = useState('');
  const min = useDebounced(minText, 500);
  const max = useDebounced(maxText, 500);

  const choosePeriod = useCallback(
    (kind: PeriodKind) => {
      if (!store) return;
      void resolvePeriod(store.id, kind)
        .then(setPeriod)
        .catch((e) => showProblem(String(e?.message ?? e)));
    },
    [store, setPeriod, showProblem],
  );

  /*
   * A report that opens on its own window — today's counts, every unpaid receipt — moves the
   * window there when it is chosen. The rest keep whatever the shop was looking at.
   */
  const choose = (next: ReportId) => {
    setWhich(next);
    const s = REPORTS.find((r) => r.id === next)!;
    if (s.period === 'today' && period?.kind !== 'today') choosePeriod('today');
    if (s.period === 'all' && period?.kind !== 'all') choosePeriod('all');
  };

  const windowed = Boolean(spec.period);
  const amount = Boolean(spec.amount);
  const periodKey = windowed ? (period ? `${period.fromAt}:${period.toAt}` : 'pending') : 'now';
  const amountKey = amount ? `${min}:${max}` : '';

  const report = useResource<LoadedReport>({
    key: `report:${store?.id ?? 'none'}:${which}:${periodKey}:${amountKey}:${shapesKey}`,
    // A sale, a payment or a delivery changes a report; those writers all notify this scope.
    scope: ACCOUNT_DERIVED_SCOPE,
    // Never kept on the phone: an old report is not one anybody should be shown.
    persist: false,
    enabled: Boolean(store) && shapesReady && (!windowed || Boolean(period)),
    deps: [store?.id, which, periodKey, amountKey, shapesKey, say],
    onFail: showProblem,
    read: () =>
      loadReport(
        which,
        store!.id,
        store!.name,
        {
          fromAt: windowed ? (period?.fromAt ?? null) : null,
          toAt: windowed ? (period?.toAt ?? null) : null,
          periodLabel: windowed ? (period?.label ?? '') : '',
          min: amount && min.trim() !== '' ? Number(min) : null,
          max: amount && max.trim() !== '' ? Number(max) : null,
        },
        say,
      ),
  });

  /*
   * THE COLUMNS LEFT OUT, by heading, per report — and remembered on this phone, because a shop that
   * sends its price-free stock list every evening should not untick Worth every evening.
   */
  const [hiddenBy, setHiddenBy] = useState<Record<string, string[]>>(() => {
    try {
      return JSON.parse(localStorage.getItem('reports:hidden-columns') ?? '{}') as Record<string, string[]>;
    } catch {
      return {};
    }
  });
  const hidden = useMemo(() => new Set(hiddenBy[which] ?? []), [hiddenBy, which]);
  const loaded = report.data;
  const doc = loaded?.doc ?? null;
  const keptColumns = useMemo(
    () => (doc ? doc.columns.map((_, i) => i).filter((i) => !hidden.has(doc.columns[i].head)) : []),
    [doc, hidden],
  );
  const chosen = useMemo(() => (doc ? keepColumns(doc, keptColumns) : null), [doc, keptColumns]);

  const toggleColumn = (head: string) =>
    setHiddenBy((prev) => {
      const now = new Set(prev[which] ?? []);
      if (now.has(head)) now.delete(head);
      else now.add(head);
      const next = { ...prev, [which]: [...now] };
      try {
        localStorage.setItem('reports:hidden-columns', JSON.stringify(next));
      } catch {
        // A private window: the choice holds for this visit only.
      }
      return next;
    });

  const [csvNote, setCsvNote] = useState<string | null>(null);

  if (!store) return null;

  const status: PageStatus = !can('reports.view')
    ? {
        // Said inside the page's own header — it used to be a second page with a second header.
        state: 'empty',
        title: 'Not part of your job here',
        body: <>Reports are for whoever runs the shop. Ask them if you need one.</>,
      }
    : { state: 'ready' };

  const fileBase = `${spec.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}`;

  return (
    <PageScaffold layout="record" onBack={goBack} title="Reports" subtitle="Choose, pick the columns, take it away">
      <ProblemDialog problem={problem} title="Could not build that report" />

      <PageState status={status}>
        {() => (
          <>
            {/* ── 1. Which report ── */}
            <section className={styles.choose} aria-label="Which report" data-print-no-print>
              <div className={styles.groups} role="tablist" aria-label="Kind of report">
                {REPORT_GROUPS.map((g) => (
                  <button
                    key={g}
                    type="button"
                    role="tab"
                    aria-selected={group === g}
                    className={`${styles.group} ${group === g ? styles.groupOn : ''}`}
                    onClick={() => setGroup(g)}
                  >
                    {g}
                  </button>
                ))}
              </div>
              <div className={styles.reports}>
                {REPORTS.filter((r) => r.group === group).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    aria-pressed={r.id === which}
                    className={`${styles.report} ${r.id === which ? styles.reportOn : ''}`}
                    onClick={() => choose(r.id)}
                  >
                    <span className={styles.reportName}>{r.label}</span>
                  </button>
                ))}
              </div>
              {/* What the chosen one answers — one line, so the report itself starts on the first screen. */}
              <p className={styles.reportHint}>{spec.hint}</p>
            </section>

            {/* ── 2. Its window, and only where one means anything ── */}
            {(windowed || amount) && (
              <section className={styles.filters} aria-label="Filters" data-print-no-print>
                {windowed && period && (
                  <FilterBar
                    period={period}
                    onPeriod={choosePeriod}
                    onCustom={(from, to) => {
                      void customPeriod(store.id, from, to)
                        .then(setPeriod)
                        .catch((e) => showProblem(String(e?.message ?? e)));
                    }}
                  />
                )}
                {windowed && !period && (
                  <LoadArea
                    area={{ data: null, loading: !periodError, error: periodError, reload: reloadPeriod }}
                    what="the dates"
                  >
                    {() => null}
                  </LoadArea>
                )}
                {amount && (
                  <div className={styles.range}>
                    <Field label="Owing from" numeric whole prefix="₦" optional value={minText} onChange={(e) => setMinText(e.target.value)} placeholder="0" />
                    <Field label="Up to" numeric whole prefix="₦" optional value={maxText} onChange={(e) => setMaxText(e.target.value)} placeholder="any" />
                  </div>
                )}
              </section>
            )}

            <LoadArea area={report} what="this report">
              {() =>
                !chosen || !doc || !loaded ? null : (
                  <>
                    {/* ── 3. What it comes to ── */}
                    {chosen.totals.length > 0 && (
                      <dl className={styles.figures} aria-label="What it comes to" data-print-no-print>
                        {chosen.totals.map((t, i) => (
                          <div
                            key={t.label}
                            className={`${styles.figure} ${i === chosen.totals.length - 1 ? styles.figureLead : ''}`}
                          >
                            <dt>{t.label}</dt>
                            <dd>{t.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}

                    {/*
                      ── 4. Its columns, each with a tick box ──
                      At least one stays: a report of nothing is not a report.
                    */}
                    {doc.columns.length > 1 && (
                      <fieldset className={styles.columns} data-print-no-print>
                        <legend className={styles.columnsHead}>Columns on the report</legend>
                        <div className={styles.columnChips}>
                          {doc.columns.map((c) => {
                            const on = !hidden.has(c.head);
                            const last = on && keptColumns.length === 1;
                            return (
                              <label key={c.head} className={`${styles.column} ${on ? styles.columnOn : ''}`}>
                                <input
                                  type="checkbox"
                                  checked={on}
                                  disabled={last}
                                  onChange={() => toggleColumn(c.head)}
                                />
                                <span>{c.head}</span>
                              </label>
                            );
                          })}
                        </div>
                      </fieldset>
                    )}

                    {/* ── The report, as it goes out ── */}
                    <div className={styles.sheet} data-print-root="page">
                      <div className={styles.sheetHead}>
                        <p className={styles.sheetShop}>{doc.shop}</p>
                        <h2 className={styles.sheetTitle}>{doc.title}</h2>
                        <p className={styles.sheetFilters}>
                          {chosen.filters} · {formatDateTime(doc.generatedAt.toISOString())}
                        </p>
                      </div>

                      {doc.rows.length === 0 ? (
                        <p className={styles.sheetEmpty}>Nothing matches these filters.</p>
                      ) : (
                        <div className={styles.tableWrap}>
                          <table className={styles.table}>
                            <thead>
                              <tr>
                                {chosen.columns.map((c) => (
                                  <th key={c.head} className={c.align === 'right' ? styles.right : undefined}>
                                    {c.head}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {chosen.rows.map((r, i) => (
                                <tr key={i}>
                                  {r.map((cell, ci) => (
                                    <td key={ci} className={chosen.columns[ci]?.align === 'right' ? styles.right : undefined}>
                                      {cell}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {chosen.totals.length > 0 && (
                        <dl className={styles.totals}>
                          {chosen.totals.map((t) => (
                            <div key={t.label} className={styles.total}>
                              <dt>{t.label}</dt>
                              <dd>{t.value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {doc.note && <p className={styles.sheetFilters}>{doc.note}</p>}
                    </div>

                    {/* ── 5. Take it away ── */}
                    {doc.rows.length > 0 && (
                      <section className={styles.out} aria-label="Take it away" data-print-no-print>
                        {loaded.poster && (
                          <Button fullWidth onClick={() => printPoster()}>
                            <PrinterIcon /> Print the poster for the wall
                          </Button>
                        )}
                        <DocumentActions
                          storeId={store.id}
                          doc={reportToRoll(chosen)}
                          pages={() => renderReportPages(chosen)}
                          a4Print
                          filename={fileBase}
                          title={`${chosen.title} — ${chosen.shop}`}
                          message={`${chosen.shop} · ${chosen.title}\n${chosen.filters}\n${chosen.totals
                            .map((t) => `${t.label}: ${t.value}`)
                            .join('\n')}`}
                        />
                        <Button
                          variant="secondary"
                          fullWidth
                          onClick={async () => {
                            const how = await shareCsv(`${fileBase}.csv`, reportToCsv(chosen));
                            setCsvNote(how === 'downloaded' ? 'CSV saved to your downloads.' : null);
                          }}
                        >
                          Download CSV (for Excel)
                        </Button>
                        {csvNote && <p className={styles.note}>{csvNote}</p>}
                      </section>
                    )}

                    {loaded.poster && doc.rows.length > 0 && (
                      <h3 className={styles.posterHeading} data-print-no-print>
                        On the wall
                      </h3>
                    )}
                    {loaded.poster && (
                      <PricePoster
                        rows={loaded.poster.rows}
                        shopName={store.name}
                        printedAt={formatDateTime(doc.generatedAt.toISOString())}
                        storefront={loaded.poster.storefront}
                      />
                    )}
                  </>
                )
              }
            </LoadArea>
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}

/**
 * The poster on A1, then put back.
 *
 * Restored in a `finally` AND on `afterprint`, because leaving `--print-size` set would make the
 * NEXT receipt print on a sheet instead of the roll — a bug that would only ever show up at a
 * counter with a customer waiting.
 */
function printPoster() {
  const root = document.documentElement;
  root.style.setProperty('--print-size', 'A1 portrait');
  root.style.setProperty('--print-margin', '18mm');
  root.setAttribute('data-print-poster', '');
  const restore = () => {
    root.style.removeProperty('--print-size');
    root.style.removeProperty('--print-margin');
    root.removeAttribute('data-print-poster');
  };
  window.addEventListener('afterprint', restore, { once: true });
  try {
    window.print();
  } finally {
    // `afterprint` does not fire everywhere; this is the belt to its braces.
    setTimeout(restore, 1500);
  }
}

/**
 * The price list, as a poster.
 *
 * Its own layout rather than a scaled A4: type sized to be read across a shop, balanced columns,
 * and the maker's name repeated at the head of each block. It carries the date it was printed
 * LARGE, because a price list on a wall with no date is how a customer argues a six-month-old
 * price. Only the prices ticked above are on it.
 */
function PricePoster({
  rows,
  shopName,
  printedAt,
  storefront,
}: {
  rows: PriceRow[];
  shopName: string;
  printedAt: string;
  storefront: { code: string | null; isPublic: boolean };
}) {
  /*
   * WHAT A CUSTOMER SCANS OFF THE WALL — what is true now, where the date says how old the sheet
   * is. Null unless the storefront is switched on and has a code: `/s/CODE` 404s otherwise, and a
   * dead QR on a wall is worse than a bare sheet.
   */
  const shopUrl = storefront.isPublic && storefront.code ? appUrl(`/s/${storefront.code}`) : null;
  const groups = useMemo(() => {
    const out = new Map<string, PriceRow[]>();
    for (const r of rows) {
      if (!out.has(r.groupName)) out.set(r.groupName, []);
      out.get(r.groupName)!.push(r);
    }
    return [...out.entries()];
  }, [rows]);

  if (rows.length === 0) return null;

  return (
    <div className={styles.poster} data-print-root="poster">
      <div className="posterHead">
        <div className="posterTitles">
          <p className="posterShop">{shopName}</p>
          <p className="posterWhen">Prices as at {printedAt}</p>
        </div>
        {shopUrl && (
          <div className="posterScan">
            <QrCode value={shopUrl} size={96} title={`Scan for ${shopName}'s current prices`} />
            <p className="posterScanNote">
              Scan for today&rsquo;s prices
              <br />
              {storefront.code}
            </p>
          </div>
        )}
      </div>

      {groups.map(([group, items]) => (
        <section key={group}>
          <h2>{group}</h2>
          {items.map((r) => (
            <div className="posterRow" key={`${r.productId}-${r.unitName}`}>
              {/* What it is and what shape it comes in are two facts, so two spans. */}
              <span className="posterItem">
                <span className="posterName">{r.productName}</span>
                <span className="posterShape">
                  {r.baseQty > 1 ? `${r.unitName.toLowerCase()} of ${r.baseQty}` : r.unitName.toLowerCase()}
                </span>
              </span>
              <span className="posterPrice">{formatMoney(r.price)}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

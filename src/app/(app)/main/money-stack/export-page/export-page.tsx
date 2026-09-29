'use client';

import { useMemo, useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { DocumentActions } from '@/components/ui/DocumentActions';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useSayInShapes } from '@/lib/stacks/selling-units';
import { loadReport, REPORTS, type ReportId, type ReportOptions } from '@/lib/stacks/export-reports';
import { renderReportPages, reportToCsv, reportToRoll, type ReportDoc } from '@/lib/report-doc';
import { shareCsv } from '@/lib/export-csv';
import { messageOf } from '@/lib/format';
import styles from './export-page.module.css';

type PeriodKind = 'today' | 'yesterday' | 'week' | 'month' | 'last_month' | 'all' | 'custom';

const PERIODS: { kind: PeriodKind; label: string }[] = [
  { kind: 'today', label: 'Today' },
  { kind: 'yesterday', label: 'Yesterday' },
  { kind: 'week', label: 'Last 7 days' },
  { kind: 'month', label: 'This month' },
  { kind: 'last_month', label: 'Last month' },
  { kind: 'all', label: 'All time' },
  { kind: 'custom', label: 'Pick dates' },
];

const fmtDay = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** The period's bounds in the shop's own days, and the words that go on the report. */
function periodOf(kind: PeriodKind, fromText: string, toText: string): { from: Date | null; to: Date | null; label: string } {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = (n: number) => new Date(midnight.getTime() + n * 86400000);
  switch (kind) {
    case 'today':
      return { from: midnight, to: null, label: `Today, ${fmtDay(midnight)}` };
    case 'yesterday':
      return { from: days(-1), to: midnight, label: `Yesterday, ${fmtDay(days(-1))}` };
    case 'week':
      return { from: days(-6), to: null, label: `${fmtDay(days(-6))} – ${fmtDay(midnight)}` };
    case 'month': {
      const first = new Date(midnight.getFullYear(), midnight.getMonth(), 1);
      return { from: first, to: null, label: `${fmtDay(first)} – ${fmtDay(midnight)}` };
    }
    case 'last_month': {
      const first = new Date(midnight.getFullYear(), midnight.getMonth() - 1, 1);
      const end = new Date(midnight.getFullYear(), midnight.getMonth(), 1);
      return { from: first, to: end, label: first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
    }
    case 'all':
      return { from: null, to: null, label: 'All time' };
    case 'custom': {
      const from = fromText ? new Date(`${fromText}T00:00:00`) : null;
      const toDay = toText ? new Date(`${toText}T00:00:00`) : null;
      const to = toDay ? new Date(toDay.getTime() + 86400000) : null;
      const label =
        from && toDay ? `${fmtDay(from)} – ${fmtDay(toDay)}` : from ? `From ${fmtDay(from)}` : toDay ? `Up to ${fmtDay(toDay)}` : 'All time';
      return { from, to, label };
    }
  }
}

/**
 * EXPORT A REPORT — the way a bank gives you a statement.
 *
 * "we should be able to export based on report, like all I have counted today, all low, all still
 * in stock, who is owing me, who I owe, set a range based on the amount owing me, who has paid me
 * and when ... just like a bank fintech does."
 *
 * Choose the report, set its filters, see it laid out as it will print, then take it away: CSV for
 * a spreadsheet, a PDF on A4 with the heading repeated on every page, a picture for WhatsApp, or
 * print it — to the shop's receipt printer as a roll, or to a page printer on A4.
 */
export default function ExportPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const say = useSayInShapes(store?.id ?? null);

  const [id, setId] = useState<ReportId>('owes');
  const spec = REPORTS.find((r) => r.id === id)!;
  const [period, setPeriod] = useState<PeriodKind>('today');
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');

  const [report, setReport] = useState<ReportDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const groups = useMemo(() => ['Stock', 'People', 'Money'] as const, []);

  if (!store) return null;

  const choose = (next: ReportId) => {
    setId(next);
    setReport(null);
    setProblem(null);
    const s = REPORTS.find((r) => r.id === next)!;
    if (s.period) setPeriod(s.period === 'all' ? 'all' : s.period);
  };

  const make = async () => {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const p = spec.period ? periodOf(period, fromText, toText) : { from: null, to: null, label: '' };
      const opts: ReportOptions = {
        from: p.from,
        to: p.to,
        periodLabel: p.label,
        min: spec.amount && min.trim() !== '' ? Number(min) : null,
        max: spec.amount && max.trim() !== '' ? Number(max) : null,
      };
      setReport(await loadReport(id, store.id, store.name, opts, say));
    } catch (e) {
      setProblem(messageOf(e, 'That report could not be made.'));
    } finally {
      setBusy(false);
    }
  };

  const fileBase = report
    ? `${report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}`
    : 'report';

  return (
    <PageScaffold onBack={goBack} title="Export a report" subtitle="CSV, PDF, a picture, or print">
      <div data-print-no-print>
        {groups.map((g) => (
          <section key={g} className={styles.group}>
            <h2 className={styles.groupHead}>{g}</h2>
            <div className={styles.choices}>
              {REPORTS.filter((r) => r.group === g).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`${styles.choice} ${r.id === id ? styles.choiceOn : ''}`}
                  aria-pressed={r.id === id}
                  onClick={() => choose(r.id)}
                >
                  <span className={styles.choiceName}>{r.label}</span>
                  <span className={styles.choiceHint}>{r.hint}</span>
                </button>
              ))}
            </div>
          </section>
        ))}

        {spec.period && (
          <section className={styles.filters}>
            <h2 className={styles.groupHead}>When</h2>
            <div className={styles.chips} role="tablist" aria-label="Period">
              {PERIODS.map((p) => (
                <button
                  key={p.kind}
                  type="button"
                  role="tab"
                  aria-selected={period === p.kind}
                  className={`${styles.chip} ${period === p.kind ? styles.chipOn : ''}`}
                  onClick={() => {
                    setPeriod(p.kind);
                    setReport(null);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {period === 'custom' && (
              <div className={styles.row2}>
                <Field label="From" type="date" value={fromText} onChange={(e) => setFromText(e.target.value)} />
                <Field label="To" type="date" value={toText} onChange={(e) => setToText(e.target.value)} />
              </div>
            )}
          </section>
        )}

        {spec.amount && (
          <section className={styles.filters}>
            <h2 className={styles.groupHead}>How much</h2>
            <div className={styles.row2}>
              <Field label="From" numeric whole prefix="₦" optional value={min} onChange={(e) => setMin(e.target.value)} placeholder="0" />
              <Field label="To" numeric whole prefix="₦" optional value={max} onChange={(e) => setMax(e.target.value)} placeholder="any" />
            </div>
          </section>
        )}

        <Button fullWidth size="large" busy={busy} busyLabel="Making the report" onClick={() => void make()}>
          Show the report
        </Button>

        {problem && (
          <InfoPanel tone="danger" title="Could not make it">
            {problem}
          </InfoPanel>
        )}
      </div>

      {report && (
        <>
          {/*
            THE REPORT AS IT WILL PRINT — the same heading, filters, table and totals as the PDF.
            `data-print-root="page"` is what a page printer receives (on A4).
          */}
          <div className={styles.sheet} data-print-root="page">
            <div className={styles.sheetHead}>
              <p className={styles.sheetShop}>{report.shop}</p>
              <h2 className={styles.sheetTitle}>{report.title}</h2>
              <p className={styles.sheetFilters}>{report.filters}</p>
            </div>
            {report.rows.length === 0 ? (
              <p className={styles.sheetEmpty}>Nothing matches these filters.</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {report.columns.map((c) => (
                        <th key={c.head} className={c.align === 'right' ? styles.right : undefined}>
                          {c.head}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r, i) => (
                      <tr key={i}>
                        {r.map((cell, ci) => (
                          <td key={ci} className={report.columns[ci]?.align === 'right' ? styles.right : undefined}>
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <dl className={styles.totals}>
              {report.totals.map((t) => (
                <div key={t.label} className={styles.total}>
                  <dt>{t.label}</dt>
                  <dd>{t.value}</dd>
                </div>
              ))}
            </dl>
            {report.note && <p className={styles.sheetFilters}>{report.note}</p>}
          </div>

          <div data-print-no-print>
            <Button
              variant="secondary"
              fullWidth
              onClick={async () => {
                const how = await shareCsv(`${fileBase}.csv`, reportToCsv(report));
                setNote(how === 'downloaded' ? 'CSV saved to your downloads.' : null);
              }}
            >
              Download CSV (for Excel)
            </Button>
            {note && <p className={styles.note}>{note}</p>}
          </div>

          <DocumentActions
            storeId={store.id}
            doc={reportToRoll(report)}
            pages={() => renderReportPages(report)}
            a4Print
            filename={fileBase}
            title={`${report.title} — ${report.shop}`}
            message={`${report.shop} · ${report.title}\n${report.filters}\n${report.totals
              .map((t) => `${t.label}: ${t.value}`)
              .join('\n')}`}
          />
        </>
      )}
    </PageScaffold>
  );
}

'use client';

import { getSupabase } from '@/lib/supabase/client';
import { productsPager, type Product } from '@/lib/stacks/catalog-stack';
import { fetchAllPages } from '@/lib/export-csv';
import { formatMoney } from '@/lib/format';
import type { ReportDoc } from '@/lib/report-doc';
import {
  debtorsAged,
  priceList,
  salesByDay,
  salesByProduct,
  salesSummary,
  staffActivity,
  storefront,
  takingsByDay,
  takingsByMethod,
  type PriceRow,
} from '@/lib/stacks/report-readers';

/**
 * THE SHOP'S REPORTS — each a question with its filters, answered whole.
 *
 * "all I have counted today, all low, all still in stock, who is owing me, who I owe, a range on
 * the amount owing me, who has paid me and when." Each report here is one of those, loaded from
 * the server with every matching row and turned into a `ReportDoc`, which the Reports page shows
 * line by line (each with a tick box) and draws as A4, a receipt roll, a picture or a CSV.
 *
 * ONE LIST, NOT TWO. The Reports page and the Export page used to keep separate lists — the one
 * with the figures (day by day, by item, by method, by person) printing through the browser, the
 * other with the lists (who owes, payments, counts) as PDF, picture and CSV. A shop asked for "a
 * proper professional reporting tool" (9 Nov); now every report has every way out.
 *
 * EVERY ROW THE QUESTION MATCHES IS ON IT. Which COLUMNS show is the shop's choice (`keepColumns`);
 * which rows is not — a list of debtors with the awkward ones ticked out is not a report. A total
 * names the column it belongs to (`of`) where its label is not that column's head, so it leaves
 * with its column.
 */

export type ReportId =
  | 'days'
  | 'takings_days'
  | 'takings'
  | 'sales'
  | 'sales_unpaid'
  | 'payments'
  | 'money_back'
  | 'items_sold'
  | 'stock_in'
  | 'stock_low'
  | 'stock_out'
  | 'stock_no_price'
  | 'counts'
  | 'prices'
  | 'owes'
  | 'aged'
  | 'owed'
  | 'empties'
  | 'staff';

export type ReportGroup = 'Money' | 'Stock' | 'People' | 'Team';

export interface ReportSpec {
  id: ReportId;
  group: ReportGroup;
  label: string;
  hint: string;
  /** Takes a period — and the one it opens on, where that is not the page's own. */
  period?: true | 'today' | 'all';
  /** Takes an amount range. */
  amount?: boolean;
}

export const REPORT_GROUPS: ReportGroup[] = ['Money', 'Stock', 'People', 'Team'];

export const REPORTS: ReportSpec[] = [
  { id: 'days', group: 'Money', label: 'Day by day', hint: 'Each trading day: receipts, what was billed and what was paid', period: true },
  { id: 'takings_days', group: 'Money', label: 'Money in, by day', hint: 'Cash, transfer and POS for each day', period: true },
  { id: 'takings', group: 'Money', label: 'How you were paid', hint: 'Cash, transfer and POS, side by side', period: true },
  { id: 'sales', group: 'Money', label: 'Every receipt', hint: 'Each sale, paid and unpaid', period: true },
  { id: 'sales_unpaid', group: 'Money', label: 'Unpaid receipts', hint: 'Sales with money still owed', period: 'all' },
  { id: 'payments', group: 'Money', label: 'Payments received', hint: 'Who paid, how much, how and when', period: true },
  { id: 'money_back', group: 'Money', label: 'Money given back', hint: 'Change, refunds and credit returned', period: true },
  { id: 'items_sold', group: 'Stock', label: 'What sold', hint: 'Each item: how much went, what it made and what it cost', period: true },
  { id: 'stock_in', group: 'Stock', label: 'Everything in stock', hint: 'What is on the shelf, and what it is worth' },
  { id: 'stock_low', group: 'Stock', label: 'Running low', hint: 'Items at or under their warning level' },
  { id: 'stock_out', group: 'Stock', label: 'None left', hint: 'Items with nothing on the shelf' },
  { id: 'stock_no_price', group: 'Stock', label: 'No price', hint: 'Items that cannot be sold yet' },
  { id: 'counts', group: 'Stock', label: 'What was counted', hint: 'Every shelf count, who counted, and the difference', period: 'today' },
  { id: 'prices', group: 'Stock', label: 'Price list', hint: 'Every item and price — prints as a poster for the wall' },
  { id: 'owes', group: 'People', label: 'Who owes me', hint: 'With their last sale and last payment', amount: true },
  { id: 'aged', group: 'People', label: 'Oldest debts', hint: 'Everyone owing, longest-owed first' },
  { id: 'owed', group: 'People', label: 'Who I owe', hint: 'Customers in credit', amount: true },
  { id: 'empties', group: 'People', label: 'Who has my containers', hint: 'Crates and bottles still with customers' },
  { id: 'staff', group: 'Team', label: 'Who did what', hint: 'Receipts, deliveries, counts and corrections, per person', period: true },
];

export interface ReportOptions {
  /** The window, already resolved in the shop's own days by the server (`periods.ts`). */
  fromAt: string | null;
  toAt: string | null;
  /** "This month, 1 – 10 Nov 2026" — said on the report. */
  periodLabel: string;
  min: number | null;
  max: number | null;
}

/** A report, and — for the price list — what the wall poster is drawn from. */
export interface LoadedReport {
  doc: ReportDoc;
  poster?: { rows: PriceRow[]; storefront: { code: string | null; isPublic: boolean } };
}

type Say = (productId: string, base: number, baseUnit: string) => string;

/** "29 Sep, 23:48" — a table cell has no room for the year it is almost always in. */
const when = (iso: string) => {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', ...(sameYear ? {} : { year: '2-digit' }), hour: '2-digit', minute: '2-digit', hour12: false,
  });
};

/** A member with no display name is known by their email; the part before the @ is enough. */
const person = (name: string | null | undefined) => (name ?? 'Someone').split('@')[0];

const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/** A shop day ("2026-11-10") as a person says it, with the weekday a shop thinks in. */
const tradingDay = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

const methodName = (m: string) =>
  m === 'pos' ? 'POS' : m === 'transfer' ? 'Transfer' : m === 'cash' ? 'Cash' : m[0].toUpperCase() + m.slice(1);

/*
 * EVERY ROW, NOT THE FIRST THOUSAND. The server caps one answer at 1,000 rows, and "Payments
 * received" for a busy month came back at exactly 1,000 — the rest of the month silently missing,
 * with totals that looked like the month's. Read a page at a time until a short one says the end.
 */
const PAGE = 1000;
async function rpcAll<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getSupabase().rpc(fn, args).range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** What some rows come to: the sum of one figure over the rows kept. */
const sumOf = (values: number[], kept: number[]) => kept.reduce((s, i) => s + (values[i] ?? 0), 0);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function amountWords(o: ReportOptions): string {
  if (o.min !== null && o.max !== null) return `between ${formatMoney(o.min)} and ${formatMoney(o.max)}`;
  if (o.min !== null) return `${formatMoney(o.min)} or more`;
  if (o.max !== null) return `up to ${formatMoney(o.max)}`;
  return 'any amount';
}

/** A doc and its totals, worked out over every row. */
function withTotals(
  doc: Omit<ReportDoc, 'totals'>,
  totalsOf: (all: number[]) => ReportDoc['totals'],
): ReportDoc {
  return { ...doc, totals: totalsOf(doc.rows.map((_, i) => i)) };
}

export async function loadReport(
  id: ReportId,
  storeId: string,
  shop: string,
  o: ReportOptions,
  say: Say,
): Promise<LoadedReport> {
  const supabase = getSupabase();
  const spec = REPORTS.find((r) => r.id === id)!;
  const base = { shop, title: spec.label, generatedAt: new Date() };
  const from = o.fromAt;
  const to = o.toAt;
  const w = { storeId, from, to };

  // ── Money, as figures ─────────────────────────────────────────────────────────
  if (id === 'days') {
    const [days, summary] = await Promise.all([salesByDay(w), salesSummary(w)]);
    const billed = days.map((d) => d.billed);
    const paid = days.map((d) => d.paid);
    const receipts = days.map((d) => d.receipts);
    return {
      doc: withTotals(
        {
          ...base,
          filters: `${o.periodLabel} · ${count(days.length, 'trading day', 'trading days')}`,
          columns: [
            { head: 'Day', weight: 2 },
            { head: 'Receipts', weight: 1.2, align: 'right' },
            { head: 'Billed', weight: 1.6, align: 'right' },
            { head: 'Paid', weight: 1.6, align: 'right' },
          ],
          rows: days.map((d) => [tradingDay(d.day), String(d.receipts), formatMoney(d.billed), formatMoney(d.paid)]),
          /*
           * CANCELLED AND CORRECTED ARE ON THE FACE OF IT, not buried — a month with forty
           * corrections in it is telling somebody something. Said only of the whole period: they
           * are not per day, so a selection of days cannot honestly carry them.
           */
          note:
            summary && (summary.voided > 0 || summary.corrected > 0)
              ? [
                  summary.voided > 0 ? count(summary.voided, 'receipt cancelled', 'receipts cancelled') : null,
                  summary.corrected > 0 ? count(summary.corrected, 'receipt corrected afterwards', 'receipts corrected afterwards') : null,
                ]
                  .filter(Boolean)
                  .join(' · ') + ' in this period.'
              : undefined,
        },
        (kept) => {
          const all = kept.length === days.length;
          const b = sumOf(billed, kept);
          const p = sumOf(paid, kept);
          // The headline last — the page says the last figure loudest.
          return [
            { label: 'Receipts', value: String(sumOf(receipts, kept)) },
            ...(all && summary ? [{ label: 'Customers served', value: String(summary.customers) }] : []),
            { label: 'Paid', value: formatMoney(p) },
            { label: 'Still owed', value: formatMoney(all && summary ? summary.owing : Math.max(0, b - p)) },
            { label: 'Billed', value: formatMoney(b) },
          ];
        },
      ),
    };
  }

  if (id === 'takings_days') {
    const days = await takingsByDay(w);
    const col = (k: 'cash' | 'transfer' | 'pos' | 'other' | 'total') => days.map((d) => d[k]);
    const hasOther = days.some((d) => d.other !== 0);
    return {
      doc: withTotals(
        {
          ...base,
          filters: `${o.periodLabel} · ${count(days.length, 'day', 'days')} · net of change given back`,
          columns: [
            { head: 'Day', weight: 1.8 },
            { head: 'Cash', weight: 1.4, align: 'right' },
            { head: 'Transfer', weight: 1.4, align: 'right' },
            { head: 'POS', weight: 1.4, align: 'right' },
            ...(hasOther ? [{ head: 'Other', weight: 1.2, align: 'right' as const }] : []),
            { head: 'Total', weight: 1.5, align: 'right' },
          ],
          rows: days.map((d) => [
            tradingDay(d.day),
            formatMoney(d.cash),
            formatMoney(d.transfer),
            formatMoney(d.pos),
            ...(hasOther ? [formatMoney(d.other)] : []),
            formatMoney(d.total),
          ]),
        },
        (kept) => [
          { label: 'Cash', value: formatMoney(sumOf(col('cash'), kept)) },
          { label: 'Transfer', value: formatMoney(sumOf(col('transfer'), kept)) },
          { label: 'POS', value: formatMoney(sumOf(col('pos'), kept)) },
          ...(hasOther ? [{ label: 'Other', value: formatMoney(sumOf(col('other'), kept)) }] : []),
          { label: 'Came in', value: formatMoney(sumOf(col('total'), kept)), of: 'Total' },
        ],
      ),
    };
  }

  if (id === 'takings') {
    const rows = await takingsByMethod(w);
    const amounts = rows.map((r) => r.amount);
    const payments = rows.map((r) => r.payments);
    return {
      doc: withTotals(
        {
          ...base,
          filters: o.periodLabel,
          columns: [
            { head: 'How', weight: 2 },
            { head: 'Payments', weight: 1.2, align: 'right' },
            { head: 'Amount', weight: 1.6, align: 'right' },
          ],
          rows: rows.map((r) => [methodName(r.method), String(r.payments), formatMoney(r.amount)]),
        },
        (kept) => [
          { label: 'Payments', value: String(sumOf(payments, kept)) },
          { label: 'Came in', value: formatMoney(sumOf(amounts, kept)), of: 'Amount' },
        ],
      ),
    };
  }

  // ── Stock ──────────────────────────────────────────────────────────────────────
  if (id === 'items_sold') {
    const rows = await salesByProduct(w);
    const revenue = rows.map((r) => r.revenue);
    const cost = rows.map((r) => r.cost);
    const margin = rows.map((r) => r.margin);
    return {
      doc: withTotals(
        {
          ...base,
          filters: `${o.periodLabel} · ${count(rows.length, 'item', 'items')}`,
          columns: [
            { head: 'Item', weight: 2.8 },
            { head: 'Sold', weight: 2.2 },
            { head: 'Made', weight: 1.5, align: 'right' },
            { head: 'Cost', weight: 1.4, align: 'right' },
            { head: 'Margin', weight: 1.4, align: 'right' },
          ],
          // In the item's own shapes — "12 crates 4 bottles", not "148".
          rows: rows.map((r) => [
            r.productName,
            say(r.productId, r.soldBase, ''),
            formatMoney(r.revenue),
            formatMoney(r.cost),
            formatMoney(r.margin),
          ]),
        },
        (kept) => [
          { label: 'Made', value: formatMoney(sumOf(revenue, kept)) },
          { label: 'Cost', value: formatMoney(sumOf(cost, kept)) },
          { label: 'Margin', value: formatMoney(sumOf(margin, kept)) },
        ],
      ),
    };
  }

  if (id === 'stock_in' || id === 'stock_low' || id === 'stock_out' || id === 'stock_no_price') {
    const filter = id === 'stock_in' ? 'in_stock' : id === 'stock_low' ? 'low' : id === 'stock_out' ? 'out' : 'no_price';
    const rows = await fetchAllPages<Product>(productsPager(storeId, filter));
    const worth = rows.map((p) => Math.max(0, Number(p.onHand)) * (Number(p.avgUnitCost) || 0));
    return {
      doc: withTotals(
        {
          ...base,
          filters: `${count(rows.length, 'item', 'items')} · stock as it stands now`,
          columns:
            id === 'stock_low'
              ? [{ head: 'Item', weight: 3 }, { head: 'Group', weight: 1.6 }, { head: 'On the shelf', weight: 2.2 }, { head: 'Warns at', weight: 1.8, align: 'right' }]
              : [{ head: 'Item', weight: 3 }, { head: 'Group', weight: 1.6 }, { head: 'On the shelf', weight: 2.2 }, { head: 'Worth', weight: 1.4, align: 'right' }],
          // On the shelf in the item's own shapes: "300 packs 10 pieces", never "3,610 pieces".
          rows: rows.map((p, i) => [
            p.name,
            p.categoryName ?? '',
            say(p.id, Number(p.onHand), p.baseUnit),
            id === 'stock_low'
              ? p.lowStockLevel !== null ? say(p.id, Number(p.lowStockLevel), p.baseUnit) : ''
              : formatMoney(worth[i]),
          ]),
          note: id === 'stock_no_price' ? 'These cannot be sold until they have a price.' : undefined,
        },
        (kept) => [
          { label: 'Items', value: String(kept.length) },
          ...(id === 'stock_low' ? [] : [{ label: 'Worth at cost', value: formatMoney(sumOf(worth, kept)), of: 'Worth' }]),
        ],
      ),
    };
  }

  if (id === 'counts') {
    const rows = await rpcAll<{
      product_id: string; product: string; base_unit: string; counted_at: string; counted_by: string;
      expected: string; counted: string; difference: string;
    }>('report_counts', { p_store_id: storeId, p_from: from, p_to: to });
    const off = rows.map((r) => (Math.abs(Number(r.difference)) > 1e-9 ? 1 : 0));
    return {
      doc: withTotals(
        {
          ...base,
          filters: `${o.periodLabel} · ${count(rows.length, 'count', 'counts')}`,
          columns: [
            { head: 'Item', weight: 2.8 },
            { head: 'When · who', weight: 2.2 },
            { head: 'Expected', weight: 1.8 },
            { head: 'Counted', weight: 1.8 },
            { head: 'Difference', weight: 1.6, align: 'right' },
          ],
          rows: rows.map((r) => {
            const diff = Number(r.difference);
            return [
              r.product,
              `${when(r.counted_at)} · ${person(r.counted_by)}`,
              say(r.product_id, Number(r.expected), r.base_unit),
              say(r.product_id, Number(r.counted), r.base_unit),
              Math.abs(diff) < 1e-9 ? 'agrees' : `${diff > 0 ? '+' : '−'}${say(r.product_id, Math.abs(diff), r.base_unit)}`,
            ];
          }),
        },
        (kept) => [
          { label: 'Counted', value: String(kept.length) },
          { label: 'With a difference', value: String(sumOf(off, kept)), of: 'Difference' },
        ],
      ),
    };
  }

  if (id === 'prices') {
    const [rows, front] = await Promise.all([priceList(storeId), storefront(storeId)]);
    return {
      doc: withTotals(
        {
          ...base,
          filters: `${count(rows.length, 'price', 'prices')} · as they stand now`,
          columns: [
            { head: 'Item', weight: 3 },
            { head: 'Group', weight: 1.8 },
            { head: 'Sold in', weight: 1.6 },
            { head: 'Price', weight: 1.4, align: 'right' },
          ],
          rows: rows.map((r) => [
            r.productName,
            r.groupName,
            r.baseQty > 1 ? `${r.unitName.toLowerCase()} of ${r.baseQty}` : r.unitName.toLowerCase(),
            formatMoney(r.price),
          ]),
        },
        (kept) => [{ label: 'Prices', value: String(kept.length) }],
      ),
      poster: { rows, storefront: front },
    };
  }

  // ── People ─────────────────────────────────────────────────────────────────────
  if (id === 'owes' || id === 'owed') {
    const rows = await rpcAll<{
      name: string; business: string | null; phone: string; balance: string;
      last_sale_at: string | null; last_payment_at: string | null;
    }>('report_balances', { p_store_id: storeId, p_side: id, p_min: o.min, p_max: o.max });
    const balances = rows.map((r) => Math.abs(Number(r.balance)));
    return {
      doc: withTotals(
        {
          ...base,
          filters: `${id === 'owes' ? 'Owing you' : 'You owe them'} ${amountWords(o)} · as it stands now`,
          columns: [
            { head: 'Customer', weight: 2.6 },
            { head: 'Phone', weight: 1.8 },
            { head: 'Last sale', weight: 1.5 },
            { head: 'Last paid', weight: 1.5 },
            { head: id === 'owes' ? 'Owes you' : 'You owe', weight: 1.6, align: 'right' },
          ],
          rows: rows.map((r, i) => [
            r.business ? `${r.name} (${r.business})` : r.name,
            r.phone,
            day(r.last_sale_at),
            day(r.last_payment_at),
            formatMoney(balances[i]),
          ]),
        },
        (kept) => [
          { label: 'Customers', value: String(kept.length) },
          { label: id === 'owes' ? 'Owed to you' : 'You owe', value: formatMoney(sumOf(balances, kept)), of: id === 'owes' ? 'Owes you' : 'You owe' },
        ],
      ),
    };
  }

  if (id === 'aged') {
    /*
     * OLDEST FIRST, because that is what this one is FOR: "who owes most" is the list above; a shop
     * chasing debt needs "who has owed longest", and the age is what turns a list into a decision.
     */
    const rows = (await debtorsAged(storeId)).sort((a, b) => (b.daysOld ?? -1) - (a.daysOld ?? -1));
    const balances = rows.map((r) => r.balance);
    return {
      doc: withTotals(
        {
          ...base,
          filters: `${count(rows.length, 'customer', 'customers')} owing · as it stands now`,
          columns: [
            { head: 'Customer', weight: 2.6 },
            { head: 'Phone', weight: 1.7 },
            { head: 'Owing since', weight: 1.7 },
            { head: 'Age', weight: 1.5 },
            { head: 'Owes', weight: 1.5, align: 'right' },
          ],
          rows: rows.map((r) => [
            r.customerName,
            r.phone ?? '',
            day(r.oldestAt),
            r.daysOld != null ? count(r.daysOld, 'day', 'days') : r.bucket,
            formatMoney(r.balance),
          ]),
        },
        (kept) => {
          const over60 = rows.map((r) => ((r.daysOld ?? 0) > 60 ? r.balance : 0));
          return [
            { label: 'Customers', value: String(kept.length) },
            { label: 'Over 60 days', value: formatMoney(sumOf(over60, kept)), of: 'Owes' },
            { label: 'Owed to you', value: formatMoney(sumOf(balances, kept)), of: 'Owes' },
          ];
        },
      ),
    };
  }

  if (id === 'empties') {
    const rows = await rpcAll<{ customer: string; phone: string; product: string; shape: string; shape_plural: string; maker: string | null; owed: string }>(
      'report_empties_holders',
      { p_store_id: storeId },
    );
    return {
      doc: withTotals(
        {
          ...base,
          filters: `${count(new Set(rows.map((r) => r.customer)).size, 'customer', 'customers')} · as it stands now`,
          columns: [
            { head: 'Customer', weight: 2.2 },
            { head: 'Phone', weight: 1.6 },
            { head: 'Item', weight: 2.8 },
            { head: 'Holding', weight: 1.6, align: 'right' },
          ],
          rows: rows.map((r) => {
            const n = Number(r.owed);
            const whole = Math.floor(n + 1e-9);
            const part = n - whole;
            const said = `${whole > 0 ? whole : ''}${part > 0.4 && part < 0.6 ? '½' : part > 0.2 && part < 0.3 ? '¼' : part > 0.7 && part < 0.8 ? '¾' : ''}`;
            return [r.customer, r.phone, r.maker ? `${r.product} · ${r.maker}` : r.product, `${said || n} ${(n === 1 ? r.shape : r.shape_plural).toLowerCase()}`];
          }),
        },
        (kept) => [{ label: 'Customers holding', value: String(new Set(kept.map((i) => rows[i].customer)).size) }],
      ),
    };
  }

  // ── Team ───────────────────────────────────────────────────────────────────────
  if (id === 'staff') {
    const rows = await staffActivity(w);
    const sold = rows.map((r) => r.sold);
    const receipts = rows.map((r) => r.receipts);
    return {
      doc: withTotals(
        {
          ...base,
          filters: `${o.periodLabel} · ${count(rows.length, 'person', 'people')}`,
          columns: [
            { head: 'Who', weight: 2 },
            { head: 'Receipts', weight: 1.1, align: 'right' },
            { head: 'Sold', weight: 1.6, align: 'right' },
            { head: 'Deliveries', weight: 1.2, align: 'right' },
            { head: 'Counts', weight: 1, align: 'right' },
            { head: 'Corrections', weight: 1.3, align: 'right' },
          ],
          rows: rows.map((r) => [
            r.who,
            String(r.receipts),
            formatMoney(r.sold),
            String(r.deliveries),
            String(r.counts),
            String(r.corrections),
          ]),
        },
        (kept) => [
          { label: 'Receipts', value: String(sumOf(receipts, kept)) },
          { label: 'Sold', value: formatMoney(sumOf(sold, kept)) },
        ],
      ),
    };
  }

  // ── Money, as lists ─────────────────────────────────────────────────────────────
  if (id === 'payments' || id === 'money_back') {
    const rows = await rpcAll<{
      occurred_at: string; customer: string; phone: string | null; amount: string; method: string;
      reference: string | null; recorded_by: string;
    }>('report_payments', { p_store_id: storeId, p_from: from, p_to: to, p_direction: id === 'payments' ? 'in' : 'out' });
    const amounts = rows.map((r) => Number(r.amount));
    const methods = [...new Set(rows.map((r) => r.method))];
    return {
      doc: withTotals(
        {
          ...base,
          filters: `${o.periodLabel} · ${count(rows.length, 'payment', 'payments')}`,
          columns: [
            { head: 'When', weight: 1.9 },
            { head: 'Customer', weight: 2.3 },
            { head: 'How', weight: 1.9 },
            { head: 'Recorded by', weight: 1.7 },
            { head: 'Amount', weight: 1.5, align: 'right' },
          ],
          rows: rows.map((r) => [
            when(r.occurred_at),
            r.customer,
            r.reference ? `${methodName(r.method)} · ${r.reference}` : methodName(r.method),
            person(r.recorded_by),
            formatMoney(r.amount),
          ]),
        },
        (kept) => [
          ...methods.map((m) => ({
            label: `By ${methodName(m).toLowerCase()}`,
            value: formatMoney(sumOf(rows.map((r) => (r.method === m ? Number(r.amount) : 0)), kept)),
            of: 'Amount',
          })),
          { label: id === 'payments' ? 'Received' : 'Given back', value: formatMoney(sumOf(amounts, kept)), of: 'Amount' },
        ],
      ),
    };
  }

  // Receipts.
  const unpaidOnly = id === 'sales_unpaid';
  const pager = async (cursor: unknown | null, limit: number) => {
    const c = cursor as { at: string; id: string } | null;
    const { data, error } = await supabase.rpc('list_sales', {
      p_store_id: storeId,
      p_query: null,
      p_after_at: c?.at ?? null,
      p_after_id: c?.id ?? null,
      p_limit: limit,
      p_filter: unpaidOnly ? 'unpaid' : null,
      p_from: from,
      p_to: to,
    });
    if (error) throw error;
    const rows = (data ?? []) as {
      id: string; occurred_at: string; total: string; paid: string; outstanding: string;
      customer_name: string | null; line_count: number;
    }[];
    const last = rows[rows.length - 1];
    return { rows, cursor: last ? { at: last.occurred_at, id: last.id } : null };
  };
  const rows = await fetchAllPages(pager);
  const col = (k: 'total' | 'paid' | 'outstanding') => rows.map((r) => Number(r[k]));
  return {
    doc: withTotals(
      {
        ...base,
        filters: `${o.periodLabel} · ${count(rows.length, 'receipt', 'receipts')}`,
        columns: [
          { head: 'When', weight: 1.9 },
          { head: 'Customer', weight: 2.2 },
          { head: 'Total', weight: 1.4, align: 'right' },
          { head: 'Paid', weight: 1.4, align: 'right' },
          { head: 'Still owed', weight: 1.4, align: 'right' },
        ],
        rows: rows.map((r) => [
          when(r.occurred_at),
          `${r.customer_name ?? 'Walk-in'} · #${r.id.slice(0, 8).toUpperCase()}`,
          formatMoney(r.total),
          formatMoney(r.paid),
          formatMoney(r.outstanding),
        ]),
      },
      (kept) => [
        { label: 'Receipts', value: String(kept.length) },
        ...(unpaidOnly
          ? [
              { label: 'Billed', value: formatMoney(sumOf(col('total'), kept)), of: 'Total' },
              { label: 'Paid', value: formatMoney(sumOf(col('paid'), kept)) },
              { label: 'Still owed', value: formatMoney(sumOf(col('outstanding'), kept)) },
            ]
          : [
              { label: 'Paid', value: formatMoney(sumOf(col('paid'), kept)) },
              { label: 'Still owed', value: formatMoney(sumOf(col('outstanding'), kept)) },
              { label: 'Sales', value: formatMoney(sumOf(col('total'), kept)), of: 'Total' },
            ]),
      ],
    ),
  };
}

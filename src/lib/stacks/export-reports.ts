'use client';

import { getSupabase } from '@/lib/supabase/client';
import { productsPager, type Product } from '@/lib/stacks/catalog-stack';
import { fetchAllPages } from '@/lib/export-csv';
import { formatMoney } from '@/lib/format';
import type { ReportDoc } from '@/lib/report-doc';

/**
 * THE REPORTS A SHOP CAN TAKE AWAY — each a question with its filters, answered whole.
 *
 * "all I have counted today, all low, all still in stock, who is owing me, who I owe, a range on
 * the amount owing me, who has paid me and when." Each report here is one of those, loaded from
 * the server with every matching row and turned into a `ReportDoc`, which the export page draws as
 * A4, a receipt roll, a picture or a CSV.
 */

export type ReportId =
  | 'stock_in'
  | 'stock_low'
  | 'stock_out'
  | 'stock_no_price'
  | 'counts'
  | 'owes'
  | 'owed'
  | 'empties'
  | 'payments'
  | 'money_back'
  | 'sales'
  | 'sales_unpaid';

export interface ReportSpec {
  id: ReportId;
  group: 'Stock' | 'People' | 'Money';
  label: string;
  hint: string;
  /** Takes a period (and which one it opens on). */
  period?: 'today' | 'month' | 'all';
  /** Takes an amount range. */
  amount?: boolean;
}

export const REPORTS: ReportSpec[] = [
  { id: 'stock_in', group: 'Stock', label: 'Everything in stock', hint: 'What is on the shelf, and what it is worth' },
  { id: 'stock_low', group: 'Stock', label: 'Running low', hint: 'Items at or under their warning level' },
  { id: 'stock_out', group: 'Stock', label: 'None left', hint: 'Items with nothing on the shelf' },
  { id: 'stock_no_price', group: 'Stock', label: 'No price', hint: 'Items that cannot be sold yet' },
  { id: 'counts', group: 'Stock', label: 'What was counted', hint: 'Every shelf count, who counted, and the difference', period: 'today' },
  { id: 'owes', group: 'People', label: 'Who owes me', hint: 'With their last sale and last payment', amount: true },
  { id: 'owed', group: 'People', label: 'Who I owe', hint: 'Customers in credit', amount: true },
  { id: 'empties', group: 'People', label: 'Who has my containers', hint: 'Crates and bottles still with customers' },
  { id: 'payments', group: 'Money', label: 'Payments received', hint: 'Who paid, how much, how and when', period: 'month' },
  { id: 'money_back', group: 'Money', label: 'Money given back', hint: 'Change, refunds and credit returned', period: 'month' },
  { id: 'sales', group: 'Money', label: 'Sales', hint: 'Every receipt, paid and unpaid', period: 'month' },
  { id: 'sales_unpaid', group: 'Money', label: 'Unpaid sales', hint: 'Receipts with money still owed', period: 'all' },
];

export interface ReportOptions {
  from: Date | null;
  to: Date | null;
  /** "Today, 29 Sep 2026" — said on the report. */
  periodLabel: string;
  min: number | null;
  max: number | null;
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

function amountWords(o: ReportOptions): string {
  if (o.min !== null && o.max !== null) return `between ${formatMoney(o.min)} and ${formatMoney(o.max)}`;
  if (o.min !== null) return `${formatMoney(o.min)} or more`;
  if (o.max !== null) return `up to ${formatMoney(o.max)}`;
  return 'any amount';
}

export async function loadReport(
  id: ReportId,
  storeId: string,
  shop: string,
  o: ReportOptions,
  say: Say,
): Promise<ReportDoc> {
  const supabase = getSupabase();
  const spec = REPORTS.find((r) => r.id === id)!;
  const base = { shop, title: spec.label, generatedAt: new Date() };
  const from = o.from?.toISOString() ?? null;
  const to = o.to?.toISOString() ?? null;

  // ── Stock ──────────────────────────────────────────────────────────────────────
  if (id === 'stock_in' || id === 'stock_low' || id === 'stock_out' || id === 'stock_no_price') {
    const filter = id === 'stock_in' ? 'in_stock' : id === 'stock_low' ? 'low' : id === 'stock_out' ? 'out' : 'no_price';
    const rows = await fetchAllPages<Product>(productsPager(storeId, filter));
    const worth = (p: Product) => Math.max(0, Number(p.onHand)) * (Number(p.avgUnitCost) || 0);
    const total = rows.reduce((s, p) => s + worth(p), 0);
    return {
      ...base,
      filters: `${rows.length} ${rows.length === 1 ? 'item' : 'items'} · stock as it stands now`,
      columns:
        id === 'stock_low'
          ? [{ head: 'Item', weight: 3 }, { head: 'Group', weight: 1.6 }, { head: 'On the shelf', weight: 2 }, { head: 'Warns at', weight: 1.6, align: 'right' }]
          : [{ head: 'Item', weight: 3 }, { head: 'Group', weight: 1.6 }, { head: 'On the shelf', weight: 2 }, { head: 'Worth', weight: 1.4, align: 'right' }],
      rows: rows.map((p) => [
        p.name,
        p.categoryName ?? '',
        say(p.id, Number(p.onHand), p.baseUnit),
        id === 'stock_low'
          ? p.lowStockLevel !== null ? say(p.id, Number(p.lowStockLevel), p.baseUnit) : ''
          : formatMoney(worth(p)),
      ]),
      totals: [
        { label: 'Items', value: String(rows.length) },
        ...(id === 'stock_low' ? [] : [{ label: 'Worth at cost', value: formatMoney(total) }]),
      ],
      note: id === 'stock_no_price' ? 'These cannot be sold until they have a price.' : undefined,
    };
  }

  if (id === 'counts') {
    const { data, error } = await supabase.rpc('report_counts', { p_store_id: storeId, p_from: from, p_to: to });
    if (error) throw error;
    const rows = (data ?? []) as {
      product_id: string; product: string; base_unit: string; counted_at: string; counted_by: string;
      expected: string; counted: string; difference: string;
    }[];
    const off = rows.filter((r) => Math.abs(Number(r.difference)) > 1e-9).length;
    return {
      ...base,
      filters: `${o.periodLabel} · ${rows.length} ${rows.length === 1 ? 'count' : 'counts'}`,
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
      totals: [
        { label: 'Counted', value: String(rows.length) },
        { label: 'With a difference', value: String(off) },
      ],
    };
  }

  // ── People ─────────────────────────────────────────────────────────────────────
  if (id === 'owes' || id === 'owed') {
    const { data, error } = await supabase.rpc('report_balances', {
      p_store_id: storeId,
      p_side: id,
      p_min: o.min,
      p_max: o.max,
    });
    if (error) throw error;
    const rows = (data ?? []) as {
      name: string; business: string | null; phone: string; balance: string;
      last_sale_at: string | null; last_payment_at: string | null;
    }[];
    const total = rows.reduce((s, r) => s + Math.abs(Number(r.balance)), 0);
    return {
      ...base,
      filters: `${id === 'owes' ? 'Owing you' : 'You owe them'} ${amountWords(o)} · as it stands now`,
      columns: [
        { head: 'Customer', weight: 2.6 },
        { head: 'Phone', weight: 1.8 },
        { head: 'Last sale', weight: 1.5 },
        { head: 'Last paid', weight: 1.5 },
        { head: id === 'owes' ? 'Owes you' : 'You owe', weight: 1.6, align: 'right' },
      ],
      rows: rows.map((r) => [
        r.business ? `${r.name} (${r.business})` : r.name,
        r.phone,
        day(r.last_sale_at),
        day(r.last_payment_at),
        formatMoney(Math.abs(Number(r.balance))),
      ]),
      totals: [
        { label: 'Customers', value: String(rows.length) },
        { label: id === 'owes' ? 'Owed to you' : 'You owe', value: formatMoney(total) },
      ],
    };
  }

  if (id === 'empties') {
    const { data, error } = await supabase.rpc('report_empties_holders', { p_store_id: storeId });
    if (error) throw error;
    const rows = (data ?? []) as { customer: string; phone: string; product: string; shape: string; shape_plural: string; maker: string | null; owed: string }[];
    const people = new Set(rows.map((r) => r.customer)).size;
    return {
      ...base,
      filters: `${people} ${people === 1 ? 'customer' : 'customers'} · as it stands now`,
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
      totals: [{ label: 'Customers holding', value: String(people) }],
    };
  }

  // ── Money ──────────────────────────────────────────────────────────────────────
  if (id === 'payments' || id === 'money_back') {
    const { data, error } = await supabase.rpc('report_payments', {
      p_store_id: storeId,
      p_from: from,
      p_to: to,
      p_direction: id === 'payments' ? 'in' : 'out',
    });
    if (error) throw error;
    const rows = (data ?? []) as {
      occurred_at: string; customer: string; phone: string | null; amount: string; method: string;
      reference: string | null; recorded_by: string;
    }[];
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    const byMethod = new Map<string, number>();
    for (const r of rows) byMethod.set(r.method, (byMethod.get(r.method) ?? 0) + Number(r.amount));
    return {
      ...base,
      filters: `${o.periodLabel} · ${rows.length} ${rows.length === 1 ? 'payment' : 'payments'}`,
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
        r.reference ? `${r.method} · ${r.reference}` : r.method,
        person(r.recorded_by),
        formatMoney(r.amount),
      ]),
      totals: [
        ...[...byMethod.entries()].map(([m, v]) => ({ label: `By ${m}`, value: formatMoney(v) })),
        { label: id === 'payments' ? 'Received' : 'Given back', value: formatMoney(total) },
      ],
    };
  }

  // Sales.
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
  const sum = (k: 'total' | 'paid' | 'outstanding') => rows.reduce((s, r) => s + Number(r[k]), 0);
  return {
    ...base,
    filters: `${o.periodLabel} · ${rows.length} ${rows.length === 1 ? 'receipt' : 'receipts'}`,
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
    totals: [
      { label: 'Sales', value: formatMoney(sum('total')) },
      { label: 'Paid', value: formatMoney(sum('paid')) },
      { label: 'Still owed', value: formatMoney(sum('outstanding')) },
    ],
  };
}

'use client';

import { getSupabase } from '@/lib/supabase/client';

/**
 * The three questions a shop owner asks at the end of a day, a week, or a month.
 *
 *   WHAT IS ON THE SHELF   and what it cost
 *   WHO OWES ME            and how much
 *   WHAT DID I SELL        over a period
 *
 * Each is answered from the same RPCs the screens already use, not from a second set written for
 * printing. A report that computes its own totals is a second opinion about the same facts, and
 * the day the two disagree nobody can tell which is right.
 *
 * Everything comes back already ordered and totalled here rather than in the component, so the
 * printed page and the screen cannot drift apart either.
 */

export interface StockLine {
  name: string;
  category: string | null;
  onHand: string;
  unit: string;
  unitCost: string;
  value: number;
  estimated: boolean;
}

export interface StockReport {
  lines: StockLine[];
  total: number;
  estimatedCount: number;
}

export async function stockReport(storeId: string): Promise<StockReport> {
  // One large page rather than the screen's cursor paging: a report is a whole answer or it is
  // misleading, and "the first thirty products" is not a valuation.
  const { data, error } = await getSupabase().rpc('list_products', {
    p_store_id: storeId,
    p_after_name: null,
    p_after_id: null,
    p_limit: 1000,
  });
  if (error) throw error;

  const lines: StockLine[] = ((data ?? []) as Record<string, string & boolean>[]).map((r) => ({
    name: String(r.name),
    category: (r.category_name as string | null) ?? null,
    onHand: String(r.on_hand),
    unit: String(r.base_unit),
    unitCost: String(r.avg_unit_cost),
    value: Number(r.on_hand) * Number(r.avg_unit_cost),
    estimated: Boolean(r.cost_is_estimated),
  }));

  return {
    lines,
    total: lines.reduce((s, l) => s + l.value, 0),
    estimatedCount: lines.filter((l) => l.estimated).length,
  };
}

export interface DebtorLine {
  name: string;
  phone: string;
  balance: number;
}

export interface DebtorReport {
  lines: DebtorLine[];
  total: number;
}

export async function debtorReport(storeId: string): Promise<DebtorReport> {
  const { data, error } = await getSupabase().rpc('list_customers', {
    p_store_id: storeId,
    p_query: null,
    p_after_name: null,
    p_after_id: null,
    p_limit: 1000,
  });
  if (error) throw error;

  const lines: DebtorLine[] = ((data ?? []) as Record<string, string>[])
    .map((r) => ({
      name: String(r.display_name),
      phone: String(r.phone),
      balance: Number(r.balance),
    }))
    // Only people who actually owe something. A debtors report listing everyone who has ever
    // bought, most of them at zero, is a list nobody reads to the end of.
    .filter((l) => l.balance > 0)
    .sort((a, b) => b.balance - a.balance);

  return { lines, total: lines.reduce((s, l) => s + l.balance, 0) };
}

export interface SalesLine {
  when: string;
  customer: string;
  items: number;
  total: number;
  outstanding: number;
}

export interface SalesReport {
  lines: SalesLine[];
  total: number;
  outstanding: number;
}

export async function salesReport(storeId: string, days: number): Promise<SalesReport> {
  const { data, error } = await getSupabase().rpc('list_sales', {
    p_store_id: storeId,
    p_query: null,
    p_after_at: null,
    p_after_id: null,
    p_limit: 1000,
  });
  if (error) throw error;

  // Cut-off applied here rather than in SQL: `list_sales` has no date argument, and adding one
  // would mean a second overload of a function three screens already call.
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const lines: SalesLine[] = ((data ?? []) as Record<string, string>[])
    .filter((r) => new Date(String(r.occurred_at)).getTime() >= since)
    .map((r) => ({
      when: String(r.occurred_at),
      customer: (r.customer_name as string | null) ?? 'Walk-in customer',
      items: Number(r.line_count),
      total: Number(r.total),
      outstanding: Number(r.outstanding),
    }));

  return {
    lines,
    total: lines.reduce((s, l) => s + l.total, 0),
    outstanding: lines.reduce((s, l) => s + l.outstanding, 0),
  };
}

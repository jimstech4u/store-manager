'use client';

import { getSupabase } from '@/lib/supabase/client';

/**
 * The reports, each windowed on the server.
 *
 * WHY NOT IN THE BROWSER: the old sales report asked for `p_limit: 1000` and filtered to thirty
 * days in JavaScript. PostgREST caps a response at 1,000 rows regardless of what is asked for, so a
 * shop with more than a thousand receipts got a report quietly missing the rest — no error, no
 * empty result, just a window that silently stopped covering the thing being looked for. In a list
 * that is annoying; in a document somebody files and acts on it is a wrong answer.
 *
 * Every reader here aggregates in SQL over the whole window and returns what a page can print.
 */

const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T[]> => {
  const { data, error } = await getSupabase().rpc(fn, args);
  if (error) throw error;
  return (Array.isArray(data) ? data : data ? [data] : []) as T[];
};

export interface SalesSummary {
  receipts: number;
  billed: number;
  paid: number;
  owing: number;
  voided: number;
  corrected: number;
  customers: number;
  busiestDay: string | null;
}

export async function salesSummary(args: {
  storeId: string;
  from: string | null;
  to: string | null;
  staff?: string | null;
  customer?: string | null;
}): Promise<SalesSummary | null> {
  const rows = await rpc<Record<string, unknown>>('sales_summary', {
    p_store_id: args.storeId,
    p_from: args.from,
    p_to: args.to,
    p_staff: args.staff ?? null,
    p_customer: args.customer ?? null,
  });
  const r = rows[0];
  if (!r) return null;
  return {
    receipts: Number(r.receipts) || 0,
    billed: Number(r.billed) || 0,
    paid: Number(r.paid) || 0,
    owing: Number(r.owing) || 0,
    voided: Number(r.voided) || 0,
    corrected: Number(r.corrected) || 0,
    customers: Number(r.customers) || 0,
    busiestDay: (r.busiest_day as string | null) ?? null,
  };
}

export interface DayRow {
  day: string;
  receipts: number;
  billed: number;
  paid: number;
}

export async function salesByDay(args: {
  storeId: string;
  from: string | null;
  to: string | null;
  staff?: string | null;
}): Promise<DayRow[]> {
  const rows = await rpc<Record<string, unknown>>('sales_by_day', {
    p_store_id: args.storeId,
    p_from: args.from,
    p_to: args.to,
    p_staff: args.staff ?? null,
  });
  return rows.map((r) => ({
    day: String(r.day),
    receipts: Number(r.receipts) || 0,
    billed: Number(r.billed) || 0,
    paid: Number(r.paid) || 0,
  }));
}

export interface ProductRow {
  productId: string;
  productName: string;
  soldBase: number;
  receipts: number;
  revenue: number;
  cost: number;
  margin: number;
}

export async function salesByProduct(args: {
  storeId: string;
  from: string | null;
  to: string | null;
}): Promise<ProductRow[]> {
  const rows = await rpc<Record<string, unknown>>('sales_by_product', {
    p_store_id: args.storeId,
    p_from: args.from,
    p_to: args.to,
  });
  return rows.map((r) => ({
    productId: String(r.product_id),
    productName: String(r.product_name ?? ''),
    soldBase: Number(r.sold_base) || 0,
    receipts: Number(r.receipts) || 0,
    revenue: Number(r.revenue) || 0,
    cost: Number(r.cost) || 0,
    margin: Number(r.margin) || 0,
  }));
}

export interface MethodRow {
  method: string;
  payments: number;
  amount: number;
}

export async function takingsByMethod(args: {
  storeId: string;
  from: string | null;
  to: string | null;
}): Promise<MethodRow[]> {
  const rows = await rpc<Record<string, unknown>>('takings_by_method', {
    p_store_id: args.storeId,
    p_from: args.from,
    p_to: args.to,
  });
  return rows.map((r) => ({
    method: String(r.method ?? 'other'),
    payments: Number(r.payments) || 0,
    amount: Number(r.amount) || 0,
  }));
}

export interface AgedRow {
  storeCustomerId: string;
  customerName: string;
  phone: string | null;
  balance: number;
  oldestAt: string | null;
  daysOld: number | null;
  bucket: string;
}

/** Ageing, which is the report an owner asks for by name. */
export async function debtorsAged(storeId: string): Promise<AgedRow[]> {
  const rows = await rpc<Record<string, unknown>>('debtors_aged', { p_store_id: storeId });
  return rows.map((r) => ({
    storeCustomerId: String(r.store_customer_id),
    customerName: String(r.customer_name ?? ''),
    phone: (r.phone as string | null) ?? null,
    balance: Number(r.balance) || 0,
    oldestAt: (r.oldest_at as string | null) ?? null,
    daysOld: r.days_old === null ? null : Number(r.days_old),
    bucket: String(r.bucket ?? ''),
  }));
}

export interface PriceRow {
  groupName: string;
  productId: string;
  productName: string;
  unitName: string;
  unitPlural: string;
  baseQty: number;
  price: number;
}

/**
 * The price list, for the wall.
 *
 * COST AND MARGIN NEVER APPEAR ON IT. A seller printing a list to hang up must not need a
 * permission that also shows them what the shop paid — so the server gates this on `sales.record`
 * rather than on `reports.view`, and returns no cost column at all.
 */
export async function priceList(storeId: string): Promise<PriceRow[]> {
  const rows = await rpc<Record<string, unknown>>('price_list', { p_store_id: storeId });
  return rows.map((r) => ({
    groupName: String(r.group_name ?? 'Everything else'),
    productId: String(r.product_id),
    productName: String(r.product_name ?? ''),
    unitName: String(r.unit_name ?? ''),
    unitPlural: String(r.unit_plural ?? ''),
    baseQty: Number(r.base_qty) || 1,
    price: Number(r.price) || 0,
  }));
}

export interface StaffRow {
  userId: string;
  who: string;
  receipts: number;
  sold: number;
  corrections: number;
  deliveries: number;
  counts: number;
  writeOffs: number;
}

export async function staffActivity(args: {
  storeId: string;
  from: string | null;
  to: string | null;
}): Promise<StaffRow[]> {
  const rows = await rpc<Record<string, unknown>>('staff_activity', {
    p_store_id: args.storeId,
    p_from: args.from,
    p_to: args.to,
    p_user_id: null,
  });
  return rows.map((r) => ({
    userId: String(r.user_id),
    who: String(r.who ?? 'Someone'),
    receipts: Number(r.receipts) || 0,
    sold: Number(r.sold) || 0,
    corrections: Number(r.corrections) || 0,
    deliveries: Number(r.deliveries) || 0,
    counts: Number(r.counts) || 0,
    writeOffs: Number(r.write_offs) || 0,
  }));
}

/**
 * Anything on screen, as a spreadsheet.
 *
 * Money as a plain number with no symbol and no thousands separator, dates as ISO — a spreadsheet
 * has to be able to add the column up, and "₦1,250.00" is text to every one of them.
 */
export function toCsv(columns: { key: string; head: string }[], rows: Record<string, unknown>[]) {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    columns.map((c) => cell(c.head)).join(','),
    ...rows.map((r) => columns.map((c) => cell(r[c.key])).join(',')),
  ].join('\n');
}

/**
 * Hand the file over.
 *
 * A Blob and an object URL rather than a data: URI, because a long price list exceeds what some
 * browsers accept in an href.
 */
export function downloadCsv(filename: string, csv: string) {
  /*
   * A byte-order mark, written as an escape rather than as a literal character.
   *
   * Without it Excel opens a UTF-8 CSV as the system codepage and every ₦ and every accented
   * customer name comes out as mojibake. As a literal it is an invisible character in the source
   * that lint rightly refuses.
   */
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

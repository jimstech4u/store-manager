'use client';

import { getSupabase } from '@/lib/supabase/client';
import { accountsChanged } from '@/lib/stacks/customer-account';
import { stockMoved } from '@/lib/stacks/catalog-stack';

/**
 * Correcting a settled receipt.
 *
 * Not a void and a re-key. The customer is holding a printed copy with a number on it and a
 * tracking link that has to keep resolving, so the sale keeps its id and gains a REVISION — and
 * what it used to say is kept in full, because "what did the copy in their hand say" is asked six
 * weeks later by somebody who was not there.
 *
 * The server reverses and re-applies rather than editing, so every step is an append to a ledger
 * that is append-only by design.
 */

export interface DocumentLine {
  productId: string;
  productName: string;
  saleUnitId: string | null;
  unitName: string | null;
  enteredQty: number;
  baseQty: number;
  unitPrice: number;
  lineTotal: number;
  containersOut: number;
}

export interface SaleDocument {
  saleId: string;
  revision: number;
  status: string;
  total: number;
  feeAmount: number;
  feeLabel: string | null;
  note: string | null;
  occurredAt: string;
  customer: { id: string; name: string } | null;
  lines: DocumentLine[];
}

function toDocument(d: Record<string, unknown>): SaleDocument {
  return {
    saleId: String(d.sale_id),
    revision: Number(d.revision) || 1,
    status: String(d.status ?? 'posted'),
    total: Number(d.total) || 0,
    feeAmount: Number(d.fee_amount) || 0,
    feeLabel: (d.fee_label as string | null) ?? null,
    note: (d.note as string | null) ?? null,
    occurredAt: String(d.occurred_at),
    customer: (d.customer as { id: string; name: string } | null) ?? null,
    lines: ((d.lines ?? []) as Record<string, unknown>[]).map((l) => ({
      productId: String(l.product_id),
      productName: String(l.product_name ?? ''),
      saleUnitId: (l.sale_unit_id as string | null) ?? null,
      unitName: (l.unit_name as string | null) ?? null,
      enteredQty: Number(l.entered_qty) || 0,
      baseQty: Number(l.base_qty) || 0,
      unitPrice: Number(l.unit_price) || 0,
      lineTotal: Number(l.line_total) || 0,
      containersOut: Number(l.containers_out) || 0,
    })),
  };
}

/** What the receipt says right now. */
export async function saleDocument(saleId: string): Promise<SaleDocument | null> {
  const { data, error } = await getSupabase().rpc('sale_document', { p_sale_id: saleId });
  if (error) throw error;
  return data ? toDocument(data as Record<string, unknown>) : null;
}

export interface Revision {
  revision: number;
  document: SaleDocument;
  reason: string;
  amendedAt: string;
  actorName: string | null;
}

/** What it used to say, newest first. */
export async function saleRevisions(saleId: string): Promise<Revision[]> {
  const { data, error } = await getSupabase().rpc('sale_revision_history', { p_sale_id: saleId });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    revision: Number(r.revision) || 1,
    document: toDocument((r.document ?? {}) as Record<string, unknown>),
    reason: String(r.reason ?? ''),
    amendedAt: String(r.amended_at),
    actorName: (r.actor_name as string | null) ?? null,
  }));
}

export interface AmendResult {
  saleId: string;
  revision: number;
  total: number;
  paid: number;
  owing: number;
  customerId: string | null;
}

/**
 * Correct it.
 *
 * `customerId` is how a WALK-IN acquires somebody to owe the difference. A receipt corrected into
 * money owing or containers out with nobody named is refused by the server — there would be nobody
 * to chase and nobody to settle the crates with, so the obligation would sit unrecoverable for
 * ever.
 */
export async function amendSale(args: {
  saleId: string;
  reason: string;
  lines: {
    productId: string;
    saleUnitId: string | null;
    enteredQty: number;
    baseQty: number;
    unitPrice: number;
    lineTotal: number;
    containersOut: number;
  }[];
  customerId?: string | null;
}): Promise<AmendResult> {
  const { data, error } = await getSupabase().rpc('amend_sale', {
    p_sale_id: args.saleId,
    p_reason: args.reason,
    p_lines: args.lines.map((l) => ({
      product_id: l.productId,
      sale_unit_id: l.saleUnitId,
      entered_qty: l.enteredQty,
      base_qty: l.baseQty,
      unit_price: l.unitPrice,
      line_total: l.lineTotal,
      containers_out: l.containersOut,
    })),
    p_customer_id: args.customerId ?? null,
  });
  if (error) throw error;

  /*
   * A correction moves the shelf, the customer's balance and their containers — so say so.
   *
   * The writer is the only thing that knows it happened; every screen guessing on a timer is the
   * arrangement `accountsChanged`/`stockMoved` replaced.
   */
  accountsChanged();
  stockMoved();

  const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
  return {
    saleId: String(r.sale_id),
    revision: Number(r.revision) || 1,
    total: Number(r.total) || 0,
    paid: Number(r.paid) || 0,
    owing: Number(r.owing) || 0,
    customerId: (r.customer_id as string | null) ?? null,
  };
}

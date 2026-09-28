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
  /*
   * THE REST OF WHAT THE RECEIPT SAID (0195).
   *
   * A document stored before that migration has none of these, and they stay UNDEFINED rather
   * than defaulting to empty — "this version did not capture its charges" and "this version had
   * no charges" are different facts, and a screen that renders the second for the first invents
   * a receipt that never existed.
   */
  charges?: { label: string; amount: number }[];
  depositTotal?: number;
  /**
   * What the receipt has already taken.
   *
   * `paymentId` is what lets a correction screen act on one rather than only print it. Without it
   * "Correct payment" could add money and nothing else, so a receipt paid N1,600 in cash that was
   * really a transfer became a receipt paid N3,200 (0205, 0206). It is optional for the same
   * reason the rest of this block is: a document stored before the id was carried does not have
   * one, and a version that cannot be acted on should say so rather than pretend.
   */
  payments?: {
    paymentId: string | null;
    amount: number;
    method: string;
    reference: string | null;
  }[];
  transferDetails?: string | null;
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
    // `undefined` where the key is absent, which is how an older document says "not captured".
    charges: d.charges
      ? ((d.charges ?? []) as Record<string, unknown>[]).map((c) => ({
          label: String(c.label ?? 'Charge'),
          amount: Number(c.amount) || 0,
        }))
      : undefined,
    depositTotal: d.deposit_total == null ? undefined : Number(d.deposit_total) || 0,
    payments: d.payments
      ? ((d.payments ?? []) as Record<string, unknown>[]).map((p) => ({
          paymentId: (p.payment_id as string | null) ?? null,
          amount: Number(p.amount) || 0,
          method: String(p.method ?? 'cash'),
          reference: (p.reference as string | null) ?? null,
        }))
      : undefined,
    transferDetails: (d.transfer_details as string | null) ?? null,
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

/**
 * What a receipt has already been paid, summed from its allocations.
 *
 * `payments` has no `sale_id` — a payment is a sum of money that arrived, and which receipts it
 * settles is a separate fact, because one payment can clear three receipts and one receipt can take
 * four payments. So the answer is in `payment_allocations`, which is what every other reader of
 * "what was this paid" uses.
 */
export async function salePaid(saleId: string): Promise<number> {
  const { data, error } = await getSupabase()
    .from('payment_allocations')
    .select('amount')
    .eq('sale_id', saleId);
  if (error) throw error;
  return ((data ?? []) as { amount: string }[]).reduce((sum, a) => sum + Number(a.amount), 0);
}

/**
 * THE NAMED CHARGES ON A RECEIPT — transport, loading, whatever the shop added.
 *
 * `sale_document` carries `fee_amount` and `fee_label` but not the itemised list, so a correction
 * seeded from it had no charges at all. Two things then went wrong at once: the corrected total
 * left them out, so the screen disagreed with the receipt it was correcting, and saving sent an
 * EMPTY list — which `amend_sale` reads as "there are none" and deletes the lot. A shop correcting
 * a quantity would have silently dropped its own transport charge.
 */
export async function saleCharges(saleId: string): Promise<{ label: string; amount: number }[]> {
  const { data, error } = await getSupabase()
    .from('sale_charges')
    .select('label, amount, sort_order')
    .eq('sale_id', saleId)
    .order('sort_order');
  if (error) throw error;
  return ((data ?? []) as { label: string; amount: string }[]).map((c) => ({
    label: c.label,
    amount: Number(c.amount) || 0,
  }));
}

/**
 * WHAT THE RECEIPT IS HOLDING ON DEPOSIT, summed off its lines.
 *
 * `sale_document` does not carry it, the same way it does not carry the itemised charges — so a
 * correction seeded from that alone believed the sale had no deposit, computed a total lower than
 * the receipt it was correcting, and showed a breakdown missing a line the paper has.
 *
 * Per product, because that is how `sale_lines` keeps it and how `amend_sale` puts it back (0190).
 */
export async function saleDeposits(
  saleId: string,
): Promise<{ productId: string; productName: string; amount: number }[]> {
  const { data, error } = await getSupabase()
    .from('sale_lines')
    .select('product_id, deposit_charged, products(name)')
    .eq('sale_id', saleId)
    .gt('deposit_charged', 0);
  if (error) throw error;
  return ((data ?? []) as unknown as {
    product_id: string;
    deposit_charged: string;
    products: { name: string } | null;
  }[]).map((r) => ({
    productId: r.product_id,
    productName: r.products?.name ?? '',
    amount: Number(r.deposit_charged) || 0,
  }));
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
  /**
   * The correction took everything off, so the receipt was CANCELLED rather than restated (0174).
   *
   * Always present, so a caller reads one shape — and it has to be read: the seller is sent to a
   * cancelled receipt, not to a new revision of a live one.
   */
  voided: boolean;
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
  /**
   * The named additions as the corrected receipt should read them.
   *
   * `undefined` means "leave them alone", which is what every caller that does not edit charges
   * should send. An EMPTY ARRAY means "there are none", which is what a seller means by deleting
   * the last one — the two are different instructions and the server keeps them apart.
   */
  charges?: { label: string; amount: number }[];
  /** Money handed over DURING the correction. Added to what the receipt already took, never replacing it. */
  payments?: {
    amount: number;
    method: string;
    reference: string | null;
    bankAccountId: string | null;
  }[];
  /** A deposit taken now, for containers this correction puts out. */
  deposit?: number | null;
  depositReason?: string | null;
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
    /*
     * `undefined` is sent as null, which the server reads as "unchanged". An empty array survives
     * as an empty array, which it reads as "none" — the distinction the whole charge-editing
     * behaviour rests on.
     */
    p_charges: args.charges ?? null,
    p_payments: (args.payments ?? []).length
      ? (args.payments ?? []).map((p) => ({
          amount: p.amount,
          method: p.method,
          reference: p.reference,
          bank_account_id: p.bankAccountId,
        }))
      : null,
    p_deposit: args.deposit ?? null,
    p_deposit_reason: args.depositReason ?? null,
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
    voided: Boolean(r.voided),
  };
}

/**
 * UNDO A CANCELLATION (0179).
 *
 * The exact inverse of voiding: the stock goes back out, the containers are owed again, the
 * deposit claim is restored and the receipt is posted again — every step an append, so the void
 * stays in the ledger with the reopen after it. Requires `sales.amend` and a reason, and the
 * cancelled document is kept in the revision history.
 *
 * Why it exists: cancelling by mistake is ordinary, and the only way back was to key the whole
 * sale again — a second document with a different number while the customer holds the first.
 */
export async function reopenSale(saleId: string, reason: string): Promise<AmendResult> {
  const { data, error } = await getSupabase().rpc('reopen_sale', {
    p_sale_id: saleId,
    p_reason: reason,
  });
  if (error) throw error;

  // It moves the shelf, the customer's balance and their containers, exactly as a correction does.
  accountsChanged();
  stockMoved();

  const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
  return {
    saleId: String(r.sale_id),
    revision: Number(r.revision) || 1,
    total: Number(r.total) || 0,
    paid: Number(r.paid) || 0,
    owing: Number(r.owing) || 0,
    customerId: null,
    voided: false,
  };
}

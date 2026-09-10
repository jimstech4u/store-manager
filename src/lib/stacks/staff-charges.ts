'use client';

import { getSupabase } from '@/lib/supabase/client';
import { invalidate } from '@/lib/stacks/invalidation';

/**
 * What a staff member owes the shop.
 *
 * Stock that went missing on somebody's watch, or a till that came up short. NOT a customer balance
 * and NEVER counted as takings — money recovered for stolen stock is not a sale, and if it leaked
 * into either the shop's takings would climb every time something went missing.
 *
 * Reached from a count that found a shortfall, and from the staff screen. Nobody is ever required
 * to be named: a form that demands a culprit collects a guess, and a guess in this table is worse
 * than a blank.
 */

export const STAFF_SCOPE = 'staff';

export function staffChargesChanged() {
  invalidate(STAFF_SCOPE);
}

export interface StaffOwing {
  memberUserId: string;
  fullName: string;
  charged: number;
  paid: number;
  writtenOff: number;
  owing: number;
  lastAt: string | null;
}

export async function staffChargesOwed(storeId: string): Promise<StaffOwing[]> {
  const { data, error } = await getSupabase().rpc('staff_charges_owed', { p_store_id: storeId });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    memberUserId: String(r.member_user_id),
    fullName: String(r.full_name ?? 'Someone'),
    charged: Number(r.charged) || 0,
    paid: Number(r.paid) || 0,
    writtenOff: Number(r.written_off) || 0,
    owing: Number(r.owing) || 0,
    lastAt: (r.last_at as string | null) ?? null,
  }));
}

/**
 *   charged     — put on them.
 *   paid        — they have handed it over, or it has come out of wages.
 *   written_off — the shop has decided not to pursue it. A decision, recorded, with a reason.
 */
export type StaffChargeDirection = 'charged' | 'paid' | 'written_off';

export async function recordStaffCharge(args: {
  storeId: string;
  memberUserId: string;
  amount: number;
  direction: StaffChargeDirection;
  reason: string;
}): Promise<void> {
  const { error } = await getSupabase().rpc('record_staff_charge', {
    p_store_id: args.storeId,
    p_member_user_id: args.memberUserId,
    p_amount: args.amount,
    p_direction: args.direction,
    p_reason: args.reason,
  });
  if (error) throw error;
  staffChargesChanged();
}

export interface StaffChargeRow {
  id: string;
  direction: StaffChargeDirection;
  amount: number;
  reason: string;
  occurredAt: string;
}

/** One person's trace — every charge, every repayment, every write-off, newest first. */
export async function staffChargeLedger(
  storeId: string,
  memberUserId: string,
): Promise<StaffChargeRow[]> {
  const { data, error } = await getSupabase()
    .from('staff_charges')
    .select('id, direction, amount, reason, occurred_at')
    .eq('store_id', storeId)
    .eq('member_user_id', memberUserId)
    .order('occurred_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    direction: r.direction as StaffChargeDirection,
    amount: Number(r.amount) || 0,
    reason: String(r.reason ?? ''),
    occurredAt: String(r.occurred_at),
  }));
}

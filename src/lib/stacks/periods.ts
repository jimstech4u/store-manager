'use client';

import { useState } from 'react';
import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';

/**
 * One vocabulary for "when", resolved on the server.
 *
 * TWO reasons it is not worked out in the browser, and both are about being wrong in ways nobody
 * notices:
 *
 *   THE SHOP'S DAY, NOT THE PHONE'S. `stores.timezone` is the shop's own clock. Eight seconds of
 *   skew once put a delivery in the wrong counting period and wrote 147 phantom bottles into stock,
 *   and a till phone is routinely minutes out and not rarely hours. "Today's takings" read at seven
 *   in the morning has to agree with the calendar on the wall.
 *
 *   HALF-OPEN, ALWAYS — `[from, to)`. An inclusive end double-counts the boundary day, and the
 *   boundary day is the one somebody checks against the drawer.
 *
 * The LABEL comes back from the server too, so the screen and the printed document say the same
 * thing and neither reconstructs it.
 */

export type PeriodKind =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'this_year'
  | 'last_year'
  | 'last_7'
  | 'last_30'
  | 'all'
  | 'custom';

export interface Period {
  kind: PeriodKind;
  fromAt: string | null;
  toAt: string | null;
  label: string;
}

/** What the chips offer, in the order a shop reaches for them. */
export const QUICK_PERIODS: { kind: PeriodKind; label: string }[] = [
  { kind: 'today', label: 'Today' },
  { kind: 'yesterday', label: 'Yesterday' },
  { kind: 'this_week', label: 'This week' },
  { kind: 'this_month', label: 'This month' },
  { kind: 'last_month', label: 'Last month' },
  { kind: 'this_year', label: 'This year' },
  { kind: 'all', label: 'Everything' },
];

export async function resolvePeriod(
  storeId: string,
  kind: PeriodKind,
  from?: string | null,
  to?: string | null,
): Promise<Period> {
  const { data, error } = await getSupabase().rpc('period_range', {
    p_store_id: storeId,
    p_kind: kind,
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) throw error;
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
  return {
    kind,
    fromAt: (r?.from_at as string | null) ?? null,
    toAt: (r?.to_at as string | null) ?? null,
    label: String(r?.label ?? ''),
  };
}

/**
 * A custom range, given as two dates the shop picked.
 *
 * The END DATE IS INCLUSIVE to the person choosing it — "1st to the 30th" means the 30th counts —
 * and half-open to the database. That translation happens here, once, rather than in every caller.
 */
export async function customPeriod(
  storeId: string,
  fromDate: string,
  toDate: string,
): Promise<Period> {
  const to = new Date(`${toDate}T00:00:00`);
  to.setDate(to.getDate() + 1);
  return resolvePeriod(
    storeId,
    'custom',
    new Date(`${fromDate}T00:00:00`).toISOString(),
    to.toISOString(),
  );
}

/**
 * The window a screen opens on, and the one the shop picks after.
 *
 * THE OPENING WINDOW IS A READ like any other — the shop's clock decides what "this month" is — and
 * three screens each resolved it in an effect whose failure was swallowed or only shown in a dialog.
 * The period stayed unknown and the whole section under it simply never appeared, with nothing to
 * press. Here it is loading until known, and a failure carries its own retry.
 *
 * Not persisted: "this month" is a fact about now, and last month's window carried into this one is
 * exactly the wrong report.
 */
export function usePeriod(storeId: string | null, initial: PeriodKind = 'this_month') {
  const opening = useResource<Period>({
    key: `period:${storeId ?? 'none'}:${initial}`,
    scope: 'periods',
    persist: false,
    enabled: Boolean(storeId),
    read: () => resolvePeriod(storeId as string, initial),
  });
  // What the shop chose on this screen — belongs to the shop it was chosen in.
  const [chosen, setChosen] = useState<{ storeId: string | null; period: Period } | null>(null);
  const period = chosen && chosen.storeId === storeId ? chosen.period : opening.data;
  return {
    period,
    setPeriod: (next: Period) => setChosen({ storeId, period: next }),
    error: period ? null : opening.error,
    reload: opening.reload,
  };
}

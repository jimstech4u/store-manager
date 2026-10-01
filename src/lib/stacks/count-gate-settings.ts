'use client';

import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';
import { SETTINGS_SCOPE, settingsChanged } from '@/lib/stacks/bank-accounts';
import { countsChanged } from '@/lib/stacks/count-gate';
import { catalogChanged } from '@/lib/stacks/catalog-stack';

/**
 * HOW THE COUNT GATE WORKS FOR THIS SHOP (0250).
 *
 *   aggressive  every day, before anything goes out — the default;
 *   relaxed     only on the days picked (ISO: 1 Monday ... 7 Sunday), like an alarm's Repeat.
 *
 * And "count when low": an item that has run low is counted before it sells, any day. The shop sets
 * it; an item follows the shop or says its own. The server decides with `count_required_today` — the
 * sale trigger and the till's banner both read it — so this module only reads and writes the choice.
 */
export type CountGateMode = 'aggressive' | 'relaxed';

export interface CountGate {
  mode: CountGateMode;
  /** ISO weekdays, 1 Monday ... 7 Sunday. */
  days: number[];
  countWhenLow: boolean;
  /** Today, as the shop's own clock says it (ISO weekday). */
  today: number;
}

export const WEEKDAYS: { iso: number; name: string }[] = [
  { iso: 1, name: 'Monday' },
  { iso: 2, name: 'Tuesday' },
  { iso: 3, name: 'Wednesday' },
  { iso: 4, name: 'Thursday' },
  { iso: 5, name: 'Friday' },
  { iso: 6, name: 'Saturday' },
  { iso: 7, name: 'Sunday' },
];

/** "Every Monday and Sunday", "Every day", "Weekdays", "Never" — the alarm's way of saying it. */
export function daysInWords(days: number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (set.length === 0) return 'Never';
  if (set.length === 7) return 'Every day';
  if (set.join() === '1,2,3,4,5') return 'Weekdays';
  if (set.join() === '6,7') return 'Weekends';
  const names = set.map((d) => WEEKDAYS.find((w) => w.iso === d)?.name ?? '');
  if (names.length === 1) return `Every ${names[0]}`;
  return `Every ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function useCountGateSettings(storeId: string | null) {
  return useResource<CountGate>({
    key: `count-gate-settings:${storeId ?? 'none'}`,
    scope: SETTINGS_SCOPE,
    enabled: Boolean(storeId),
    deps: [storeId ?? ''],
    read: async () => {
      const { data, error } = await getSupabase().rpc('count_gate_settings', { p_store_id: storeId });
      if (error) throw error;
      const d = (data ?? {}) as { mode?: string; days?: number[]; count_when_low?: boolean; today?: number };
      return {
        mode: d.mode === 'relaxed' ? 'relaxed' : 'aggressive',
        days: (d.days ?? []).map(Number),
        countWhenLow: Boolean(d.count_when_low),
        today: Number(d.today) || 1,
      };
    },
  });
}

/** After any change: the settings re-read, and so does every "not counted today" on the till. */
function gateChanged() {
  settingsChanged();
  countsChanged();
}

export async function setCountGate(storeId: string, mode: CountGateMode, days: number[]): Promise<void> {
  const { error } = await getSupabase().rpc('set_count_gate', {
    p_store_id: storeId,
    p_mode: mode,
    p_days: [...new Set(days)].sort((a, b) => a - b),
  });
  if (error) throw error;
  gateChanged();
}

export async function setCountWhenLow(storeId: string, on: boolean): Promise<void> {
  const { error } = await getSupabase().rpc('set_count_when_low', { p_store_id: storeId, p_on: on });
  if (error) throw error;
  gateChanged();
}

/** An item's own say on "count when low": true, false, or null to follow the shop. */
export function useProductCountWhenLow(productId: string | null) {
  return useResource<{ own: boolean | null; shop: boolean }>({
    key: `product-count-when-low:${productId ?? 'none'}`,
    scope: SETTINGS_SCOPE,
    enabled: Boolean(productId),
    deps: [productId ?? ''],
    read: async () => {
      const { data, error } = await getSupabase().rpc('product_count_when_low', { p_product_id: productId });
      if (error) throw error;
      const d = (data ?? {}) as { own?: boolean | null; shop?: boolean };
      return { own: d.own ?? null, shop: Boolean(d.shop) };
    },
  });
}

export async function setProductCountWhenLow(productId: string, on: boolean | null): Promise<void> {
  const { error } = await getSupabase().rpc('set_product_count_when_low', {
    p_product_id: productId,
    p_on: on,
  });
  if (error) throw error;
  gateChanged();
  catalogChanged();
}

export { SETTINGS_SCOPE };

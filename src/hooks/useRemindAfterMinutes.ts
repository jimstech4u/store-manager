'use client';

import { useDemandState } from '@academix-admin/state-stack';
import { useAuth } from '@/providers/AuthProvider';
import { SETTINGS_SCOPE } from '@/lib/stacks/bank-accounts';

/** What the shop chose, and what it means before anybody has chosen (0158). */
const DEFAULT_MINUTES = 30;

/**
 * The settings screen's own snapshot, READ ONLY — and declared in exactly its shape.
 *
 * ONE KEY, ONE SHAPE. This first declared the same key with `null` as its initial value, so the
 * settings screen — which reads `snapshot.settings` — got null from the store this hook had just
 * initialised, and the app died with "Cannot read properties of null". A key belongs to one shape;
 * anybody else reading it declares that shape or leaves it alone.
 */
interface SettingsSnapshot {
  settings: { update_reminder_minutes?: number } | null;
  shop: unknown;
  pending: number;
  error: string | null;
}

const EMPTY: SettingsSnapshot = { settings: null, shop: null, pending: 0, error: null };

/**
 * HOW LONG A WAITING UPDATE LEAVES SOMEBODY ALONE after "Not now".
 *
 * Read from the copy of the shop's settings the settings screen already keeps on the device — not
 * fetched. This runs on every screen, and a round trip on every start-up, to learn how long to wait
 * before asking about something that may never happen, is a cost the shop pays for nothing. A
 * device that has never opened settings waits the default, which is the answer the database gives
 * anyway.
 */
export function useRemindAfterMinutes(): number {
  const { store } = useAuth();
  const [cached] = useDemandState<SettingsSnapshot>(EMPTY, {
    key: `settings:${store?.id ?? 'none'}`,
    scope: SETTINGS_SCOPE,
    persist: true,
    deps: [store?.id ?? ''],
    // Nothing is asked for here: this reads what the settings screen wrote, or the default.
    revalidateOnMount: false,
  });

  const minutes = cached?.settings?.update_reminder_minutes;
  return typeof minutes === 'number' && minutes >= 5 ? minutes : DEFAULT_MINUTES;
}

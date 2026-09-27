'use client';

import { useCallback } from 'react';
import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';
import { invalidate } from '@/lib/stacks/invalidation';

/**
 * HOW LONG A DISMISSED UPDATE WAITS BEFORE ASKING AGAIN.
 *
 * One column of `store_settings`, read and written on its own. The Settings screen used to hold
 * the whole row in one snapshot and save it with one button — right for a page that edits all of
 * it, wrong now that each setting has its own page. A page that read the whole row could write
 * back a header, a footer and a bank account it never showed, and last-writer-wins between two
 * screens is how a shop loses the setting it changed on the other one.
 */

export const UPDATE_REMINDER_SCOPE = 'update_reminder';

export function useUpdateReminder(storeId: string | null) {
  const read = useCallback(async () => {
    if (!storeId) return { minutes: 30 };
    const { data, error } = await getSupabase()
      .from('store_settings')
      .select('update_reminder_minutes')
      .eq('store_id', storeId)
      .single();
    if (error) throw error;
    /*
     * Wrapped in an object: a bare number would be fine, but state-stack reads a bare null as
     * "never answered" and this column can be null on a row written before it existed. Thirty
     * minutes is the shipped default and the same one the service worker assumes.
     */
    return { minutes: Number((data as { update_reminder_minutes: number | null }).update_reminder_minutes ?? 30) };
  }, [storeId]);

  const resource = useResource<{ minutes: number }>({
    key: `update-reminder:${storeId ?? 'none'}`,
    scope: UPDATE_REMINDER_SCOPE,
    enabled: Boolean(storeId),
    deps: [storeId ?? ''],
    read,
  });

  /** Saves as it is changed. Writes ONLY this column. */
  const set = useCallback(
    async (minutes: number) => {
      if (!storeId) return;
      const { error } = await getSupabase()
        .from('store_settings')
        .update({ update_reminder_minutes: minutes })
        .eq('store_id', storeId);
      if (error) throw error;
      invalidate(UPDATE_REMINDER_SCOPE);
      await resource.reload();
    },
    [storeId, resource],
  );

  return { ...resource, minutes: resource.data?.minutes ?? 30, set };
}

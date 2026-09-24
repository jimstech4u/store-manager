'use client';

import { getSupabase } from '@/lib/supabase/client';
import { invalidate } from '@/lib/stacks/invalidation';
import { useResource } from '@/lib/stacks/resource';

/**
 * THE SHOPPER'S OWN ACCOUNT — a third kind of person in this app.
 *
 * It already knows two: a shop, and somebody who works at one. A shopper is neither. They have no
 * store, no role and no permission to anything; `/main` has nothing in it for them. What a shop
 * needs from them is the whole of what is kept here — a name and a number it can ring about an
 * order — and nothing else is asked for, because nothing else is needed.
 *
 * ASKED FOR AT CHECKOUT AND NOWHERE ELSE. Browsing, filling a basket and saving things all work
 * with no account at all: somebody comparing prices at a bus stop should never meet a sign-up form.
 * It appears at the one moment it is genuinely required — when a shop is being asked to set goods
 * aside for a named person it can reach.
 */

export const CUSTOMER_ACCOUNT_SCOPE = 'customer_account';

export interface CustomerAccount {
  display_name: string;
  phone: string;
  created_at: string;
}

/**
 * Who the signed-in shopper is.
 *
 * WRAPPED IN AN OBJECT, and that is not decoration. "Signed in, no shopper account" is a real
 * answer that the checkout acts on by asking who they are — but a bare `null` is how every read in
 * this project says "never answered", so returning it made `loaded` false for ever and the form
 * that should have appeared never did. The answer is `{ account: null }`; the absence is still
 * `null`, and the two no longer look alike.
 */
export function useCustomerAccount(signedIn: boolean) {
  return useResource<{ account: CustomerAccount | null }>({
    key: 'customer-account',
    scope: CUSTOMER_ACCOUNT_SCOPE,
    enabled: signedIn,
    deps: [signedIn],
    read: async () => {
      const { data, error } = await getSupabase().rpc('my_customer_account');
      if (error) throw error;
      return { account: ((data ?? []) as CustomerAccount[])[0] ?? null };
    },
  });
}

/** Save it. The caller is `auth.uid()` server-side — there is no user id to pass, by design. */
export async function saveCustomerAccount(name: string, phone: string): Promise<void> {
  const { error } = await getSupabase().rpc('save_customer_account', {
    p_name: name,
    p_phone: phone,
  });
  if (error) throw error;
  invalidate(CUSTOMER_ACCOUNT_SCOPE);
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/providers/AuthProvider';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { ChoosePassword } from '@/components/auth/ChoosePassword';
import { getSupabase } from '@/lib/supabase/client';

/**
 * The authenticated boundary.
 *
 * One place decides where an unauthenticated or un-onboarded user goes, rather than each page
 * guarding itself — a per-page guard is only correct until someone adds a page and forgets, and
 * that failure shows up as a screen that renders briefly with someone else's data.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { loading, storesLoading, session, stores, store, error, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  /*
   * Is this a staff login still on the password their admin chose?
   *
   * Asked here rather than on each page for the same reason the sign-in check is: a per-page guard
   * is correct only until somebody adds a page and forgets, and this one failing open means
   * somebody works a whole shift on a password their manager knows.
   *
   * `undefined` means "not asked yet" and is deliberately distinct from `false`. Treating an
   * unanswered question as "no" would flash the app for a moment before the gate appeared, which
   * is the one thing a gate must not do.
   */
  const [mustChange, setMustChange] = useState<boolean | undefined>(undefined);
  const [loginEmail, setLoginEmail] = useState<string | null>(null);

  /*
   * IS THIS A SHOPPER RATHER THAN A SHOP?
   *
   * A third kind of person signs in here now, and they have no store — which until they existed
   * meant one thing: "you have not made your shop yet", and a redirect to the wizard. A shopper
   * sent there is being asked to open a business in order to buy a crate of drinks.
   *
   * READ FROM THE SESSION, WHICH IS ALREADY HERE. The first version asked the database, and that
   * was a mistake worth recording: it put an ASYNC STEP in front of a redirect that had always been
   * synchronous, and the answer could land a second or two later — by which time a real shop had
   * been sitting on `/main` and was then thrown into the shop wizard. Caught by a probe that
   * watched the address after signing in, not by reading the code.
   *
   * It grants nothing. User metadata is client-writable, so nothing may be permitted on the
   * strength of it; it chooses between two public screens. Every permission is still decided by the
   * database from `auth.uid()`.
   */
  const isShopper = session?.user?.user_metadata?.signed_up_as === 'customer';

  const askMembership = useCallback(async () => {
    if (!session) {
      setMustChange(undefined);
      return;
    }
    /*
     * A READ THAT FAILS IS STILL AN ANSWER TO THIS QUESTION: do not interrupt.
     *
     * The returned `error` was handled and a THROWN one was not — and with no signal the call
     * throws rather than returning. `mustChange` then stayed `undefined`, which this gate reads as
     * "not asked yet", so the app sat on "Opening your shop" for ever: a shop with its own till
     * cached on the device, locked out by a question nobody could answer. The database enforces
     * every permission regardless; this flag only decides whether to interrupt.
     */
    try {
      const { data, error } = await getSupabase().rpc('my_membership');
      const row = (data as { must_change_password: boolean; login_email: string | null }[] | null)?.[0];
      setMustChange(error ? false : Boolean(row?.must_change_password));
      setLoginEmail(row?.login_email ?? null);
    } catch {
      setMustChange(false);
    }
  }, [session]);

  useEffect(() => {
    void askMembership();
  }, [askMembership]);

  const needsAccount = !loading && !session;
  /*
   * "You have no shop" is a claim, and it needs an answer to make it. With no signal the read fails
   * and the list is empty — which used to route a signed-in shop to the create-a-shop wizard, the
   * one screen it could not possibly want. An error means we do not know, so nothing is claimed.
   */
  /*
   * "YOU HAVE NOT MADE YOUR SHOP YET" — which is only true of somebody who came here to run one.
   *
   * A shopper has no store and never will; `/main` is their screen too, and it renders the
   * customer's own home rather than the shop's tabs. So they are not missing anything and must not
   * be sent anywhere: not to the create-a-shop wizard, and not out to the marketplace either,
   * which was the earlier stopgap and left a shopper with no home of their own.
   */
  const needsStore =
    !loading && !storesLoading && !!session && !isShopper && stores.length === 0 && !error;
  const needsOnboarding =
    !loading && !!store && !store.onboardedAt && !pathname.startsWith('/setup');

  useEffect(() => {
    if (needsAccount) router.replace('/login');
    else if (needsStore) router.replace('/setup');
    else if (needsOnboarding) router.replace('/setup/opening');
  }, [needsAccount, needsStore, needsOnboarding, isShopper, router]);

  if (loading || (session && mustChange === undefined)) {
    return <FullPageMessage title="Opening your shop" tone="loading" />;
  }

  /*
   * Before anything else this session can do.
   *
   * Above the store and onboarding checks on purpose: somebody on a borrowed password should not
   * be walked through setting up a shop first.
   */
  if (session && mustChange) {
    return (
      <ChoosePassword
        loginEmail={loginEmail ?? session.user.email ?? null}
        onDone={() => setMustChange(false)}
        onSignOut={() => void signOut()}
      />
    );
  }

  // Render nothing while the redirect is in flight. Showing the children first would flash a
  // screen the user is not allowed to be on, which looks like a bug and briefly is one.
  if (needsAccount || needsStore || needsOnboarding) {
    return <FullPageMessage title="One moment" tone="loading" />;
  }

  return <>{children}</>;
}

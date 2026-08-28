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
  const { loading, session, stores, store, signOut } = useAuth();
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

  const askMembership = useCallback(async () => {
    if (!session) {
      setMustChange(undefined);
      return;
    }
    const { data, error } = await getSupabase().rpc('my_membership');
    const row = (data as { must_change_password: boolean; login_email: string | null }[] | null)?.[0];
    // A failed read must not lock somebody out of their own shop. The database enforces every
    // permission anyway; this flag only decides whether to interrupt.
    setMustChange(error ? false : Boolean(row?.must_change_password));
    setLoginEmail(row?.login_email ?? null);
  }, [session]);

  useEffect(() => {
    void askMembership();
  }, [askMembership]);

  const needsAccount = !loading && !session;
  const needsStore = !loading && !!session && stores.length === 0;
  const needsOnboarding =
    !loading && !!store && !store.onboardedAt && !pathname.startsWith('/setup');

  useEffect(() => {
    if (needsAccount) router.replace('/login');
    else if (needsStore) router.replace('/setup');
    else if (needsOnboarding) router.replace('/setup/opening');
  }, [needsAccount, needsStore, needsOnboarding, router]);

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

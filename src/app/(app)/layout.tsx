'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/providers/AuthProvider';
import { FullPageMessage } from '@/components/ui/FullPageMessage';

/**
 * The authenticated boundary.
 *
 * One place decides where an unauthenticated or un-onboarded user goes, rather than each page
 * guarding itself — a per-page guard is only correct until someone adds a page and forgets, and
 * that failure shows up as a screen that renders briefly with someone else's data.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { loading, session, stores, store } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const needsAccount = !loading && !session;
  const needsStore = !loading && !!session && stores.length === 0;
  const needsOnboarding =
    !loading && !!store && !store.onboardedAt && !pathname.startsWith('/setup');

  useEffect(() => {
    if (needsAccount) router.replace('/login');
    else if (needsStore) router.replace('/setup');
    else if (needsOnboarding) router.replace('/setup/opening');
  }, [needsAccount, needsStore, needsOnboarding, router]);

  if (loading) {
    return <FullPageMessage title="Opening your shop" tone="loading" />;
  }

  // Render nothing while the redirect is in flight. Showing the children first would flash a
  // screen the user is not allowed to be on, which looks like a bug and briefly is one.
  if (needsAccount || needsStore || needsOnboarding) {
    return <FullPageMessage title="One moment" tone="loading" />;
  }

  return <>{children}</>;
}

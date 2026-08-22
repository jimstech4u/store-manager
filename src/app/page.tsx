'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/providers/AuthProvider';
import { FullPageMessage } from '@/components/ui/FullPageMessage';

/**
 * Entry point: send people where they actually belong.
 *
 * The decision needs the auth state, which is only known on the client, so this is a redirect
 * rather than a server rewrite.
 */
export default function RootPage() {
  const { loading, session, stores } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!session) router.replace('/login');
    else if (stores.length === 0) router.replace('/setup');
    else router.replace('/main');
  }, [loading, session, stores.length, router]);

  return <FullPageMessage title="Opening Store Manager" tone="loading" />;
}

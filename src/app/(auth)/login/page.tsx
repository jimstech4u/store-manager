'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import NavigationStack from '@academix-admin/navigation-stack';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { safeNext } from '@/lib/auth/after-sign-in';
import { useAuth } from '@/providers/AuthProvider';
import SignIn from './signin/signin';
import SignUp from './signup/signup';
import Verify from './verify/verify';

/**
 * The auth stack.
 *
 * These screens used to be one component with a `mode` flag and two early returns, which meant
 * the only way back from "create an account" was another button that set the flag the other way,
 * and no way back at all from the six-digit screen. They are steps in a flow, so they are a
 * stack — the same one the rest of the app uses, with a real back arrow and a browser Back that
 * moves between steps instead of abandoning the flow.
 *
 * `persist={false}` on purpose. A half-finished sign-in is not worth restoring, and restoring the
 * six-digit screen for a code that has since expired would be worse than starting again. This is
 * the same choice academix-web makes for its login stack, for the same reason.
 */

const navLink = {
  signin: SignIn,
  signup: SignUp,
  verify: Verify,
};

function AuthStack() {
  const params = useSearchParams();
  const router = useRouter();
  const { loading, session } = useAuth();

  /*
   * ALREADY SIGNED IN — go to the shop rather than asking for the password again.
   *
   * Reached by anything that points at sign-in without checking first: the marketplace's own
   * button, a bookmark, and (before its start_url was fixed) every launch of the installed app.
   * Typing a password you have already typed is the clearest possible way for an app to say it
   * has forgotten you, when it has not.
   */
  /*
   * `next`, not `/main`. This guard raced the sign-in screen's own redirect and sometimes won: a
   * shopper who signed in from their basket was carried to a till instead, and then bounced on to
   * the shop wizard. Both now send them to the same place, so which one wins does not matter.
   */
  useEffect(() => {
    if (!loading && session) router.replace(safeNext(params.get('next')));
  }, [loading, session, router, params]);

  // The marketplace's "Open a shop" lands here expecting the sign-up form, not sign-in.
  const entry = params.get('mode') === 'signup' ? 'signup' : 'signin';

  return (
    <div style={{ height: '100dvh', overflow: 'hidden' }}>
      <NavigationStack
        id="auth"
        navLink={navLink}
        entry={entry}
        transition="slide"
        persist={false}
        // navigation-stack defaults this to false, so browser back/forward would otherwise skip
        // straight out of the flow rather than moving between its steps.
        syncHistory
      />
    </div>
  );
}

/**
 * Wrapped in Suspense because useSearchParams opts the page out of prerendering otherwise. Next
 * builds this route statically and cannot know the query string at build time, so the part that
 * reads it has to be allowed to resolve on the client.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<FullPageMessage title="Opening" tone="loading" />}>
      <AuthStack />
    </Suspense>
  );
}

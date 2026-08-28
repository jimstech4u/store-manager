'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import NavigationStack from '@academix-admin/navigation-stack';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
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

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * BACK, WHERE THERE MAY BE NOTHING TO GO BACK TO.
 *
 * A public page is reached in ways an app screen never is: a search result, a WhatsApp link, a shop
 * code typed into the address bar, a new tab. In every one of those the browser's history is one
 * entry long and `router.back()` either does nothing or leaves the site entirely — which, from a
 * back button the page itself drew, reads as the page being broken.
 *
 * So the rule academix-web's public pages use: go back if there is somewhere to go back to, and
 * otherwise go to the place this page belongs under. A product's home is its shop; a shop's is the
 * marketplace. Nobody is ever left on a dead end.
 *
 * `history.length` is read in an effect rather than during render, because it is not the same on
 * the server and in the browser and using it while rendering would make the button appear and then
 * change its mind.
 */
export function useBackTo(fallback: string) {
  const router = useRouter();
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    try {
      setCanGoBack(window.history.length > 1);
    } catch {
      setCanGoBack(false);
    }
  }, []);

  const goBack = useCallback(() => {
    if (canGoBack) {
      router.back();
      return;
    }
    router.push(fallback);
  }, [canGoBack, router, fallback]);

  return goBack;
}

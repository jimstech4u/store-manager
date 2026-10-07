'use client';

import { appUrl } from '@/lib/app-url';

/**
 * HANDING AN ORDER TO THE PERSON BUYING IT: the link a customer follows an open order by, and the
 * words it is sent with. All items sends them (the till's order code opens All items; the sheet that
 * used to send just the link is in `_unused/`).
 *
 * Built on the TOKEN, not the code, wherever there is one.
 */
export function orderTrackLink(code: string, shareToken: string | null): string {
  return shareToken
    ? appUrl(`/t/${encodeURIComponent(shareToken)}`)
    : appUrl(`/track?code=${encodeURIComponent(code)}`);
}

/** "Your order at Ashabi comes to N12,000. Follow it here: …" — one sentence, one link. */
export function orderShareMessage(storeName: string, link: string, total?: string): string {
  return (
    `Your order at ${storeName}` + (total ? ` comes to ${total}.` : '.') + `\nFollow it here: ${link}`
  );
}

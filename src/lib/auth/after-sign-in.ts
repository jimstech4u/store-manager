/**
 * WHERE SOMEBODY LANDS AFTER SIGNING IN.
 *
 * There are now three kinds of person here — a shop, somebody who works at one, and a shopper on
 * the marketplace — and only the first two belong at `/main`. A shopper sent there is bounced to
 * "create your shop", which is the one screen they will never want.
 *
 * The answer is not guessed from who they are: it is carried. Whatever sent them to sign in says
 * where to come back to (`/login?next=/cart`), and that is honoured. Everything else goes to
 * `/main`, which is right for the two kinds of person who have always used this app, and the app
 * shell sends a shopper who arrives there anyway back to the marketplace.
 *
 * ONLY A PATH ON THIS SITE. `next` arrives from the address bar, so anyone can put anything in it.
 * An absolute URL would make this an open redirect: a link to our own sign-in page that lands on
 * somebody else's site, wearing our name, asking for a password. A leading `//` is the same attack
 * spelled differently.
 */
export function safeNext(next: string | null | undefined, fallback = '/main'): string {
  if (!next) return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//')) return fallback;
  // `\` because some browsers normalise a backslash to a forward slash, which turns `/\evil.com`
  // into a protocol-relative URL after this function has said it was fine.
  if (next.includes('\\')) return fallback;
  return next;
}

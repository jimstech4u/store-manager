'use client';

import { useEffect } from 'react';
import { useNav, useObject } from '@academix-admin/navigation-stack';

/**
 * Handing a customer to the page you just pushed.
 *
 * THE RULE THIS EXISTS TO ENFORCE: a push carries an ID, never a record.
 *
 * The statement page used to be opened with `{ id, name }` and the action page with
 * `{ id, kind, owed }`. Both put record data in the URL, and that is wrong in three separate ways:
 *
 *   IT GOES STALE. `owed` was a money figure captured at the moment of the tap. Record a payment,
 *   go back, tap again from a list that had not refreshed, and the form said "They owe ₦40,000"
 *   over an account that no longer did. A balance is not a navigation parameter.
 *
 *   IT IS EDITABLE. The stack serialises params into the address bar, so the name shown as a page
 *   title was a string anybody could type. A page should not be able to claim a customer is called
 *   something they are not.
 *
 *   IT ONLY CARRIES WHAT SOMEBODY REMEMBERED TO PACK. Every new field the pushed page wants means
 *   editing every push site, and the ones that get missed fail silently with a default.
 *
 * So the list that already HAS the customers publishes a lookup — `nav.provideObject` — and the
 * pushed page asks for the one it wants by id with `useObject`. The same shape academix-web uses
 * for `getTransactionById`, and for the same reason: the list is the thing that legitimately knows.
 *
 * ONE KEY, ONE SHAPE. Both the Money list and the People list publish this, so it lives here
 * rather than being written out twice — two providers of one key with two different row types is a
 * race, and it is the exact mistake that white-screened the bank page.
 *
 * ALWAYS A FALLBACK. A getter is a convenience, never the source of truth: on a cold start, a
 * deep link, or a hard refresh, nothing has published anything and `isProvided` is false. Every
 * consumer must still be able to read its own record from the server — which is why these hooks
 * return `null` rather than pretending, and why the pages that use them fetch on a miss.
 */

/** The minimum a list row has to expose. Both customer lists already return exactly this. */
export interface CustomerSummary {
  id: string;
  display_name: string;
  business_name: string | null;
  phone: string;
  balance: string;
}

const KEY = 'getCustomerById';

/*
 * Global, with a name of its own.
 *
 * The consumers are in other stacks — People publishes, and the Money stack's statement page reads
 * — and a page-scoped object is addressed by its provider's uid, so it would never be found from
 * a different stack. `global` with an explicit scope is how academix-web addresses the same
 * cross-stack case (`{ global: true, scope: 'payment-transactions' }`).
 */
const OPTIONS = { global: true, scope: 'customers' } as const;

/** Publish a lookup over the rows this list is holding. Call it from any customer list. */
export function useProvideCustomers(rows: CustomerSummary[]) {
  const nav = useNav();

  useEffect(() => {
    if (rows.length === 0) return;
    return nav.provideObject(KEY, () => (id: string) => rows.find((r) => r.id === id), OPTIONS);
  }, [nav, rows]);
}

/**
 * The customer a list is holding, or `null`.
 *
 * `null` means "nobody has published one" — a cold start, a deep link, a reload. It does NOT mean
 * the customer does not exist, and a caller that treats it that way will show an empty page to
 * somebody who pasted a link. Read your own record when this is null.
 */
export function useCustomerFromList(customerId: string | null): CustomerSummary | null {
  const obj = useObject<(id: string) => CustomerSummary | undefined>(KEY, OPTIONS);
  if (!customerId || !obj.isProvided) return null;
  const lookup = obj.getter();
  return lookup?.(customerId) ?? null;
}

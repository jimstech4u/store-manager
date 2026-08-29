'use client';

import { useCallback } from 'react';
import { useProvideRequestHandler, useSendRequest } from '@academix-admin/navigation-stack';

/**
 * Changing one row of a list without re-reading the list.
 *
 * A shop's lists grow. Ten thousand sales is an ordinary year, and the way every screen here used
 * to react to a change was `refresh()` — throw the list away and fetch page one again. That is
 * wrong twice over: it costs a round trip proportional to nothing the user did, and it silently
 * discards the pages they had already scrolled through, dumping them back at the top.
 *
 * The row that changed is the row to change. A page that edits a customer, records a sale or
 * voids a receipt knows exactly which id it touched and what it now looks like, so it says so —
 * and the list patches that one entry in the state it already holds. Nothing is fetched, nothing
 * is lost, and the screen behind shows the new figure the moment you return to it.
 *
 * Built on navigation-stack's request channel rather than a store of our own: the list and the
 * page changing it are in different stacks, often not mounted at the same time, and that is
 * precisely the problem the channel solves. A message to a list nobody is showing is simply
 * unhandled — the list will read the truth from the database the next time it loads, which is the
 * correct outcome and needs no special case.
 */

export type ListChange<T> =
  /** This row is new, or is now different. Inserted at the top when it is not already present. */
  | { type: 'upsert'; row: T }
  /** This row is gone — voided, removed, closed. */
  | { type: 'remove'; id: string }
  /** Part of a row changed and the sender does not hold the whole thing. */
  | { type: 'patch'; id: string; patch: Partial<T> };

/**
 * Registered by the list. One channel per list, named for what it holds.
 *
 * `dependencies` carries the current rows, because the handler closes over them — without it a
 * message arriving after the second page loaded would patch the first page's copy and put the
 * list back to where it was.
 */
export function useListChannel<T extends { id: string }>(
  key: string,
  rows: T[],
  write: (next: T[]) => void,
) {
  useProvideRequestHandler<ListChange<T>, { applied: boolean }>(
    `list:${key}`,
    (change) => {
      if (change.type === 'remove') {
        const next = rows.filter((r) => r.id !== change.id);
        // Nothing to do is not a failure: the row may be on a page this device has not loaded.
        if (next.length !== rows.length) write(next);
        return { applied: next.length !== rows.length };
      }

      if (change.type === 'patch') {
        let touched = false;
        const next = rows.map((r) => {
          if (r.id !== change.id) return r;
          touched = true;
          return { ...r, ...change.patch };
        });
        if (touched) write(next);
        return { applied: touched };
      }

      const index = rows.findIndex((r) => r.id === change.row.id);
      if (index === -1) {
        /*
         * New rows go to the TOP.
         *
         * Every list here is newest-first — sales, payments, people by recency — so that is where
         * a new one belongs. A list ordered some other way will want its own handler rather than
         * this default, which is why this hook takes the writer rather than owning the state.
         */
        write([change.row, ...rows]);
        return { applied: true };
      }

      const next = rows.slice();
      next[index] = change.row;
      write(next);
      return { applied: true };
    },
    { global: true, scope: 'lists', dependencies: [rows, write] },
  );
}

/**
 * Used by whatever changed something.
 *
 * Deliberately fire-and-forget from the caller's point of view: the write to the database has
 * already succeeded by the time this is called, and whether some list elsewhere was listening
 * changes nothing about that. Failing to tell a list is not a reason to tell the user a sale did
 * not go through.
 */
export function useListNotifier<T extends { id: string }>(key: string) {
  const [send] = useSendRequest<ListChange<T>, { applied: boolean }>(`list:${key}`, {
    global: true,
    scope: 'lists',
  });

  return useCallback(
    (change: ListChange<T>) => {
      void Promise.resolve(send(change)).catch(() => {
        // Nobody is showing that list. It will read the truth when it next loads.
      });
    },
    [send],
  );
}

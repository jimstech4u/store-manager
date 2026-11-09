'use client';

import { useCallback, useRef } from 'react';
import { StateStack, getDefaultStorage, useDemandResource } from '@academix-admin/state-stack';

/**
 * ONE WAY TO READ SOMETHING — kept, shown straight away next time, and honest while it loads.
 *
 * Three bugs this exists to make impossible, each of which was on screen:
 *
 *   A FAKE FIGURE BEFORE THE REAL ONE. Hooks started at `0` or `[]`, so a customer's balance read
 *   ₦0 and a list read "nothing here yet" until the answer arrived — a figure that looks exactly like
 *   a real one. Here the value is `null` until the first answer, and `loaded` says so; a screen shows
 *   a loader, never a zero it made up. (academix-web's balance does the same: `null`, and nothing
 *   drawn until there is something true to draw.)
 *
 *   A RELOAD THAT FORGETS. Pages that kept what they read in `useState` came back from a reload — or
 *   from a push the stack restored — empty, so the page showed a spinner, lost its scroll position
 *   (restoration ran against nothing), and re-read everything. The value lives in state-stack,
 *   persisted: the last answer is on screen the moment the page is, and a fresh read replaces it
 *   behind the scenes.
 *
 *   A FAILED REFRESH THAT WIPES THE SCREEN. A read that fails keeps what is already shown and sets
 *   only `error`. Retry is `reload()` — never a page reload, which throws away the stack, every cache
 *   and whatever was typed.
 *
 * `key` must be unique for the VALUE: include every id the read depends on (`account:${id}`).
 * `scope` is the invalidation scope a writer notifies (`ledgersChanged()` → `customer_ledgers`), so
 * a change made anywhere re-reads this without anybody having to know it exists.
 */

export interface Resource<T> {
  /** The last answer, or `null` if there has never been one. Never a made-up default. */
  data: T | null;
  /** There is an answer to show — possibly one from before, while a newer read runs. */
  loaded: boolean;
  /** A read is in flight. With `loaded`, it is a background refresh; without, the first load. */
  loading: boolean;
  /** The last read failed. What was on screen stays; this says the newer answer did not arrive. */
  error: string | null;
  /** Read again now. Keeps what is shown until the answer lands. */
  reload: () => void;
  /**
   * Write the value directly — for a change THIS device just made, which is already known and
   * needs no round trip (see `patch-local.ts`). Persisted, and every screen showing it updates.
   */
  set: (next: T | ((prev: T | null) => T)) => void;
}

export function useResource<T>(opts: {
  key: string;
  scope: string;
  read: () => Promise<T>;
  /** A change re-reads. Primitives only — a fresh array literal would re-read every render. */
  deps?: readonly unknown[];
  /** `false` holds the read (no store yet, no id yet). */
  enabled?: boolean;
  /** Called once per failed read, with the message — for a page that opens a dialog. */
  onFail?: (message: string) => void;
  /** Default `true`. `false` for a fact about today that must never be carried into tomorrow. */
  persist?: boolean;
}): Resource<T> {
  const { key, scope, enabled = true, persist = true } = opts;

  const readRef = useRef(opts.read);
  readRef.current = opts.read;
  const failRef = useRef(opts.onFail);
  failRef.current = opts.onFail;

  const res = useDemandResource<T>(
    // `read` is this project's own signature: no signal, because a Supabase call is not abortable
    // the way a fetch is. The library cancels by ignoring a superseded answer, which is the part
    // that matters — a screen left and returned to must not take whichever reply lands second.
    () => readRef.current(),
    {
      key,
      scope,
      enabled,
      persist,
      deps: opts.deps ? [...opts.deps] : [],
      fallbackMessage: 'That could not be read.',
      onError: (message) => failRef.current?.(message),
    },
  );

  const set = useCallback(
    (next: T | ((prev: T | null) => T)) => res.setData(next),
    [res],
  );

  const reload = useCallback(() => {
    void res.refetch();
  }, [res]);

  return { data: res.data, loaded: res.loaded, loading: res.loading, error: res.error, reload, set };
}

/**
 * A `reload` that actually reads again, for a hook built directly on `useDemandState`.
 *
 * `demand()` returns early once a key has been demanded, so a hook that handed out its own `load`
 * as `reload` gave the Try again buttons and the refresh on resume a function that did nothing — the
 * reason another till's sale, deposit or count never reached a screen until something else happened
 * to invalidate its scope. This clears the demanded flag for each key first (keeping the value on
 * screen) and then runs the load.
 */
export function useReload(scope: string, keys: string | string[], load: () => void): () => void {
  const list = Array.isArray(keys) ? keys : [keys];
  const joined = list.join('\u0000');
  return useCallback(() => {
    for (const k of joined.split('\u0000')) StateStack.core.resetDemand(scope, k);
    load();
  }, [scope, joined, load]);
}

/**
 * Write a cached value that some OTHER screen reads, by the key and scope it reads it under.
 *
 * The writer knows what it changed; the list or total showing it should not have to go and ask.
 * This updates the persisted value and every screen subscribed to it, in this tab and others. A
 * value nobody has ever read (`null`) is left alone — there is nothing on screen to correct, and
 * inventing a first answer from a patch would be showing a figure the server never gave.
 */
export function patchCached<T>(
  scope: string,
  key: string,
  patch: (prev: T) => T,
): void {
  const core = StateStack.core;
  const prev = core.getStateSync<T | null>(scope, key, null);
  if (prev === null || prev === undefined) return;
  void core.setState(scope, key, patch(prev), true, getDefaultStorage());
}

/**
 * A RECORD CHANGED, SO EVERY CACHE ON THIS DEVICE THAT HOLDS IT SAYS SO.
 *
 * "renaming a product or customer and any changes to data does not get updated in some lists like
 * pickers and pages." `patchCached` corrects the keys a writer knows about, and a writer knows about
 * four or five. A product's name is also in every picker search, the till's open orders, low stock,
 * what is expiring, the supplier's deliveries; a customer's in the sales list, the till's tabs, the
 * picker. Each was right only after it happened to read again.
 *
 * So the change is applied by IDENTITY, wherever it is held: every cached object whose `id` is this
 * record takes the changed fields it already has (never a field it did not have — a copy keeps its
 * own shape), and every object that refers to it (`productId` beside `productName`, `customer_id`
 * beside `customer_name`, as `refs` says) takes the new name. Ids are uuids, so an id that matches is
 * this record and nothing else. Only what changed is written, and the server's next read has the
 * last word.
 *
 * Values in memory only: a key nobody has read this session is re-read when it is.
 */
export function patchRecordEverywhere(change: {
  id: string;
  /** The record's changed fields, under the names its cached copies use. */
  fields: Record<string, unknown>;
  /** Where another record refers to this one: the id field and the name field beside it. */
  refs?: [idField: string, nameField: string][];
  /** The name those references take. */
  name?: string;
}): void {
  const { id, fields, refs = [], name } = change;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 10 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = walk(x, depth + 1);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? out : v;
    }
    // Plain objects only: a Map or a Date is left exactly as it is.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const o = v as Record<string, unknown>;
    let next: Record<string, unknown> | null = null;
    const set = (k: string, value: unknown) => {
      if (o[k] === value) return;
      (next ??= { ...o })[k] = value;
    };
    if (o.id === id) {
      for (const [k, value] of Object.entries(fields)) if (value !== undefined && k in o) set(k, value);
    }
    if (name !== undefined) {
      for (const [idField, nameField] of refs) if (o[idField] === id && nameField in o) set(nameField, name);
    }
    for (const [k, child] of Object.entries(o)) {
      if (child === null || typeof child !== 'object') continue;
      const w = walk(child, depth + 1);
      if (w !== child) (next ??= { ...o })[k] = w;
    }
    return next ?? o;
  };

  const core = StateStack.core;
  for (const [scope, keys] of Object.entries(core.dehydrate())) {
    for (const [key, value] of Object.entries(keys)) {
      const next = walk(value, 0);
      if (next !== value) void core.setState(scope, key, next, true, getDefaultStorage());
    }
  }
}

/** How other records name a product or a customer beside its id. */
export const PRODUCT_REFS: [string, string][] = [
  ['productId', 'productName'],
  ['product_id', 'product_name'],
];
export const CUSTOMER_REFS: [string, string][] = [
  ['customerId', 'customerName'],
  ['customer_id', 'customer_name'],
  ['store_customer_id', 'customer_name'],
];

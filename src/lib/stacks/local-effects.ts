'use client';

import { patchCached } from '@/lib/stacks/resource';
import type { Product } from '@/lib/stacks/catalog-stack';
import type { CustomerAccount } from '@/lib/stacks/customer-account';
import type { DepositCustomer, DepositMove, EmptiesCustomer } from '@/lib/stacks/customer-ledgers';
import type { OwedRow } from '@/lib/empties-rollup';

/**
 * WHAT A SALE CHANGES, CHANGED HERE FIRST.
 *
 * «if we make changes in the sell page, then everything that depends on that change — sales,
 *  empties, deposits, customer account, stock — can change locally as well (fastest), then when it
 *  loads online it will be the same, or different if other people's sales moved the same figures»
 *
 * The till knows exactly what it just recorded: which items left the shelf and how many, what went
 * on the customer's account, which containers went with them, what deposit was taken. Every screen
 * that shows one of those figures reads it from a cache this module can write — so they all say the
 * new figure the moment the sale settles, without a round trip, whether they are on screen or not.
 *
 * THE SERVER STILL HAS THE LAST WORD. The writers also invalidate their scopes, so every screen that
 * is showing one of these re-reads behind what is shown, and every other one re-reads when it is
 * next opened. What this device worked out is replaced by what the shop's books say — the same
 * figure, or a different one when another till sold from the same shelf in the meantime.
 *
 * ONLY WHAT IS KNOWN. A figure this device cannot work out exactly — what the shelf is worth now,
 * which depends on the cost of the layer that was sold — is left to the re-read rather than guessed.
 * And nothing is written into a cache that has never been read: a patch is a correction to something
 * on screen, never a first answer.
 *
 * The keys below are the ones the owning hooks read under. If one changes there, the patch here
 * silently does nothing and the re-read still corrects the screen — slower, never wrong.
 */

export interface SaleEffects {
  storeId: string;
  saleId: string;
  customer: { id: string; name: string } | null;
  /** How far their balance moved: + what went on account, − what paid down an older debt. */
  balanceDelta: number;
  /** A deposit taken with the sale. */
  deposit: { amount: number; reason: string | null } | null;
  /** What left the shelf, per item, in base units. */
  stockOut: { productId: string; base: number }[];
  /** Containers that went with the customer, in the shape they went in. */
  containersOut: {
    productId: string;
    productName: string;
    productUnitId: string;
    unitName: string;
    unitPlural: string;
    baseQty: number;
    qty: number;
  }[];
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function applySaleLocally(e: SaleEffects): void {
  const now = new Date().toISOString();

  /* ── The shelf ─────────────────────────────────────────────────────────────── */
  const out = new Map<string, number>();
  for (const s of e.stockOut) out.set(s.productId, (out.get(s.productId) ?? 0) + s.base);

  if (out.size > 0) {
    // The stock list (usePaginatedList key 'products' → `list:products`).
    patchCached<{ items: Product[]; cursor: unknown; hasMore: boolean }>(
      'catalog_flow',
      'list:products',
      (snap) => ({
        ...snap,
        items: snap.items.map((p) =>
          out.has(p.id) ? { ...p, onHand: String(num(p.onHand) - (out.get(p.id) ?? 0)) } : p,
        ),
      }),
    );
    // Each item's own page (useProduct → `product:${id}`).
    for (const [productId, base] of out) {
      patchCached<{ product: Product | null; error: string | null; settled: boolean }>(
        'catalog_flow',
        `product:${productId}`,
        (st) =>
          st.product
            ? { ...st, product: { ...st.product, onHand: String(num(st.product.onHand) - base) } }
            : st,
      );
    }
  }

  if (!e.customer) return;
  const cid = e.customer.id;

  /* ── What they owe ─────────────────────────────────────────────────────────── */
  if (e.balanceDelta !== 0) {
    // Take payment's own figure (`balance:${id}`).
    patchCached<number>('account_derived', `balance:${cid}`, (b) => b + e.balanceDelta);
    // Their account page (`account:v2:${id}`).
    patchCached<{ account: CustomerAccount; history: unknown[] }>(
      'account_derived',
      `account:v2:${cid}`,
      (st) => ({
        ...st,
        account: { ...st.account, balance: String(num(st.account.balance) + e.balanceDelta) },
      }),
    );
  }

  /* ── The containers they took ──────────────────────────────────────────────── */
  const took = e.containersOut.filter((c) => c.qty > 0);
  if (took.length > 0) {
    const total = took.reduce((sum, c) => sum + c.qty, 0);
    const shapes = new Set(took.map((c) => c.productUnitId)).size;

    // The Empties list (`empties-customers:${storeId}`) — they join it if they were not on it.
    patchCached<EmptiesCustomer[]>('customer_ledgers', `empties-customers:${e.storeId}`, (rows) => {
      const had = rows.find((r) => r.customerId === cid);
      if (had) {
        return rows.map((r) =>
          r.customerId === cid
            ? { ...r, stillOut: r.stillOut + total, shapesOut: Math.max(r.shapesOut, shapes), lastAt: now }
            : r,
        );
      }
      return [
        { customerId: cid, name: e.customer!.name, phone: null, stillOut: total, shapesOut: shapes, lastAt: now },
        ...rows,
      ];
    });

    // What they owe, shape by shape (`area:empties-owed:${id}`). A shape already owed grows; a new
    // one waits for the re-read, which knows its maker.
    patchCached<OwedRow[]>('customer_ledgers', `area:empties-owed:${cid}`, (rows) =>
      rows.map((r) => {
        const add = took
          .filter((c) => c.productUnitId === r.productUnitId)
          .reduce((sum, c) => sum + c.qty, 0);
        return add > 0 ? { ...r, owed: r.owed + add } : r;
      }),
    );
  }

  /* ── A deposit taken with the sale ─────────────────────────────────────────── */
  if (e.deposit && e.deposit.amount > 0) {
    const amount = e.deposit.amount;

    patchCached<DepositCustomer[]>('customer_ledgers', `deposit-customers:${e.storeId}`, (rows) => {
      const had = rows.find((r) => r.customerId === cid);
      if (had) {
        return rows.map((r) =>
          r.customerId === cid
            ? { ...r, held: r.held + amount, taken: r.taken + amount, lastAt: now }
            : r,
        );
      }
      return [
        {
          customerId: cid,
          name: e.customer!.name,
          phone: null,
          held: amount,
          taken: amount,
          given: 0,
          retained: 0,
          lastAt: now,
        },
        ...rows,
      ];
    });

    // Their deposit ledger (`area:deposit-ledger:${id}`), newest first with the running balance.
    patchCached<DepositMove[]>('customer_ledgers', `area:deposit-ledger:${cid}`, (moves) => [
      {
        id: `local:${e.saleId}`,
        direction: 'taken',
        amount,
        reason: e.deposit!.reason,
        occurredAt: now,
        running: (moves[0]?.running ?? 0) + amount,
      },
      ...moves,
    ]);
  }
}

/* ═══ A product edited or added ═══════════════════════════════════════════════════════ */

/**
 * Put a saved product's row into every cache that shows it.
 *
 * The product form told the stock list — only while that list was on screen — and nothing else. The
 * item's own page caches it separately, so a rename or a new price came back from the form to a page
 * still saying the old one. What the product is worth and which shapes it sells in are server
 * figures and are re-read through `catalogChanged()`; the row itself is what was just saved.
 */
export function applyProductLocally(row: Product): void {
  patchCached<{ items: Product[]; cursor: unknown; hasMore: boolean }>(
    'catalog_flow',
    'list:products',
    (snap) => {
      const had = snap.items.some((p) => p.id === row.id);
      return {
        ...snap,
        items: had ? snap.items.map((p) => (p.id === row.id ? { ...p, ...row } : p)) : [row, ...snap.items],
      };
    },
  );
  patchCached<{ product: Product | null; error: string | null; settled: boolean }>(
    'catalog_flow',
    `product:${row.id}`,
    (st) => ({ ...st, product: st.product ? { ...st.product, ...row } : row }),
  );
}

/* ═══ A customer added or changed ═════════════════════════════════════════════════════ */

export interface CustomerChange {
  id: string;
  storeId: string;
  name?: string;
  phone?: string;
  business?: string | null;
  /** Only for a customer just created: what they owe from before, already on their account. */
  openingBalance?: number;
}

/**
 * Put a customer's new details into every list and page that names them.
 *
 * Their name and number appear in five places: the People list, the list of who owes money, their
 * account page, and the Empties and Deposits lists. The form told the first of those, and only
 * while it was mounted — so a number saved from the WhatsApp screen, or a customer added mid-sale,
 * was missing or stale everywhere else until each list happened to re-read.
 */
export function applyCustomerLocally(c: CustomerChange): void {
  const rowPatch = {
    ...(c.name !== undefined ? { display_name: c.name } : {}),
    ...(c.phone !== undefined ? { phone: c.phone } : {}),
    ...(c.business !== undefined ? { business_name: c.business } : {}),
  };

  type CustomerRow = {
    id: string;
    display_name: string;
    business_name: string | null;
    phone: string;
    balance: string;
  };

  // The People list: a new customer joins it at the top.
  patchCached<{ items: CustomerRow[]; cursor: unknown; hasMore: boolean }>(
    'customer_flow',
    'list:customers',
    (snap) => {
      const had = snap.items.some((r) => r.id === c.id);
      if (had) {
        return { ...snap, items: snap.items.map((r) => (r.id === c.id ? { ...r, ...rowPatch } : r)) };
      }
      if (c.name === undefined) return snap;
      return {
        ...snap,
        items: [
          {
            id: c.id,
            display_name: c.name,
            business_name: c.business ?? null,
            phone: c.phone ?? '',
            balance: String(c.openingBalance ?? 0),
          },
          ...snap.items,
        ],
      };
    },
  );

  // Who owes money — only renamed here; a new debtor arrives with the list's own re-read.
  patchCached<{ items: CustomerRow[]; cursor: unknown; hasMore: boolean }>(
    'money_flow',
    'list:debtors',
    (snap) => ({ ...snap, items: snap.items.map((r) => (r.id === c.id ? { ...r, ...rowPatch } : r)) }),
  );

  // Their account page.
  patchCached<{ account: CustomerAccount; history: unknown[] }>(
    'account_derived',
    `account:v2:${c.id}`,
    (st) => ({
      ...st,
      account: {
        ...st.account,
        customer: {
          ...st.account.customer,
          ...(c.name !== undefined ? { name: c.name } : {}),
          ...(c.phone !== undefined ? { phone: c.phone } : {}),
          ...(c.business !== undefined ? { business: c.business } : {}),
        },
      },
    }),
  );

  // The Empties and Deposits lists name them too.
  const namePatch = {
    ...(c.name !== undefined ? { name: c.name } : {}),
    ...(c.phone !== undefined ? { phone: c.phone } : {}),
  };
  patchCached<EmptiesCustomer[]>('customer_ledgers', `empties-customers:${c.storeId}`, (rows) =>
    rows.map((r) => (r.customerId === c.id ? { ...r, ...namePatch } : r)),
  );
  patchCached<DepositCustomer[]>('customer_ledgers', `deposit-customers:${c.storeId}`, (rows) =>
    rows.map((r) => (r.customerId === c.id ? { ...r, ...namePatch } : r)),
  );
}

# Working on store-manager

Read this before writing code. It is the set of rules that were arrived at by getting them
wrong first — each one names the bug that produced it, because a rule without its reason gets
"simplified" away by the next person who does not know what it cost.

The two hard rules, if you read nothing else:

1. **state-stack is the state management tool.** Fetched data does not live in `useState`.
2. **A `nav.push` carries an id and an intent. Never a record.**

---

## 1. The shape of the thing

Three sibling projects under `academix-project/`:

| Path | What it is |
|---|---|
| `store-manager/` | This app. Next.js 15 App Router, TypeScript strict, CSS Modules, Supabase. |
| `academix-ui/` | The `@academix-admin/*` package monorepo. npm workspaces + changesets. |
| `academix-web/` | The reference app. **When unsure how a library is meant to be used, read how academix-web uses it** — it is older and its patterns are the ones the packages were built for. |

store-manager is a multi-tenant SaaS for Nigerian wholesale and distribution businesses. The
domain is money owed, containers lent out, and deposits held — three separate obligations that
settle in different ways. Rolling them into one number is what makes an account impossible to
explain across a counter, which is the thing this product exists to fix.

`STORE_MANAGER_PLAN.md` and `STORE_MANAGER_SCENARIOS.md` at the project root hold the product
scope. `ACADEMIX_PLAN.md` holds the library plan and the Library Charter.

---

## 2. state-stack

`@academix-admin/state-stack`. `useDemandState` is the primary hook.

```ts
const [value, demand, set, meta] = useDemandState<T>(initial, options);
```

That is a four-slot tuple and it has been destructured wrong more than once. `demand(loader)`
runs a loader at most once per key; `set(next)` writes directly; `meta` carries `isHydrated`.

### 2.1 The options that matter

```ts
{
  key: string,                 // identity. See 2.2 — this is where the bugs live.
  scope: string,               // a group that can be invalidated together
  persist: boolean,            // survive a remount
  deps: unknown[],             // change → reset and reload
  revalidateOnMount: boolean,  // default TRUE
  ttl: number,                 // ⚠ see 2.5 — usually wrong
  revive: (raw) => T,          // normalise a value persisted by an older build
}
```

### 2.2 ONE KEY = ONE HOOK = ONE SHAPE

**This is the rule that white-screened a page in production-shaped code.**

`useBankAccounts` wrote a bare `BankAccount[]` under `bank-accounts:<storeId>`. The bank page
wrote `{ accounts, error, settled }` under the same key. A cache does not care which of its
writers ran last: whichever wrote second handed the other a value of the wrong shape, and the
page died with `Cannot read properties of undefined (reading 'length')`. The identical
collision existed silently on `product:<id>` — `settled` came back undefined, so "Loading"
never cleared.

Keys are strings assembled inline (`` key: `product:${id}` ``), so a collision is **invisible to
`tsc`** and only appears at runtime, on a second visit, after something else wrote first.

- Before adding a `useDemandState`, `grep "key: \`" "key: '"` across `src/` for the key you want.
- If two screens want the same data, **hoist one owning hook into `src/lib/stacks/`** and have
  both consume it. Existing examples: `useBankAccountsState`, `useProduct`, `useCustomerAccount`.
- Add a `revive` when a persisted value could have been written by an older build.

### 2.3 A loader must never blank before it fetches

The reported symptom was "the statement loses its data when we push to a receipt". The obvious
diagnosis — a `useState` lost on unmount — was **wrong**: navigation-stack keeps pushed-under
pages mounted (`components.tsx` keeps them in `renders`; only *popped* entries are removed).

The real cause was the `onResume` loader clearing rows and balance before refetching. On a
screen whose whole job is to state what somebody owes, a momentary ₦0 is not a loading state,
it is a wrong number shown confidently, to two people looking at the same phone.

```ts
// WRONG — blanks first
demand(async ({ set }) => {
  set({ rows: [], balance: null }, { override: true });
  const data = await fetch();
  set(data, { override: true });
});

// RIGHT — writes once, and a failed refresh keeps what was cached
demand(async ({ set }) => {
  try {
    const data = await fetch();
    set({ ...data, error: null, settled: true }, { override: true });
  } catch (e) {
    set({ ...snapshotRef.current, error: message(e), settled: true }, { override: true });
  }
});
```

On a **failed refresh, keep the cached value and set only `error`.** An empty bank list says
"this shop takes no transfers", which is a worse and more confident lie than "the refresh
failed".

Reading the current snapshot inside a loader needs a **ref**, not the value — the loader writes
the snapshot, so depending on it is an infinite refetch loop.

### 2.4 A cached list resets when the QUESTION changes

`usePaginatedList` skipped its fetch whenever rows were already restored. Right for a remount.
Wrong for a `deps` change — and it shipped:

- The product picker **stopped searching**. Typing "co" showed the previous search's rows.
- A store switch **would have kept the previous shop's customers** under the new shop's name.

`deps` are now compared explicitly: same question and rows already here → keep them; different
question → reset regardless of what is on screen.

**Any list whose `deps` include a search term passes `persist: false`.** The term is not part of
the cache key, so restoring means answering one query with another query's results. Browse lists
persist. Questions do not.

### 2.5 `ttl` deletes live state

`setTTL` schedules a timer that **deletes the value from memory and storage and re-renders
subscribers with `null`** — while the app is open. It is not a staleness marker. Do not put
`ttl` on a data cache. Use it only for deliberately expiring flow state (OTP, signup steps).
Freshness comes from `revalidateOnMount` and explicit invalidation.

### 2.6 Invalidation, not polling

**Polling is banned.** A write knows it happened; it says so.

```ts
export function accountsChanged() { void StateStack.core.clearScope(ACCOUNT_SCOPE); }
```

Existing invalidators: `accountsChanged()` (money/customers), `catalogChanged()` (products),
`settingsChanged()` (bank accounts, staff, shop settings — clears the whole settings scope
deliberately, because configuration is read together and written rarely).

state-stack scopes in use: `sell_flow`, `stock_flow`, `catalog_flow`, `customer_flow`,
`money_flow`, `settings_flow`, `search_flow`, `storefront_flow`, `receipt_flow`, `list_flow`.

`AuthProvider` holds `STORE_SCOPED` — the scopes cleared when the active store changes. **A new
scope holding store-specific data must be added to that list**, or switching shop will leave the
previous shop's data on screen.

Note that **navigation-stack object scopes are a different namespace** from state-stack scopes.
`{ global: true, scope: 'customers' }` on a `provideObject` has nothing to do with the
`customer_flow` state-stack scope, and clearing one does not touch the other. Object scopes in
use: `customers`, `catalog`.

### 2.7 What legitimately stays in `useState`

Not everything belongs in state-stack. Keep local:

- **Form drafts and typed input** — a keystroke is not fetched data.
- **Error/`problem`/`busy` slots for an action** — they belong to the tap that caused them and
  should not outlive the visit. Keep a *load* error (belongs to the cached value) separate from
  an *action* error (belongs to this visit); sharing one slot resurrected a stale "could not
  approve" from cache over a queue that had since loaded fine.
- **App-lifetime providers** (`AuthProvider`) — never unmount, nothing to restore.
- **Deliberately fresh reads.** `TakePayment` fetches the pre-sale balance each time the sheet
  opens: it is a decision input at that moment, not a value to cache.

---

## 3. navigation-stack

`@academix-admin/navigation-stack`. Stacks live in `src/app/(app)/main/<name>-stack/`, each a
`NavigationStack` with a `navLink` map from route key to component.

Every tab stack **stays mounted** so switching is instant and each tab keeps its scroll and
history. That is why stale data is a real problem here, and why `usePageLifecycle` exists.

### 3.1 A push carries an id and an intent — never a record

Reference implementation: academix-web's `payment-transactions.tsx` (provider) and
`view-transaction-page.tsx` (consumer).

```ts
// PROVIDER — the list that legitimately has the data
useEffect(() => {
  if (rows.length === 0) return;
  return nav.provideObject(
    'getCustomerById',
    () => (id: string) => rows.find((r) => r.id === id),
    { global: true, scope: 'customers' },
  );
}, [nav, rows]);

nav.push('statement_page', { id: c.id });          // ← ID ONLY

// CONSUMER
const obj = useObject<(id: string) => Row | undefined>('getCustomerById',
  { global: true, scope: 'customers' });
const fromList = obj.isProvided ? obj.getter()?.(id) : null;
const name = fromList?.display_name ?? myOwnRead.name ?? 'Customer';   // ← FALLBACK
```

Three non-negotiables:

1. **`{ global: true, scope: '<name>' }` when provider and consumer are in different stacks.**
   The default page scope is addressed by the *provider's page uid* and is unfindable from
   another stack.
2. **Always a database fallback.** `isProvided` is false on a cold start, a deep link and a hard
   refresh. A getter is an optimisation, never the source of truth. This is verified by a probe
   that opens a statement URL in a **fresh browser context**.
3. **One key, one provider shape** — §2.2 applies to objects too. Both customer lists publish
   `getCustomerById` through the single shared `src/lib/stacks/customer-directory.ts`.

Why params are wrong for records — all three were live bugs:

- **Stale.** `account_action_page` received `{ id, kind, owed }`. `owed` was a balance frozen at
  tap time, displayed directly above the box where somebody types how much is being paid.
- **Editable.** The stack serialises params into the address bar, so `statement_page`'s `name`
  made the page title a string anybody could type.
- **Lossy.** Only what someone remembered to pack travels; every new field means editing every
  push site, and the missed ones fail silently with a default.

`kind`, `fresh`, a prefill string the user typed — these **are** navigation intent. They belong
in params.

### 3.2 `provideObject` carries callbacks too

There is no push-for-result in the API: `nav.push` resolves when the page appears, not when it
is finished with. So the caller publishes a callback and the pushed page calls it.

The sell page publishes `onProductSaved` under `{ global: true, scope: 'catalog' }`;
`product_form_page` picks it up with `useObject` and calls it after saving. That is what puts a
product created mid-sale straight onto the receipt.

Provide it **once**, pointing at a ref that is reassigned every render. Re-providing on every
render captures a stale closure; providing once without a ref captures the first render's copy
of every order and line it touches.

### 3.3 Lifecycle, not timers

```ts
usePageLifecycle(nav, {
  onResume: () => { void reload(); },              // RELOAD, do not clear (§2.3)
  onExit:   () => { void StateStack.core.clearScope(scope); },
}, [reload, scope]);
```

Wrapped as `useLiveRefresh(nav, reload, { scope })`. `onResume` reloads over what is on screen;
`onExit` drops the scope, because leaving for good is the honest moment to forget.

`useLocation()` returns the **top** entry's params. `usePageState(nav).isActive` and
`nav.isTop()` answer "am I the visible one".

### 3.4 Pages versus sheets

**A form is a page. A choice is a sheet.**

A form has typing to lose and a draft to preserve; on a 390px phone the keyboard covers the half
you are typing into, dragging to reach a field reads as a dismiss gesture, and there is no back
button. A page gets a title, a back arrow, the whole screen and a URL, and survives a rotation
and a reload.

Already moved to pages: `account_action_page`, `count_entry_page`, `product_form_page`.
Legitimately still sheets: the product picker, the customer picker, the payment sheet.

If a sheet genuinely needs one field, that is fine — bottom-viewer 0.3.2 keeps a focused field
clear of the keyboard and stops a touch on it dismissing. Five-field forms are not that.

---

## 4. The `@academix-admin/*` packages

Installed here (check `package.json` for live versions):

| Package | Use |
|---|---|
| `navigation-stack` | stacks, pages, params, objects, lifecycle |
| `navigation-bar` | the tab bar; owns ONE floating slot (the circular action) |
| `state-stack` | all fetched state |
| `header` | page headers and header actions |
| `search-viewer` | full-screen search sheets |
| `selection-viewer` | pick-one-from-a-list sheets |
| `bottom-viewer` | general bottom sheets |
| `dialog-viewer` | dialogs |
| `modal-sheet` | the primitive under the viewers |
| `sidebar` | side navigation |

### 4.1 The Library Charter

Every package is **public-first, app-agnostic and non-breaking**. A package must never learn
about store-manager. When store-manager needs something a package does not do, the package gains
a *general* capability and store-manager uses it.

Worked example: the tab bar covered our floating total. The fix was **not** a
`floatingButtonAboveBar` prop that encodes our specific layout — it was
`onVisibilityChange({ hidden, height, mode })`, a bar reporting its own state, which any consumer
can use. Our `FloatingAmount` listens and positions itself.

The corollary: **do not publish an API with no consumer.** A `floatingButtonAboveBar` prop was
added and then reverted for exactly this reason.

### 4.2 Changing a package

1. Edit in `academix-ui/packages/<name>/src/`.
2. Add tests. **Mutation-test them** — remove the fix and confirm the test fails. A test that
   passes with and without the fix is documentation, not verification.
3. `npm run build && npm run typecheck && npm run test` at the `academix-ui` root (workspace-wide,
   so cross-package resolution is exercised).
4. **Bump the version. Never downgrade** — bottom-viewer was once blind-bumped 0.3.0 → 0.2.1.
   Check the published version before choosing the next one.
5. Publish from the **root** with the workspace flag:
   ```
   cd academix-ui && export NPM_TOKEN=<from academix-web/.env.local> \
     && npm publish --workspace @academix-admin/<name>
   ```
   Do **not** publish with `--userconfig <temp npmrc>` from the package directory — it bypasses
   scope resolution and 404s even when `npm whoami` succeeds.
6. Bump the dependency here and `npm install`.

`npm publish` is an external, hard-to-reverse action: confirm with the user each time.

**Known:** `academix-ui` commits are local only. Pushing 403s because `jimstech4u` has no access
to `academix-admin/academix-ui`. npm publishing works.

---

## 5. Supabase

Postgres with RLS. Migrations in `supabase/migrations/`, numbered.

- RPCs are `SECURITY DEFINER` with a **pinned `search_path`**.
- **Server-authoritative.** Read the caller from `auth.uid()`. Never accept a client-supplied
  `p_user_id`, role, or permission — the client asks, the server decides.
- The ledger is **append-only**. Nothing in this product destroys a record; corrections are new
  entries. Voided, not deleted.
- The user has **pre-authorised live RPC/schema deploys** via the Management API. Do not stop to
  ask again.

---

## 6. Verification

**Click-through with Playwright is the standard of proof here.** `tsc` passing is not evidence
that a screen works; a screenshot of the screen working is.

Probes live in `scripts/probe-*.mjs` and take a base URL:

```
node scripts/probe-hydrate.mjs http://localhost:3100
```

| Probe | Covers |
|---|---|
| `probe-hydrate` | data is drawn immediately on return from a push; no empty flash |
| `probe-objects` | the add form is a page; the shared picker; id-only pushes; **cold deep link** |
| `probe-keyboard` | sheets with fields survive typing; forms that moved are not dialogs |
| `sale-scenarios` | the sale flows end to end |
| `probe-money`, `probe-search`, `probe-sheet`, `probe-picker`, `probe-people` | per-area |
| `scenario-irekanmi` | the full business walkthrough |

### 6.1 Write probes that can fail

A probe that cannot detect the bug is worse than none, because it reports success. Two real
examples from this codebase:

- `probe-hydrate` originally waited 3s after a pop and asserted the page was populated. That
  passed **before and after** the fix, because a refetch finishes inside 3s. It now samples the
  DOM every 100ms over the first 600ms — the only window where a cache and a refetch differ —
  and was mutation-tested by reinstating the blanking loader (`100ms:0r/0`).
- `probe-objects` reported 2/2 while silently skipping its only interesting step, because the
  customer it picked had no receipts. It now searches for one that does.

Also: never assert on a fixed sleep for anything network-dependent. Wait for the element.

### 6.2 Harness traps that have cost time

- **`:visible` excludes `position: fixed`.**
- **Every tab stack stays mounted**, so an unscoped `.first()` matches a *hidden* tab's element.
  Scope the selector.
- **`scrollTop = 0` on a container already at 0 fires no event.** Nudge down, then up.
- **The nav param is compact** (`stock-stack:1.a1.d1`) — one segment per entry, never the route
  key. Assert on depth.
- **Kill stale `next start` processes before probing.** They serve old chunks and produce
  failures that are not in the code:
  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*next*start*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  ```

### 6.3 Before saying it is done

```
npx tsc --noEmit          # 0 errors
npx next lint             # 0 warnings
npx next build            # compiles
node scripts/<probes>     # the affected areas, clicked through
```

---

## 7. House style

- **Comments explain WHY, and name the failure.** "Kept apart because a browse list is worth
  restoring and a set of results for a term they have since cleared is not" beats "// cache".
  A rule without its reason gets deleted by the next person.
- **Write in the register of the product.** This is software for a shop counter. "What they
  already owed", not "opening balance adjustment".
- Match the surrounding file's comment density and naming.
- CSS Modules; design tokens (`var(--space-3)`, `var(--text-sm)`, `var(--surface)`), not literals.
- Every page gets `padding-bottom: var(--nav-height)`. No override may cancel it.
- **Dead code goes to project-root `_unused/`** with a `MANIFEST.md` row. Never straight-delete.

---

## 8. Environment

- Windows. PowerShell and Git Bash are both available and take **different syntax**.
- **The Bash tool collapses backslashes in heredocs.** `'\\n'` arrives as a real newline and
  breaks scripts. For anything with escapes, write a `.py` file to the scratchpad with the Write
  tool and run it. This has bitten repeatedly.
- Dev server on **port 3100**. Credentials for probes: `SAMPLE_EMAIL` / `SAMPLE_PASSWORD` in
  `.env.local`.
- `git push` to this repo sometimes fails with an HTTP/2 framing error or a 408 and still exits
  0. **Verify with `git status -sb` or `git ls-remote`** — do not trust the exit code.

---

## 9. Open threads

- `academix-ui` needs a push; requires a token with `academix-admin` access.
- `scenario-irekanmi` reaches 19/22; the remaining failures are the harness's customer-attach at
  step 8, not the app.
- The pagination assertion in `probe-hydrate` is weak — the debtor list loads all its rows in one
  page, so "came back paged" passes without a second page ever being fetched. It proves nothing
  was lost, not that a cursor was restored. Needs a store with more rows than one page.

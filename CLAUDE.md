# store-manager

**Read [INSTRUCTIONS.md](INSTRUCTIONS.md) before writing code.** It carries the full rules and,
more importantly, the bug behind each one. What follows is only the part that must not be got
wrong even by a session that reads nothing else.

## The two hard rules

1. **state-stack is the state management tool.** Fetched data does not live in `useState`.
   `useDemandState` from `@academix-admin/state-stack`, with a `key` and a `scope`.
2. **`nav.push` carries an id and a navigation intent. Never a record.** Records travel through
   `nav.provideObject` / `useObject` — always with a database fallback, because `isProvided` is
   false on a cold start and a deep link.

## The traps that have actually cost time

- **One key = one hook = one shape.** Two `useDemandState` calls on one key with different value
  shapes is a data race invisible to `tsc`. It white-screened the bank page. If two screens want
  the same data, hoist one owning hook into `src/lib/stacks/`.
- **A loader must never blank before it fetches.** Pushed-under pages stay mounted, so a page
  returning from a push has not remounted — a blank on the way back is a loader clearing state,
  not a lost `useState`. On a failed refresh, keep the cached value and set only `error`.
- **No polling.** A write invalidates a scope (`accountsChanged()`, `catalogChanged()`,
  `settingsChanged()`); `usePageLifecycle`'s `onResume` reloads.
- **`ttl` deletes live state**, it does not mark it stale. Keep it off data caches.
- **A form is a page. A choice is a sheet.**
- **The Library Charter:** `@academix-admin/*` packages are public-first, app-agnostic and
  non-breaking. A package never learns about store-manager.

## A change this device made is already known — do not go and ask

state-stack is reactive. A write patches the cache the screen is already holding; it does not
invalidate it and wait to be told what just happened.

This was wrong in four places at once and produced one symptom every time: **the shop had to
reload the page.** Add an item and press Back — the list does not have it. Invent a unit and return
to the picker — never heard of it. Rename something — the old name. Remove something — still there,
so remove it again.

The rule:

- **The writer knows the row.** A page that saves knows the id it touched and what it now says, so
  it says so: `useListNotifier` → `upsert` / `patch` / `remove`, which patches the list in the
  state it already holds. Nothing is fetched and no scroll position is lost.
- **Hand back the whole row, not an id.** The product form used to return `{id, name}` on the
  reasoning that a new item's cost and stock are computed elsewhere and inventing them would put
  wrong numbers on screen. That is true of an item that has TRADED. One created ten seconds ago has
  nothing on the shelf and nothing spent on it — saying so is the only correct answer, not a guess.
- **Invalidate only what the server computes.** `catalogChanged()` now notifies a DERIVED scope —
  stock on hand, landed cost, which units something sells in. The lists are not in it. Notifying
  the scope the paginated list lives in means every save costs a full re-read to learn something
  this device decided.
- **Another device is the exception.** Its changes arrive on the next genuine read — `onResume`,
  or a reload somebody asked for. That is a real trigger; our own writes are not.

`scripts/probe-no-round-trip.mjs` holds the line: it **watches the network**, not the pixels, and
fails if a list-read RPC fires after an add, a rename or a new unit. "It appeared" is not the
claim; "it appeared without asking" is.

## A screen for everything the shop can do, and nothing it cannot

The database is ahead of the screens, and silently. A shop can invite staff, hold deposits, agree a
price with one customer, read its own audit log and take back a shared receipt link — all built,
permissioned and tested — and reach none of it. Nothing fails; the capability simply has no door,
so nobody knows to ask for it.

**[UI_AUDIT.md](UI_AUDIT.md) is the standing list**, and `scripts/audit-ui.py` regenerates the raw
scan. Run it after any migration that adds a function or a table. The scan over-reports on purpose
— a helper called only from SQL is not a gap — so the file records the READING of it, and what was
ruled out, so the next pass does not re-raise the same rows.

Both directions count:

- **Backend with no UI.** A migration that ends without a screen is half a feature. If the screen
  is genuinely for later, say so in UI_AUDIT.md rather than leaving it to be rediscovered.
- **UI with no backend, or with none left.** `formatQtyWithPack` still describes the
  one-pack-per-product model that no longer exists. Dead code goes to `_unused/` with a MANIFEST
  row, never a straight delete.
- **UI wired to nothing.** The product form sends `p_category_id: null` on every save, so a
  category can be displayed and never chosen. A field that cannot change anything is worse than a
  missing one, because it looks answered.
- **An API with no consumer is a bug in the same family.** Two RPCs added in one session had no
  caller by the end of it. The Library Charter says do not publish one; the same applies to SQL.

## Things that were got wrong, with the reason

Each of these was a real defect found by clicking, not by reading. The reason is the part worth
keeping — the rule alone is forgettable, the bug behind it is not.

- **A page never clears a scope it does not own.** `useLiveRefresh` took a `scope` and cleared it
  in `onExit`. The account page cleared `customer_flow` — where the People list and the customer
  picker both live — so opening somebody's account and pressing Back deleted the list of everybody.
  Signing out and switching shop are the only things that legitimately delete cached data.
- **"Something changed" means re-read, not delete.** `catalogChanged()` and friends called
  `clearScope`, which throws the cached values away. For a hook that refetches on mount that is
  merely redundant; for a paginated list it destroys the reader's place. They publish to
  `invalidate()` now and holders call their own `refresh()` — which keeps the rows on screen while
  they are corrected, per the older rule that a loader must never blank before it fetches.
- **A callback published once is found by everyone.** The customer form handed its result back
  through a session-wide `onCustomerCreated` that the sell screen publishes and never withdraws, so
  a form opened from the People tab attached the new customer to whatever sale happened to be open.
  When a pushed page hands something back, the CALLER states the intent in the push
  (`then: 'attach-to-sale'`), and a caller that says nothing gets nothing.
- **Popping a pushed page destroys what was typed on it.** Choosing a customer from Take payment
  popped back to the till because the picker lived there, discarding the charge and note already
  entered. If a screen needs a choice, the sheet opens ON that screen.
- **The measuring unit must be one the shop sells.** The units screen exempts one unit from having
  to be measured; picking it by size alone landed on a bought-only unit, which is exactly the kind
  that must be answered for — the screen then demanded an answer it gave no way to give.
- **Copy a working SQL function verbatim and change one line.** 0058 rewrote `save_draft_order`
  "more tidily", changed the parameter order, created a second overload, and PostgREST answered 300
  to every call — the till stopped saving. 0059 restored it from memory and lost the idempotency
  lookup. Diff the new definition against the old before applying, and check the live overload
  count is still 1.
- **A guard must not fail open.** `assert_product_units_settled` asked a membership-filtered reader
  for gaps; RLS removed every row before it could see one, so a product with stranded stock saved
  cleanly reporting nothing wrong. Checks answer honestly for any caller and are reachable only
  from SECURITY DEFINER; readers keep the membership test, because empty is the right answer to a
  READ and a lie as an answer to "may this save?".
- **A probe that cannot fail is worse than no probe.** One asserted a form value against
  `innerText`, which never contains an input's value, and reported data loss that had already been
  fixed. Another used `getByRole('button', { name: 'Sell' })`, which matches SUBSTRINGS, and hit
  "Close this tab without selling" — opening a dialog that then looked exactly like the bug being
  hunted. Mutation-test every probe by restoring the fault, and make the mutation faithful: a
  half-restored one passes and proves nothing.
- **Probes clean up after themselves.** `stock_movements` is append-only and refuses deletes, so a
  probe that received stock cannot remove its product — five "Cost probe" items sat in the shop's
  real picker, and ninety-three empty draft tabs accumulated in the customer bar. Retire what
  cannot be deleted, and cancel the tabs a run opened.

## The library comes first

`@academix-admin/*` is not a folder of helpers to reach past. Before building anything that looks
like a sheet, a picker, a list, a dialog or a nav surface:

1. **Read what the package already does.** Its source and its README, not a guess from the name.
   Most of what gets hand-rolled here already exists — `selection-viewer` brings its own search
   box, and a second one was built on top of it before anybody looked.
2. **Use it.** The site uses `selection-viewer`, `search-viewer`, `bottom-viewer` and
   `dialog-viewer`. A hand-made bottom sheet is a bug, not a shortcut.
3. **If the capability is missing, or the package is wrong, FIX THE PACKAGE.** Not a wrapper, not
   a copy, not a `!important` in app CSS reaching into the package's DOM. Make the change
   non-breaking — additive props with defaults that preserve today's behaviour — then publish it,
   then depend on the published version. A patch in the app is only acceptable when a library fix
   is genuinely impossible without breaking the library.
4. **A package never learns about store-manager.** That is the Library Charter, and it is what
   makes 2 and 3 safe to do.

## One composer, not a wall of boxes

A list of things the user adds — fees on a delivery, payments on a sale, charges on an order — is
**one set of inputs and an Add button**, with what has been added listed above it. Never a fixed
row of boxes per possible kind: nobody can name every fee a load might carry, and a screen that
tries has ten empty fields on it for the nine that do not apply this time.

The shop names each one as it adds it. That is also why the fees are stored by name rather than
summed into a total — "loading" and "union levy" mean something to the person reading it back.

## Verification

Click-through with Playwright is the standard of proof — `tsc` passing is not evidence a screen
works. Probes are `scripts/probe-*.mjs`, dev server on port 3100. Write probes that can actually
fail: mutation-test them by removing the fix. See INSTRUCTIONS.md §6 for the harness traps.

Before saying it is done: `npx tsc --noEmit`, `npx next lint`, `npx next build`, and the probes
for the areas touched.

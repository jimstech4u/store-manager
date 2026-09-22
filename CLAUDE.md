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

## Reads say nothing until they know, and writes land here first

- **A read goes through `useResource`** (`src/lib/stacks/resource.ts`) or `useLoadArea`: `null`
  until the first answer, persisted, a failed refresh keeps what is shown, Try again is `reload()`.
  **Never a made-up `0` or `[]`.** Take payment read a customer's balance with the failure
  swallowed as `Number(data ?? 0)`, so a read that did not arrive said "owes nothing" — and that
  zero decided whether money handed over was change or a debt payment, and was patched into the
  lists as their balance. The stock screen said "worth ₦0", Deposits "held ₦0", Empties "nothing is
  out" before their first answer. A loader, or "Checking…", until `loaded`.
- **A `reload` that does not reset the demand does nothing.** Seventeen hooks handed out their `load`
  as `reload`; `demand()` skips a key already demanded, so every Try again and every refresh on
  resume was a no-op — which is why another till's sale, deposit or count never arrived. Use
  `useReload` (older hooks) or `useResource` (does it itself).
- **The writer applies what it did everywhere it shows** (`src/lib/stacks/local-effects.ts`), then
  invalidates for the server's word. A sale moves stock, a balance, containers and a deposit on this
  phone the moment it settles; a product or customer edit renames every list that names it.
- The full pattern: `USAGE_PATTERN.md` → state-stack → *store-manager: `useResource`*.

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
- **A sheet's back-gesture handling is a LIBRARY capability, not app code.** Seventy lines of it
  lived in `src/hooks/useOverlayRoute.ts`, carrying three fixes that each cost a production bug.
  It is now `@academix-admin/overlay-route` — `useOverlayRoute(name, open, onClose, {onRestore})` —
  and the viewer packages take a `historyRoute` prop that wires it. Import it from
  navigation-stack (which re-exports it and registers its pop ledger behind it) and the overlay's
  history entry is counted by every pop. Never re-implement this in the app.
- **An overlay the URL still names after a reload costs a Back press.** A fragment survives a
  reload, so the shop comes back with `#ax=…` naming a picker that did not reopen — standing on
  that picker's own history entry. The next Back spends itself closing a sheet that is not there,
  so leaving one page takes two presses. The library settles this itself now: an overlay
  on screen claims its name, and anything left unclaimed after the first frames is closed. A sheet
  that CAN come back passes `onRestore` and a name that is stable across loads — store-manager's
  are not (`picker:${useId()}`), so its sheets are transient by design.
- **Copy the working function and add; do not tidy it.** 0080 needed two columns on
  `save_product_units`. The copy "improved" the key its second pass reads from `defined_against` to
  `defined_against_store_unit_id` — a name the client has never sent — so the null branch would
  have fired for every shape on every save and silently erased every relationship in the shop.
  Every crate would have forgotten how many bottles it holds, and nothing would have raised. This
  rule was already written down, from 0058, and it still caught me. A round-trip test (save it back
  unchanged, assert the tree survives) is the cheap way to know.
- **A hook that returns a fresh object every render must not pretend otherwise.** `useProblem`
  was wrapped in `useMemo` so callers could safely list it as a dependency — and it could not
  deliver that, because its `controller` comes from `useDialog`, which returns a new object every
  render. The memo changed every render too. On the return-units page the effect depending on it
  FETCHED, so every keystroke reloaded from the server and overwrote the row just added: the
  composer cleared, the list stayed empty, nothing saved, and nothing looked broken. Depend on
  `problem.show` bound to a local const — `useCallback(..., [])`, genuinely stable. A memo that
  quietly does nothing is worse than none, because it invites the dependency that breaks.
- **`history.go(-n)` counts the browser's entries, not yours.** navigation-stack keeps a log of
  the entries it wrote so a pop can name its target rather than count. Two writers were not
  declaring themselves to it — a tab switch (which restamps the current entry's serial) and an
  overlay push (a picker, a sheet). From the first undeclared write the log could no longer find
  where it was standing, so every pop silently fell back to counting, and the count was right
  about the number and wrong about whose entries it was counting. Symptom: **Back on one tab
  landed on another** — two tabs one page deep each is enough. Fixed in 0.15.1–0.15.3; the cases are
  `test/group-reselect-pop.test.tsx`, `test/overlay-entry-ledger.test.tsx`,
  `test/entry-log-edges.test.tsx`, `test/entry-log-epoch.test.tsx` and
  `test/pop-lands-clean.test.tsx`, while `scripts/probe-tab-reselect.mjs` and
  `scripts/probe-reload-overlay.mjs` hold the same ground in the app, browser Back included.
  Serials are now scoped to the document that issued them, because the counter restarts at 0 on a
  reload while the browser's entries keep their old numbers — the same number meaning two
  different entries is how a log answers confidently and wrongly.
- **A section must not delete itself as it is filled in.** "Where are the 9 pieces?" was gated on
  the shortfall still being non-zero. Typing the write-off balanced the count, the gate went false,
  and the whole block unmounted — taking the money box with it, so the one question it existed to
  ask could never be answered. Gate a form on whether it has been STARTED, not on whether the
  condition that raised it is still true.
- **A cleanup that does not check is worse than none.** The deposit probe snapshotted the shop's
  draft ids, diffed afterwards, and printed "nothing left behind" — while leaving an order every
  run. PostgREST caps a response at **1,000 rows**, this shop has 1,057 drafts, and both reads were
  silently truncated, so the new order fell outside the window. No error, no empty result, just a
  window that quietly stopped covering the thing being looked for. Keep the id when you write the
  row rather than searching for it after, and finish by READING what is still there and saying so.
- **A fix in the handler is not a fix if an EFFECT re-does it.** `addUnit` was corrected to add a
  shape linked to nothing; the shape builder still ticked "crates go inside something bigger" on the
  crate, and the box could not be unticked — unticking cleared the link and a normalising
  `useEffect` re-made it on the next render. The effect was written when a shape declared what it
  was MADE OF, where "the first unit measures everything else" is arguable; once a shape declared
  what it GOES INSIDE, the same write meant the opposite. **Grep for every writer of the field
  before believing a fix**, and reread the effects a model change leaves behind — one that is merely
  redundant under the old meaning is actively wrong under the new one.
- **A probe must target the shop it signs INTO.** `admin.from('stores').select('id').limit(1)` is
  whichever row the database hands back first, and stopped being the sample account's shop the day a
  second shop existed. The units were created somewhere the browser could not see, so the picker
  answered "No unit by that name" and it read like a broken search. Take the store from
  `my_membership` on the signed-in client.
- **`fullPage` is the document, and these pages scroll inside a container.** Every screenshot came
  back the same 844px of viewport with the card being asserted about off the bottom. Screenshot the
  ELEMENT — `locator.screenshot()` after `scrollIntoViewIfNeeded` — which is also how a shape
  builder is read: one card at a time.
- **Measure a clipped control against something that did NOT move.** The parent row overflowed the
  card, so the delete button sat 99px off a 390px phone with nothing to scroll to reach it. The
  first check compared it to the ROW's right edge — and an overflowing row is wider, so its edge
  moved out to wherever the clipped controls ended up and everything was inside it by definition.
  It passed with the fault restored. Compare against the card, or the viewport.
- **`1fr` is `minmax(auto, 1fr)`.** A grid column holding a `<select>` is floored at its LONGEST
  OPTION, so the row grew with the shop's own words: short names fitted, real ones pushed the
  controls off the screen. `min-width: 0` on the item, or a wrapping flex row, and mutation-test it
  by removing BOTH — leaving the zero minimum in place while reverting the display made the fault
  un-restorable and the test meaningless.
- **Probes clean up after themselves.** `stock_movements` is append-only and refuses deletes, so a
  probe that received stock cannot remove its product — five "Cost probe" items sat in the shop's
  real picker, and ninety-three empty draft tabs accumulated in the customer bar. Retire what
  cannot be deleted, and cancel the tabs a run opened.

## The library comes first

`@academix-admin/*` is not a folder of helpers to reach past. Before building anything that looks
like a sheet, a picker, a list, a dialog, a nav surface or a state hook:

1. **Read [`../USAGE_PATTERN.md`](../USAGE_PATTERN.md) first**, then the package's source if you
   need more. That file is written from the source and from how this app and academix-web actually
   use each package; several package READMEs describe APIs the code does not have (dialog-viewer,
   bottom-viewer, navigation-bar, sidebar, side-drawer), so do not trust a README over it. Most of
   what gets hand-rolled here already exists — `selection-viewer` brings its own search box, and a
   second one was built on top of it before anybody looked.
2. **Use it.** The site uses `selection-viewer`, `search-viewer`, `bottom-viewer` and
   `dialog-viewer`. A hand-made bottom sheet is a bug, not a shortcut.
3. **If the capability is missing, or the package is wrong, FIX THE PACKAGE.** Not a wrapper, not
   a copy, not a `!important` in app CSS reaching into the package's DOM. Make the change
   non-breaking — additive props with defaults that preserve today's behaviour — then publish it,
   then depend on the published version, and add the new capability to `USAGE_PATTERN.md`. A patch
   in the app is only acceptable when a library fix is genuinely impossible without breaking the
   library — and then it goes under that package's *Gaps* in `USAGE_PATTERN.md`, so the next person
   reads it as a workaround rather than the design.
4. **A package never learns about store-manager.** That is the Library Charter, and it is what
   makes 2 and 3 safe to do.

## A shape is defined once, and then given roles

A product's units are SHAPES: a crate, and the bottles inside it. `product_units` carries the tree —
`defined_against_id` is the parent, `defined_qty` is how many to it, `base_qty` is derived by a
trigger and never typed.

Everything else **selects** a shape rather than redefining one. Four roles, all flags on the shape,
all answered by the shop:

| | |
|---|---|
| `is_bought` | deliveries arrive in it |
| `is_sold` | customers buy in it, at `sell_price` |
| `is_counted` | the shop counts the shelf in it — a distributor counts crates, not bottles |
| `is_deposit` | deposits are held and given back in it — nobody holds money against one bottle |

Quantities a customer may buy are `whole_digit` plus `allow_quarter` / `allow_half` /
`allow_three_quarter` — ticking whole and half means 1, 1.5, 2, 2.5 and refuses the rest.

The editor was two lists, "Sold in" and "Bought in", with a note under the second explaining that
anything you also sell is "already above". That explanation was the design telling on itself. One
list now.

**A quantity is DECOMPOSED, never divided.** 1,196 bottles is "99 crates 8 bottles" — not "99.67
crates", which no shop has ever said and nobody can check against a shelf: the eight loose bottles,
the entire reason the figure is not round, vanish into a decimal. `stockInShapes` in
`src/lib/shape-quantities.ts` — pure, no imports, so it is testable as arithmetic — walks the tree
largest-first, drops shapes that divide to nothing, and says a sub-smallest remainder as a fraction
of the smallest shape the shop names. Stock below zero is said as ONE signed figure and not
decomposed, because "minus 1 crate 4 bottles" reads like something somebody could go and find.

The reader behind it (`product_selling_units`, 0084) returns every shape with ANY role, not only
sold ones: a shop selling Malta only in packs of 24 has no sold shape below a pack, so 250 cans read
"10 packs 0.42 packs". A shape's role is exactly the evidence that the shop has a word for it.

**A shape has to survive the whole chain, and it did not.** The till asked which shape and then
threw the answer away: `save_draft_order` was sent `pack_id` — the retired one-pack-per-product id
from before 0061 — and nothing else. So the draft could not store it, `settle_draft_order` could not
pass it on, the sale line had nowhere to keep it, and both public pages named quantities through
`product_packs`. Four places, one missing column, and the symptom in each was a different-looking
bug.

The costly one was not the receipt. Claiming an order read the shape back as null, so three crates
returned as three pieces at the same price each: the bill and the stock movement both fell by twelve
and nothing on screen looked wrong. A shop whose shapes were migrated from packs in 0061 still had a
pack for `to_base_qty` to multiply by and never saw it; a shop that DEFINED its shapes on this
software had no pack at all and got it on every sale.

`sale_unit_id` on `draft_order_lines` and `sale_lines` (0085), carried through settling (0086), read
by both public pages (0087). The server checks the shape belongs to the product rather than trusting
a client-authored id, and derives the base quantity from it when the caller did not send one.
`scripts/probe-shape-through-the-chain.mjs` writes a draft, reads it back the way a claiming till
does, and cancels it — it settles nothing, because a settled sale moves stock and nothing here can
move it back.

**Check what a reader RETURNS, not just that it ran.** The same probe found that
`deposit_ledger.direction` is `('collected','paid')` while `public_track_token` had been testing it
against `'out'` since 0064 — never true, so every empties figure on the customer's tracking page has
been negative for as long as the page has existed: "-10 NBL crate", with "-₦1,250" beside it. It was
caught because the block was copied into the new receipt reader and the first live call was read
rather than merely checked for an error.

**And it has to reach every screen that says it.** Four do — the stock list, a product, the count
screen, and the picker on a delivery — and after the list was fixed the other three were still
dividing or showing base units, importing the corrected function without calling it. The function
being right is not the claim; the screen saying it is. `scripts/probe-shape-read-ui.mjs` clicks all
four, and SUPPLIES the shelf by intercepting the read rather than writing one: no product in the
sample shop has two shapes and a remainder, and a round number reads identically either way, so the
same probe against the shop as it stands passes while proving nothing.

## One form per record, and it is a page

There is ONE product form and ONE customer form, and mid-sale reaches them by pushing the real
page with `{ required: 'minimum' }` — never a second, smaller form in a sheet. A quick-add sheet
existed and asked four questions where the real form asks eleven; two forms for one record drift,
always, and a sheet's local state does not survive a rotation.

`minimum` changes what is REQUIRED and what starts folded. It hides nothing.

**Required at a counter, and ZERO IS AN ANSWER.** What is on the shelf, whether the container comes
back, how many are already out, what the customer already owed. Blank is refused; `0` is accepted
and recorded. "None" and "nobody looked" are different facts, and a form that accepts a blank makes
every new record silently claim nothing is owed — right most of the time, and unrecoverable the
rest, because nobody goes back to check a blank they did not know they left.

A count of zero is a COUNT, not a movement: `stock_movements` refuses `qty_delta = 0` and is right
to, so `open_stock_by_count` writes the movement only when something moved and always records the
count.

**Every page is registered in every tab, once, in `src/app/(app)/main/record-pages.tsx`.** It used
to be per stack, and a page reached a second tab only after somebody hit navigation-stack's "Missing
route" screen on the one journey nobody walked. Now each stack's `navLink` holds its front page and
the pages it always had (via `tabRoutes`, in their ORIGINAL order), and `RECORD_PAGES` arrives
through `additionalNavLinks`. A new page goes at the END of `RECORD_PAGES`: the URL encodes a route
by its position, so inserting or reordering sends open URLs to the wrong page.

**A record's name opens it, wherever it is mentioned** (`RecordLink`): the customer on a receipt,
an item on a receipt or a ledger line, the supplier on a delivery. A page that belongs to a parent
record has a header action back up to it (a statement, empties or deposit page → the account; a
count → the item). The next record is one push away, and Back walks back through what was followed.

## Nothing sells off a shelf nobody has counted today

The count is a GATE, and it is answered by the server, never by a timestamp on a receipt or a draft.
`needs_count_today` asks one question — has somebody entered a count for this item on the shop's own
calendar day? — and three screens read the same answer: the till, the count page it pushes, and Take
payment. A sale left open overnight is checked against TODAY, which is the whole reason the earlier
version (a list the till built up as items were ADDED) was wrong.

- **The till counts ONCE a day, for everybody.** `count_from_till` locks the item, looks for today's
  count and refuses a second one with `unique_violation` — which the screen reads as "somebody
  already did this", names them, and carries on. Two tills on two receipts in the same second queue
  on the lock, and the second sees the first's figure. Mid-sale, with a customer waiting, a second
  figure is not a second count; it is a guess overwriting a fact.
- **The count SCREEN may count again, as often as the shop likes** — a delivery lands at two and the
  shelf is walked again at six, and both are real counts. Every fresh count after the day's first
  needs `counts.correct` (owner, manager), needs a reason, and writes the figure it replaces to
  `stock_count_edits` BEFORE anything moves. `counted_by`/`counted_at` on the period always say who
  walked the shelf this time; the trail says who said what before that, and why it changed.
- **There is one act, not two.** 0145 shipped a separate "correct this count" and 0146 dropped it:
  counting again with a reason IS the correction, and two ways to change one figure means two trails
  and one more thing to explain to a shop.
- **A guard on the server, not only on the screen.** A trigger on `sale_lines` refuses a line on a
  sale created in THIS transaction for an item nobody counted today. "In this transaction" is exactly
  `sales.created_at = now()`, so amending an old receipt stays possible whatever today's shelf says.
- **Say what happened, in the words somebody at the shelf would use.** The variance reasons are not
  ledger categories with labels attached: "Sold, but nobody entered it", "Broken or spoiled",
  "Stolen or missing" — each with what it does to the money underneath it, and only the ones that can
  be true of THIS gap (nothing is stolen when there is more on the shelf than expected).

## Three things happen to a container, and all three are recordable

It came back. It is still owed. Or it is GONE. The settle screen could record the first, records the
second by doing nothing — which is right, and must stay one keystroke of nothing — and had no answer
at all for the third unless the shop happened to be holding a deposit against it.

On trust, broken, paid for at the counter is the commonest case in this trade. With nowhere to put
it the containers stayed outstanding for ever against a customer who had already settled, so a
shop's "still out" list filled with obligations nobody owed and nobody could clear.
`deposit_forfeits` has existed since 0004 for exactly this — table, trigger, RLS policy, no writer.
0090 is its writer. The money is NOT recorded as a payment: it was handed over for broken bottles,
and allocating it would pay down whatever sale happened to be oldest.

**THE TWO SIDES NEVER ADD UP.** `they_hold` is ours, out with them; `we_hold` is theirs, left with
us. They settle separately — a customer holding 55 of our crates while we hold 65 of theirs owes 55
and is owed 65 — and `rollUpOwed` bucketed by maker and shape alone, so both screens said "120
crates still with them". A breakage fee is worked out from that figure. `side` is part of the bucket
key and rides out on every line; the empties screen and the account each list the two apart, and the
recording buttons act on what THEY hold, which is the only side those screens can settle.

**Returns are counted in SHAPES, one box each.** "Five crates and three bottles" is what somebody
says while stacking them by the door. One box in the pool's smallest unit made the seller multiply
by twelve and add, at a counter, and then told them the answer was not a shape the pool accepts. The
multiplication is said back on the page, because arithmetic nobody can see is arithmetic nobody
checks.

**Over-returning is a condition, caught before the button.** `settle_empties` refuses more than the
receipt sent out, and must — but a seller finding out from a red dialog has already counted the
bottles onto the counter. Usually it means the customer brought another receipt's worth too, which
is a real thing, settled receipt by receipt.

## A failure interrupts. A condition stays on the page.

**Something that FAILED opens a dialog** — `@academix-admin/dialog-viewer`, through
`src/components/ui/Dialog.tsx`. Not an `InfoPanel` somewhere on the page. A save that failed is a
one-off event that must be acknowledged before anything else continues, and a panel two screens
down gets scrolled past: the shop presses Save, sees nothing change, presses it again.

**Every confirmation is a dialog too** — no `window.confirm`, no hand-rolled overlay. A question
that must be answered before work continues is exactly what a dialog is.

**A CONDITION is not a failure and must not be dismissible.** "Some of this can come in but never
go out", "Enter your email address" — these describe the state the form is in, they stay visible
while they are being fixed, and a dialog would let them be dismissed with the problem still there.
Those stay as `InfoPanel`.

**The test is whether an ATTEMPT happened.** A condition is something the form can see about itself
without trying anything: a missing field, a unit with nowhere to go. A failure is what came back
from work that was actually done — a save, a sign-in, an upload. A first version of this rule asked
"would it still be true after pressing OK?", which sounds equivalent and is not: "that email and
password do not match" is still true afterwards, and it is unmistakably a failure. The signin form
holds both kinds in one variable and needs both surfaces.

"Could not load" is neither — and it is NOT a whole-screen replacement. **A page has one
`PageScaffold` and never returns early to draw a different one.** Its header — title, back,
actions — is drawn once and stays; the body switches through `<PageState status={status}>{() =>
content}</PageState>`: loading, or the error with Try again, or an empty state, or the content.
Pages used to `return <FullPageMessage/>` before their scaffold, which threw the header away — no
title, no way back while a read was in flight — and a first attempt at fixing that drew a SECOND
header around the message, which is the same mistake in a different place. academix-web's
`redeem-codes` is the shape: header, then exactly one of data > loading > error > empty.
`FullPageMessage` on its own is for screens with no header at all: the app opening, signing in,
the public receipt and shop pages.

The pattern is academix-web's, and it is worth reading rather than guessing:
`payment-stack/top-up-page` for errors (`const errorDialog = useDialog()`, `errorDialog.open(<…>)`,
`<errorDialog.DialogViewer title buttons showCancel closeOnBackdrop layoutProp />`) and
`profile-stack/profile-page/profile-title` for confirmations with a busy state on the confirming
button. The theme is handed over in `layoutProp`, because the package is app-agnostic by charter
and has no business reading store-manager's CSS variables.

## Green is what adds

Any control that turns what has been typed into a line — "Add charge", "Add payment", "Add this
fee", "Add an item", "Add another item" — is the PRIMARY button. A grey outline reads as "the
other option", the thing you press when you do NOT want the main one, and the seller who does not
press it has typed an amount that will not count. One shape, learnt once, everywhere on the site.

## An action ENDS the page. Nothing is pinned to the foot.

The commit button goes last in the flow, after the final question. There is no `footer` prop on
`PageScaffold` — it was removed rather than left unused, because a prop that exists gets reached
for, and every screen that had one has been migrated.

- **A pinned bar costs a row of the form on every phone, permanently.** The new-unit form is two
  fields long and was spending a fifth of its visible page keeping "Add it" reachable when it was
  never more than one scroll away.
- **It covers what is being typed.** With the keyboard up on a phone, a bar at the foot and the
  keyboard between them take most of what is left of the screen.
- **Scrolling to the bottom to commit is the honest gesture.** You have just been asked eight
  questions; the last thing you should see before saving is your answer to the eighth.

**The strongest argument for pinning is a live figure, and it still loses.** The claim screen showed
"This tab becomes ₦X" in a sticky bar because the total changes as lines are ticked — and the bar
sat over the last rows of the very list being ticked, so the choice at the bottom was made
underneath the readout of its own effect. The figure ends the page now, which is where somebody
looks when they have finished the list.

Sheets are not pages. A `BottomSheet`'s own actions belong at its foot — that is the shape of a
sheet. But what a sheet may HOLD is narrow:

- **No input inside a bottom viewer, ever.** Not a text box, not a date, not a checkbox. Anything
  typed is a form, and a form is a pushed page — a sheet's local state does not survive a rotation,
  and the keyboard covers the half being typed into. The count prompt on the till and the custom
  date range were both sheets with boxes in them; both are pages now (`count_gate_page`,
  `period_page`), and the photo check's "keep the background" tick became two buttons.
- **No confirmation or message in a bottom viewer either.** "Remove this account?", "Close this
  shop?", "Added" — those are `ConfirmDialog` / `ProblemDialog` (DialogViewer). An earlier version
  of this file called the bank, staff and product confirmation sheets "right as they are", and they
  stayed sheets because of it. A sheet is for CHOOSING from a list or VIEWING something; a question
  that must be answered is a dialog.

The one thing that legitimately floats is `FloatingAmount`, which is the running total on the till:
it is a readout, not an action, it is off to one side rather than a full-width bar, and the sell
screen's commit lives on `TakePayment` at the end of that page like everything else.

## A warning that cannot be turned off gets ignored

`InfoPanel` given an `id` folds to a single line, remembers whether this device opened it, and
offers **Stop showing me this**. The stock screen carried two open paragraphs above the list, so
the shop scrolled past its own stock to reach it — and read neither, which is how the NEXT
warning becomes furniture too.

- The dismiss lives INSIDE the panel, under the reason. You decide to stop seeing a warning after
  you have understood it, and it leaves the title the whole width.
- Dismissals are per DEVICE (`src/lib/hidden-notices.ts`, localStorage). "Do not show this on the
  till" is not "do not show this to the owner". Settings → This device lists what was put away and
  gives it back; add the id to `NOTICE_NAMES` so it can be listed by name.

## A form asks what it can answer for, and nothing else yet

The product form asked "On the shelf right now" before any shape was named — twelve of what? — and
the customer form asked "They already owe you" before anybody was named. In `minimum` mode, the one
a counter uses with somebody waiting, both were marked REQUIRED, so the fastest path through the
form demanded answers it had not made answerable.

Everything below the shapes is ABOUT a shape; everything below the name is about a person. Both wait
now, and say what they are waiting for — a form that silently grows as you type it is unsettling,
and a dashed line naming what unlocks the rest costs nothing.

- **Gate on the loosest honest signal.** The product form gates on one shape having a NAME, not on
  `unitProblems` returning null — that is the save rule and is stricter, and gating on it makes the
  sections flicker out while somebody is halfway through typing "12" into a crate. The customer form
  gates on the name being non-empty, not valid, so backspacing to fix a typo does not hide the form.
- **Gate on whether it was STARTED, not on whether the condition still holds.** See the empties
  screen: "Where are the 9 pieces?" was gated on the shortfall being non-zero, so filling in the
  write-off balanced the count and deleted the section — taking the money box with it.

## Nothing makes the shop leave what it is doing

An item or a customer can be created wherever one is chosen — the till, a delivery, a count, a
payment — and the flow carries on. The record lands unconfirmed for whoever may sign off. The
alternative is abandoning a half-entered delivery to file something on another screen, which is
how a load ends up on paper.

The picker offers adding BEFORE the list, not only after a search fails: the customer picker
always did, and the product picker made you fail first.

## One composer, not a wall of boxes

A list of things the user adds — fees on a delivery, payments on a sale, charges on an order — is
**one set of inputs and an Add button**, with what has been added listed above it. Never a fixed
row of boxes per possible kind: nobody can name every fee a load might carry, and a screen that
tries has ten empty fields on it for the nine that do not apply this time.

The shop names each one as it adds it. That is also why the fees are stored by name rather than
summed into a total — "loading" and "union levy" mean something to the person reading it back.

## An app on the phone, not a page in a browser

Installed (`src/app/manifest.ts`, `public/sw.js`), this opens from the home screen in its own window:
one tap beside WhatsApp instead of finding a tab. `InstallApp` offers it on the landing page and in
Settings — one tap on Android through `beforeinstallprompt`, and on iPhone the two steps Apple leaves
to us, since there is no install API there. Both disappear once it is installed.

**The installed app starts at `/main`, not `/`.** `/` is the public marketplace and knows nothing
about a session, so every launch of the installed app opened a shopfront with a Sign in button —
which reads exactly like being logged out, and was reported as that. Sign-in also sends anybody who
already has a session straight on, rather than asking for a password it does not need.

**AN INSTALLED APP UPDATES ITSELF, EXCEPT ITS MANIFEST.** Pages are fetched network-first, so a
launch with a signal always gets the newest build, and build files are content-hashed. The worker is
re-checked on launch (and at most daily), takes over at once and drops older caches. The MANIFEST is
the exception: Android re-reads it in its own time and iOS reads it once, at install — so a change
to `start_url`, the name or the icon never reaches a phone that installed before it. Anything that
must reach old installs has to be done IN THE APP: `/` sends a standalone launch to `/main` itself,
which is what heals every app installed while `start_url` was still `/`.

**INSTALLING IS PER-PLATFORM, and the app says which.** Android hands us the install itself
(`beforeinstallprompt`, only once the site qualifies: HTTPS, manifest with 192 and 512 icons, a
worker with a fetch handler) — one tap. iOS has no API at all and never has: Safari installs from
its Share sheet, so two steps is the shortest honest offer. Chrome, Firefox and Edge on iPhone
CANNOT install — the Home Screen is Safari's alone there — so they are told that and handed over
(`x-safari-…`, with the link to copy in case the browser ignores it).

**The service worker caches the SHELL, never the shop's data.** state-stack already keeps what each
screen read, in IndexedDB, and knows when it is stale; a second copy in a worker would be a second
answer to "what does this shop owe", ageing on its own. Pages are cached BY PATH: navigation-stack
writes the whole stack into `?nav=`, so caching by full URL stored hundreds of keys and matched none.
`/main` is precached and the current path is warmed on each move, because every screen after the
first is a client-side move the browser never fetches.

**A failed read must not decide who you are.** Offline the shop list could not be fetched, the list
was emptied, and the layout read "no shops" as "has not made one yet" — sending a signed-in shop to
the create-a-shop wizard over its own till. The list is now kept on the device per person, a failed
read keeps what it had, and `needsStore` requires an answer rather than an absence. Choosing WHICH
shop to open is about the list, not about the read that fetched it (`chooseStore`), or a cold start
with no signal chooses nothing and every page renders `null` behind the tab bar.

**Nothing pushes a page while the app is starting up.** The till offers its count screen when a line
needs counting, and guarded that on `nav.isActiveStack()` — which reports whether the stack syncs
history, true of all four tabs at once. On boot it pushed onto whichever tab the shop had actually
opened, and that history entry then swallowed the next Back press. `useIsActiveStack()`
(navigation-stack 0.19.0) is the question that was meant.

## Nobody meets a door they cannot open

Three layers, one map (`ROUTE_NEEDS` in `lib/permissions.ts`, each entry the permission that page's
own write checks in the database):

1. **The way in is not drawn.** A button, header action or row that would push a page this person
   cannot use is absent (`usePermission().canOpen(route)`), and a `RecordLink` to one reads as plain
   text. The pickers check for themselves, so no caller has to: `CustomerPicker` hides "Add a new
   customer", `ProductPicker` hides "Add".
2. **The page says so, under its one header.** `gatePage` wraps every such page in
   `record-pages.tsx`, for an old link, a URL, or a role that changed while the page sat open. Six
   pages say it in their own words instead (`SAYS_ITSELF`).
3. **The server refuses anyway.** The first two only save somebody the walk.

**The answer comes from the SERVER, not from the role.** `PermissionsProvider` reads
`member_permissions(store, me)` once per shop — the same rule `has_permission` enforces, role plus
that person's own ticks — and `usePermission` uses it, falling back to the role map only until the
first answer arrives. Asking the role alone was wrong in both directions: a manager whose Reports box
was unticked still saw the button and was refused, and a staff member given counting could not find
Count at all. `scripts/probe-permission-gates.mjs` makes a staff login with counting added and
deposits removed and walks the screens.

## Permission in a store says nothing about the ids you were handed

`has_permission(p_store_id, 'deposits.manage')` answers "may this person act in this shop". It does
not answer "is this customer theirs" or "is this pool theirs", and all four deposit writers trusted
both. A member of one shop could write rows into another shop's ledger, against another shop's
customer, into another shop's pool — and every READ is scoped by `is_store_member`, so the shop
being written to could not see how the rows got there.

`take_deposit` is the one worth remembering. It DID look the pool up by `(id, store_id)` — inside a
`coalesce`, to find a default rate:

    v_per := coalesce(p_per_unit, (select deposit from empties_categories
                                    where id = p_category_id and store_id = p_store_id));

Supply `p_per_unit` and the subquery never runs, so the check never happens. **A guard that only
fires when an optional argument is missing is not a guard.** It reads like one, which is why it
survived — and it took a benchmark with two shops in it to notice, because with one shop every id
belongs to you.

`assert_deposit_target` (0097) is called first thing, where no argument can skip it. The same
question asked of the two writers that move stock (0098) had a worse answer: a member of one shop
could SELL another shop's product off their shelf, BILL another shop's customer, and RECEIVE stock
into another shop's item — the last of those silently moving the average cost every margin of theirs
is computed from.

**A function that DERIVES the store cannot be lied to about it.** `settle_empties` checks the sale
against the store it was given and `save_product_units` reads the store off the product, and neither
needed fixing. That is the shape to copy: taking `p_store_id` as an argument and trusting the rest of
the payload is what created both holes.

## The benchmark never stops growing

`node scripts/run-scenarios.mjs` puts a week of trade through a shop it creates and drops. It is not
a test suite that gets finished — **every session adds to it**, and the rule is simple: anything that
could cost a shop money, stock, a container or a customer's trust gets a scenario, and the scenario
goes in whether it passes or not. A red scenario naming a real gap is worth more than no scenario.

It has already earned it several times over:

- **The clock.** Eight seconds of skew put a delivery outside the period that should have contained
  it; the count then wrote 147 phantom bottles into stock.
- **A sale had no correction path at all.** `sales.status`, `sales.revision`, `sales.amend_reason`
  and the `sales.amend` permission all existed; the function did not. 0094.
- **A cancelled receipt said nothing** on the copy the customer is holding — it read as a live bill,
  with the shop's bank account on it. 0095.
- **A product must be LINKED to a pool.** Ticking `is_returnable` says a shape comes back; it does
  not say into what, and without the link the containers leave and the ledger records nothing.

Two rules for writing one:

1. **Go through the RPCs the app calls, with the arguments it sends.** A harness that writes rows
   directly passes while the app is broken, which is the one thing a benchmark must never do.
2. **Assert the FIGURE, not that the call returned.** "A delivery can be recorded" passed while
   twenty crates came in as twenty bottles. "The landed cost is ₦370.83" did not.

## The clock belongs to the shop, not to the phone

A money event is stamped by the server. Every RPC that records one defaults `p_occurred_at` to
`now()`, and the app sends nothing — so it does not matter what a till phone thinks the time is.

The benchmark found this by tripping over it. The machine running it was **eight seconds** behind
the database, and eight seconds was enough to put a delivery and a sale outside the counting period
that should have contained them: the count read "you are 147 over", demanded a reason for a
discrepancy that was entirely the system's own arithmetic, and on closing wrote 147 bottles into
stock that had never existed.

The sale and delivery paths were already innocent. Five money writers were not — every action on a
customer's account, and settling empties — and a shop phone is routinely minutes out and not rarely
hours. The day a payment lands on is how a shop checks its drawer against its takings.

Backdating stays where it is meant to be: `backfill_debtor` and `backfill_empties` take an `p_as_of`
DATE, separately and on purpose, because "this is from the old book" is a thing somebody says
deliberately.

## Verification

Click-through with Playwright is the standard of proof — `tsc` passing is not evidence a screen
works. Probes are `scripts/probe-*.mjs`, dev server on port 3100. Write probes that can actually
fail: mutation-test them by removing the fix. See INSTRUCTIONS.md §6 for the harness traps.

**Port 3100 runs `next start`, not `next dev` — a BUILD, so an edit is not on it until you rebuild.**
A probe run against it after changing a screen tests the previous version, and says so in the
language of a defect: three screens were reported as still speaking in base units for twenty minutes
after they had been fixed, and the debug line added to find out why never appeared either. Rebuild
and restart before believing a UI probe, either way round — a PASS on a stale build is the worse
half of this, because nothing looks wrong.

Restarting means freeing the port, not launching another one. `next start` on a taken port logs
`EADDRINUSE` and exits while the OLD server keeps answering — on a `.next` the rebuild has already
replaced, so it serves HTML naming chunks that no longer exist and the page renders nothing a
locator can find. Kill the listener by port (`Get-NetTCPConnection -LocalPort 3100`), confirm it is
free, then start.

Before saying it is done: `npx tsc --noEmit`, `npx next lint`, `npx next build`, and the probes
for the areas touched.

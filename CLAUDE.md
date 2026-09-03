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
- **A cleanup that does not check is worse than none.** The deposit probe snapshotted the shop's
  draft ids, diffed afterwards, and printed "nothing left behind" — while leaving an order every
  run. PostgREST caps a response at **1,000 rows**, this shop has 1,057 drafts, and both reads were
  silently truncated, so the new order fell outside the window. No error, no empty result, just a
  window that quietly stopped covering the thing being looked for. Keep the id when you write the
  row rather than searching for it after, and finish by READING what is still there and saying so.
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

**Register a pushed route in EVERY stack that can push it.** The product form is reachable from
four; the unit form it offers to push was registered in two. The symptom is navigation-stack's own
"Missing route" screen, on the one journey nobody walked.

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

"Could not load" is neither — that is a whole screen with no content, so it is a `FullPageMessage`.

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

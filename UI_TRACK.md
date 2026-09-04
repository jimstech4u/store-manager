# The page-by-page walk

Every screen in the app, opened and looked at, checked against what the database behind it can
actually do. **This file is the record so the next session starts where the last one stopped**, and
does not re-walk ground already covered or re-raise something already ruled out.

- `[ ]` not walked yet
- `[~]` walked, findings open
- `[x]` walked, and everything found is fixed or recorded as deliberate

Every row carries a REASON, because the verdict alone is forgettable and the reason is the part the
next session needs. "Fine" is not a reason.

Screenshots go to the scratchpad, not the repository — they are evidence for the session that took
them, and a stale screenshot is worse than none.

    node scripts/walk-ui.mjs <stack>      # opens each page in a stack and photographs it

---

## What the first wave found

Every one of these was a screen that looked right. The base unit is how the arithmetic adds up, and
it kept leaking into the sentence — the stock figure, the cost, the price and the count box each
picked their own shape, so a single product page could say the shop buys pieces and sells crates
while every figure on it was individually correct.

`scripts/probe-shapes-everywhere.mjs` holds that ground now. It checks the RELATIONSHIP rather than
any one screen: every row in the stock list against its own product's shapes, then one product's
shelf, cost, price and count boxes against each other AND against the database — because a number
can be formatted perfectly, sit under the right label, name a real shape, and still be read from the
wrong column.

## How a page is judged

Four questions, in this order. A page can look right and be wrong on all but the first.

1. **Does it show what it claims?** Numbers in the shapes a shop counts in, money named rather than
   folded into a total, blanks distinguished from zeroes.
2. **Can the shop reach everything the page implies?** A screen that lists something it cannot edit,
   or names a capability with no control, is half a feature.
3. **Does the backend behind it have anything the page never offers?** This is `UI_AUDIT.md`'s
   question asked page by page rather than repo-wide.
4. **Do failures interrupt and conditions stay?** A failed save is a dialog; a state the form is in
   is a panel. `window.confirm` is neither.

---

## sell-stack

| | Page | Walked | What was found |
|---|---|---|---|
| `[ ]` | `sell_page` | — | |
| `[ ]` | `take_payment_page` | — | |
| `[ ]` | `receipt_page` | — | |
| `[ ]` | `claim_page` | — | |
| `[ ]` | `share_whatsapp_page` | — | |
| `[ ]` | `empties_page` | — | |
| `[ ]` | `empties_settle_page` | — | |
| `[ ]` | `sales_page` (shared) | — | |
| `[ ]` | `product_form_page` (shared) | — | |
| `[ ]` | `customer_form_page` (shared) | — | |
| `[ ]` | `unit_form_page` (shared) | — | |

## stock-stack

| | Page | Walked | What was found |
|---|---|---|---|
| `[x]` | `stock_page` | 2026-09-04 | Negative stock read **"−0.08 packs"** — true, useless, and one bottle. Cost read "₦5,068.80 per pack cost", a phrase nobody finished. Both fixed; a negative now reads in the biggest shape it is whole in ("−1 bottle", "−124 crates"). 120 rows checked: none names a unit its own product does not have.
| `[x]` | `product_page` | 2026-09-04 | **Three facts, three different shapes** — shelf decomposed, cost "per piece", price "1 pack". Read together: a shop that buys pieces and sells packs. All three were individually right. Replaced with ONE table, cost and price per shape. Price also came from `product.listPrice`, null since 0061, so a product priced per shape showed no price at all while its own list row quoted one.
| `[~]` | `receive_page` | 2026-09-04 | Empty state reads well, green primary. Not yet walked WITH lines on it — fees, supplier and the cost breakdown only appear then.
| `[~]` | `stock_history_page` | 2026-09-04 | Opens and lists movements with who and when. Quantities not yet checked against the shape rule.
| `[ ]` | `units_page` | — | |
| `[ ]` | `return_units_page` | — | |

## count-stack

| | Page | Walked | What was found |
|---|---|---|---|
| `[~]` | `count_page` | 2026-09-04 | Reads "records say" in shapes since the stock-read work. Reopening a closed count still has no door (`reopen_stock_period`).
| `[x]` | `count_entry_page` | 2026-09-04 | One box, fixed to the counting shape. A shelf of three packs and five loose bottles had to be entered as 3.208 packs — worked out in your head, in front of the shelf, on the one screen whose purpose is comparing what you see with what the records say. A box per shape now, and the question restored: replacing the field had taken its label with it.

## money-stack

| | Page | Walked | What was found |
|---|---|---|---|
| `[x]` | `money_page` | 2026-09-04 | Led with **"Owed by those loaded so far — ₦7,492,810"**: a sum over whatever pages of a paged list were in memory, so it grew as you scrolled. The real figure is ₦23,254,747.50 across 113 customers. `store_money_owed` (0091) computes it where the rows are, through the same `customer_balance_total` the list uses. Credit shown separately — netting it would understate the debt and hide the deposit at once.
| `[~]` | `sales_page` | 2026-09-04 | Lists receipts, searchable by customer or note. `search_sales` exists server-side and is not what the box uses — to check.
| `[ ]` | `statement_page` | — | |
| `[~]` | `reports_page` | 2026-09-04 | Opens. The stock table quotes base units deliberately (quantity × cost each = worth is an arithmetic somebody checks by eye) — recorded so it is not "fixed" into shapes.
| `[ ]` | `account_action_page` | — | |

## people-stack

| | Page | Walked | What was found |
|---|---|---|---|
| `[ ]` | `people_page` | — | |
| `[ ]` | `account_page` | — | |

## settings-stack

| | Page | Walked | What was found |
|---|---|---|---|
| `[ ]` | `settings_page` | — | |
| `[ ]` | `staff_page` | — | |
| `[ ]` | `staff_invite_page` | — | |
| `[ ]` | `bank_page` | — | |
| `[ ]` | `bank_form_page` | — | |
| `[ ]` | `review_page` | — | |

## Outside the app shell

| | Page | Walked | What was found |
|---|---|---|---|
| `[ ]` | `/login` | — | |
| `[ ]` | `/setup`, `/setup/opening` | — | |
| `[x]` | `/r/[token]` — the shared receipt | 2026-09-04 | Now shows shapes, every charge by name, the deposit, what is still to come back, payment by method, and a real bank account. One thing left: `unit_name` prints capitalised mid-sentence ("2 Packs"), because the shop's own casing is right for a label and wrong in a sentence.
| `[~]` | `/track`, `/t/[token]` — order tracking | 2026-09-04 | Carries shapes, deposit and empties since 0087. It POLLS every 4s (`POLL_MS`), against the no-polling rule — defensible for a public page with no navigation lifecycle, but it should be recorded as a decision rather than left as an accident.
| `[ ]` | `/s/[code]` — the shared order | — | |
| `[ ]` | `/preview` | — | |

---

## Capability with no door

Carried over from [UI_AUDIT.md](UI_AUDIT.md), which is the repo-wide scan. This is the same list as
a worklist, so a session can pick one up and know what was already decided about it.

| | Capability | Decision |
|---|---|---|
| `[ ]` | Staff invitations — `invite_staff`, `accept_invitations` | |
| `[ ]` | Editing a staff member — `update_staff_details` | |
| `[ ]` | The activity feed — `activity_feed`, `audit_log` | |
| `[ ]` | Per-customer agreed prices — `customer_prices` | |
| `[x]` | Product **groups** — every form sent `p_category_id: null` | **Built, and reshaped.** The scan found the column was never written; it could not find that the SHAPE was wrong. One category per product cannot say what a shop means — Goldberg is a Beer, a PET, and an NBL product, three groupings answering three questions. 0093: join table, `create_product_group` (returns the existing one rather than refusing, because it is called from inside a picker), `set_product_groups`, retire. Multi-select `GroupPicker` in the product form, new groups made without leaving it. `products.category_id` is kept pointing at the first group by that one writer, so the stock list and receipt go on working. |
| `[ ]` | Barcode lookup — `product_by_barcode` | |
| `[ ]` | Searching sales — `search_sales` | |
| `[ ]` | Reopening a closed count — `reopen_stock_period` | |
| `[ ]` | Reviewing a variance — `movement_reviews` | |
| `[ ]` | Archive and restore — `restore_customer`, `restore_product` | |
| `[ ]` | Revoking a shared link — `revoke_share_link` | |
| `[ ]` | Costing method — `apply_weighted_average` | |
| `[ ]` | Joining a shop by code — `find_store_by_code` | |
| `[ ]` | Price check — `price_check` | |
| `[x]` | Empties owed back — `empties_outstanding` | **Built.** `empties-page` lists receipts with containers out; reached from the till and from a receipt. |
| `[x]` | Customer deposits — `deposit_ledger`, `deposit_holdings` | **Built.** Taken on the till per line and as an order total; settled on `empties-settle-page`. |
| `[x]` | The pools themselves — `empties_categories` | **Built.** "NBL crate" held ₦1,500 and "NBL bottle" ₦125, both seeded by a migration and unchangeable: `save_empties_category` was written in 0082 for a screen nobody built, and it EDITS only, so there was no way to make the first pool either. 0092 adds create and retire (refused while customers still hold containers, with the number); `settings → Crates and bottles` is the door. |
| `[x]` | Deposit forfeits — `deposit_forfeits` | **Built 0090.** "Not coming back", with what was paid for them. |

---

## Can the shop change what it sees?

`scripts/audit-management.py` asks this of every value on screen — a unit name, a price, a deposit
rate, a pool, a group — in four verbs: can it be ADDED, EDITED, DELETED, SET. A screen that shows a
row it cannot create, correct or retire is half a feature, and the missing half is always the same
one: the shop gets a value wrong once and lives with it.

Two warnings from writing it. It guessed function names on the first run and reported that a
customer cannot be created, which the app plainly does — `upsert_customer` is the writer, not the
`save_customer` it looked for. A scan that invents the name it searches for finds nothing and calls
it a gap, which is the most expensive kind of wrong: it buries the real gaps in a list nobody
trusts. And it can only see whether a verb EXISTS, never whether the model is the right shape —
categories were single-valued and should always have been many, and no scan was ever going to say
so.

What it found still open, worst first:

| | Value | What is missing |
|---|---|---|
| `[ ]` | A unit's name (Crate, Bottle, Dirica) | Can be added, never renamed or retired. A typo is permanent AND spreads: the name is on every product using that unit. |
| `[ ]` | A member of staff | `invite_staff` and `update_staff_details` both exist and nothing calls either. No way to remove somebody or change their role at all. |
| `[ ]` | A customer | `archive_customer` and `restore_customer` exist, dead. A mis-tap is permanent from the screen's point of view. |
| `[ ]` | A shared receipt link | `revoke_share_link` exists, dead. A link, once sent, cannot be withdrawn. |
| `[ ]` | A closed count | `reopen_stock_period` exists, dead. A count closed by mistake is final. |
| `[ ]` | A price agreed with one customer | No writer at all, though `resolve_price` already honours them and the till says "this customer's agreed price". |
| `[ ]` | A bulk price band | No writer at all. |
| `[ ]` | How stock is costed | `apply_weighted_average` exists, dead. The shop is on FIFO and cannot say otherwise. |
| `[ ]` | A product | `restore_product` exists, dead — archiving works, putting back does not. |

## Ruled out, so nobody raises them again

Nothing yet. A row here needs the reason it is not a gap, not just the verdict.

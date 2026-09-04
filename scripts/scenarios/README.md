# The benchmark

    node scripts/run-scenarios.mjs            # everything
    node scripts/run-scenarios.mjs 8 9        # only those

A week of trade through a shop created for the run and dropped at the end. Probes ask whether a
screen is right; this asks whether the books still add up after a sale, a delivery, a deposit, a
return, a count and a correction have all happened to each other.

**This file is never finished.** Every session adds to it. Anything that could cost a shop money,
stock, a container or a customer's trust gets a scenario — and the scenario goes in whether it
passes or not, because a red one naming a real gap is worth more than no scenario at all.

---

## Two rules for writing one

1. **Go through the RPCs the app calls, with the arguments it sends.** A harness that writes rows
   directly passes while the app is broken, which is the one thing a benchmark must never do. Every
   helper in `harness.mjs` is the call the app makes.
2. **Assert the FIGURE, not that the call returned.** "A delivery can be recorded" passed happily
   while twenty crates came in as twenty bottles. "The landed cost is ₦370.83" did not.

And one about the shop: it is created and dropped per run because every ledger here is append-only
and there is no undo. Dropping it needs `session_replication_role = replica` — seven tables refuse
deletes, and the audit trigger logs the deletion into a table that references the store being
deleted. Never point this at a real shop.

---

## What it found

Each of these was live, and none of them was visible from any single screen.

| | Found by | What it was |
|---|---|---|
| **The clock** | scenario 7 | Eight seconds of skew put a delivery outside the counting period that should have contained it. The count read "you are 147 over" and closing it wrote 147 bottles into stock that had never existed. Five money writers were sending the browser's clock; they let the server stamp now. |
| **No way to void a sale** | scenario 8 | `sales.status`, `sales.revision`, `sales.amend_reason` and the `sales.amend` permission all existed. The function did not. A seller who keyed thirty crates instead of three had no correction path at all. (0094) |
| **A cancelled receipt said nothing** | scenario 11 | The link the customer holds read as a live bill — items, total, what is owed, the shop's bank account — for a sale the shop had cancelled. (0095) |
| **A product must be LINKED to a pool** | scenario 5 | Ticking `is_returnable` says a shape comes back. It does not say into what, and without the link four crates went out and the ledger recorded none of them. |
| **A delivery line says `base_factor`** | scenario 2 | Not `base_qty`. Twenty crates arrived as twenty bottles and the whole ₦94,000 landed on them. |

---

## Covered

**A shop opens** — 1 a customer with a balance and crates from the old book · 2 a product with a
shape tree, a price, stock opened from a count, and a delivery whose fees land in the cost · 3 roles
that may be handed out, and what a seller may not do

**A week of trade** — 4 a credit sale, and the shape recorded on the line · 5 crates out with a
deposit at the rate actually taken · 6 a partial return, one written off as paid for, and the
opening crates left untouched · 7 a count: the gate, the period, the variance it will not close over

**Corrections, and what the customer sees** — 8 a sale keyed wrong and voided, with all three
ledgers put back and the money left alone · 9 the permission, and the refusal once empties have
started coming back · 10 a shared receipt in shapes, an older receipt settled by a later payment,
and a link taken back · 11 a voided sale on the customer's own copy

**Edges** — 12 half a crate · 13 a third of one, refused · 14 overselling, and honest negative
stock · 15 the same order settled twice from two devices · 16 paying more than the bill · 17 an
empty sale and a line of nothing · 18 a price below cost, with the loss visible · 19 two customers
with one name, and a walk-in with none · 20 a shape retired after things were sold in it

---

## The queue

Next, roughly in the order a shop would miss them.

- [ ] **A delivery corrected or reversed.** The same question as scenario 8, on the buying side.
      There is no `void_purchase`, and a mis-keyed delivery moves both stock and cost.
- [ ] **Money in and out of an account** — a payment, a charge, a credit, a refund, and a statement
      that adds up afterwards. `account-action-page` reaches five RPCs and none is in the benchmark.
- [ ] **Two shops.** Nothing here proves a reader is scoped to one: `is_store_member` is on
      everything, and a benchmark with a second shop and a second owner would prove it rather than
      assume it.
- [ ] **A staff member actually acting.** Scenario 3 checks what a role MAY do; nothing signs in as
      one and is refused.
- [ ] **The tracking link while an order is still open**, and after it settles — the customer
      watching an order being built is a live page.
- [ ] **A count reopened** (`reopen_stock_period`), and what happens to the movements it already
      wrote.
- [ ] **Empties across two receipts.** A customer brings six crates against receipts that sent four
      and four; the shop settles both.
- [ ] **A deposit refunded in cash, and one left on account** — `refund_deposit` and
      `forfeit_deposit` are reached by the app and not by this.
- [ ] **A product archived while it has stock**, and restored.
- [ ] **Rounding.** A crate of seven at a price that does not divide, checked to the kobo through
      the whole chain: line, sale, balance, receipt.

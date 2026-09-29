<!-- markdownlint-disable MD013 -->

# Store Manager — work tracker

Kept in the repo so it moves with the code. Ticked only when **verified** (benchmark, probe, live
data or click-through) — not when it merely compiles. Newest work at the top of each open list.

`☐` open · `☑` done and verified · `◐` done, not yet click-through verified · `⛔` blocked on the shop

---

## 1. Open queue — worked top to bottom

| # | Item | Area | State |
| --- | --- | --- | --- |
| Q1 | **Price gate at the till** — an item with no price cannot be settled; a mid-sale "set the price" page is pushed for it, the way the count gate pushes the count. Line chip, note, pay button, Take payment refusal, `price_gate_page`, server refuses N0 (0221). `probe-price-gate-ui.mjs` 9/9 | Sell · Backend | ☑ |
| Q2 | **Add-customer needs two taps** on Take payment / Correct payment — the correction's `onCustomerForAmend` was never provided by anyone; Take payment now attaches to the order it is paying for (`onCustomerForPayment`). Not clicked through: it would create a real customer | Sell | ◐ |
| Q3 | **Filters** on Stock, Count, Yard, Sales, Money, People, Suppliers — server-side, so they survive pagination | All lists · Backend | ☐ |
| Q4 | **Export the filtered list** (CSV) from every list that has filters — all matching rows, not just the loaded page | All lists | ☐ |
| Q5 | Change handed back on **Correct payment** is recorded as money out — worked out as Take payment does (paid − still owed − old debt, capped at cash in), kept on the correction, written after it lands | Sell | ◐ |
| Q6 | Every **edit form tells its lists** (product, supplier, bank, group, unit) — only the customer edit does | All stacks | ☐ |
| Q7 | **Search lists stop flashing "nothing found"** — lists answer before they say empty (`usePaginatedList`); search-viewer 0.3.1 reads a stale "no results" as loading while the text differs from the term searched. Frame-by-frame: loading from the instant the box changes, then the match | All searches · Library | ☑ |
| Q8 | **Fractions set small** (`Qty`) wherever a quantity is the headline — only the empties list has it | All stacks | ☐ |
| Q9 | **Base units still leaking** — product page, receive picker and count list already spoke in shapes (base unit only for an item with none); stock history, the low-stock page and the review queue now do too (`useSayInShapes`). Malta's history reads "+133 cans 12 pieces". The stock-value report keeps base units because its cost column is per base unit | Stock · Count | ☑ |
| Q10 | Expiry can be **added to an undated lot** from the edit form — confirm by click-through | Stock | ☐ |
| Q11 | Destiny's receipt — checked: she holds 1½ 7up crates across two receipts (1 from 28 Sep, ½ from 29 Sep), and her account and both receipts agree. If the crate is back, it is one tap now: All back on that receipt | Data | ☑ |
| Q12 | Audit sweep findings (section 5) | All | ☐ |
| Q13 | **All items** — the open order on its own, marked NOT A RECEIPT on screen, paper and PDF; share on WhatsApp / share with the tracking link, PDF, print. From the till (under Scan) and Take payment. `probe-all-items-and-line-ui.mjs` | Sell | ☑ |
| Q15 | **Till stuck on "that order is no longer open"** (29 Sep, live) — my probes' clean-up deleted the shop's open drafts; the till then could not save, pay or close, and a second Close cancelled A406 Hotel (₦142,600, reopened). Probes now clean only their own tabs (`probe-drafts.mjs`); the till re-saves a dead order as a new one, treats "no such order" as closed, and re-selects a tab a failed close puts back. `probe-dead-order-ui.mjs` 8/8 | Sell | ☑ |
| Q16 | **Stock is whole** — no ½/¼ on shelf, lot, count or yard boxes (`Field whole`); server refuses a fractional base figure or count (0222). Malta Guinness Can re-said as 133 cans 12 pieces, 24 to a can | Stock · Count · Backend | ☑ |
| Q17 | **Pickers reach everything** — product picker pages past 50 (0223); customer picker re-checks on open; no "nothing found" flash while a term is being fetched (`usePaginatedList`). Selection-viewer paginated on an element that never scrolls — fixed and published as 0.5.1. Probe: 105 of 105 | Shared · Library | ☑ |
| Q18 | **Date stock that already has a history** — `date_shelf_stock` (0224) splits an undated lot or makes one for stock that has none, moving no stock; the edit form offers it once an item has a history. Also: a pre-filled shelf no longer forces a recount and a reason on every save | Stock · Backend | ☑ |
| Q20 | **Empties brought back, settled where they are read** — every line a customer holds offers All back (confirmed) and Part (the empties page, line chosen), plus "They brought everything back". On a just-settled receipt it is asked BEFORE printing or sharing, recorded at the sale's moment against the sale, so "still with you" on the paper is true (server-proven: 5 → 4). On the account page, dated now. Account: `probe-empties-brought-back-ui.mjs` 5/5; receipt: not clicked through (needs a real sale) | Sell · People | ◐ |
| Q19 | **Robustness sweep of the till** — (a) settling an order another till closed: saved again and settled, or the other till's receipt shown; (b) Take payment / All items / sale line find an order by any id it has had (`formerIds`); (c) the order is saved, awaited, before it is settled — the customer just chosen reaches the shop ("customer is needed" after adding one); (d) a finished sale or correction is unwound before its receipt is shown, so Back never lands on "This sale is no longer open" (`finish-flow.ts`). Needs one real sale to click through | Sell | ◐ |
| Q21 | **All items → Take payment** — the list is swapped for payment (`swapTo`: a real pop, then the push), gates first; Back from payment is the till. Probe 8/8 | Sell | ☑ |
| Q22 | **A price typed on the line satisfies the price gate** — only a line at nothing is stopped; setting the shop's price is still one tap on the chip | Sell | ☑ |
| Q23 | **A receipt settles only its own empties** — `sale_empties_outstanding` (0225): what the sale sent out, less what came back against it, capped at what the customer still holds. On every receipt (dated at the sale when fresh, now otherwise); gone once settled. The account keeps the whole picture | Sell · Backend | ☑ |
| Q24 | **Payment confirmed on its own page** — customer, amount, method, time, and where the account stands now; swapped in for the form so Back is the account; Share as text. Probe 8/8 | People | ☑ |
| Q25 | **Back on Stock lands on Sell (PWA)** — not reproducible in Chrome or WebKit: straight, after a reload, after a relaunch on Sell with Stock restored two deep, and at the root (`probe-stock-back-ui.mjs`, both engines, 0 failed). Settings → Updates → **Record navigation** now captures the library's own trace on the phone for a report | Navigation | ◐ |
| Q26 | **A payment opens its receipt from history** — the statement's and the account's payment lines open the payment page as a receipt ("Owes now"), with Share to send it again | People · Money | ☑ |
| Q14 | **A line opens from Take payment** — the till's own `SaleLineRow` on `sale_line_page`; Add an item and Scan there push it with the product. Line logic shared with the till (`sale-line-ops`). Same probe, 19/19 | Sell | ☑ |

**Blocked on the shop** — nothing can be done until you give the figure:

| Item | Needs | State |
| --- | --- | --- |
| Four Piece-only sachets (Action Bitters, Eaglejie, Elder's, Striker) | sachets per pack | ⛔ |
| Best London Dry Gin carton | packs per carton | ⛔ |
| Supa Komando Bottle (25cl) — returnable with no maker | who makes it | ⛔ |
| ~~Malta Guinness Can priced N13,000 per can with 133.5 on the shelf~~ | resolved: the Can is 24 pieces (0222) | ☑ |

---

## 2. Done this session — by feature

### Stock counting
- ☑ A count is judged against the shelf **as it was when counted** — 22 of 28 variances were phantom post-count sales (0213, 0215–0219)
- ☑ A **new day is a new period**, decided by server time in the shop's timezone, never the device (0214)
- ☑ The day's running figures keep moving; the variance stays **pinned to the count** (`expected_at_count`, 0218)
- ☑ A variance resolution is dated **inside** the period it settles (0217 → 0219)
- ☑ Count card, variance headline and summary read **in shapes** — "180 packs 11 pieces", not 180.9167
- ☑ Count list **paginates** — 31 → 105 rows, proven by `probe-count-paging-ui.mjs`

### Shapes, quantities and prices
- ☑ Pieces and bottles are **neither sold nor bought**; pieces don't come back, bottles do
- ☑ A shape with halves is **counted, not weighed** — server refuses the contradiction (0204)
- ☑ A shop's own "halves too" beats the global `piece` rule — Malta Guinness 133.5 enters (0211)
- ☑ Shelf boxes **snap to parts** and offer ½ / ¼ buttons; parts row lines up across shapes
- ☑ **Cheaper prices survive** a shape going off sale — anchored to the shape, re-linked (0207)
- ☑ Cheaper prices editable **on the price screen** itself
- ☑ Halves read as halves everywhere — 66 displays through `formatQtySpoken`
- ☑ Maker groups restored — 9 makers over 78 products

### Customers and money
- ☑ **One number is one customer** — no silent rename on a shared phone (0203); archived customers **come back** (0212)
- ☑ Kadijat / Dcc **split** back into two accounts
- ☑ Customers can be **edited**; opening figures correctable **until they trade**
- ☑ A payment keyed wrong can be **taken back** (0205, 0206) — Destiny's N3,200 put right
- ☑ **Change is money leaving**, not a debt — till records it (Take payment); Samod's N250 cleared
- ☑ **Give money back** to a customer (0210); **collect a supplier's credit** (0220)
- ☑ Cash receipts stop **printing the bank account**
- ☑ Edit form **tells the People and Money lists**

### Empties
- ☑ Empties **roll up by maker** — "3 crates Nigerian Breweries", with an "all of it" button
- ☑ A reversal is **dated to what it reverses** (0209)
- ☑ Goldberg / Castle Lite crates come back; Kadijat's 4½ crates recorded

### Deliveries
- ☑ A delivery is **composed one line at a time**; supplier required; base-unit line removed

### The till
- ☑ **No price, no sale** — the count gate's twin, on the line, the note, the button and Take payment; server backstop 0221
- ☑ **All items** page — NOT A RECEIPT, share / WhatsApp / PDF / print, before anything is paid
- ☑ **Lines edit from Take payment**, and items are added there too, through the till's own row
- ☑ A restore from the shop **keeps each line's key** — a line named by key no longer vanishes when a page mounts

### Sync and search
- ☑ **Other tills hear** a price, shape, maker, expiry, allocation or supplier change (0208)
- ☑ Pickers open **with the keyboard**; the two server-backed pickers stop flashing empty
- ☑ Cost with no record says **"not recorded yet"**, not N0.00

---

## 3. Done this session — by page (stack)

| Stack | Page | What changed | State |
| --- | --- | --- | --- |
| Sell | take-payment | change recorded as money out | ☑ |
| Sell | amend-payment | lists what was paid, with "take it back" | ☑ |
| Sell | empties-record | roll-up by maker, "all of it" | ☑ |
| Sell | empties | fractions set small | ☑ |
| Sell | receipt-history | account printed only on transfer | ☑ |
| Stock | product form | dated stock one section; shelf in shapes & prefilled; parts buttons; per-lot reason | ◐ |
| Stock | shape-price | cheaper prices on the page | ◐ |
| Stock | receive | compose-and-list, supplier required | ◐ |
| Stock | supplier-account / supplier-payment | collect a credit | ◐ |
| Stock | stock list | cost "not recorded yet" | ☑ |
| Count | count list | pagination | ☑ |
| Count | count entry | everything in shapes | ◐ |
| People | customer-edit (new) | name, phone, business, opening figures | ◐ |
| People | account | Edit button, Give back button | ◐ |
| Money | — | receives list patches from edits | ◐ |
| Shared | 6 pickers | autoFocus; 2 stop flashing empty | ◐ |
| Sell | price-gate (new) | price the shapes on this sale | ☑ |
| Sell | order-items (new) | All items, NOT A RECEIPT, share / PDF / print | ☑ |
| Sell | sale-line (new) | one line, the till's row; add or change | ☑ |
| Sell | take-payment | lines open; All items / Add / Scan; refuses unpriced; attaches a new customer | ☑ |
| Sell | amend-page | a customer created for a correction is named on it | ◐ |

---

## 4. Backend — migrations this session

| # | What | State |
| --- | --- | --- |
| 0201 | receipt line says the shape | ☑ |
| 0202 | low-stock setter stops writing a dropped column | ☑ |
| 0203 | one number is one customer | ☑ |
| 0204 | a shape sold in halves is counted | ☑ |
| 0205 | a payment can be taken back | ☑ |
| 0206 | a receipt says which payment | ☑ |
| 0207 | a cheaper price survives the shape | ☑ |
| 0208 | the other tills hear an edit | ☑ |
| 0209 | a reversal is dated to what it reverses | ☑ |
| 0210 | money handed back | ☑ |
| 0211 | a shape that sells in parts | ☑ |
| 0212 | a customer can be added back | ☑ |
| 0213 | a count is judged at its moment | ☑ |
| 0214 | a new day is a new period | ☑ |
| 0215 | the count is stamped first *(fixes my 0213 regression)* | ☑ |
| 0216–0217 | a resolution sits inside its period *(fixes 0213)* | ☑ |
| 0218 | the day runs, the count is pinned | ☑ |
| 0219 | a resolution is dated inside its count *(fixes 0218)* | ☑ |
| 0220 | a supplier credit can be collected | ☑ |
| 0221 | nothing sells without a price | ☑ |
| 0222 | stock is whole; the half is a shape (Malta re-said) | ☑ |
| 0223 | the product picker reaches every item | ☑ |
| 0224 | date stock already on the shelf | ☑ |
| 0225 | the empties one sale still owes | ☑ |

---

## 5. Audit sweep — 29 Sep

### Backend — clean
- ☑ **No overloaded functions** — the trap that made a defaulted param a second function
- ☑ **Every SECURITY DEFINER pins its search_path**
- ☑ **Every table has row security**
- ☑ **No function names a column that no longer exists** — `plpgsql_check` over every ordinary
  and trigger function (the 0202 class). Only hit: `amend_sale`'s runtime temp table, a known
  false positive the benchmark exercises
- ☑ **No receipt settled for more than it came to** (the Destiny class)
- ☑ **No stock below nothing; no customer returning more containers than went out**
- ☑ **No payment reversed twice**
- ☑ **All 13 open count differences are real** — each pinned expectation equals a from-scratch
  recomputation to its count. The model holds; the differences are the shop's to explain

### Backend — found
| # | Finding | State |
| --- | --- | --- |
| A1 | Tables other tills never heard — published (0226) and mapped. Found worse on the way: six tables with no `store_id` were subscribed with a `store_id` filter and so never heard at all (shapes, prices, maker links, allocations). Subscribed unfiltered; a shape change proven heard | ☑ |
| A2 | **The benchmark leaked its whole shop every run** (replica mode stands down the FK cascades too): 2,834 rows across 25 tables, none in the live shop, purged. The teardown now runs `purge-orphans.sql`; 192/192 and nothing left after a run | ☑ |
| A3 | 58 sellable shapes have no price — the price gate (Q1) will stop each at the till | info |

### Shop data — for the shop, not a code fault
| Product | Counted vs records | |
| --- | --- | --- |
| Pepsi PET (60cl) | **942 pieces short** (78½ packs) | real |
| American Cola PET (60cl) | 774 pieces over | real |
| Fanta Small PET (50cl) | 492 over | real |
| Supa Komando Small PET | 60 over · Heineken Big 36 over | real |
| 7up Bottle −21 · Coca-Cola Small PET −24 · Maltina Small PET −24 · Fayrouz −12 · Goldberg −12 · Guinness Big −6 · Aquavie −3 · Origin +6 | | real |

Large "over" figures usually mean an opening quantity keyed short, not stock appearing.

### Frontend — found
| # | Finding | State |
| --- | --- | --- |
| F1 | **iOS keyboard never rises on open** — search-viewer 0.3.1 / selection-viewer 0.5.2 focus inside the tap (layout effect; an invisible stand-in when the box is not mounted yet) and no longer remount. Proven: a text box has focus in the tap that opens both. The keyboard itself needs your iPhone to confirm | ◐ |
| F2 | **Search pages flash "nothing found"** — see Q7 | ☑ |
| F3 | Only four list channels exist (`customers`, `debtors`, `products`, `sales`); the other writers (groups, units, bank, shop) feed derived figures that already re-read — **Q6 narrows to renames showing on list rows** | ☐ |

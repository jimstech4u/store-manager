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
| Q3 | **Filters, on the server** (0228) — Stock: running low / none left / no price; People: owes you / you owe them / has your empties; Sales: today / unpaid / paid (plus a date range the server takes). They hold across every page. Count, Yard and Suppliers are short, whole lists already | All lists · Backend | ☑ |
| Q4 | **Export the filtered list** — every matching row, walked page by page on the server, as CSV (shared on a phone, downloaded elsewhere). Probe: none left 4, no price 50, owes 5, empties 7, unpaid 7, all sales 41 — each the server's count | All lists | ☑ |
| Q5 | Change handed back on **Correct payment** is recorded as money out — worked out as Take payment does (paid − still owed − old debt, capped at cash in), kept on the correction, written after it lands | Sell | ◐ |
| Q6 | Every **edit form tells its lists** — checked: products (list channel), customers (edit page), suppliers (scope), banks (state) already do; groups and units are create-only there. And other tills now hear all of them (0226) | All stacks | ☑ |
| Q7 | **Search lists stop flashing "nothing found"** — lists answer before they say empty (`usePaginatedList`); search-viewer 0.3.1 reads a stale "no results" as loading while the text differs from the term searched. Frame-by-frame: loading from the instant the box changes, then the match | All searches · Library | ☑ |
| Q8 | **Fractions set small** — stock is whole now (0222), so a part only headlines on empties: the empties list, the empties block on receipts and accounts, and "theirs in your yard" use `Qty` | All stacks | ☑ |
| Q9 | **Base units still leaking** — product page, receive picker and count list already spoke in shapes (base unit only for an item with none); stock history, the low-stock page and the review queue now do too (`useSayInShapes`). Malta's history reads "+133 cans 12 pieces". The stock-value report keeps base units because its cost column is per base unit | Stock · Count | ☑ |
| Q10 | Expiry on stock with a history — done as Q18 (0224) | Stock | ☑ |
| Q11 | Destiny's receipt — checked: she holds 1½ 7up crates across two receipts (1 from 28 Sep, ½ from 29 Sep), and her account and both receipts agree. If the crate is back, it is one tap now: All back on that receipt | Data | ☑ |
| Q12 | Audit sweep findings (section 5) — A1, A2, F2, F3 done; F1 waits on an iPhone | All | ☑ |
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
| Q25 | **Back on Stock lands on Sell (PWA)** — found: switching tabs restamps the entry you are on, so the entry behind a deep page is often another tab's, and the phone's Back followed it there (the app's own arrow was fine, which is why the earlier probe could not reproduce it). navigation-stack 1.7.0 `backStaysInTab`: the phone's Back pops the page of the tab on screen. Also: the app's own pops never change tab or rewind another tab. `probe-tab-back-ui.mjs` 10/10 on Chromium and WebKit; library `tab-never-blank` 14 tests, 7 of which fail on 1.6.1 | Navigation · Library | ☑ |
| Q26 | **A payment opens its receipt from history** — the statement's and the account's payment lines open the payment page as a receipt ("Owes now"), with Share to send it again | People · Money | ☑ |
| Q27 | **"Waiting for you" does its job** — customers open their edit page (it opened the empty new-customer form); stock cards read in shapes, open the item, leave the list when marked; "Wrong" asks first and says what comes off the shelf; its reversals no longer come back as new entries (0227). Probe 6/6 | Settings | ☑ |
| Q28 | **Export centre, like a bank statement** — Money → Export: counted today, running low, still in stock, none left, no price, who owes me (with a ₦ range), who I owe, empties held, payments received / money given back, sales, unpaid sales; a period (today … last month, or dates). Each is an A4 report (shop, title, filters, repeated heading, totals, Page n of N) that saves as a multi-page PDF, prints on A4 or on the roll, and downloads as CSV (0229). `probe-export-reports-ui.mjs` 13/13; PDF pages, roll picture and print view looked at | Money · Backend | ☑ |
| Q29 | **Every document shares the same way** — `DocumentActions`: Share, WhatsApp, Send as picture, Print, Save as PDF, on the payment receipt, All items and the export centre. Payment receipt now says the whole account balance (live fix) | People · Sell · Money | ☑ |
| Q30 | **A tab went blank (Money)** — `pop()` on a tab's first page (a second tap on Back while the page slides out) emptied the stack and a tab group hands an empty tab to nobody. 1.7.0: a tab keeps its first page however it is emptied; a push straight after a pop is no longer carried away by the pop's late history move; a page reopened mid-animation stays. Arrow tapped twice fast on Sales → Money's first page, drawn (probe B) | Navigation · Library | ☑ |
| Q31 | **A picker's arrow leaves search** — with the keyboard up, the selection viewer's arrow did nothing (the box it returned to grabbed focus and re-entered search). selection-viewer 0.5.3; library test fails on 0.5.2. `probe-viewer-back-ui.mjs` 12/12 on Chromium and WebKit: Stock search (arrow, phone Back) and the Sell product picker (arrow stays out of search, close, phone Back) | Shared · Library | ☑ |
| Q32 | **Search, filters and export stay pinned as a list scrolls** — the till's pattern (header travels, a bar sticks) on every list page with a search: `PinnedTools` + `headerScrolls`. Clicked through on People, Stock, Sales, Money, Empties and Count (`probe-pinned-tools-ui.mjs`: search at the top, title gone, search still opens). Orders' Show/When filter rows moved into the bar too | All lists | ☑ |
| Q32b | Pinned bar on **Orders, Deposits, Suppliers** — same component, renders correctly, but the shop's lists there are too short to scroll, so the pinning itself has not been seen yet | Sell · Stock | ◐ |
| Q33 | **"Something always creates a new customer behind" — and a new phone did not show the shop's open customers** — root cause in state-stack: a persisted write reached memory only after IndexedDB finished, so the till's load of the shop's tabs was still in flight when the till read an empty list, started a customer on top of it, and that write landed last and replaced them. state-stack 0.6.3 writes memory first (library test: 3 of 4 cases fail on 0.6.2); a fresh till now opens on A406 Hotel and the shop's other tabs, Chromium and WebKit. Also: the till's own automatic tab is `provisional`, kept on that phone until something is put on it (`probe-auto-tab-stays-local-ui.mjs` 6/6), and the probes used this session close any tab their browser starts. The shop cleared the 37 empty tabs itself on 30 Sep | Sell · Library | ☑ |
| Q34 | **A card tapped in a sideways row finishes fully on screen**, on every page — navigation-stack 1.8.0 `useRevealTappedInRows`, called once in the shell; the row moves sideways only and the page never moves (Stock filters 47% → 100%, Money periods, both engines). **Closing a customer tab leaves the next one in view** — the tab it goes to is fully in the row after closing the last tab and after closing one scrolled away (`probe-row-reveal-ui.mjs`, Chromium and WebKit). The WebKit failure seen first was the lost-write bug (Q33) | All lists · Sell · Library | ☑ |
| Q35 | **Before stock history the edit form sets the OPENING; after it, the shelf changes by a count** — "history" is anything that physically moved the amount after the opening (sale, delivery, damage, adjustment); a matched count is not history but is on the record. Before: shelf and "When does it go off?" are editable, loaded with the current figure and dated lots, saved with `set_opening_stock` (0231) — no reason, no correction, nothing waiting. After: the shelf is read-only and points to a count; dates are corrected lot by lot. The form's save now hands every list the NEW figure and tells stock and count screens to re-read. Chivita Active Zest Can set to 3 Cans (72 pieces) through it; its stuck count cleared. `probe-opening-before-history-ui.mjs` 14/14, Chromium and WebKit | Stock · Backend | ☑ |
| Q36 | **Stock history reads on a phone** — each entry stacked (what happened and the change; when and who; what was on the shelf after), names not emails, "See the receipt" on sales only, counts shown with Matched or the difference (0232), a Counts filter. `probe-stock-history-ui.mjs` on American Cola, 33 Bottle, Chivita: no overlaps, date on one line | Stock | ☑ |
| Q37 | **Expiry dates stay editable after stock history, as lines** — only the shelf figure locks. Before and after history the dates are the same multi-line edit as a new item: every dated line read back as it is (same date on two lines stays two lines), added, removed or re-dated, no reason asked. After history Save calls `set_shelf_dates` (0237), which re-dates what is on the shelf and moves no stock. Stock now goes out of the line that goes off first (0238). `probe-expiry-after-history-ui.mjs` 8/8 on American Cola, every writer intercepted | Stock · Backend | ☑ |
| Q38 | **Search and picker sheets: the keyboard rises on open, the header stays, the rows sit above it** — a phone raises its keyboard only for a focus made in the tap (0.3.4 / 0.5.6 focused after the slide: no keyboard on first open), and a box focused while its sheet slides up makes iOS pan the page (0.3.1-0.3.3). modal-sheet 0.3.0 `instant` draws the sheet at rest in the render that opens it; search-viewer 0.3.5 / selection-viewer 0.5.7 open instant when the box takes focus and focus it in the tap. `probe-search-viewers-ui.mjs`: focused in the tap AND never mid-slide, page not panned, header on screen — Chromium and WebKit; `probe-viewer-back-ui.mjs` 12/12. The iPhone itself still to confirm | Shared · Library | ◐ |
| Q39 | **Dated lines can never exceed the shelf** — "Add this date" is off once a line would take more than is still undated; the box says "Up to 1065 packs 7 pieces still to date" and refuses more; with the whole shelf dated there is no box to add, until a line is taken off. Lines are said in shapes. `probe-expiry-after-history-ui.mjs` 14/14 | Stock | ☑ |
| Q40 | **Count history for the whole shop** — Count → the history button: every count newest first, what was counted and what the records said (in shapes), Matched or the difference, who and when; filters All / Today / This week / Matched / Off, search by every word, CSV export; a row opens that item's stock history, which shows the same count. Opening counts and removed items are left out (0239). `probe-count-history-ui.mjs` all passing (Off lists Budweiser 6 bottles short, 30 Sep) | Stock · Backend | ☑ |
| Q41 | **What you owe a customer, settled from their account** — shown only when there is something: a card each for money you owe them, their deposit and their empties you hold; and the account's actions as a grid of cards (payment, charge, empties, deposit, statement, you owe them). `probe-account-cards-ui.mjs` 9/9 | People | ☑ |
| Q42 | **A corrected receipt said the customer owed it all again** — Oroja brother: N13,200 corrected with N13,100 paid printed "Owed before N13,100 · Total owed N13,200"; the account was right (N100). The receipt read the account at the sale's first moment, before the correction's money. 0240: a receipt (till copy and customer link) is read at the moment its version was issued — Paid, Owed before, Total owed and empties together; a voided payment is left out on both sides; money handed over for a receipt pays that receipt first (the till used to pay the oldest debt first and print "Paid N0"), surplus to older debts, then credit; a correction never leaves a receipt paid past its total; a receipt moved to another customer takes its counter money with it. Also fixes Busayo Store's, Dcc's and Destiny's reprints. Rehearsed rolled back on real customers (overpay, lower a paid receipt, move customer, debtor pays at till); all 18 balances unchanged. `probe-receipt-owed-ui.mjs` 6/6 | Sell · Backend | ☑ |
| Q43 | **All items shows the bill as it will be** — four boxes under the paper, above Take payment (charges, deposit, their balance, still with you): *Their balance* (Owed before, Owed in all — or their credit), *Charges* and *Deposit* (the same forms as Take payment, now one shared `OrderExtras` component: several lines, Cancel keeps what was added, unticking takes them off the bill, and what is added here is on Take payment's bill), and *Still with you* (what they hold plus what this order sends out, 0241, rolled up as the receipt does). All of it is on the screen, the paper, PDF, picture, print, WhatsApp and share. `probe-all-items-extras-ui.mjs` 17/17, Chromium and WebKit | Sell · Backend | ☑ |
| Q44 | **A maker is counted in crates; Arewa's receipt (NG2QZ) lost her old empties** — the customer form wrote "1 Nigerian Breweries" and "1 International Breweries" as BOTTLES she holds: the maker's unit was picked by a tie that fell alphabetically to Bottle, and the maker line dropped the side. The receipt read product rows only, so her old empties never reached it. Fixed with her say-so: she holds 1 Trophy crate, the shop holds 1 NBL crate of hers (the two bottle rows dropped, the append-only guard lifted for that and restored); her receipt now reads International Breweries 5 crates. 0242: a maker's unit is its biggest container (customer form, supplier form, yard), the maker writer takes a side, receipts and All items read maker rows with the crate's real size, the yard lists makers in crates. The roll-up adds only crates across a maker — bottles stay with their beer ("International Breweries bottles 2" is gone); the yard count counts a maker in crates and its loose bottles item by item | People · Yard · Sell · Backend | ☑ |
| Q45 | **A receipt settles what they had from before, too** — the empties block on a receipt starts with this sale's own containers and, when they hold more, offers *Include what they had from before*: ticked, it lists everything they hold (Arewa: 13 NBL, 5 International, 3 Guinness crates) and settles any of it at the sale's moment, so the paper is true; Part carries the choice. One labelling rule (`lineLabelOf`) for the roll-up, All back and Part, so a bottle line settles its own beer. A maker's own row (entered by maker) can now be handed back or written off (0243: `customer_empties_owed` says the unit; `returnOwedRow`). `probe-receipt-older-empties-ui.mjs` 5/5 Chromium and WebKit (writers answered by the probe); `probe-empties-brought-back-ui.mjs` 5/5 | Sell · People · Backend | ☑ |
| Q46 | **Their empties and money owed back can be cleared from the account** — "I returned Arewa's NBL crate but could not clear it": the empties page could only read what the shop holds of theirs. Each such line now has *Given back* (asked first), and *Give some of theirs back* opens the counting page on their side. A maker's own row reached the app with its shape id as the text "null", so it would have been refused — mapped to none now. Money handed back moved onto the new Money page (Q47). `probe-give-back-ui.mjs` 7/7 Chromium and WebKit (writers answered), the server call rehearsed rolled back (her crate goes to 0) | People · Sell | ☑ |
| Q47 | **Money is a ledger, like Empties and Deposit** — "too many buttons here": the account's five money cards (payment, charge, you owe them, return money, statement) became one *Money* card showing who owes whom. It opens `money_customer_page`: the figure, a button for each record (Record a payment, Record a charge, Return money to them — only while the shop owes them — Record what you owe them), the statement link, and *Every move of it* (sales, payments, charges, money back, opening balance, each opening its receipt or payment). The account keeps three cards: Money, Empties, Deposit — and no longer repeats the Empties page's lines (All back / Part live on Empties); order: who owes whom, what you owe them, the cards, the history. `probe-money-ledger-ui.mjs` 11/11 Chromium and WebKit | People | ☑ |
| Q48 | **A deposit paid at the till was counted twice, and missing from the receipt** — Mr Friday: goods N61,150 + POS N100 + a N9,950 crate deposit, N71,200 handed over. The receipt said "Left on this sale N100", no deposit, two cash lines; his account said the shop owed HIM N9,950 while also holding his deposit. Causes: the order's charges were added AFTER the payments were matched, so the POS N100 was left unmatched beside his money; and the deposit came in with the payments AND went to the deposit ledger. 0244: once the charges are on, a sale takes the money given at it (`settle_sale_from_its_money`, topping up an existing match — a first version broke the unique pair and would have failed a settle; caught by rehearsal and fixed within minutes, no sale attempted meanwhile); a deposit taken with a sale is moved off the money account ("Moved into their deposit", 0245) and counted once, in its own ledger; receipts say "Deposit, held for you" and print one line per way of paying. Repaired live: Mr Friday's sale fully paid, balance N0, deposit N9,950 held. A new deposit sale rehearsed end to end (rolled back): fully paid, balance unmoved, deposit added. `probe-receipt-deposit-ui.mjs` 6/6 | Sell · Money · Backend | ☑ |
| Q49 | **A page loses its place when you come back to it** (account after Empties/Deposit/Money, reported on the iPhone) — not reproducible on desktop engines: the first probe's drop (900 → 351) was Playwright scrolling the tapped button into view, and with a plain tap every round trip comes back exact on 1.8.0 and 1.9.0 alike. What the trace did show: a covered page reports scroll events at zero height, and navigation-stack recorded them, so on a browser that drops a hidden element's offset (iOS Safari) the saved position was the wrong one. navigation-stack 1.9.0 (published): records scroll only from the page the user is on, and restores until it holds (~0.75s, stops on touch). `probe-scroll-kept-ui.mjs` 5/5 Chromium and WebKit. The iPhone itself still to confirm | Library · All | ◐ |
| Q50 | **Change at the till: old balance or change, given now or owed on the receipt** — when a customer who owes hands over more, a box decides whether the extra clears their old balance (ticked by default); unticked it is change. Change is *given now*, by cash, transfer or POS, or *owed to them* (a named customer only) and printed as "Change owed to you"; the receipt offers to give it before printing, or when they bring it back, by the way it went back. 0246: `sale_change` ledger (append-only), `settle_sale_change` (the server works out the overpayment from the money given at the sale, less the sale and any deposit; unticked takes it back off the old receipts), `give_sale_change`; receipts and the customer's link say the change. Rehearsed rolled back: owe, clear old balance, give by transfer, too much refused, owe then give. `probe-change-ui.mjs` 6/6 Chromium and WebKit (settle answered by the probe). The receipt's give-it block not clicked through — no sale owes change yet | Sell · Backend | ◐ |
| Q51 | **A correction did not load the deposit back** — Mrs Adeola (#C74E799F): goods N32,150 and a N6,000 deposit, saved unpaid; the correction asked for N32,150 of the N38,150 she handed over, and her account showed her owing N6,000. A correction read the receipt's old per-line deposit (nought since deposits moved onto the order). Repaired live: her N6,000 recorded as a transfer at the correction's moment, balance N0. 0247: `sale_deposit_unpaid` (the deposit put down with the sale, less what the money for this receipt paid beyond its goods) — a correction asks for it beside the goods, and the receipt says "Deposit still to pay"; `cancel_sale_deposit` gives a mistaken deposit back on the ledger with a reason and reverses its account line. 0248: one `sale_deposit_put_down` (taken less cancelled) read by every receipt and the correction. The correction now loads the whole breakdown: the items step shows the deposit and what was paid; the payment step draws the receipt's deposit and payments with Take payment's OWN lines — the till's "Deposit held" line and its payment rows — each with its cross ("reuse the same lines, not a new one"), beside the charges' own crosses; a cross asks why, on the record. Rehearsed: a paid deposit cancelled becomes their credit; an unpaid one is no longer owed. `probe-correction-deposit-ui.mjs` 9/9 Chromium and WebKit (nothing written) | Sell · Backend | ☑ |
| Q52 | **Corrections work like Take payment, and their state is robust** — (1) Correct payment's crosses no longer ask a reason: a payment or the deposit is marked to come off (struck through, *Put back* undoes it) and written with the correction under its one reason — 0249 `correct_sale` takes back, cancels and corrects in one transaction. (2) Correct payment showed "Items N0 · Total for this sale N0": Take payment had one `total` for both the bill and what is left to pay; now `total` is the bill and `due` is what the money counts against (the till unchanged). (3) The correction's draft was never cleared, so the next correction on a receipt resumed the last one (old paid figures, payments already taken back) — it is cleared when saved, checked against the receipt when resumed (corrected since → start again; otherwise paid/payments/deposit re-read), and seeded by direct reads (a spent demand would never re-seed). `probe-correction-deposit-ui.mjs` 17/17 Chromium and WebKit | Sell | ☑ |
| Q53 | **Every search box in a sheet looks the same** — customers, suppliers, units and the open-tabs search had no padding and fell back to a tall grey slab; one `searchLook` now used by all seven pickers and search sheets (the product picker's look) | Shared | ☑ |
| Q54 | **A page body never blank under its header** — `LoadArea` drew nothing with no answer and no read in flight; it now says it is reading. The Deposit page moved to `PageState` like the account and Money pages | Shared | ☑ |
| Q55 | **The Statement is the account** — "drop the statement entirely and make the account page very detailed": the account lists every receipt with its total, paid and what is open (the statement's one extra, from the same `customer_statement`); the Money tab's debtors open the account; the Money page has no statement link. The statement page is in `_unused/` (MANIFEST row) and its route key opens the account, so an old link still works. The header shortcut "Their account" shows only where it is needed: not on the Money page (only ever opened from the account), and on Deposit and Empties only when they were not opened from the account — no more account → deposit → account loop. `probe-money-ledger-ui.mjs` 13/13 Chromium and WebKit; Deposit from the Deposits list keeps the shortcut | People · Money | ☑ |
| Q56 | **The count gate is the shop's to set** — Settings → *Count gate*: **Aggressive** (every day before anything sells, the default) or **Relaxed** (only the days picked on *Repeat*, an alarm-style Every Monday … Every Sunday list). Running low → *Count an item when it runs low* (the shop's say, any day, even when Relaxed); an item's own page has its own box, following the shop until ticked or unticked, with *Follow the shop*. One server rule, `count_required_today`, read by the sale trigger and the till's banner (0250). Ashabi: every count record removed with the owner's say-so (counts had never moved stock — all 20 adjustments are receipt corrections or the ZZ Probe removal; stock unchanged for every item, checked before and after; the ZZ Probe's period kept as its record), and set Relaxed, Monday and Sunday (0251). Rehearsed: a Thursday sale with no count goes through, the item's period opens from the ledger. `probe-count-gate-settings-ui.mjs` 13/13 Chromium; WebKit not run — the machine was out of memory | Settings · Stock · Sell · Backend | ◐ |
| Q14 | **A line opens from Take payment** — the till's own `SaleLineRow` on `sale_line_page`; Add an item and Scan there push it with the product. Line logic shared with the till (`sale-line-ops`). Same probe, 19/19 | Sell | ☑ |

**Blocked on the shop** — nothing can be done until you give the figure:

| Item | Needs | State |
| --- | --- | --- |
| Four Piece-only sachets (Action Bitters, Eaglejie, Elder's, Striker) | sachets per pack | ⛔ |
| Best London Dry Gin carton | packs per carton | ⛔ |
| ~~Supa Komando Bottle (25cl) — returnable with no maker~~ | resolved: merged into the Pepsi / 7up / Mirinda / Teem / Komando Bottle (35cl), Seven-Up (SBC) (0236) | ☑ |
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
| Stock | product form | dated stock one section; shelf in shapes & prefilled; whole numbers only; dating stock with a history | ☑ |
| Stock | shape-price | cheaper prices on the page (`probe-open-items-ui.mjs`, read-only) | ☑ |
| Stock | receive | compose-and-list, supplier required — refused before anything is sent (`probe-open-items-ui.mjs`, 0 writes) | ☑ |
| Stock | supplier-account / supplier-payment | collect a credit | ◐ |
| Stock | stock list | cost "not recorded yet" | ☑ |
| Count | count list | pagination | ☑ |
| Count | count entry | everything in shapes — Malta asks Cans and Pieces (`probe-open-items-ui.mjs`) | ☑ |
| People | customer-edit (new) | name, phone, business, opening figures | ☑ |
| People | account | Edit button, Give back button, empties settled from the line, payment receipts | ☑ |
| Money | — | receives list patches from edits | ◐ |
| Shared | 6 pickers | focused inside the tap; never flash empty; page to the end | ☑ |
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
| 0226 | the tables other tills never heard | ☑ |
| 0227 | the review queue skips its own reversals | ☑ |
| 0228 | lists filter on the server | ☑ |
| 0229 | reports to export (counts, balances in a range, payments, empties holders; in-stock filter) | ☑ |
| 0230 | the 13 other cans take Malta Guinness's shape: Can of 24 Pieces (shapes only; stock untouched, reads in pieces until recounted) | ☑ |
| 0231 | `set_opening_stock`: before stock history the shelf figure is the opening — set again with no reason, the ledger appended (never edited), lots rebuilt from the latest dates, counts moved with it (a matched count stays matched) | ☑ |
| 0232 | an item's history shows its counts, including ones that matched | ☑ |
| — | 29 Sep's 33 counts removed at the shop's request (several were wrong; none had moved stock — every figure unchanged) | ☑ |
| 0233 | items sold together merged, history rewritten into one: Bigi 350mL (Cola+Apple+Tropical), Pepsi\|7up PET 60cl, Coke\|Fanta\|Sprite Big PET 60cl and Small PET 50cl; three Coke bottles renamed; Bigi 500mL created empty. Totals = sum of members, balances recomputed, absorbed items deleted | ☑ |
| 0234 | Kadijat's Goldberg sale (28 Sep) made a plain sale again — its "Teg" correction only attached her | ☑ |
| 0235 | product search finds every word typed, in any order ("bigi apple" finds the merged Bigi) | ☑ |
| 0236 | Bigi 600mL (the empty 500mL renamed, Bitter Lemon merged in: 12 pieces); 7up Bottle 35cl + Supa Komando Bottle 25cl -> Pepsi / 7up / Mirinda / Teem / Komando Bottle (35cl), 507 bottles; Pepsi Bottle 50cl renamed to match. The two Bigi Water sales of 28 Sep are real and stay | ☑ |
| 0237 | `set_shelf_dates`: an item's shelf dates set as lines after stock history (moves no stock; lines never exceed the shelf) | ☑ |
| 0238 | stock goes out of the line that goes off first (undated last) | ☑ |
| 0239 | `count_history_page`: the shop's counts in one list, filtered (matched / off / today / week) and searched by every word; opening counts and removed items left out | ☑ |
| 0240 | a receipt is the account as at its version (`receipt_moment`); one allocator, `allocate_payment`: the receipt it was paid for first, oldest debt next, then credit; corrections never overpay a receipt and move its counter money with it; voided payments out of the account-as-at | ☑ |
| 0241 | `order_empties_preview`: what a customer holds plus what an open order would send out, by the sale trigger's own rule, for All items | ☑ |
| 0242 | a maker is counted in crates: `group_return_units` biggest container first, `record_customer_empties_for_group` takes `p_side`, `group_unit_base_qty`, maker rows on receipts (`customer_containers_as_at`) and All items, `yard_empties_by_group` in crates, `countable_empties` says each shape's size | ☑ |
| 0243 | `customer_empties_owed` returns each row's store unit, so a maker's own row can be handed back | ☑ |
| 0244 | a sale takes the money given at it once its charges are on; a deposit paid with a sale is counted once (moved off the money account); receipts say the deposit; repaired Mr Friday | ☑ |
| 0245 | the history says a deposit paid with a sale as "Moved into their deposit", not a charge | ☑ |
| 0246 | change given or owed: `sale_change` ledger, `settle_sale_change`, `give_sale_change`; receipts say the change | ☑ |
| 0247 | `sale_deposit_unpaid` and `cancel_sale_deposit`; receipts and the correction's document say the deposit and what is unpaid; repaired Mrs Adeola | ☑ |
| 0248 | `sale_deposit_put_down` (taken less cancelled), read by every receipt and the correction | ☑ |
| 0249 | `correct_sale`: payments taken back, the deposit cancelled and the receipt corrected in one transaction, under one reason | ☑ |
| 0250 | count gate settings: aggressive / relaxed with days, count when low (shop and item), `count_required_today` behind the sale trigger and `needs_count_today` | ☑ |
| 0251 | Ashabi: every count record removed (owner's say-so; stock unchanged), gate relaxed Monday and Sunday | ☑ |

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
| F3 | Only four list channels exist (`customers`, `debtors`, `products`, `sales`); the other writers (groups, units, bank, shop) feed derived figures that already re-read — **Q6 narrows to renames showing on list rows** — see Q6 | ☑ |

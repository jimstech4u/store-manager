/**
 * The Irekanmi walkthrough, driven entirely by clicking.
 *
 * A customer with an existing position — money owed, three different pools of empties out, and a
 * deposit the shop is holding — buys again, part-pays, brings some empties back and leaves money
 * for the rest. Every obligation has to stay separately accountable through all of it.
 *
 * Driven through the UI rather than through RPCs on purpose. The ledger has database tests; what
 * has never been proven is that a person standing at a counter can actually carry this out, and
 * that the numbers they are shown at each step are the right ones.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2];
const OUT = path.join(process.cwd(), 'shots', 'irekanmi');
fs.mkdirSync(OUT, { recursive: true });

const raw = fs.readFileSync('.env.local', 'utf8');
const env = (k) => (raw.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]?.trim().replace(/^"|"$/g, '');

/*
 * A fresh customer per run.
 *
 * Every ledger this scenario touches is append-only by design, so a second run against the same
 * customer ADDS another opening balance rather than replacing it — the first re-run reported
 * ₦400,000 owed and six dispenser bottles, and the app was right both times. Re-running has to
 * start from a clean position for the assertions to mean anything, and the honest way to do that
 * is a new customer, not by reaching in and deleting history.
 */
const RUN = String(Date.now()).slice(-6);
const CUSTOMER = `Irekanmi ${RUN}`;
// Digits only, and genuinely different each run.
//
// The first version built this from a base-36 timestamp with the letters stripped out, which
// usually left one or two digits padded with zeros — so every run produced the SAME phone
// number, resolved to the same identity, and reused the previous run's customer. The app was
// right to match them; the harness was wrong to ask.
const PHONE = `0808${RUN}0`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const step = (n) => console.log(`\n${n}`);

let shotN = 0;
const shot = async (page, name) => {
  shotN += 1;
  await page.screenshot({
    path: path.join(OUT, `${String(shotN).padStart(2, '0')}-${name}.png`),
    fullPage: false,
  });
};

const money = (t) => Number(String(t ?? '').replace(/[^0-9.]/g, ''));

async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
  await page.locator('input[type="password"]').first().evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, env('SAMPLE_PASSWORD'));
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(7000);
}

const tab = async (page, name) => {
  await page.getByRole('button', { name, exact: true }).first().click();
  // Wait for the tab's own content, not a fixed delay: switching remounts nothing (all stacks
  // stay alive) but the newly visible stack still needs a frame to become hit-testable.
  await page.waitForTimeout(2500);
  await page
    .locator('[class*="PageScaffold_body"]:visible')
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => {});
};

/**
 * Fill a Field by its visible label, scoped to a root.
 *
 * Scoping matters: the People page and the customer picker both render a "Search customers"
 * input, and an unscoped lookup resolved the hidden one behind the open dialog and then waited
 * thirty seconds for it to become visible.
 */
async function fillLabelled(root, labelText, value) {
  const input = root
    .locator('label')
    .filter({ hasText: new RegExp(labelText) })
    .first()
    .locator('xpath=following::input[1]');
  await input.fill(String(value));
}

/**
 * Pick an <option> by a substring of its text.
 *
 * `selectOption({ label })` matches the whole label exactly and takes a string, not a pattern —
 * and these options carry their deposit in the text ("NBL crate — ₦1,500 each"), so an exact
 * label match on the pool name alone never hits.
 */
async function selectByText(select, text) {
  const value = await select.evaluate(
    (el, t) => (Array.from(el.options).find((o) => o.textContent.includes(t)) || {}).value,
    text,
  );
  if (!value) throw new Error(`no option containing "${text}"`);
  await select.selectOption(value);
}

/** The visible input belonging to a visible <label>, resolved through its `for` attribute. */
function fieldByLabel(page, text) {
  return page
    .locator('label:visible')
    .filter({ hasText: new RegExp(text) })
    .first()
    .locator('xpath=following::input[1]');
}

/** The open dialog, so every lookup inside a sheet is unambiguous. */
const sheet = (page) => page.locator('[role="dialog"]').first();

/**
 * A control on the tab the user is actually looking at.
 *
 * ALL SIX TAB STACKS STAY MOUNTED — that is what makes switching tabs instant and preserves each
 * tab's scroll position. It also means every hidden tab's controls are still in the DOM, so an
 * unscoped `.first()` happily resolves a control on a tab nobody can see and then waits for it to
 * become visible until the timeout. Money and People both have a "Search customers" field, and
 * Money is mounted first; that is exactly how this bit.
 *
 * Every lookup in this file goes through here or through `sheet()`.
 */
const onScreen = (page, selector) => page.locator(`${selector}:visible`).first();

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[acct]') || t.startsWith('[sell]')) console.log('    ' + t); });

  await signIn(page);

  // ── 1 · The customer ────────────────────────────────────────────────────────────
  step('1. Create the customer');
  await tab(page, 'People');

  const existing = page.getByText(CUSTOMER, { exact: false });
  if ((await existing.count()) === 0) {
    await page.getByRole('button', { name: /Add a customer/i }).first().click();
    await page.waitForTimeout(1400);
    const dlg = sheet(page);
    // Search and create are one screen: typing a name that finds nothing offers to add it.
    await dlg.getByLabel('Search customers').fill(CUSTOMER);
    await page.waitForTimeout(1800);
    await dlg.getByRole('button', { name: new RegExp(`Add "${CUSTOMER}"|Add a new customer`) })
      .first().click();
    await page.waitForTimeout(1000);
    await fillLabelled(dlg, 'Phone number', PHONE);
    await shot(page, 'new-customer-form');
    await dlg.getByRole('button', { name: /^Save/i }).first().click();
    await page.waitForTimeout(3000);
  }
  await shot(page, 'people-list');
  // Search for them, so the row is on screen regardless of how many customers exist.
  await onScreen(page, 'input[aria-label="Search customers"]').fill(CUSTOMER);
  await page.waitForTimeout(1800);
  check('customer exists in the list',
    (await page.getByText(CUSTOMER, { exact: false }).count()) > 0);

  // ── 2 · Open the account ────────────────────────────────────────────────────────
  step('2. Open their account');
  // The row BUTTON, not the name span inside it, and scrolled into view first: the People list
  // is its own scroll container and the row can sit below the fold.
  const row = page.getByRole('button', { name: new RegExp(CUSTOMER) }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();

  /*
   * Wait for the account to actually arrive rather than for a fixed number of milliseconds.
   * It makes two round trips (the balances and the whole history), and a timeout tuned on a fast
   * connection reports the loading spinner as a failure on a slow one — which is exactly the
   * wrong way round, since the slow connection is the one real users are on.
   */
  const ready = await page
    .getByText(/Everything that has happened/i)
    .first()
    .waitFor({ timeout: 25000 })
    .then(() => true)
    .catch(() => false);

  await shot(page, 'account-empty');
  if (!ready) {
    const body = await page.locator('body').innerText();
    console.log('   page said:', body.split(String.fromCharCode(10)).filter(Boolean).slice(0, 12).join(' | '));
  }
  check('account page opened', ready);
  if (!ready) throw new Error('account page never loaded — stopping');


  /** Read the position cards and the per-pool rows straight off the screen. */
  const readState = () =>
    page.evaluate(() => {
      const cards = {};
      document.querySelectorAll('[class*="account-page_card__"]').forEach((c) => {
        const l = c.querySelector('[class*="cardLabel"]')?.textContent?.trim();
        const v = c.querySelector('[class*="cardValue"]')?.textContent?.trim();
        if (l) cards[l] = v;
      });
      const pools = {};
      document.querySelectorAll('[class*="account-page_row__"]').forEach((r) => {
        const n = r.querySelector('[class*="rowName"]')?.textContent?.trim();
        const q = r.querySelector('[class*="rowQty"]')?.textContent?.trim();
        if (n) pools[n] = q;
      });
      const events = document.querySelectorAll('[class*="account-page_event__"]').length;
      return { cards, pools, events };
    });

  const doAction = async (buttonText, fill) => {
    await onScreen(page, 'button:has-text("' + buttonText + '")').click();
    await page.waitForTimeout(1300);
    const dlg = sheet(page);
    await fill(dlg);
    await dlg.getByRole('button', { name: /Record it/i }).click();
    // The sheet closes only once the write has returned and the account reloaded.
    await dlg.waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1600);
  };

  // 3 - What they already owed before this shop had the app
  step('3. Enter the opening position');
  for (const r of [
    { money: '200000', pool: 'NBL crate', qty: '3' },
    { money: '', pool: 'Guinness bottle', qty: '4' },
    { money: '', pool: 'Dispenser water bottle', qty: '3' },
  ]) {
    await doAction('Enter what they already owed', async (dlg) => {
      if (r.money) await fillLabelled(dlg, 'Money they already owed', r.money);
      await selectByText(dlg.locator('select#pool'), r.pool);
      await fillLabelled(dlg, 'How many', r.qty);
    });
  }
  await shot(page, 'opening-position');

  let state = await readState();
  console.log('    ' + JSON.stringify(state));
  check('opening money owed is 200,000',
    money(state.cards['They owe you']) === 200000, state.cards['They owe you']);
  check('3 NBL crates out', money(state.pools['NBL crate']) === 3, state.pools['NBL crate']);
  check('4 Guinness bottles out',
    money(state.pools['Guinness bottle']) === 4, state.pools['Guinness bottle']);
  check('3 dispenser bottles out',
    money(state.pools['Dispenser water bottle']) === 3, state.pools['Dispenser water bottle']);

  // 4 - The deposit the shop is already holding
  step('4. Record the deposit already held');
  await doAction('Take a deposit instead', async (dlg) => {
    await selectByText(dlg.locator('select#pool'), 'NBL crate');
    await fillLabelled(dlg, 'How many', '10');
    await fillLabelled(dlg, 'Deposit for each', '2000');
    await fillLabelled(dlg, 'Why / note', 'Held against 10 NBL crates');
  });
  await shot(page, 'deposit-held');

  state = await readState();
  console.log('    ' + JSON.stringify(state));
  check('shop is holding 20,000',
    money(state.cards['You are holding their money']) === 20000,
    state.cards['You are holding their money']);
  check('history records every step', state.events >= 4, state.events + ' events');


  // 5 - Build the receipt
  step('5. Build the sale');
  await tab(page, 'Sell');
  const startBtn = onScreen(page, 'button:has-text("Start a customer")');
  if (await startBtn.count()) { await startBtn.click(); await page.waitForTimeout(1200); }

  const addItem = async (term, name) => {
    await onScreen(page, 'button:has-text("Add an item")').click();
    await page.waitForTimeout(900);
    await onScreen(page, 'input[aria-label="Search products"]').fill(term);
    await page.waitForTimeout(1600);
    await page.locator('[class*="pickItem"]:visible').filter({ hasText: new RegExp(name) })
      .first().click();
    await page.waitForTimeout(1400);
  };

  /** The line card for a product, so quantity/price edits hit the right one. */
  const lineFor = (name) =>
    page.locator('[class*="sell-page_line__"]:visible').filter({ hasText: new RegExp(name) }).first();

  const setQty = async (name, value) => {
    await lineFor(name).locator('[class*="stepperField"] input').fill(String(value));
    await page.waitForTimeout(700);
  };
  const setPrice = async (name, value) => {
    const inputs = lineFor(name).locator('input');
    await inputs.last().fill(String(value));
    await page.waitForTimeout(700);
  };
  const pickUnit = async (name, unit) => {
    await lineFor(name).getByRole('button', { name: unit, exact: true }).first().click();
    await page.waitForTimeout(900);
  };

  await addItem('trophy', 'Trophy');
  await pickUnit('Trophy', 'Half crate');

  await addItem('coca', 'Coca-Cola');

  await addItem('goldberg', 'Goldberg');
  await setQty('Goldberg', 3);

  await addItem('malta', 'Malta');
  await setPrice('Malta', 13000);

  await addItem('american', 'American Cola');
  await setQty('American Cola', 10);

  await shot(page, 'receipt-lines');

  const lineTotals = await page.evaluate(() =>
    [...document.querySelectorAll('[class*="sell-page_line__"]')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({
        name: el.querySelector('[class*="lineName"]')?.textContent?.trim(),
        total: el.querySelector('[class*="lineTotalValue"]')?.textContent?.trim(),
      })));
  console.log('    lines: ' + JSON.stringify(lineTotals));

  const totalOf = (n) => money(lineTotals.find((l) => (l.name || '').includes(n))?.total);
  check('half crate of Trophy is 4,100', totalOf('Trophy') === 4100, String(totalOf('Trophy')));
  check('1 pack of Coca-Cola is 4,500', totalOf('Coca-Cola') === 4500, String(totalOf('Coca-Cola')));
  check('3 crates of Goldberg is 27,000', totalOf('Goldberg') === 27000, String(totalOf('Goldberg')));
  check('Malta overridden to 13,000', totalOf('Malta') === 13000, String(totalOf('Malta')));
  check('10 American Cola at the bulk price is 36,000',
    totalOf('American Cola') === 36000, String(totalOf('American Cola')));

  // 6 - Two named charges, not one lumped "extra"
  step('6. Add transport and loading');
  await onScreen(page, 'button:has-text("Extra charge or note")').click();
  await page.waitForTimeout(800);

  for (const [i, c] of [['Transport', '2000'], ['Loading', '500']].entries()) {
    await onScreen(page, 'button:has-text("Add a charge")').click();
    await page.waitForTimeout(700);
    await fieldByLabel(page, `Charge ${i + 1}`).fill(c[0]);
    await page.waitForTimeout(400);
    // The amount box belongs to the row just filled, so scope to that row.
    await page.locator('[class*="chargeRow"]:visible').nth(i).locator('input').nth(1).fill(c[1]);
    await page.waitForTimeout(600);
  }
  await shot(page, 'receipt-charges');

  const grand = money(await onScreen(page, '[class*="footerTotal"]').innerText());
  console.log('    total to pay: ' + grand);
  check('total is 84,600 goods + 2,000 transport + 500 loading',
    grand === 87100, String(grand));

  // 7 - Declare the crates going out with the goods
  step('7. Crates going out');
  /*
   * By LABEL, not by index.
   *
   * The first version used `input.nth(2)`, and moving the quick-parts block changed the input
   * order — so it typed the crate count into the PRICE field. The total went to ₦56,010 and the
   * scenario blamed the app for a number the harness had written itself.
   */
  await fieldByLabel(lineFor('Trophy'), 'going out').fill('0.5');
  await page.waitForTimeout(600);
  await fieldByLabel(lineFor('Goldberg'), 'going out').fill('3');
  await page.waitForTimeout(900);
  await shot(page, 'crates-out');

  // 8 - Attach the customer, then part-pay
  step('8. Attach the customer and take 40,000');
  await onScreen(page, '[class*="customerChip"]').click();
  await page.waitForTimeout(1400);
  {
    const dlg = sheet(page);
    await dlg.getByLabel('Search customers').fill(CUSTOMER);
    await page.waitForTimeout(1900);
    await dlg.locator('button').filter({ hasText: new RegExp(CUSTOMER) }).first().click();
    await page.waitForTimeout(1600);
  }

  await onScreen(page, 'button:has-text("Take payment")').click();
  await page.waitForTimeout(1600);
  {
    const dlg = sheet(page);
    await fieldByLabel(dlg, 'Amount').fill('40000');
    await page.waitForTimeout(900);
    await shot(page, 'payment-sheet');
    await dlg.getByRole('button', { name: /rest on account/i }).click();
    await page.waitForTimeout(6000);
  }
  // The receipt is a pushed page now, not a sheet held in state.
  const hasReceipt = await page
    .getByText(/Sale recorded|Receipt/i)
    .first()
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check('a receipt page opened after settling', hasReceipt);

  if (hasReceipt) {
    const receipt = page.locator('[class*="PageScaffold_body"]:visible').first();
    const text = await receipt.innerText();
    await shot(page, 'receipt');
    check('receipt itemises Transport', /Transport/.test(text), '');
    check('receipt itemises Loading separately', /Loading/.test(text), '');
    check('receipt shows what is still with the customer',
      /Still with you/.test(text) && /NBL crate/.test(text),
      text.split(String.fromCharCode(10)).filter(Boolean).slice(-8).join(' | '));
    // Back out of the receipt the way a seller would.
    await onScreen(page, 'button[aria-label="Go back"]').click();
    await page.waitForTimeout(1500);
  }

  // 9 - Back to the account: what stands now
  step('9. The account after the sale');
  await tab(page, 'People');
  await shot(page, 'people-after-sale');
  /*
   * The People tab keeps its own stack, so switching back lands on the account page it was left
   * on rather than the list. That is correct — it is what makes tabs feel like places — so the
   * scenario has to cope with either, not assume the list.
   */
  const onList = await onScreen(page, 'input[aria-label="Search customers"]').count();
  if (onList) {
    await onScreen(page, 'input[aria-label="Search customers"]').fill(CUSTOMER);
    await page.waitForTimeout(1900);
    const row2 = page.getByRole('button', { name: new RegExp(CUSTOMER) }).first();
    await row2.scrollIntoViewIfNeeded();
    await row2.click();
  }
  await page.getByText(/Everything that has happened/i).first().waitFor({ timeout: 25000 });
  // Give the page a fair, generous window to refresh ITSELF before touching anything.
  console.log('    waiting 10s for an automatic refresh...');
  await page.waitForTimeout(10000);
  const auto = await readState();
  console.log('    after 10s idle: ' + JSON.stringify(auto.cards));
  check('the account refreshed itself on returning to the tab',
    money(auto.cards['They owe you']) === 247100, auto.cards['They owe you'] || 'n/a');
  await shot(page, 'account-after-sale');

  state = await readState();
  console.log('    ' + JSON.stringify(state));
  // 200,000 already owed + 87,100 sale - 40,000 paid = 247,100
  check('owes 200,000 + 87,100 - 40,000 = 247,100',
    money(state.cards['They owe you']) === 247100, state.cards['They owe you']);
  check('NBL crates now 13 + 3.5 out from this sale',
    money(state.pools['NBL crate']) === 16.5, state.pools['NBL crate']);

  // 10 - They bring one crate back and pay a deposit on the rest
  step('10. One crate back, deposit on the rest');
  await doAction('They brought empties back', async (dlg) => {
    await selectByText(dlg.locator('select#pool'), 'NBL crate');
    await fillLabelled(dlg, 'How many', '1');
  });
  await doAction('Take a deposit instead', async (dlg) => {
    await selectByText(dlg.locator('select#pool'), 'NBL crate');
    await fillLabelled(dlg, 'How many', '2.5');
    await fillLabelled(dlg, 'Deposit for each', '6000');
    await fillLabelled(dlg, 'Why / note', 'Paid instead of returning 1/2 Trophy + 2 Goldberg');
  });
  await shot(page, 'account-final');

  state = await readState();
  console.log('    ' + JSON.stringify(state));
  check('history now carries the whole story', state.events >= 8, state.events + ' events');

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} so far`);
  console.log('page errors:', errors.length ? errors.slice(0, 3) : 'none');

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  if (failed.length) process.exit(1);
};

run().catch((e) => {
  console.error('HARNESS ERROR:', e.message);
  process.exit(2);
});

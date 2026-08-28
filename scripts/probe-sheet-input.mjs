/**
 * A text field inside a sheet is not a drag handle.
 *
 * Reported twice from a real phone: typing into a BottomViewer closes it, while the search viewer
 * stays put. The cause is not focus handling — it is that `Sheet.Content` carried the same
 * `drag: 'y'` gesture as the header, so every input inside a sheet sat on top of a drag surface.
 * A touch that moves a few pixels as a thumb settles on a field IS a drag, and on release the
 * sheet asks whether it was dragged far enough to dismiss — as a FRACTION OF ITS OWN HEIGHT.
 *
 * That fraction is why the search viewer looked immune: the same stray 40px is 5% of a full-screen
 * sheet and 40% of a 200px one. Nothing was wrong with search-viewer's focus handling; it was just
 * too tall to dismiss by accident.
 *
 * This drags on the field itself, by an amount that is meaningful for a short sheet, and asserts
 * the sheet survives. It also drags the HANDLE by the same amount, because the fix must not turn
 * into "nothing dismisses any more".
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const raw = fs.readFileSync('.env.local', 'utf8');
const env = (k) => (raw.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]?.trim().replace(/^"|"$/g, '');

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
};

const b = await chromium.launch();
const p = await (
  await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
).newPage();

await p.goto(BASE + '/login', { waitUntil: 'networkidle' });
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p
  .locator('input[type="password"]')
  .first()
  .evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);

await p.evaluate(() => {
  document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 120; });
});
await p.waitForTimeout(350);
await p.evaluate(() => {
  document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 0; });
});
await p.waitForTimeout(800);

const sheetOpen = async () =>
  (await p.locator('[role="dialog"]:visible').count()) > 0 &&
  (await p.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].find(
      (e) => e.getBoundingClientRect().height > 0,
    );
    return d ? Number(getComputedStyle(d).opacity) > 0.5 : false;
  }));

/*
 * "Add an account" IS A PAGE NOW, and this probe records that.
 *
 * It used to open that sheet and check a drag on its field could not dismiss it. The sheet is
 * gone: four fields, one of them the account number a seller reads out to a customer about to send
 * money, is a form, and forms belong on pages. So the first thing checked here is that it is not a
 * dialog at all.
 *
 * The drag and typing checks then move to a sheet that legitimately keeps a field — the delivery
 * picker, which is a CHOICE and correctly stays a sheet.
 */
await p.getByRole('button', { name: 'More', exact: true }).first().click();
await p.waitForTimeout(2200);
await p.locator('button:visible').filter({ hasText: /bank|money is collected/i }).first().click();
await p.waitForTimeout(2400);
await p.getByRole('button', { name: 'Add an account' }).first().click();
await p.waitForTimeout(2200);

check('the bank form is a page, not a dialog', (await p.locator('[role="dialog"]:visible').count()) === 0);
check('its fields are on the page', /Account number/i.test(await p.locator('body').innerText()));
check('it says what it is for', /customers transfer money into/i.test(await p.locator('body').innerText()));
await p.screenshot({ path: 'shots/bank-form-page.png' });

await p.goBack();
await p.waitForTimeout(2000);

// Now a sheet that SHOULD stay a sheet, and still holds a field.
await p.getByRole('button', { name: 'Stock', exact: true }).first().click();
await p.waitForTimeout(2400);
await p.getByRole('button', { name: 'Record a delivery' }).first().click();
await p.waitForTimeout(2200);
await p.locator('button:visible').filter({ hasText: /add an item|what came in/i }).first().click();
await p.waitForTimeout(1800);

check('the picker sheet opened', await sheetOpen());

const heightNow = () =>
  p.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].find(
      (e) => e.getBoundingClientRect().height > 0,
    );
    return d ? Math.round(d.getBoundingClientRect().height) : 0;
  });

/*
 * This picker DELIBERATELY goes full screen when its search is focused.
 *
 * `minHeight: isSearchFocused ? "100dvh" : minHeight` — a designed transition to a full-screen
 * search layout, which is why selection-viewer has always been pleasant to type in. It is not the
 * fault that was fixed in bottom-viewer, where focus flipped `detent` AND `minHeight` mid-keyboard
 * and the sheet oscillated.
 *
 * So the check is that it settles: one step to full height, and then STILL. An asserting-no-change
 * version of this reported the picker broken for doing exactly what it is meant to do.
 */
const beforeFocus = await heightNow();
await p.locator('[role="dialog"] input').first().click();
await p.waitForTimeout(900);
const afterFocus = await heightNow();
await p.waitForTimeout(700);
const settledFocus = await heightNow();
console.log(`  height ${beforeFocus}px -> ${afterFocus}px on focus, ${settledFocus}px once settled`);
check('the sheet settles after focusing and then holds', afterFocus === settledFocus,
  `${afterFocus} -> ${settledFocus}`);

const sheetHeight = await heightNow();
console.log(`  sheet is ${sheetHeight}px tall of 844px viewport`);

/*
 * Drag downward, starting ON the input, FAR ENOUGH TO DISMISS.
 *
 * A fixed 90px was useless as a test: dismissal is a fraction of the sheet's own height (0.6 by
 * default), so on this 844px sheet 90px is 11% and nothing happens whether the guard is there or
 * not — the probe passed against a build with the guard switched off.
 *
 * The distance is now 75% of the sheet, which is unambiguously past the threshold. That is not a
 * realistic gesture, and it is not meant to be: the property being tested is that a field is NOT A
 * DRAG SURFACE AT ALL. Once that holds, the realistic case — a thumb moving a few pixels on a
 * short sheet, where those pixels ARE past the threshold — cannot happen either.
 */
/*
 * The bank-NAME field, by placeholder.
 *
 * Index 0 is the account number (`inputmode="decimal"`), which strips letters — typing "First Bank"
 * into it and then blaming the app was this probe's own bad aim, twice.
 */
const field = p.locator('[role="dialog"] input').first();
let box = await field.boundingBox();
if (box) {
  await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await p.waitForTimeout(700);

  /*
   * RE-READ THE BOX AFTER FOCUSING.
   *
   * The first version of this probe reused the pre-focus coordinates and reported a failure that
   * was entirely its own: focusing the search field makes SelectionViewer swap in its full-screen
   * search header, complete with a back button, so the drag was landing on a control that had not
   * been there a moment earlier — and closing the sheet exactly as it was designed to.
   *
   * Instrumenting the page settled it: no pointerdown reached the sheet at all, and the dialog was
   * still on screen at opacity 1. The guard was working; the measurement was not.
   */
  box = (await field.boundingBox()) ?? box;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  const pull = Math.round(sheetHeight * 0.75);
  for (let dy = 20; dy <= pull; dy += 20) {
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy);
    await p.waitForTimeout(12);
  }
  await p.mouse.up();
  await p.waitForTimeout(900);

  check('a drag starting on the field does not dismiss the sheet', await sheetOpen(),
    `dragged ${Math.round(sheetHeight * 0.75)}px on a ${sheetHeight}px sheet`);
  await p.screenshot({ path: 'shots/sheet-input-drag.png' });
} else {
  check('a drag starting on the field does not dismiss the sheet', false, 'no field found');
}

// Typing must still work, and still leave it open.
if (await sheetOpen()) {
  /*
   * Click ONCE, then type on the keyboard — the way a person does.
   *
   * `locator.type()` re-focuses the element before every character, which masks exactly the fault
   * being looked for: a probe using it passed against a build that steals focus 60ms after each
   * keystroke. Clicking once and then sending keys leaves the focus where the app put it.
   */
  await field.click();
  await p.waitForTimeout(300);
  await p.keyboard.type('cola', { delay: 90 });
  await p.waitForTimeout(1200);
  check('typing leaves the sheet open', await sheetOpen());
  const got = await field.inputValue();
  const focusStayed = await p.evaluate(() => {
    return document.activeElement?.tagName === 'INPUT';
  });
  check('focus stays in the field while typing', focusStayed,
    focusStayed ? '' : 'focus was taken off the input mid-word');
  const label = await field.evaluate((el) => el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.id || '?');
  console.log(`  typed into "${label}", value is "${got}"`);
  check('and the text is there', got === 'cola', `got "${got}"`);
}

/*
 * The handle must STILL dismiss. A fix that makes a sheet undismissable by drag has traded one
 * fault for a worse one.
 */
if (await sheetOpen()) {
  const handle = await p.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].find(
      (e) => e.getBoundingClientRect().height > 0,
    );
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 12 };
  });
  if (handle) {
    await p.mouse.move(handle.x, handle.y);
    await p.mouse.down();
    for (let dy = 40; dy <= 600; dy += 40) {
      await p.mouse.move(handle.x, handle.y + dy);
      await p.waitForTimeout(12);
    }
    await p.mouse.up();
    await p.waitForTimeout(1200);
    check('dragging the handle still dismisses it', !(await sheetOpen()));
  }
}

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

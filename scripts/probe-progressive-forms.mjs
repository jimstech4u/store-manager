/**
 * A form asks what it can answer for, and nothing else yet.
 *
 * «when filling product or customer form we hide some entry until some are entered, like now we
 *  need to defined shapes first so until that is set then other parts shows to fill»
 *
 * Both forms asked everything from the first keystroke. "On the shelf right now: ___" before any
 * shape is named is twelve of what; "They already owe you ₦___" before anybody is named is a
 * question about nobody. And in `minimum` mode — the one a counter uses, with a customer waiting —
 * both were marked REQUIRED, so the fastest path through the form demanded answers it had not made
 * answerable.
 *
 * The three things this checks are the three ways progressive disclosure goes wrong: it never
 * appears, it appears too early, or it appears and then VANISHES again while somebody is still
 * typing. The last is the one that made the empties screen unusable a few hours ago.
 *
 * READ-ONLY. It types into forms and leaves without saving.
 *
 *     node scripts/probe-progressive-forms.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/progressive';
mkdirSync(SHOTS, { recursive: true });

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

/** Is this tab actually somewhere a finger could land? */
const tabReachable = async (label) => {
  const el = p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first();
  if ((await el.count()) === 0) return false;
  const box = await el.boundingBox();
  return box != null && box.y >= 0 && box.y + box.height <= 844 + 1;
};

const tab = async (label) => {
  /*
   * The bar has two states and a probe meets both.
   *
   * Typing raises the keyboard, which pushes it off a 390x844 phone. Scrolling down a long form
   * collapses it into a single floating button. Either way Playwright resolves the `.nav-item`,
   * finds it outside the viewport, and retries for thirty seconds.
   *
   * A WHEEL, not `window.scrollTo`: the bar comes back on a scroll gesture and a programmatic
   * scroll produces none. From the middle of the screen, because the wheel goes to whatever is
   * under the pointer and after a form that is wherever the last click left it.
   */
  await p.evaluate(() => {
    (document.activeElement instanceof HTMLElement ? document.activeElement : null)?.blur();
  });
  await p.mouse.move(195, 420);
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(1200);

  if (!(await tabReachable(label))) {
    // Collapsed to its floating button. Tap it, which is what somebody does when they can see one
    // button and want six.
    const toggle = p.locator('button, [role="button"]').filter({ hasNotText: /./ }).first();
    if ((await toggle.count()) > 0) {
      await toggle.click({ timeout: 5000 }).catch(() => {});
      await p.waitForTimeout(1500);
    }
  }

  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(4000);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  /*
   * THE CUSTOMER FORM FIRST, and that ordering is not arbitrary.
   *
   * The tab bar is reachable on a screen nobody has scrolled. Opening a long form, scrolling it and
   * pressing Back leaves the bar collapsed into its floating button — so whichever section runs
   * second could not get to its tab, and four attempts at coaxing the bar back tested nothing at
   * all. Each section needs the bar once; both use it while it is known good.
   */
  // ══ The customer form waits for a name ════════════════════════════════════════════
  console.log('\n— a new customer —');
  await tab('People');
  await p.waitForTimeout(1500);
  const addPerson = p
    .getByRole('button', { name: /Add (a )?(customer|somebody|person)/i })
    .first();
  check('People offers to add somebody', (await addPerson.count()) > 0);
  await addPerson.click();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/3-customer-empty.png` });

  const person = await body();
  check('the form opens', /Their name/i.test(person), person.slice(0, 50));
  check(
    'it does not yet ask what they owe',
    !/already owe you/i.test(person),
    'a question about nobody',
  );
  check(
    'and says what it is waiting for',
    /Give them a name first/i.test(person),
  );

  await p.getByLabel(/Their name/i).first().fill('Progressive probe');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${SHOTS}/4-customer-named.png` });

  const named = await body();
  check(
    'named, the rest appears',
    /already owe you/i.test(named),
    (named.match(/They already owe you/i) ?? ['it did not'])[0],
  );
  check('and the waiting line goes', !/Give them a name first/i.test(named));

  // It must survive continuing to type — a backspace to fix a typo must not hide it.
  await p.getByLabel(/Their name/i).first().fill('Progressive probe customer');
  await p.waitForTimeout(1200);
  check(
    'and stays while the name is still being edited',
    /already owe you/i.test(await body()),
  );

  /*
   * Leave the form the way a person would.
   *
   * The tab bar is in the DOM while a form is pushed over it but positioned off the bottom, so
   * Playwright resolved the People tab and then retried for thirty seconds on "element is outside
   * of the viewport". Nobody taps a tab from inside a form; they press Back.
   */
  const leave = p.getByRole('button', { name: 'Go back' }).first();
  if ((await leave.count()) > 0) {
    await leave.click();
    await p.waitForTimeout(3000);
    // A form with something typed into it asks before throwing it away.
    const discard = p.getByRole('button', { name: /Discard|Leave|Yes/i }).first();
    if ((await discard.count()) > 0) {
      await discard.click();
      await p.waitForTimeout(2500);
    }
  }

  // ══ The product form waits for a shape ════════════════════════════════════════════
  console.log('— a new item —');
  await tab('Stock');
  await p.getByRole('button', { name: 'Add an item you sell' }).first().click();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/1-product-empty.png` });

  const blank = await body();
  check('the form opens', /What is it called/i.test(blank), blank.slice(0, 50));
  check(
    'it does not yet ask what is on the shelf',
    !/On the shelf right now/i.test(blank),
    'twelve of what?',
  );
  check(
    'nor whether the container comes back',
    !/Does the container come back/i.test(blank),
    'a shape nobody has named',
  );
  check(
    'and it says what it is waiting for',
    /Say what it comes in first/i.test(blank),
    'a form that grows silently as you type is unsettling',
  );

  // Name it, then give it a shape.
  await p.getByLabel(/What is it called/i).first().fill('Progressive probe item');
  await p.waitForTimeout(1200);
  const stillHidden = await body();
  check(
    'a name alone is not enough — the questions are about a SHAPE',
    !/On the shelf right now/i.test(stillHidden),
  );

  const addShape = p.getByRole('button', { name: /Add a shape|Add another shape|Add shape/i }).first();
  check('the shapes editor offers to add one', (await addShape.count()) > 0);
  if ((await addShape.count()) > 0) {
    await addShape.click();
    await p.waitForTimeout(2500);

    /*
     * A SHAPE IS ADDED BY CHOOSING WHICH ONE, so the button opens a picker and the gesture is not
     * finished until something is picked. A first version clicked the button and stopped, then
     * reported that the form had failed to open up — the app was right and the probe was half way
     * through a two-step action.
     */
    const pick = p.locator('[class*="UnitPicker"] button:visible, [role="dialog"] li button:visible').first();
    if ((await pick.count()) > 0) {
      await pick.click();
      await p.waitForTimeout(2500);
    } else {
      check('the shape picker offers a unit to choose', false, 'nothing to pick from');
    }
    await p.screenshot({ path: `${SHOTS}/2-product-shape.png` });
  }

  const withShape = await body();
  check(
    'once there is a shape, the rest appears',
    /On the shelf right now/i.test(withShape),
    (withShape.match(/On the shelf right now/i) ?? ['it did not'])[0],
  );
  check(
    'and the waiting line goes',
    !/Say what it comes in first/i.test(withShape),
  );

  /*
   * AND IT MUST NOT VANISH AGAIN.
   *
   * The failure mode that made the empties screen unusable this morning: a section gated on the
   * condition that RAISED it, so filling it in made it disappear. Typing into the stock box must
   * not take the stock box away.
   */
  const shelf = p.getByLabel(/On the shelf right now/i).first();
  if ((await shelf.count()) > 0) {
    await shelf.fill('12');
    await p.waitForTimeout(1500);
    const after = await body();
    check(
      'and does not disappear as it is filled in',
      /On the shelf right now/i.test(after),
      'a section gated on the condition that raised it deletes itself',
    );
  }

  check('no page errors along the way', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  console.log('\n  ok  read-only — nothing was saved');
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

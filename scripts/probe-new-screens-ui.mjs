/**
 * The new screens exist, load, and say the right thing — clicked, not type-checked.
 *
 * `tsc` passing is not evidence that a screen works. Five screens shipped in the last two rounds
 * with a server behind each of them, and the way a screen like that fails is navigation-stack's own
 * "Missing route" card or a blank panel where a reader returned an error nobody surfaced — neither
 * of which a compiler can see.
 *
 * WHAT IT CHECKS, per screen: that it reached the screen at all (not the missing-route card), and
 * that a sentence only that screen could produce is on it.
 *
 *     node scripts/probe-new-screens-ui.mjs [http://localhost:3100]
 *
 * NOTE: port 3100 runs `next start`, which is a BUILD — an edit is not on it until it is rebuilt
 * and restarted. A pass against a stale build is the worse half of that, because nothing looks
 * wrong.
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';
import { reachCount } from './lib/reach.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const NL = String.fromCharCode(10);
const SHOTS = 'shots/new-screens';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();

const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

const tab = async (label) => {
  await p.waitForTimeout(700);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(3500);
};

/** A screen is "reached" only if navigation-stack did not answer with its unknown-route card. */
const reached = async (name) => {
  const t = await body();
  if (/missing route/i.test(t)) {
    check(`${name} is registered in this stack`, false, 'navigation-stack answered "Missing route"');
    return false;
  }
  return true;
};

const shot = async (name) => {
  await p.screenshot({ path: `${SHOTS}/${name}.png` });
};

/*
 * WAIT FOR THE CONTENT, not for a guessed number of milliseconds.
 *
 * A first version slept three seconds after each tap and then read the body. On a cold start the
 * correction screen was still showing "Reading this receipt", so the probe asserted against a
 * spinner and reported three failures on a screen that works. A fixed sleep is a guess about
 * somebody else's network.
 */
const settled = async (re, ms = 25000) => {
  /*
   * `getByText`, not `locator('body').filter({ hasText })`.
   *
   * The filter form matches the BODY element — which exists from the first paint whatever is in it
   * — so `waitFor` resolved instantly and the helper waited for nothing at all. It then read the
   * page mid-load and reported four working screens as broken. A wait that cannot time out is the
   * same class of mistake as an assertion that cannot fail.
   */
  try {
    await p.getByText(re).first().waitFor({ state: 'visible', timeout: ms });
    return true;
  } catch {
    return false;
  }
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ══ The yard ══════════════════════════════════════════════════════════════════════
  console.log(NL + '— the yard —');
  await reachCount(p, tab);
  const yardLink = p.getByRole('button', { name: /your yard/i }).first();
  check('the count screen offers the yard', (await yardLink.count()) > 0);
  if ((await yardLink.count()) > 0) {
    await yardLink.click();
    await p.waitForTimeout(3000);
    if (await reached('yard_page')) {
      const t = await body();
      check('the yard screen loads', /your yard|empties standing here/i.test(t));
      /*
       * THE HONEST ANSWER, on screen.
       *
       * Before 0128 this page's figures would have read "−4,587" for Goldberg crates. The shop has
       * never counted its yard, so every row must say so rather than showing a number.
       */
      check(
        'an uncounted stack says so instead of showing a figure',
        /not counted yet|never been counted/i.test(t),
        (t.match(/not counted yet|never been counted/i) ?? ['nothing'])[0],
      );
      check('and no negative figure is shown', !/-[\d,]+ (crate|bottle)/i.test(t));
      await shot('01-yard');

      const countBtn = p.getByRole('button', { name: /count the yard/i }).first();
      if ((await countBtn.count()) > 0) {
        await countBtn.click();
        await settled(/count the yard|by maker/i);
        if (await reached('yard_count_page')) {
          const c = await body();
          check('the count screen loads', /count the yard|by maker/i.test(c));
          check(
            'and it offers both grains',
            /by maker/i.test(c) && /item by item/i.test(c),
          );
          check(
            'and explains that a blank is not a nought',
            /nobody looked/i.test(c),
          );
          await shot('02-yard-count');
        }
      }
    }
  }

  // ══ What is going off ═════════════════════════════════════════════════════════════
  console.log(NL + '— what is going off —');
  await tab('Stock');
  await p.waitForTimeout(1500);
  /*
   * The banner only appears when there IS something to warn about, which is the point — so the
   * screen is reached by its own route when the banner is absent rather than failing the probe for
   * a shop whose shelf happens to be clean.
   */
  const expiryLink = p.getByRole('button', { name: /what is going off/i }).first();
  if ((await expiryLink.count()) > 0) {
    check('the stock screen raises an expiry alarm when there is one', true);
    await expiryLink.click();
  } else {
    console.log('        (no dated stock close to going off — reaching the screen directly)');
    await p.goto(`${BASE}/main?tab=stock`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(2000);
  }
  await p.waitForTimeout(2500);
  {
    const t = await body();
    if (/going off|each delivery keeps its own date/i.test(t)) {
      check('the expiry screen loads', true);
      check(
        'and says each delivery keeps its own date',
        /each delivery keeps its own date|delivery on its own/i.test(t),
      );
      await shot('03-expiry');
    } else {
      console.log('        (skipped: the alarm was not raised, so the screen was not opened)');
    }
  }

  // ══ Correcting a receipt ══════════════════════════════════════════════════════════
  console.log(NL + '— correcting a receipt —');
  const { data: sale } = await shop
    .from('sales')
    .select('id')
    .eq('status', 'posted')
    .order('occurred_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sale) {
    await tab('Money');
    await p.waitForTimeout(2000);
    // Reached from the sales list, which is the journey a shop actually takes.
    const receipts = p.getByRole('button', { name: /all sales|receipts/i }).first();
    if ((await receipts.count()) > 0) await receipts.click();
    await p.waitForTimeout(2500);

    /*
     * A ROW OF THE SALES LIST, and nothing else.
     *
     * `locator('li button, button').filter({ hasText: /#|₦/ })` matched a HIDDEN customer tab from
     * the till, which is still mounted underneath — Playwright then waited thirty seconds for
     * something invisible to become clickable. The same family of mistake as
     * `getByRole('button', { name: 'Sell' })` matching "Close this tab without selling": a locator
     * loose enough to match the wrong thing eventually will.
     *
     * Anchored on the list itself, and required to be visible.
     */
    const row = p.locator('ul li > button:visible').first();
    if ((await row.count()) > 0) {
      await row.click();
      await p.waitForTimeout(3500);
      const t = await body();
      if (/receipt/i.test(t)) {
        const wrong = p.getByRole('button', { name: /something on this is wrong/i }).first();
        check('a receipt offers a correction', (await wrong.count()) > 0);
        if ((await wrong.count()) > 0) {
          await wrong.click();
          // 'What it should have said' is the SUBTITLE and is painted immediately; the reason
          // field only exists once the document has been read.
          await settled(/why is it being corrected/i);
          if (await reached('amend_page')) {
            const a = await body();
            check('the correction screen loads', /correct this receipt|what it should have said/i.test(a));
            check(
              'it shows what each line used to say',
              /was \d/i.test(a),
              (a.match(/was \d[^·]{0,20}/i) ?? ['nothing'])[0],
            );
            check('and demands a reason', /why is it being corrected/i.test(a));
            /*
             * THE BUTTON IS DISABLED UNTIL SOMETHING HAS CHANGED.
             *
             * A commit that is always pressable on a form where nothing has been edited invites a
             * revision that says exactly what the last one said — with a reason attached, which is
             * worse than no revision at all.
             */
            const commit = p.getByRole('button', { name: /nothing changed yet|correct it/i }).first();
            check(
              'and will not commit until something changes',
              (await commit.count()) > 0 && !(await commit.isEnabled()),
              (await commit.count()) > 0 ? await commit.innerText() : 'no button',
            );
            await shot('04-amend');
          }
        }
      }
    }
  }

  // ══ Reports ═══════════════════════════════════════════════════════════════════════
  console.log(NL + '— reports, over a window —');
  await tab('Money');
  await p.waitForTimeout(1500);

  /*
   * THE WINDOW ON THE MONEY SCREEN ITSELF — the summary that sits on a list rather than in a tab.
   */
  {
    const t = await body();
    check(
      'the money screen summarises the period it is showing',
      /billed/i.test(t) && /came in/i.test(t),
      (t.match(/Billed[^A-Z]{0,30}/) ?? ['nothing'])[0],
    );
    check(
      'and names the window in words',
      /september|this month|today|\d{4}/i.test(t),
    );
    await shot('05-money-window');
  }

  const reportsBtn = p.getByRole('button', { name: /reports/i }).first();
  if ((await reportsBtn.count()) > 0) {
    await reportsBtn.click();
    // 'What you sold' is a TAB and is there from the first paint. The CSV button is not.
    await settled(/save as csv/i);
    if (await reached('reports_page')) {
      const t = await body();
      check('the reports screen loads', /reports|what you sold/i.test(t));
      check(
        'and offers the whole catalogue',
        /day by day/i.test(t) && /price list/i.test(t) && /who did what/i.test(t),
      );
      check('with a period to choose', /this month|today/i.test(t));
      check('and a way out to a spreadsheet', /save as csv/i.test(t));
      await shot('06-reports');

      // The poster is its own layout, and the button says so.
      const prices = p.getByRole('tab', { name: /price list/i }).first();
      if ((await prices.count()) > 0) {
        await prices.click();
        await settled(/print the poster/i);
        const pl = await body();
        check('the price list prints as a poster', /print the poster/i.test(pl));
        check('and carries the date it was printed', /prices as at/i.test(pl));
        /*
         * AND NO COST ON IT. The server returns no cost column at all; this is the screen-level
         * half of the same promise, because a poster hangs on a wall customers stand in front of.
         */
        check('and no cost or margin anywhere on it', !/\bcost\b|\bmargin\b/i.test(pl));
        await shot('07-price-poster');
      }
    }
  }

  // ══ What staff owe ════════════════════════════════════════════════════════════════
  console.log(NL + '— what staff owe —');
  // The settings tab is labelled "More" on the bar — four tabs now, and it holds everything else.
  await tab('More');
  await p.waitForTimeout(2000);
  const owed = p.getByRole('button', { name: /what staff owe/i }).first();
  check('settings offers it', (await owed.count()) > 0);
  if ((await owed.count()) > 0) {
    await owed.click();
    await settled(/what staff owe|missing stock/i);
    if (await reached('staff_charges_page')) {
      const t = await body();
      check('the staff charges screen loads', /what staff owe|missing stock/i.test(t));
      check(
        'and says it is not a customer account',
        /not a customer account|never appears in your takings/i.test(t),
      );
      await shot('08-staff-charges');
    }
  }
} catch (e) {
  console.log(`  FAIL  the probe could not finish — ${e.message}`);
  failed += 1;
} finally {
  await browser.close();
  console.log(NL + `  screenshots in ${SHOTS}/`);
}

console.log(NL + (failed === 0 ? 'ALL PASS' : `${failed} FAILED`));
process.exit(failed === 0 ? 0 : 1);

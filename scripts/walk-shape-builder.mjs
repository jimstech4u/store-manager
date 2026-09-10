/**
 * Building a Goldberg by hand: a crate, a bottle, twelve to the crate.
 *
 * Written because a fix that read correctly in the source was still wrong on the screen. The
 * auto-link lived in an EFFECT, not in the handler that was corrected, so `addUnit` returned a
 * shape linked to nothing and the next render linked it anyway — and the box could not be
 * unticked either, because unticking cleared the link the effect immediately re-made.
 *
 * It asserts the sentence the card SAYS, not the state behind it. "Crates go inside something
 * bigger", ticked, on the card of the thing everything else goes into, is the whole defect, and it
 * is only visible as text.
 *
 *     node scripts/walk-shape-builder.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const NL = String.fromCharCode(10);
const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS = 'shots/shape-builder';
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

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const stamp = Date.now().toString().slice(-6);
const CRATE = `WCrate${stamp}`;
const BOTTLE = `WBottle${stamp}`;
const PACK = `WPack${stamp}`;
/*
 * THE SHOP THIS PROBE WILL SIGN IN AS, asked of the membership.
 *
 * Taken from `stores.limit(1)` it is whichever row the database hands back first, which is not the
 * sample account's shop and stopped being it the moment a second shop existed. The words were
 * created somewhere the browser could not see, so the picker answered "No unit by that name" and
 * the walk looked like a search bug.
 */
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

// The shop's words, made directly: this walks the SHAPE builder, and inventing a unit is a
// different screen with its own probe.
const madeUnits = [];
for (const [name, plural] of [
  [CRATE, `${CRATE}s`],
  [BOTTLE, `${BOTTLE}s`],
  [PACK, `${PACK}s`],
]) {
  const { data } = await admin
    .from('store_units')
    .insert({ store_id: storeId, name, plural })
    .select('id')
    .single();
  madeUnits.push(data.id);
}

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

let step = 0;
/*
 * THE CARDS, not the page.
 *
 * `fullPage` is the whole document, and this form scrolls inside a container — so it returned the
 * same 844px of viewport every time and the card being asserted about was usually off the bottom of
 * it. A shape builder is judged one card at a time anyway: what is ticked, and what sentence it
 * says.
 */
const shot = async (name) => {
  step += 1;
  const prefix = `${SHOTS}/${String(step).padStart(2, '0')}-${name}`;
  await p.screenshot({ path: `${prefix}.png` });
  console.log(`     ${prefix}.png`);

  const cards = await p.locator('li[class*="UnitsEditor_card__"]').all();
  for (const [i, c] of cards.entries()) {
    const who = (await c.locator('[class*="UnitsEditor_cardName"]').first().innerText())
      .trim()
      .toLowerCase();
    await c.scrollIntoViewIfNeeded();
    await p.waitForTimeout(250);
    const file = `${prefix}--${i + 1}-${who}.png`;
    await c.screenshot({ path: file });
    console.log(`     ${file}`);
  }
};

/** The card for one shape, by the name in its head. */
const card = (name) =>
  p
    .locator('li[class*="UnitsEditor_card__"]')
    .filter({ hasText: new RegExp(`^${name}`) })
    .first();

const addShape = async (unitName) => {
  await p.getByRole('button', { name: /Add a shape/i }).first().click();
  await p.waitForTimeout(2000);
  // Searched rather than scrolled to: the sheet lists every word this shop has and paginates, so
  // a unit whose name sorts late is not on screen to be clicked.
  const box = p.getByPlaceholder(/Crate, Bag, Litre/i).first();
  await box.click();
  await p.waitForTimeout(600);
  // Typed, not filled. `fill` sets the value and fires one input event; the sheet's search is
  // debounced off real keystrokes and never saw it — the box stayed on its placeholder.
  await box.pressSequentially(unitName, { delay: 40 });
  await p.waitForTimeout(3000);
  await p.locator('[class*="UnitPicker_row"]').filter({ hasText: unitName }).first().click();
  await p.waitForTimeout(1500);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  // Waited FOR, not waited out: the nav bar appearing is what "signed in" means, and a cold dev
  // server compiles /main for longer than any fixed number worth writing down.
  await p.locator('.nav-item').first().waitFor({ state: 'visible', timeout: 180000 });
  await p.waitForTimeout(3000);

  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(800);
  await p
    .locator('.nav-item')
    .filter({ hasText: /^Stock$/ })
    .first()
    .click();
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: /add an item|add what you sell/i }).first().click();
  await p.waitForTimeout(4000);

  await p.getByLabel(/What is it called/i).fill(`ZZ Shape Walk ${stamp}`);
  await p.waitForTimeout(600);
  await shot('empty-form');

  // ── One shape: nothing to go inside, so nothing offers to ──────────────────────────
  console.log('\n— the crate, alone —');
  await addShape(CRATE);
  await shot('crate-only');

  const crateAlone = await card(CRATE).innerText();
  check(
    'a lone shape is not asked what it goes inside',
    !/go inside something bigger/i.test(crateAlone),
    crateAlone.split('\n').filter(Boolean).join(' | ').slice(0, 90),
  );
  check('and nothing claims to measure anything yet', !/is measured in/i.test(crateAlone));

  // ── Two shapes: both may be asked, neither is answered ─────────────────────────────
  console.log('\n— and the bottle —');
  await addShape(BOTTLE);
  await p.waitForTimeout(1200);
  await shot('crate-and-bottle');

  // The four role ticks come first on every card; the fifth is the container question.
  // Found by its WORDS, not its position — see probe-opening-in-shapes.
  const crateBox = card(CRATE)
    .locator('label')
    .filter({ hasText: /go inside something bigger/i })
    .locator('input');
  const bottleBox = card(BOTTLE)
    .locator('label')
    .filter({ hasText: /go inside something bigger/i })
    .locator('input');

  check('the crate is asked whether it goes inside something', await crateBox.isVisible());
  check('so is the bottle', await bottleBox.isVisible());

  /*
   * THE DEFECT, as a single assertion.
   *
   * The crate is what everything else goes into. Adding a bottle after it must not tick the
   * crate's box — and it did, for as long as an effect measured every unlinked shape against
   * whichever shape happened to be added first.
   */
  check('adding the bottle does not tick the CRATE', !(await crateBox.isChecked()));
  check('and does not tick the bottle either', !(await bottleBox.isChecked()));
  check(
    'neither is disabled — each could still go in the other',
    !(await crateBox.isDisabled()) && !(await bottleBox.isDisabled()),
  );
  check(
    'no container has been chosen for anybody',
    !/fit inside one/i.test(await p.locator('body').innerText()),
  );

  // ── Twelve bottles to a crate, said on the bottle's card ───────────────────────────
  console.log('\n— twelve bottles fit inside one crate —');
  await bottleBox.check();
  await p.waitForTimeout(900);
  await shot('bottle-asked');

  const pending = card(BOTTLE).locator('select');
  check('ticking opens a row with nothing chosen', (await pending.inputValue()) === '');

  const options = await pending.locator('option').allInnerTexts();
  check(
    "and offers only this item's other shapes",
    options.length === 2 &&
      /choose one/i.test(options[0]) &&
      options[1].includes(CRATE.toLowerCase()),
    options.join(' / '),
  );

  const howMany = card(BOTTLE)
    .getByLabel(new RegExp(`How many ${BOTTLE}s`, 'i'))
    .first();
  await howMany.fill('12');
  await p.waitForTimeout(500);
  await pending.selectOption({ label: CRATE.toLowerCase() });
  await p.waitForTimeout(1200);
  await shot('bottle-in-crate');

  const bottleCard = await card(BOTTLE).innerText();
  check(
    "the bottle's card says the sentence a shop says",
    /fit inside one/i.test(bottleCard),
    bottleCard.split('\n').filter(Boolean).join(' | ').slice(0, 110),
  );
  check(
    'and the twelve survived being typed before the container was picked',
    (await card(BOTTLE)
      .getByLabel(new RegExp(`How many ${BOTTLE}s`, 'i'))
      .first()
      .inputValue()) === '12',
  );

  /*
   * AND THE CRATE CAN NO LONGER GO IN A BOTTLE.
   *
   * A crate made of bottles cannot go inside one — the circle guard — and with only two shapes on
   * the item that leaves the crate nothing to choose, so the question closes itself.
   */
  check('the crate is no longer offered a container', await crateBox.isDisabled());
  check('and is still unticked', !(await crateBox.isChecked()));

  const crateAfter = await card(CRATE).innerText();
  check(
    'the crate never says it goes inside anything',
    !/fit inside one/i.test(crateAfter),
    crateAfter.split('\n').filter(Boolean).join(' | ').slice(0, 90),
  );
  check(
    'and the bottle is now what everything is measured in',
    /is measured in/i.test(await card(BOTTLE).innerText()),
  );

  /*
   * AND ALL OF IT IS ON THE SCREEN.
   *
   * The sentence read correctly and every text assertion passed while the container dropdown was
   * clipped at the right edge and the button that unsays the relationship was off a 390px phone
   * entirely — `grid-template-columns: 1fr` is floored at the longest option in the dropdown, so
   * the row grew with the shop's own words. Nothing that reads the DOM can see that; the geometry
   * has to be asked for.
   */
  /*
   * MEASURED AGAINST THE CARD, which is the width the phone actually gives this.
   *
   * Measured against the ROW it proves nothing: an overflowing row is WIDER, so its own right edge
   * moves out to wherever the clipped controls ended up and everything is inside it by definition.
   * The first version of this check passed with the fault restored.
   */
  const cardBox = await card(BOTTLE).boundingBox();
  const edge = cardBox.x + cardBox.width;
  for (const [what, el] of [
    ['the container dropdown', card(BOTTLE).locator('select').first()],
    ['the button that unsays it', card(BOTTLE).locator('[class*="UnitsEditor_remove"]').last()],
  ]) {
    const box = await el.boundingBox();
    check(
      `${what} is on the screen, not clipped off the card`,
      box !== null && box.x >= cardBox.x - 1 && box.x + box.width <= edge + 1,
      box === null
        ? 'not rendered'
        : `ends at ${Math.round(box.x + box.width)}px, card ends at ${Math.round(edge)}px`,
    );
  }

  /*
   * THE SECOND CONTAINER IS VISIBLE BEFORE IT IS POSSIBLE.
   *
   * With a crate and a bottle and nothing else, there is nothing left for a bottle to go inside —
   * the crate already holds them. Gated on having a candidate, the control disappeared, so the one
   * item where a shop would go looking for "it also goes in a pack" is the one that never mentioned
   * it. Shown and disabled, with the reason under it.
   */
  const offer = card(BOTTLE).getByRole("button", { name: /also go inside another/i });
  check("the second container is offered even with nothing left to choose", (await offer.count()) === 1);
  check("and it is not pressable yet", await offer.first().isDisabled());
  check(
    "and says what it is waiting for",
    /add the shape first/i.test(await card(BOTTLE).innerText()),
  );

  /*
   * ── A SHAPE GOES INSIDE MORE THAN ONE THING ──
   *
   * A bottle sits in a crate AND in a pack, and a shop that sells both needs to say so once, on the
   * bottle. Nothing new is stored for it — the crate and the pack each record what they hold — so
   * the only question is whether the form offers a second row.
   */
  console.log(NL + "— and bottles also go inside a pack —");
  await addShape(PACK);
  await p.waitForTimeout(1200);
  await shot("pack-added");

  const another = card(BOTTLE).getByRole("button", { name: /also go inside another/i });
  check("the bottle offers a second container", (await another.count()) > 0);

  if ((await another.count()) > 0) {
    await another.first().click();
    await p.waitForTimeout(900);
    await shot("second-container-asked");

    const rows = card(BOTTLE).locator('[class*="UnitsEditor_parentRow"]');
    check(
      "a second row opens beside the first",
      (await rows.count()) === 2,
      `${await rows.count()} row(s)`,
    );

    const pick = rows.nth(1).locator("select");
    const opts = await pick.locator("option").allInnerTexts();
    check(
      "and it does not offer the crate a second time",
      !opts.some((o) => o.includes(CRATE.toLowerCase())),
      opts.join(" / "),
    );
    check(
      "but does offer the pack",
      opts.some((o) => o.includes(PACK.toLowerCase())),
      opts.join(" / "),
    );

    await rows.nth(1).getByLabel(new RegExp(`How many ${BOTTLE}s`, "i")).first().fill("6");
    await p.waitForTimeout(400);
    await pick.selectOption({ label: PACK.toLowerCase() });
    await p.waitForTimeout(1200);
    await shot("bottle-in-crate-and-pack");

    check("both containers stay on the card", (await rows.count()) === 2, `${await rows.count()} row(s)`);
    const said = (await card(BOTTLE).innerText()).toLowerCase();
    check("the crate is still one of them", said.includes(CRATE.toLowerCase()));
    check("and so is the pack", said.includes(PACK.toLowerCase()));

    const counts = [];
    for (const r of await rows.all()) counts.push(await r.locator("input").first().inputValue());
    check("each container keeps its own count", counts.join(",") === "12,6", counts.join(","));
  }

  // ── Untickable, and it stays unticked ──────────────────────────────────────────────
  console.log('\n— and the shop can change its mind —');
  await bottleBox.uncheck();
  await p.waitForTimeout(1500);
  await shot('unticked');

  check('unticking clears the link', !(await bottleBox.isChecked()));
  check('and nothing puts it back', !/fit inside one/i.test(await p.locator('body').innerText()));
  check('the crate is offered a container again', !(await crateBox.isDisabled()));

  console.log('\n— page errors —');
  check('no uncaught error', errors.length === 0, errors.join(' / '));
} catch (e) {
  console.log(`\n  FAIL  the walk did not finish — ${String(e).split('\n')[0]}`);
  await shot('where-it-stopped');
  failed += 1;
} finally {
  await browser.close();
  // Nothing was saved — the form was never submitted — so only the two words need removing.
  for (const id of madeUnits) {
    await admin.from('store_units').delete().eq('id', id);
  }
  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

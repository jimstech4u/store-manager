/**
 * A sheet with a field in it must SIT STILL.
 *
 * The reported fault (video: shots/videos/IMG_2138.MP4, iOS): the sheet flickered, sat at a
 * different height in almost every frame, and looked like it closed itself while somebody was
 * typing into it.
 *
 * Cause, in modal-sheet: the entrance-animation effect depended on the measured sheet height, so
 * every re-measure — and a soft keyboard causes a stream of them — teleported the sheet back to
 * the bottom of the screen before sliding it up again. Both the `zIndex` and `opacity` transforms
 * treat "at the bottom" as gone, so each re-measure blinked the sheet out and back.
 *
 * WHAT THIS MEASURES: the sheet's top edge, sampled repeatedly while typing. A stable sheet moves
 * once (when the keyboard opens) and then holds. The broken one moved on every keystroke, and
 * periodically vanished.
 *
 * Playwright cannot raise a real on-screen keyboard, so the keyboard is simulated by resizing the
 * visual viewport — which is exactly the signal the code under test reacts to.
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

const reveal = async () => {
  await p.evaluate(() => {
    document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 120; });
  });
  await p.waitForTimeout(350);
  await p.evaluate(() => {
    document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 0; });
  });
  await p.waitForTimeout(800);
};

// The delivery picker — a sheet that legitimately keeps a field.
await reveal();
await p.getByRole('button', { name: 'Stock', exact: true }).first().click();
await p.waitForTimeout(2400);
await p.getByRole('button', { name: 'Record a delivery' }).first().click();
await p.waitForTimeout(2400);
await p.locator('button:visible').filter({ hasText: /add an item|what came in/i }).first().click();
await p.waitForTimeout(1600);

const sheetBox = () =>
  p.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].find(
      (e) => e.getBoundingClientRect().height > 0,
    );
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const cs = getComputedStyle(d);
    return {
      top: Math.round(r.top),
      height: Math.round(r.height),
      opacity: Number(cs.opacity),
      vh: window.innerHeight,
    };
  });

const opened = await sheetBox();
check('the sheet is open', opened !== null, JSON.stringify(opened));
check('its top is on screen', opened !== null && opened.top >= 0, `top ${opened?.top}`);

/*
 * IT MUST RESPECT ITS OWN maxHeight.
 *
 * This picker asks for 92dvh, so it should stop short of the screen and leave the page visible
 * behind it. A modal-sheet change once assigned every sheet a maximum equal to the whole viewport
 * — overwriting what search-viewer and selection-viewer set through `style` rather than the prop —
 * and both quietly began filling the screen. Nothing in the suite noticed, because nothing was
 * asserting the one number that changed.
 */
check('it respects its declared maxHeight rather than filling the screen',
  opened !== null && opened.height <= opened.vh * 0.94,
  `${opened?.height}px of ${opened?.vh}px viewport`);

/*
 * Sample EVERY FRAME, not every keystroke.
 *
 * The first version of this check read the sheet's top edge after each character, 320ms apart, and
 * passed cleanly against a deliberately broken build. Two reasons, both worth remembering:
 *
 *   THE FAULT IS FASTER THAN THE SAMPLING. A teleport-and-reslide takes ~250ms, so sampling at
 *   320ms lands reliably in the gaps between them — the sheet is back where it started every time
 *   it is looked at.
 *
 *   THE FAULT IS NOT IN `top`. The teleport moves the sheet with a CSS transform and hides it via
 *   `opacity`/`zIndex`; `getBoundingClientRect().top` of a full-height sheet reads 0 throughout.
 *
 * So this installs a requestAnimationFrame recorder inside the page and reads the transform and
 * opacity on every frame. A blink that lasts four frames is invisible to a 320ms sampler and
 * perfectly visible to this one.
 */
const startSampling = () =>
  p.evaluate(() => {
    const w = window;
    w.__sheetSamples = [];
    w.__sheetSampling = true;
    const tick = () => {
      if (!w.__sheetSampling) return;
      const d = [...document.querySelectorAll('[role="dialog"]')].find(
        (e) => e.getBoundingClientRect().height > 0,
      );
      if (d) {
        const cs = getComputedStyle(d);
        // translateY out of the matrix — matrix(a,b,c,d,tx,ty) / matrix3d(...,tx,ty,tz,1)
        const m = cs.transform;
        let ty = 0;
        if (m && m !== 'none') {
          const n = m.match(/matrix3d\(([^)]+)\)/)
            ? m.match(/matrix3d\(([^)]+)\)/)[1].split(',').map(Number)[13]
            : m.match(/matrix\(([^)]+)\)/)
              ? m.match(/matrix\(([^)]+)\)/)[1].split(',').map(Number)[5]
              : 0;
          ty = Number(n) || 0;
        }
        w.__sheetSamples.push({ ty: Math.round(ty), op: Number(cs.opacity) });
      } else {
        w.__sheetSamples.push({ ty: null, op: null });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const stopSampling = () =>
  p.evaluate(() => {
    window.__sheetSampling = false;
    return window.__sheetSamples;
  });

const field = p.locator('[role="dialog"] input').first();
await field.click();
await p.waitForTimeout(700);

await startSampling();
// Each character changes the result list, so the content is re-measured — the same churn a soft
// keyboard produces, and the exact trigger for the fault.
for (const ch of ['c', 'o', 'l', 'a']) {
  await field.type(ch, { delay: 60 });
  await p.waitForTimeout(320);
}
const samples = await stopSampling();

const frames = samples.length;
const gone = samples.filter((s) => s.ty === null || s.op === null || s.op < 0.5).length;
const shoved = samples.filter((s) => s.ty !== null && s.ty > 40).length;
const maxTy = Math.max(0, ...samples.filter((s) => s.ty !== null).map((s) => s.ty));

console.log(`  ${frames} frames sampled; max translateY ${maxTy}px; ${gone} faded out; ${shoved} shoved down`);

check('the sheet stayed visible on every frame while typing', gone === 0,
  `${gone}/${frames} frames faded or missing`);
check('the sheet was never thrown back down the screen', shoved === 0,
  `${shoved}/${frames} frames translated more than 40px (max ${maxTy}px)`);

const after = await sheetBox();
check('it is still fully opaque', after !== null && after.opacity === 1, `opacity ${after?.opacity}`);
await p.screenshot({ path: 'shots/stability-typing.png' });

/*
 * THE OPENING WINDOW — where the fault actually lives.
 *
 * The teleport only fires while the sheet is in its `opening` state. On iOS that window is wide
 * open for exactly the wrong reason: the field autofocuses, the keyboard animates in over ~300ms
 * feeding a stream of height changes, and every re-animate restarts the 250ms timer, so `opening`
 * never ends. On a desktop browser the sheet settles in 250ms and later churn is harmless, which
 * is why the typing check above passes on a broken build.
 *
 * So this reproduces the real sequence: open the sheet, then change the viewport repeatedly during
 * those first milliseconds. `effectiveMaxHeight` is derived from the window height and is a
 * dependency of the same effect, so this drives it the same way a keyboard does.
 */
await p.keyboard.press('Escape');
await p.waitForTimeout(900);

await startSampling();
await p.locator('button:visible').filter({ hasText: /add an item|what came in/i }).first().click();
for (const h of [800, 760, 720, 690, 660]) {
  await p.setViewportSize({ width: 390, height: h });
  await p.waitForTimeout(45);
}
await p.waitForTimeout(700);
const openSamples = await stopSampling();

const openGone = openSamples.filter((x) => x.ty === null || x.op === null || x.op < 0.5).length;
const openMaxTy = Math.max(0, ...openSamples.filter((x) => x.ty !== null).map((x) => x.ty));
// One slide up from the bottom is the entrance and is expected. Count how many SEPARATE times the
// sheet was down near the bottom after having risen — each of those is a restarted entrance.
let restarts = 0;
let wasUp = false;
for (const x of openSamples) {
  const down = x.ty === null || x.op === null || x.op < 0.5 || x.ty > 200;
  if (!down) wasUp = true;
  else if (wasUp) { restarts += 1; wasUp = false; }
}
console.log(`  opening window: ${openSamples.length} frames, max translateY ${openMaxTy}px, ${openGone} hidden, ${restarts} restarts`);
check('the entrance is not restarted by a resize mid-open', restarts === 0,
  `${restarts} restart(s) after the sheet had already risen`);

await p.setViewportSize({ width: 390, height: 844 });
await p.waitForTimeout(600);

/*
 * Now simulate the keyboard itself: shrink the visual viewport, which is the signal the sheet
 * reacts to, and confirm the top stays on screen rather than being pushed above it.
 */
await p.setViewportSize({ width: 390, height: 480 });
await p.waitForTimeout(900);
const squeezed = await sheetBox();
console.log('  with the viewport squeezed to 480:', JSON.stringify(squeezed));
check('the top stays in view with the keyboard up', squeezed !== null && squeezed.top >= 0,
  `top ${squeezed?.top}`);
check('the sheet is no taller than the visible area',
  squeezed !== null && squeezed.height <= squeezed.vh, `${squeezed?.height} vs ${squeezed?.vh}`);
await p.screenshot({ path: 'shots/stability-keyboard.png' });

await p.setViewportSize({ width: 390, height: 844 });
await p.waitForTimeout(700);
const restored = await sheetBox();
check('it survives the keyboard closing', restored !== null, JSON.stringify(restored));

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

/**
 * A BUILD THAT IS ALREADY WAITING MUST STILL BE OFFERED.
 *
 * Reported as "my PWA is not getting updates anymore", and it was exactly that: the new build was
 * downloaded and sitting in `waiting` on the device, and nothing ever announced it.
 *
 * `ready()` skips a build found during the first twenty seconds after launch — a version that was
 * ready before the shop had done anything is not news. It USED TO DROP IT: on every launch that
 * check runs inside the window, so the waiting build was discarded, and the resume handler only
 * asked the SERVER, which has nothing newer to give because the new build is already on the device.
 * No `updatefound`, no prompt, for ever. The only escape was fully closing every window, which an
 * installed app on a phone essentially never does.
 *
 * WHY THE WAITS ARE LONG. The grace period is twenty seconds and the offer is now deferred to the
 * end of it, so a check made before then proves nothing. The first version of this test waited
 * eight seconds and reported the fault correctly for the wrong reason.
 *
 *     node scripts/probe-update-waiting.mjs
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const BASE = 'http://localhost:3101';
const SW = 'public/sw.js';
copyFileSync(SW, SW + '.bak');
const original = readFileSync(SW, 'utf8');
let failed = 0;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();
try {
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(6000);
  const reg1 = await p.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return { active: !!r?.active, waiting: !!r?.waiting };
  });
  console.log('  after first load:', JSON.stringify(reg1));

  // A new deploy: the worker script changes.
  writeFileSync(SW, original.replace(/const VERSION = '[^']+'/, "const VERSION = 'zzzznewbuild'"));
  console.log('  swapped in a new worker');

  // The app comes back to the foreground — what it does on every resume.
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(26000);
  const reg2 = await p.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return { active: !!r?.active, waiting: !!r?.waiting };
  });
  console.log('  after a resume:', JSON.stringify(reg2));
  const body1 = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  const openPrompt = /new version|update/i.test(body1);
  console.log(`  ${openPrompt ? 'PASS' : 'FAIL'}  a new build is offered while the app is open`);
  if (!openPrompt) failed += 1;

  // Now the case that matters: a build is waiting, and the app is RELAUNCHED (a fresh page in the
  // same profile, as reopening an installed app does).
  const p2 = await ctx.newPage();
  await p2.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(6000);
  const reg3 = await p2.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return { waiting: !!r?.waiting };
  });
  console.log('  on relaunch, still waiting:', JSON.stringify(reg3));
  await p2.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p2.waitForTimeout(26000);
  const body2 = (await p2.locator('body').innerText()).replace(/\s+/g, ' ');
  const relaunchPrompt = /new version|update/i.test(body2);
  console.log(`  ${relaunchPrompt ? 'PASS' : 'FAIL'}  and a build already waiting is offered after a relaunch`);
  if (!relaunchPrompt) failed += 1;
} finally {
  // The worker on disk is a build artefact; put back exactly what was there.
  writeFileSync(SW, original);
  await b.close();
  console.log(failed === 0 ? '  all good' : '  ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

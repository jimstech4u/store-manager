/**
 * The reported money-stack faults:
 *   1. a card shows a balance but the statement behind it shows nothing
 *   2. opening a receipt and coming back leaves stale figures
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE=process.argv[2];
const raw=fs.readFileSync('.env.local','utf8');
const env=k=>(raw.match(new RegExp(`^${k}=(.*)$`,'m'))??[])[1]?.trim().replace(/^"|"$/g,'');
const results=[];
const check=(n,ok,d='')=>{results.push({n,ok});console.log(`  ${ok?'PASS':'FAIL'}  ${n}${d?` — ${d}`:''}`);};

const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2})).newPage();
await p.goto(BASE+'/login',{waitUntil:'networkidle'});
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);

// The bar autohides, so a scrolled page leaves the tabs off screen. Scroll back up first, the
// same as a person would.
/*
 * Nudge, then return to the top.
 *
 * Setting `scrollTop = 0` on a container ALREADY at 0 fires no scroll event, so the bar never
 * hears anything and stays hidden from whatever the last run left behind. A down-then-up produces
 * the upward event that reveals it — which is what a finger does anyway.
 */
await p.evaluate(() => {
  document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 120; });
});
await p.waitForTimeout(400);
await p.evaluate(() => {
  document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 0; });
});
await p.waitForTimeout(900);
await p.getByRole('button',{name:'Money',exact:true}).first().click();
await p.waitForTimeout(2600);

/*
 * Read the card and open THE SAME card.
 *
 * Taking `.first()` twice is not the same row twice: the list now re-reads itself while it is on
 * screen, so it can reorder between the read and the click — and the run then compares one
 * customer's card with another customer's statement and calls it a mismatch. Freezing the row by
 * its own text is what makes the comparison mean anything.
 */
const card = p.locator('[class*="rowLink"]:visible').first();
const cardText = await card.innerText();
const cardName = cardText.split(String.fromCharCode(10))[0];
console.log('  comparing customer:', cardName);
const sameCard = p.locator('[class*="rowLink"]:visible').filter({ hasText: cardName }).first();
const owed = Number(cardText.replace(/[^0-9.]/g,''));
console.log('  card says:', cardText.replace(/\n/g,' | '));
await sameCard.click();
await p.waitForTimeout(3200);
await p.screenshot({path:'shots/money-statement.png'});

const body = await p.locator('body').innerText();
check('statement explains the balance rather than showing nothing',
  !/Nothing has been sold to this customer\.$/m.test(body),
  body.includes('No receipts') ? 'no receipts, but the rest is listed' : 'receipts listed');

const hasContent = await p.locator('[class*="money-page_row"]:visible').count();
check('statement lists something', hasContent > 0, `${hasContent} rows`);

// Open a receipt, come back, and check the figures are not stale.
const receipt = p.locator('[class*="rowLink"]:visible').first();
if (await receipt.count()) {
  await receipt.click();
  await p.waitForTimeout(2600);
  const onReceipt = /Sale recorded|Receipt|receipt/i.test(await p.locator('body').innerText());
  check('a receipt page opened', onReceipt);
  await p.goBack();
  await p.waitForTimeout(3000);
  const back = await p.locator('body').innerText();
  check('back lands on the statement, not a blank', back.length > 200, `${back.length} chars`);
  await p.screenshot({path:'shots/money-back.png'});
}
// The figure the card promised must be the figure the statement shows.
/*
 * The STATEMENT's balance card, not the first `.summaryValue` on the page.
 *
 * Every tab stack stays mounted, so an unscoped `.first()` resolved the Money list's own "owed by
 * those loaded so far" total — a different number for a different thing — and the run reported a
 * mismatch that existed only in the selector.
 */
const header = await p
  .locator('[class*="balanceCard"]:visible [class*="summaryValue"]')
  .first()
  .innerText()
  .catch(() => '');
const cardAmount = cardText.split(String.fromCharCode(10)).pop();
console.log('  card said:', cardAmount, ' statement header says:', header);
const title = await p.locator('h1:visible').first().innerText().catch(() => '');
console.log('  statement is for:', title);
check('statement header matches the card',
  header.replace(/[^0-9]/g, '') === cardAmount.replace(/[^0-9]/g, ''),
  `${header} vs ${cardAmount}`);
await b.close();
const failed=results.filter(r=>!r.ok);
console.log(`\n${results.length-failed.length}/${results.length} passed`);

/**
 * Open the generated PDF in a real PDF viewer and photograph it.
 *
 * A valid-looking structure is not the same as a reader accepting the file, and a PDF writer with
 * no library is exactly where that difference bites.
 */
import { chromium } from '@playwright/test';
import path from 'node:path';

const abs = path.resolve('shots/receipt-sample.pdf').split(path.sep).join('/');
const file = 'file:///' + abs;

const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 700, height: 1000 } })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(file, { waitUntil: 'load' });
await p.waitForTimeout(4000);
await p.screenshot({ path: 'shots/receipt-pdf-render.png' });
console.log('rendered:', file);
console.log('page errors:', errs.length ? errs.slice(0, 2) : 'none');
await b.close();

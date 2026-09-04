/**
 * The benchmark: a whole shop's worth of business, run against a throwaway shop.
 *
 * «let make a testable case scenerios as the benchmark that we can run the store against to ensure
 *  that we have everthing working»
 *
 * Probes answer "is this screen right?". This answers a different question: put a real week of
 * trade through the shop and do the books still add up? A sale, a delivery, a deposit, a return, a
 * count, a correction — each one is fine on its own and the failures live in what one does to
 * another.
 *
 * ONE SHOP PER RUN, created at the start and dropped at the end. Every ledger here is append-only
 * and there is no void path, so a suite that ran against a real shop could not be run twice. The
 * scenarios share that shop ON PURPOSE and build on each other, because that is what makes the
 * question interesting: the customer who owed you from the book is the same one buying on credit in
 * scenario 5.
 *
 *     node scripts/run-scenarios.mjs              # everything
 *     node scripts/run-scenarios.mjs 4 5          # only those, and whatever they depend on
 */

import { closeShop, openShop, results } from './scenarios/harness.mjs';
import { scenarios as opening } from './scenarios/01-a-shop-opens.mjs';
import { scenarios as trading } from './scenarios/02-a-week-of-trade.mjs';
import { scenarios as corrections } from './scenarios/03-corrections-and-what-the-customer-sees.mjs';

/*
 * In order, because they build on each other. A scenario that needs a customer uses the one made in
 * scenario 1 — which is the point: a benchmark of isolated units would not find the failures that
 * only appear when a deposit taken on Monday meets a return on Thursday.
 */
const ALL = [...opening, ...trading, ...corrections];

const wanted = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n));

console.log('\n╔══ store-manager benchmark ═══════════════════════════════════════════════╗');
console.log('║  A throwaway shop, a week of trade, and the books checked afterwards.    ║');
console.log('╚═════════════════════════════════════════════════════════════════════════╝');

let shopId = null;
const started = Date.now();

try {
  const { storeId, slug } = await openShop(new Date().toISOString().slice(0, 16));
  shopId = storeId;
  console.log(`\n  a fresh shop: ${slug}\n`);

  /*
   * The context every scenario writes into and the next one reads.
   *
   * Deliberately shared and deliberately mutable: scenario 2 makes the product scenario 4 sells,
   * and scenario 5 settles the deposit scenario 4 took. A scenario that cannot see what came before
   * it is testing a shop nobody runs.
   */
  const ctx = { storeId, slug };

  for (const [i, scenario] of ALL.entries()) {
    const number = i + 1;
    if (wanted.length > 0 && !wanted.includes(number)) continue;

    console.log(`  ── ${scenario.name}`);
    try {
      await scenario.run(ctx);
    } catch (e) {
      /*
       * A scenario that throws is reported and the run CARRIES ON.
       *
       * Stopping would hide everything after it, and the later scenarios are where the interesting
       * failures are. What follows may fail for want of what this one should have made, so the
       * thrown message is printed rather than swallowed — the first failure usually explains the
       * rest.
       */
      console.log(`    ✖  it stopped: ${String(e.message ?? e).slice(0, 140)}`);
      process.exitCode = 1;
    }
    console.log('');
  }
} catch (e) {
  console.log(`\n  the benchmark could not start: ${String(e.message ?? e)}`);
  process.exitCode = 1;
} finally {
  if (shopId) {
    const dropped = await closeShop(shopId);
    console.log(dropped ? '  the benchmark shop was dropped; nothing is left behind' : '');
  }
}

const { checks, failures } = results();
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n  ${checks - failures} of ${checks} checks passed in ${secs}s` +
    (failures > 0 ? ` — ${failures} FAILED` : ''),
);
if (failures > 0) process.exitCode = 1;

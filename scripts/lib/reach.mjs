/**
 * Reaching Count and People now that neither is a tab.
 *
 * Both were stack roots with a place on the nav bar, and twelve probes said `await tab('Count')` or
 * `await tab('People')` to get to them. The bar is four tabs now:
 *
 *   COUNT   is reached from the Stock screen's floating button — counting is something you do TO
 *           stock, and the pill is the same gesture as Take payment on the till.
 *   PEOPLE  is reached from Settings, under a Customers section, because the list is a reference
 *           rather than a job.
 *
 * ONE HELPER RATHER THAN TWELVE EDITS. The next time a way in moves, it moves here — and a probe
 * that silently stopped reaching the screen it was written for would go on passing against whatever
 * it landed on instead, which is the failure mode this file exists to prevent.
 */

/*
 * Each waits for the DESTINATION to have drawn, not for a guessed number of milliseconds.
 *
 * Reaching either screen is two taps now rather than one, and a fixed sleep sized for the old
 * single tap left probes reading a list before its first page had landed — "the People list loads
 * — 0 rows", followed immediately by the same list reporting 30. A sleep is a guess about somebody
 * else's network; waiting for the thing you navigated to is not.
 */
async function drawn(p, re, ms = 25000) {
  /*
   * Polls the BODY's text rather than waiting on a locator.
   *
   * `getByText(re).first()` resolves to whichever node matches first in the DOM — and a pushed-under
   * page stays mounted, so that is often a HIDDEN copy on the screen beneath. Waiting for it to
   * become visible then times out while the thing being waited for is plainly on screen.
   */
  const until = Date.now() + ms;
  for (;;) {
    const text = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
    if (re.test(text)) break;
    if (Date.now() > until) throw new Error(`never drew ${re}`);
    await p.waitForTimeout(250);
  }
  await p.waitForTimeout(600);
}

/** Stock → the floating Count pill. */
export async function reachCount(p, tab) {
  await tab('Stock');
  const pill = p.getByRole('button', { name: /^Count$/ }).first();
  await pill.waitFor({ timeout: 20000 });
  await pill.click();
  await drawn(p, /check the shelf against the records|nothing to count/i);
}

/** Settings → Customers → Everyone you sell to. */
export async function reachPeople(p, tab) {
  await tab('More');
  const row = p.getByRole('button', { name: /everyone you sell to/i }).first();
  await row.waitFor({ timeout: 20000 });
  await row.click();
  await drawn(p, /your customers|nobody yet|search by name/i);
}

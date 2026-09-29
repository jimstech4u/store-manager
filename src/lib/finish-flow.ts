'use client';

import type { useNav } from '@academix-admin/navigation-stack';

type Nav = ReturnType<typeof useNav>;

/**
 * Wait for the browser to finish a history move that navigation-stack has queued.
 *
 * A pop hands its browser entries back with `history.go(-n)`, which is asynchronous — it queues
 * the move and returns. Pushing before it lands writes the new entry and then has the browser step
 * back over it. So the next push waits for the `popstate` (or a short timeout, when there was no
 * history entry to give back at all).
 */
function historySettled(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('popstate', finish);
      // One more turn, so the stack's own popstate handler has run before anything is pushed.
      setTimeout(resolve, 0);
    };
    window.addEventListener('popstate', finish);
    setTimeout(finish, 450);
  });
}

/**
 * A FINISHED FLOW LEAVES NO WAY BACK INTO IT — the receipt is shown in its place.
 *
 * "after sale recorded and I have printed the receipt, if I press back I get back to this page"
 * — Take payment, saying "This sale is no longer open". The receipt was opened with
 * `pushAndPopUntil`, which rebuilt the in-app stack correctly but added a browser history entry on
 * top of the payment screen's: the payment screen's URL was still in history, and Back walked
 * straight into it. The correction flow did the same with `replace`.
 *
 * So the flow is unwound FIRST — a real pop, which gives its history entries back — and the
 * receipt pushed on what is left. History reads till → receipt, and Back from the receipt is the
 * till (or the receipt the correction started from).
 *
 * `backTo` names where to unwind to. When it is already the page on top it is simply shown; when
 * nothing in the stack matches, the stack unwinds to its root.
 */
export async function finishInto(
  nav: Nav,
  backTo: (entry: { key: string; params?: Record<string, unknown> }) => boolean,
  receipt: { id: string; fresh?: boolean } | null,
): Promise<void> {
  const stack = nav.getStack() as { key: string; params?: Record<string, unknown> }[];
  const hasTarget = stack.some((e) => backTo(e));
  const popped = await nav.popUntil(
    hasTarget ? (e: { key: string; params?: Record<string, unknown> }) => backTo(e) : (_e: unknown, i: number) => i === 0,
  );
  if (popped) await historySettled();

  if (!receipt) return;
  const top = nav.getStack().at(-1) as { key: string; params?: Record<string, unknown> } | undefined;
  // Unwound onto the very receipt the flow started from: it re-reads itself, nothing to push.
  if (top?.key === 'receipt_page' && top.params?.id === receipt.id) return;
  await nav.push('receipt_page', { id: receipt.id, ...(receipt.fresh ? { fresh: '1' } : {}) });
}

/**
 * A PROBE CLEANS UP ONLY WHAT IT MADE.
 *
 * The probes sign in as the shop's own account, so an order the probe opens and an order the shop
 * opens at the same minute look the same in `draft_orders`. The old sweep deleted every open draft
 * created after the probe started — and on 29 Sep that deleted a customer the shop was serving
 * (MPECZ), which left the till unable to save, pay or close that tab, and the confusion that
 * followed cancelled a ₦142,600 order.
 *
 * So the probe's browser is watched instead: every `save_draft_order` it sends carries the tab's
 * `p_client_uuid`, and only drafts with one of THOSE client ids are cleaned up — cancelled, not
 * deleted, exactly as closing the tab would, so the audit trail stays readable.
 *
 *     const tracked = trackDrafts(page);
 *     ...
 *     await sweepDrafts(admin, tracked);
 */

export function trackDrafts(page) {
  const clientIds = new Set();
  page.on('request', (req) => {
    if (!req.url().includes('/rpc/save_draft_order')) return;
    try {
      const body = JSON.parse(req.postData() ?? '{}');
      if (body.p_client_uuid) clientIds.add(body.p_client_uuid);
    } catch {
      // Not JSON — not ours to read.
    }
  });
  return clientIds;
}

export async function sweepDrafts(admin, clientIds) {
  const ids = [...clientIds];
  if (ids.length === 0) return;
  const { data } = await admin
    .from('draft_orders')
    .update({ status: 'cancelled' })
    .in('client_uuid', ids)
    .eq('status', 'open')
    .select('code');
  const n = (data ?? []).length;
  if (n) console.log(`  (closed ${n} probe tab(s): ${(data ?? []).map((d) => d.code).join(', ')})`);
}

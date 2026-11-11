/**
 * A RECEIPT'S CONTAINERS, as plain data and one pure rule — shared by the app (`stacks/sale-empties`)
 * and the agent's server, which cannot import a browser module.
 */

export interface SaleContainer {
  productId: string;
  productName: string;
  productUnitId: string;
  unitName: string;
  unitPlural: string;
  groupName: string | null;
  wentOut: number;
  cameBack: number;
  stillOut: number;
}

/**
 * WHAT SHOULD HAVE COME BACK WITH A CORRECTED RECEIPT, shape by shape — the correction flow's figure,
 * shown on the correction page and applied after it saves.
 *
 * What came back splits in two: the receipt's OWN containers (up to what it sent out before) and
 * OLDER ones handed in with it. A correction that sends out fewer can only have had that many of its
 * own back — #D1746E61 went from three Amstel crates to two and kept three "back", one more than it
 * took — so the own part is cut to the new figure and the older part stays. A shape the person set by
 * hand (`chosen`) is theirs, whatever the rule says.
 */
export function correctedBack(
  before: SaleContainer[],
  outNow: Record<string, number>,
  chosen: Record<string, number> = {},
): Record<string, number> {
  const ids = new Set([...before.map((c) => c.productUnitId), ...Object.keys(outNow)]);
  const out: Record<string, number> = {};
  for (const id of ids) {
    if (chosen[id] !== undefined) {
      out[id] = chosen[id];
      continue;
    }
    const was = before.find((c) => c.productUnitId === id);
    const back = was?.cameBack ?? 0;
    const own = Math.min(back, was?.wentOut ?? 0);
    const older = back - own;
    out[id] = Math.min(own, outNow[id] ?? 0) + older;
  }
  return out;
}

/**
 * HOW MANY CONTAINERS EACH SHAPE SENDS OUT on the corrected receipt: a returnable line sends out its
 * quantity. Returnable is NOT read from a line's `containersOut` alone — receipts written since
 * containers moved to their own ledger carry 0 there, and the correction page said "0 crates went
 * out" for crates that had. So: the shape went out with this receipt before, or the line says so, or
 * the till's shapes say it is returnable (`isReturnable`, for an item just added).
 */
export function containersGoingOut(
  lines: { saleUnitId: string | null; qty: string | number; containersOut?: string | number | null }[],
  before: SaleContainer[],
  isReturnable: (saleUnitId: string) => boolean = () => false,
): Record<string, number> {
  const went = new Set(before.filter((c) => c.wentOut > 0 || c.cameBack > 0).map((c) => c.productUnitId));
  const out: Record<string, number> = {};
  for (const l of lines) {
    const pu = l.saleUnitId;
    if (!pu) continue;
    if (!(went.has(pu) || Number(l.containersOut) > 0 || isReturnable(pu))) continue;
    out[pu] = (out[pu] ?? 0) + (Number(l.qty) || 0);
  }
  return out;
}

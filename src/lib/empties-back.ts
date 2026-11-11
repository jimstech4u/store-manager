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

/**
 * THE SHAPES A CONTAINER COMES BACK IN — "3 bottles from 1 crate of Goldberg of 12 bottles" (11 Nov),
 * and "plan for when we have a larger number of shapes for a product": a crate of 24 can come back as
 * crates, as packs of 6, as loose bottles. The ledger has always held parts (a quarter of a crate is
 * 0.25); this is what lets the screen ask in each shape and say it back the same way.
 *
 * The container's own shape first, then every smaller shape of the same product that fits into it
 * evenly, largest first. Just the container when it is already the smallest, or nothing smaller is
 * kept for the product.
 */
export interface Shape {
  name: string;
  plural: string;
  /** Its size in the product's base units: a crate 24, a pack 6, a bottle 1. */
  base: number;
}

type UnitLike = { productId: string; productUnitId: string; name: string; plural: string; baseQty: number };

export function shapesOf(units: UnitLike[], productUnitId: string): Shape[] {
  const self = units.find((u) => u.productUnitId === productUnitId);
  if (!self || !(self.baseQty > 0)) return [];
  const fits = (b: number) => {
    const n = self.baseQty / b;
    return Math.abs(n - Math.round(n)) < 1e-6;
  };
  const smaller = units
    .filter((u) => u.productId === self.productId && u.baseQty > 0 && u.baseQty < self.baseQty - 1e-9 && fits(u.baseQty))
    .sort((a, b) => b.baseQty - a.baseQty);
  // One shape per size: a shop with "Bottle" and "Piece" both at 1 is asked once.
  const seen = new Set<number>([self.baseQty]);
  const out: Shape[] = [{ name: self.name, plural: self.plural, base: self.baseQty }];
  for (const u of smaller) {
    if (seen.has(u.baseQty)) continue;
    seen.add(u.baseQty);
    out.push({ name: u.name, plural: u.plural, base: u.baseQty });
  }
  return out;
}

/**
 * A figure in containers as a count of each shape, largest first: 1.2917 crates of 24 with packs of 6
 * and bottles → [1, 1, 1]. Only meaningful with more than one shape (one shape keeps its fraction).
 */
export function splitShapes(qty: number, shapes: Shape[]): number[] {
  if (shapes.length === 0) return [];
  // To the smallest shape first: the ledger keeps four places, so 23 of 24 cans is 0.9583 of a crate,
  // 22.999 cans — which counted down would say 4 loose cans where 5 came back.
  const grain = shapes[shapes.length - 1].base;
  let rest = Math.round((qty * shapes[0].base) / grain) * grain;
  return shapes.map((s) => {
    const n = Math.max(Math.floor(rest / s.base + 1e-6), 0);
    rest -= n * s.base;
    return n;
  });
}

/** Back to the figure the ledger keeps, in containers, at its own precision (four places). */
export function joinShapes(counts: number[], shapes: Shape[]): number {
  if (shapes.length === 0) return 0;
  const base = counts.reduce((sum, n, i) => sum + n * (shapes[i]?.base ?? 0), 0);
  return Math.round((base / shapes[0].base) * 10000) / 10000;
}

/**
 * A figure said in the shapes the shop counts in: "1 crate 1 pack 3 bottles", "3 bottles", "2 crates".
 * With one shape (or a part no shape makes), the figure with its fraction ("1 1/2 crates").
 */
export function saidInShapes(
  qty: number,
  shapes: Shape[],
  fallback: { name: string; plural: string },
  spoken: (n: number) => string = (n) => String(n),
): string {
  const word = (n: number, one: string, many: string) => (n === 1 ? one : many).toLowerCase();
  const plain = () => `${spoken(qty)} ${word(qty, fallback.name, fallback.plural)}`;
  if (shapes.length < 2) return plain();
  const counts = splitShapes(qty, shapes);
  if (Math.abs(joinShapes(counts, shapes) - qty) > 1e-3) return plain();
  const said = counts
    .map((n, i) => (n > 0 ? `${n} ${word(n, shapes[i].name, shapes[i].plural)}` : null))
    .filter(Boolean);
  return said.length > 0 ? said.join(' ') : `0 ${fallback.plural.toLowerCase()}`;
}

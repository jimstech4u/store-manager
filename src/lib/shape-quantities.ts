/**
 * Saying a quantity in the shapes a shop actually names.
 *
 * PURE, and deliberately in its own file with no imports at all — the same reason
 * `quantity-rules.ts` is. It is arithmetic a shop will argue with, so it has to be testable on its
 * own, without a React tree or a database: `scripts/probe-stock-in-shapes.mjs` compiles this one
 * file and runs it.
 */

/** Only what the decomposition needs. Any row carrying these will do. */
export interface ShapeQuantity {
  name: string;
  plural: string;
  baseQty: number;
  onHandBase: number;
  isCounted?: boolean;
}

/**
 * What is on the shelf, said in shapes: "99 crates 8 bottles".
 *
 * The old sentence was a division — 1,196 bottles over twelve — which reads "99.67 crates". No shop
 * has ever said that, and nobody can check it against a shelf: the eight loose bottles, which are
 * the entire reason the number is not round, vanish into a decimal.
 *
 * Greedy down the tree, largest shape first, so it works at any depth — a pallet of crates of
 * bottles decomposes as readily as a crate of bottles. Shapes that divide to nothing are left out,
 * because "99 crates 0 bottles" is a form, not a sentence.
 */
export function stockInShapes(units: ShapeQuantity[] | undefined): string {
  if (!units || units.length === 0) return '';

  const shapes = [...units].sort((a, b) => b.baseQty - a.baseQty);
  let left = shapes[0].onHandBase;

  /*
   * Negative stock is a real state — an offline sale, a count still to be resolved — and it must
   * not be dressed up. NOT decomposed, because "minus 1 crate 4 bottles" reads like a quantity
   * somebody could go and find.
   *
   * Said in the SMALLEST shape, which is the correction the walk found: leading with the counting
   * shape produced "−0.08 packs", which is true, unactionable, and one bottle. In the smallest
   * shape the same figure is a whole number and an instruction — "−1 bottle" — and the sign still
   * makes it unmistakable for something on the shelf.
   */
  if (left < 0) {
    /*
     * The biggest shape it comes out whole in — largest first, so a shortfall of 1,488 bottles is
     * "-124 crates" and a shortfall of one is "-1 bottle". Both were got wrong in turn by fixing
     * the shape rather than the rule: the counting shape gave "-0.08 packs", the smallest gave
     * "-1488 pieces", and each is true and unactionable.
     *
     * Nothing divides only when the shortfall is genuinely fractional, and then the smallest shape
     * with a decimal is the honest answer rather than a tidy lie.
     */
    const readsWhole = shapes.find(
      (u) => u.baseQty > 0 && Math.abs(left / u.baseQty - Math.round(left / u.baseQty)) < 1e-9,
    );
    const unit = readsWhole ?? shapes[shapes.length - 1];
    const qty = Number((left / unit.baseQty).toFixed(2));
    return `${qty} ${Math.abs(qty) === 1 ? unit.name.toLowerCase() : unit.plural.toLowerCase()}`;
  }

  const parts: string[] = [];
  for (const shape of shapes) {
    if (shape.baseQty <= 0) continue;
    const whole = Math.floor(left / shape.baseQty + 1e-9);
    if (whole > 0) {
      parts.push(`${whole} ${whole === 1 ? shape.name.toLowerCase() : shape.plural.toLowerCase()}`);
      left -= whole * shape.baseQty;
    }
  }

  // A remainder smaller than the smallest shape — half a litre where the shop only names litres.
  const smallest = shapes[shapes.length - 1];
  if (left > 1e-9) {
    const part = Number((left / smallest.baseQty).toFixed(2));
    parts.push(`${part} ${smallest.plural.toLowerCase()}`);
  }

  if (parts.length === 0) {
    return `0 ${smallest.plural.toLowerCase()}`;
  }
  return parts.join(' ');
}

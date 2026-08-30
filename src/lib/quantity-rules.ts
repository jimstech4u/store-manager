/**
 * What quantities a shop actually sells a unit in.
 *
 * One place, because three screens need the same answer and three answers is how a till lets
 * through a quantity the database then refuses. The till offers these as buttons, snaps a typed
 * figure to them, and decides whether a new line starts at one or at nothing.
 *
 * THERE ARE TWO KINDS OF THING IN A SHOP, and the whole file turns on the difference.
 *
 *   THINGS THAT ARE WEIGHED. A chicken is 3.2 kg because that is what the scale said. There is no
 *   grid to land on — 2.22 is as real as 3, the price is the weight times the rate, and rounding it
 *   to anything is throwing away money in one direction or the other. `wholeDigit` off.
 *
 *   THINGS THAT ARE COUNTED. Crates, packs, bags. A shop sells them whole, and some shops also
 *   sell a half or a quarter of one. Nothing in between exists: there is no such thing as 4.3
 *   crates, and a till that accepts one has recorded something the shop cannot hand over.
 *
 * FOR COUNTED THINGS THE FRACTION SETS A STEP, it is not a list of three separate buttons. A shop
 * that says it sells quarters is saying its step is a quarter — so a half and three-quarters come
 * with it, because those are quarters too. A shop that says halves gets halves and nothing finer.
 * Whole numbers are always sellable whatever the step: somebody who sells three-quarter bags
 * certainly sells one bag.
 */

export interface QuantityRules {
  wholeDigit: boolean;
  allowQuarter: boolean;
  allowHalf: boolean;
  allowThreeQuarter: boolean;
}

/**
 * The finest amount this unit is sold in, below a whole one. Zero when it is sold whole only.
 *
 * The quarter flag wins over the half flag when both are set, because a shop that sells quarters
 * can obviously sell halves — two of them — and the finer answer is the one that permits more.
 */
function stepFor(rules: QuantityRules): number {
  if (rules.allowQuarter) return 0.25;
  if (rules.allowHalf) return 0.5;
  if (rules.allowThreeQuarter) return 0.75;
  return 0;
}

/**
 * The part-amounts to offer as buttons, in order.
 *
 * Every multiple of the step that is still less than a whole one — so a quarter-step offers ¼, ½
 * and ¾ from the single flag, rather than making a shop tick three boxes to mean one thing.
 *
 * EMPTY FOR ANYTHING WEIGHED. A part-button on a chicken is meaningless: the seller is copying a
 * number off a scale, and "½" is not a reading a scale produces.
 */
export function partsFor(rules: QuantityRules): { label: string; value: number }[] {
  if (!rules.wholeDigit) return [];

  const step = stepFor(rules);
  if (step === 0) return [];

  const labels: Record<string, string> = { '0.25': '¼', '0.5': '½', '0.75': '¾' };
  const parts: { label: string; value: number }[] = [];

  for (let v = step; v < 1; v = Number((v + step).toFixed(4))) {
    parts.push({ label: labels[String(v)] ?? String(v), value: v });
  }
  return parts;
}

/**
 * The quantity a line starts at.
 *
 * ONE only when the unit is sold strictly whole, because then there is no question to ask — a crate
 * is a crate and the seller is about to press + anyway.
 *
 * NOTHING otherwise, and that is deliberate. A shop selling half crates has no safe default:
 * starting at one is a guess that gets recorded whenever somebody is hurrying, and half a crate
 * sold as a whole one is a real loss. A weighed thing is worse still — nobody can guess what a
 * chicken weighs. Starting at nothing makes the seller say.
 */
export function startingQty(rules: QuantityRules): number {
  const soldWholeOnly = rules.wholeDigit && partsFor(rules).length === 0;
  return soldWholeOnly ? 1 : 0;
}

/**
 * Snap a typed quantity onto what the shop sells.
 *
 * Somebody types 4.3 into a unit sold in halves; they meant 4.5 or 4, and 4.3 is a line the
 * database will refuse at the worst moment, after the money has been counted. Snapped to the
 * NEAREST allowed figure rather than down, because a seller who overshoots slightly meant the one
 * they were reaching for.
 *
 * UNTOUCHED FOR ANYTHING WEIGHED. 3.2 kg of chicken is not an error to be corrected, it is the
 * scale reading, and a till that rounded it would be inventing a weight nobody weighed.
 */
export function snapQty(value: number, rules: QuantityRules): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (!rules.wholeDigit) return value;

  const parts = partsFor(rules).map((p) => p.value);
  if (parts.length === 0) return Math.round(value);

  /*
   * The figures within reach: the whole number below, that number plus each allowed part, and the
   * whole number above. Whole numbers are in the list unconditionally — a step of three-quarters
   * must not make "one bag" unsellable on the way to 1.5.
   */
  const whole = Math.floor(value);
  const candidates = [whole, ...parts.map((p) => whole + p), whole + 1];

  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(c - value) < Math.abs(best - value)) best = c;
  }

  // Guard the float: 0.1 + 0.2 arithmetic leaves 4.500000000000001, which then fails an equality
  // check somewhere downstream and looks like a different bug entirely.
  return Number(best.toFixed(4));
}

/** Whether a quantity is one this shop can actually sell. */
export function isAllowedQty(value: number, rules: QuantityRules): boolean {
  return snapQty(value, rules) === Number(value.toFixed(4));
}

/**
 * Saying what a customer owes back, the way a shop says it out loud.
 *
 * PURE, and with no imports at all — the same reason `shape-quantities.ts` and `quantity-rules.ts`
 * are. This is arithmetic a customer will argue with across a counter, so it has to be testable on
 * its own, without a React tree or a database.
 *
 * THE RULE, in the shop's words:
 *
 *   Three and a half crates of Goldberg and two and a half of Gulder is FIVE NBL crates, half a
 *   Goldberg and half a Gulder.
 *
 * Not six. Not five and a half of something unnamed. The whole crates are interchangeable — a
 * Goldberg crate settles a Gulder crate because both go back to Nigerian Breweries — so they add
 * up. The halves do not: half a crate is a physical part-load of one particular beer, and adding
 * two halves into "one NBL crate" would claim a crate exists that nobody can hand over.
 *
 * So: WHOLE PARTS ADD UP ACROSS THE GROUP, FRACTIONS STAY WITH THEIR PRODUCT.
 */

/** One product's shape, and how many of it are owed. What the reader returns per row. */
export interface OwedRow {
  productId: string;
  productName: string;
  productUnitId: string;
  unitName: string;
  unitPlural: string;
  /** How many of the smallest shape one of these is worth — crates and bottles must not mix. */
  baseQty: number;
  groupId: string | null;
  groupName: string | null;
  /**
   * Whose containers these are.
   *
   *   `they_hold`  ours, out with them
   *   `we_hold`    theirs, left with us
   *
   * Two separate obligations that settle separately: a customer holding four of our crates while
   * we hold two of theirs owes four and is owed two, and netting them would produce a figure
   * neither party recognises.
   */
  side?: 'they_hold' | 'we_hold';
  owed: number;
}

/** A line as it should be read out or printed. */
export interface OwedLine {
  /** What to call it: a group when several products share the whole units, else the product. */
  label: string;
  /** The shape, in the shop's own word. */
  unit: string;
  qty: number;
  /** Said as "½" rather than "0.5" when it is a part-load. */
  said: string;
  /** True for the fractional remainder of one product, which never merges with anything. */
  isPart: boolean;
  /** Which products fed this line, so a screen can show the working. */
  products: string[];
  /**
   * Whose containers this line is about — carried out so a screen never prints the two together.
   *
   * A customer holding 55 of our crates while we hold 65 of theirs was rolled into "120 crates":
   * the bucket key was the maker and the shape, and said nothing about which way the obligation
   * ran. One number, made of two opposite facts, and it is the number a breakage fee is worked out
   * from.
   */
  side: 'they_hold' | 'we_hold';
}

/**
 * A fraction as somebody says it.
 *
 * Halves, quarters and three-quarters, because those are the parts the shapes allow
 * (`whole_digit` / `allow_half` / `allow_quarter` / `allow_three_quarter`). Anything else falls
 * back to the decimal rather than being rounded into a lie.
 */
export function saidAsPart(n: number): string {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  if (near(n, 0.25)) return '¼';
  if (near(n, 0.5)) return '½';
  if (near(n, 0.75)) return '¾';

  const whole = Math.floor(n);
  const rest = n - whole;
  if (whole > 0) {
    if (near(rest, 0.25)) return `${whole}¼`;
    if (near(rest, 0.5)) return `${whole}½`;
    if (near(rest, 0.75)) return `${whole}¾`;
  }
  // Trailing zeros trimmed: "2" not "2.00", "2.3" not "2.30".
  return String(Number(n.toFixed(3)));
}

/**
 * What is owed, gathered for reading.
 *
 * Grouped by GROUP AND SHAPE together. A crate and a bottle are different obligations however
 * closely related the products are — "eight NBL" has to mean eight of one thing — so `baseQty` and
 * the unit's name both take part in the key. Rolling a crate together with a bottle because both
 * are NBL would be the pool model's mistake in a new place.
 *
 * WHOLE ONES ARE NAMED BY THE MAKER whenever the product has one — "NBL 2", even when only Gulder
 * contributes. The shop says it that way because a whole crate IS interchangeable: the customer can
 * hand back any NBL crate against it. (This used to name a lone contributor by the product, which is
 * how the counter never talks about it.)
 *
 * ONE PRODUCT IS ADDED UP BEFORE IT IS SPLIT. A receipt now lists everything still with the customer
 * — old receipts and this one — so the same beer can arrive as several rows: half a Goldberg crate
 * from Monday and half from Wednesday. Split first, those are two halves; added first, they are the
 * whole crate the customer is actually holding.
 */
export function rollUpOwed(input: OwedRow[]): OwedLine[] {
  const buckets = new Map<
    string,
    {
      unit: string;
      unitOne: string;
      group: string | null;
      whole: number;
      products: Set<string>;
      side: 'they_hold' | 'we_hold';
    }
  >();
  const parts: OwedLine[] = [];

  const combined = new Map<string, OwedRow>();
  for (const r of input) {
    const k = `${r.productId}|${r.productUnitId}|${r.side ?? 'they_hold'}`;
    const had = combined.get(k);
    combined.set(k, had ? { ...had, owed: had.owed + r.owed } : { ...r });
  }
  const rows = [...combined.values()];

  for (const r of rows) {
    if (!(r.owed > 0)) continue;

    const whole = Math.floor(r.owed + 1e-9);
    const rest = r.owed - whole;

    /*
     * The shape is part of the key, not just the group.
     *
     * `baseQty` alone is not enough: two products can both call something a "crate" and mean
     * twelve, and two others can both say "bottle" and mean one. It is the pair that identifies
     * "the thing everyone at this counter means", which is what may be added up.
     */
    const side = r.side ?? 'they_hold';
    const key = `${side}|${r.groupId ?? `product:${r.productId}`}|${r.baseQty}|${r.unitPlural.toLowerCase()}`;

    if (whole > 0) {
      const b = buckets.get(key) ?? {
        unit: r.unitPlural,
        unitOne: r.unitName,
        group: r.groupName,
        whole: 0,
        products: new Set<string>(),
        side,
      };
      b.whole += whole;
      b.products.add(r.productName);
      buckets.set(key, b);
    }

    /*
     * THE PART-LOAD, kept with its own product and never added to anything.
     *
     * Half a crate of Goldberg and half a crate of Gulder are two half-crates of two different
     * beers. They are not one crate, and a customer handing back "one NBL crate" against them
     * would be handing back something that does not exist.
     */
    if (rest > 1e-9) {
      parts.push({
        label: r.productName,
        // Singular for anything up to one: "½ crate", not "½ crates".
        unit: rest <= 1 ? r.unitName : r.unitPlural,
        qty: rest,
        said: saidAsPart(rest),
        isPart: true,
        products: [r.productName],
        side,
      });
    }
  }

  const wholes: OwedLine[] = [...buckets.values()].map((b) => ({
    // By the maker whenever there is one — the whole crate is anybody's crate from that maker.
    label: b.group ?? [...b.products][0],
    unit: b.whole === 1 ? b.unitOne : b.unit,
    qty: b.whole,
    said: String(b.whole),
    isPart: false,
    products: [...b.products],
    side: b.side,
  }));

  // Biggest obligation first — that is the one a conversation at the counter starts with. Parts
  // after the wholes, because they are the remainder of the same story.
  wholes.sort((a, b) => b.qty - a.qty);
  parts.sort((a, b) => a.label.localeCompare(b.label));

  return [...wholes, ...parts];
}

/** The whole thing as one sentence: "8 NBL crates, ½ Goldberg crate, 4 Goldberg bottles". */
export function owedInWords(rows: OwedRow[]): string {
  // One side at a time: "nothing" for a customer who holds none of ours is true even while we hold
  // some of theirs, and saying the two in one breath is what produced a figure nobody recognised.
  const lines = rollUpOwed(rows).filter((l) => l.side === 'they_hold');
  if (lines.length === 0) return 'nothing';
  return lines
    .map((l) => `${l.said} ${l.label} ${l.unit.toLowerCase()}`)
    .join(', ');
}

/**
 * A receipt's `empties` rows, as the rule reads them.
 *
 * Both copies of a receipt — the till's and the shared link — hand over the same snake_case rows
 * (0140), so the mapping lives here once rather than in each page.
 */
export function owedRowsFromReceipt(rows: unknown): OwedRow[] {
  if (!Array.isArray(rows)) return [];
  return (rows as Record<string, unknown>[]).map((r) => ({
    productId: String(r.product_id ?? ''),
    productName: String(r.product_name ?? ''),
    productUnitId: String(r.product_unit_id ?? ''),
    unitName: String(r.unit_name ?? ''),
    unitPlural: String(r.unit_plural ?? ''),
    baseQty: Number(r.base_qty) || 1,
    groupId: (r.group_id as string | null) ?? null,
    groupName: (r.group_name as string | null) ?? null,
    side: 'they_hold',
    owed: Number(r.owed) || 0,
  }));
}

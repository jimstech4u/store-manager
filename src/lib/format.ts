/* =====================================================================================
   Formatting money and quantities for display.

   These functions FORMAT. They never compute. All money and quantity arithmetic happens in
   Postgres against `numeric` columns (plan decision C4) — the moment a naira amount is added
   up in JavaScript it goes through a float, and a stock or debt figure that drifts makes CRODS
   variance meaningless, which is the feature everything else rests on.

   Values arrive from Supabase as STRINGS for exactly that reason. Parsing one to a number here
   is fine — it is the last step before pixels — but the result must never be written back.
   ===================================================================================== */

/**
 * Naira, whole by default.
 *
 * Nigerian trade does not use kobo, so "₦3,700" is what a seller says and what the receipt
 * should show. `decimals` exists for the rare store that configures otherwise
 * (`stores.money_decimals`) and for derived figures like average cost, where the fractions are
 * real and hiding them would misreport the number.
 */
export function formatMoney(
  value: string | number | null | undefined,
  decimals = 0,
): string {
  const n = toNumber(value);
  if (n === null) return '—';

  return `₦${n.toLocaleString('en-NG', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Money without the currency mark — for table columns where the header already says naira. */
export function formatAmount(
  value: string | number | null | undefined,
  decimals = 0,
): string {
  const n = toNumber(value);
  if (n === null) return '—';
  return n.toLocaleString('en-NG', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * A quantity, showing decimals only when the value actually has them.
 *
 * "12 pieces" and "1.4 kg" both read naturally; "12.0000 pieces" reads like a machine, and
 * this audience reads it as an error. Trailing zeros are dropped rather than padded.
 */
export function formatQty(value: string | number | null | undefined): string {
  const n = toNumber(value);
  if (n === null) return '—';

  const rounded = Math.round(n * 10000) / 10000;
  return rounded.toLocaleString('en-NG', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

export interface PackInfo {
  name: string;
  baseUnitQty: number;
}

/**
 * Say a quantity the way the seller would.
 *
 * 24 pieces in a 12-per-pack product is "2 packs", and 26 is "2 packs and 2 pieces" — not
 * "2.1667 packs", which is a number no one at a counter has ever said out loud. Forcing people
 * to convert in their heads is how a tool stops being used, so the conversion happens here.
 */
export function formatQtyWithPack(
  baseQty: string | number | null | undefined,
  baseUnit: string,
  pack?: PackInfo | null,
): string {
  const n = toNumber(baseQty);
  if (n === null) return '—';

  if (!pack || pack.baseUnitQty <= 0) {
    return `${formatQty(n)} ${pluralUnit(baseUnit, n)}`;
  }

  const whole = Math.floor(Math.abs(n) / pack.baseUnitQty) * Math.sign(n || 1);
  const remainder = n - whole * pack.baseUnitQty;

  if (whole === 0) {
    return `${formatQty(n)} ${pluralUnit(baseUnit, n)}`;
  }
  if (Math.abs(remainder) < 0.0001) {
    return `${formatQty(whole)} ${pluralise(pack.name, whole)}`;
  }
  return (
    `${formatQty(whole)} ${pluralise(pack.name, whole)}` +
    ` and ${formatQty(remainder)} ${pluralUnit(baseUnit, remainder)}`
  );
}

/**
 * A signed variance, always carrying its sign.
 *
 * The sign is the entire message — "6 short" and "6 over" are different problems with different
 * causes — so it is never dropped, and "0" is stated as "exact" rather than left as a bare
 * zero that could be mistaken for a missing value.
 */
export function formatVariance(value: string | number | null | undefined): string {
  const n = toNumber(value);
  if (n === null) return '—';
  if (Math.abs(n) < 0.0001) return 'exact';
  return `${n > 0 ? '+' : '−'}${formatQty(Math.abs(n))}`;
}

/** Plain-language variance, for anyone who reads words faster than signs. */
export function describeVariance(
  value: string | number | null | undefined,
  baseUnit: string,
): string {
  const n = toNumber(value);
  if (n === null) return 'Not counted yet';
  if (Math.abs(n) < 0.0001) return 'Matches exactly';
  const amount = `${formatQty(Math.abs(n))} ${pluralUnit(baseUnit, Math.abs(n))}`;
  return n < 0 ? `${amount} missing` : `${amount} more than expected`;
}

const UNIT_LABELS: Record<string, { one: string; many: string }> = {
  piece: { one: 'piece', many: 'pieces' },
  kg: { one: 'kg', many: 'kg' },
  g: { one: 'g', many: 'g' },
  litre: { one: 'litre', many: 'litres' },
  cl: { one: 'cl', many: 'cl' },
  metre: { one: 'metre', many: 'metres' },
  yard: { one: 'yard', many: 'yards' },
};

export function pluralUnit(unit: string, count: number): string {
  const label = UNIT_LABELS[unit];
  if (!label) return unit;
  return Math.abs(count) === 1 ? label.one : label.many;
}

function pluralise(word: string, count: number): string {
  if (Math.abs(count) === 1) return word.toLowerCase();
  return `${word.toLowerCase()}s`;
}

/** Strings in, number or null out. Empty and unparseable both mean "no value", not zero. */
function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A date the way it would be said aloud, not an ISO string.
 *
 * "16 Aug 2026" is unambiguous to everyone. "16/08/2026" and "08/16/2026" are the same eleven
 * characters meaning two different days, and this product records money against dates.
 */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return `${formatDate(d)}, ${d.toLocaleTimeString('en-NG', {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

/**
 * What actually went wrong, said in whatever words are available.
 *
 * `e instanceof Error ? e.message : fallback` is written in 31 files here and is wrong in the case
 * that matters most: a Supabase error is a PLAIN OBJECT with a `message`, not an `Error`. So every
 * failed RPC — the commonest failure this app has — took the fallback branch, and the shop was told
 * "That could not be saved" while the database was saying something specific and useful like which
 * constraint refused it.
 *
 * Found by a probe that forced a 500 and read the dialog, not by reading the code: the fallback is
 * a perfectly plausible sentence, so nothing looks broken.
 */
export function messageOf(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

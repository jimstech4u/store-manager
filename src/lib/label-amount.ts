/**
 * "TRANSPORT 2000" — A NAME AND AN AMOUNT, TYPED IN ONE BOX.
 *
 * Take payment adds a charge or a deposit with one box (the composer rule: one input, never a wall
 * of them), so the box has to understand the way a seller says it: "transport 2000", "2,500 loading",
 * "deposit 5k crates", "₦1500". The amount is the number in it; everything else is what it is for.
 * A trailing "k" is thousands, which is how amounts are said at a counter.
 */
export interface LabelAmount {
  /** What it is for, as typed; empty when only a number was typed. */
  label: string;
  /** The amount, or null when there is no usable number in the text. */
  amount: number | null;
}

const NUMBER = /(?:₦|n(?=\d))?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k)?\b/gi;

export function parseLabelAmount(text: string): LabelAmount {
  const raw = text.replace(/\s+/g, ' ').trim();
  if (!raw) return { label: '', amount: null };

  // The LAST number is the amount: "2 trips 3000" is a charge of 3,000 for two trips.
  let match: RegExpExecArray | null = null;
  for (let m = NUMBER.exec(raw); m; m = NUMBER.exec(raw)) match = m;
  NUMBER.lastIndex = 0;
  if (!match) return { label: raw, amount: null };

  const whole = match[1].replace(/,/g, '');
  let amount = Number(match[2] ? `${whole}.${match[2]}` : whole);
  if (match[3]) amount *= 1000;
  if (!(amount > 0) || !Number.isFinite(amount)) return { label: raw, amount: null };

  const label = (raw.slice(0, match.index) + ' ' + raw.slice(match.index + match[0].length))
    .replace(/\s+/g, ' ')
    .replace(/^[\s:,\-–—]+|[\s:,\-–—]+$/g, '')
    .replace(/^for\s+/i, '')
    .trim();
  return { label, amount: Math.round(amount * 100) / 100 };
}

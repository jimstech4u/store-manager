/**
 * WHAT WAS TYPED INTO THE TILL'S ONE BOX — how many, and of what.
 *
 * "3 b/s" is three of Big Stout, said the way a customer says it and the way the shop's words
 * (product_aliases, 0269) are taught. The number leads, as it does on paper; everything after it is
 * the search. A part is said as ½, ¼, ¾ or 1/2, alone or after a whole number ("2½", "2 1/2").
 *
 * No number means the seller did not say: the line starts the way any new line starts.
 */
export interface QuickAddText {
  /** How many, when a number led the text. */
  qty: number | null;
  /** What to search for. */
  term: string;
}

const PARTS: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75 };

export function parseQuickAdd(text: string): QuickAddText {
  const raw = text.replace(/\s+/g, ' ').trim();
  const m = /^(\d+(?:\.\d+)?)?\s?([½¼¾]|[1-3]\/[24])?\s+(.+)$/.exec(raw);
  if (!m || (!m[1] && !m[2])) return { qty: null, term: raw };

  const whole = m[1] ? Number(m[1]) : 0;
  let part = 0;
  if (m[2]) {
    if (PARTS[m[2]] !== undefined) part = PARTS[m[2]];
    else {
      const [a, b] = m[2].split('/').map(Number);
      part = a / b;
    }
  }
  const qty = Number((whole + part).toFixed(4));
  const term = m[3].trim();
  // "0 b/s" and "3/4" alone are not an order for something.
  if (!(qty > 0) || term === '') return { qty: null, term: raw };
  return { qty, term };
}

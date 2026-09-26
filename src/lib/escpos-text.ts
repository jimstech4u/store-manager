'use client';

import type { ReceiptImageInput } from '@/lib/share';

/**
 * A RECEIPT IN THE PRINTER'S OWN LETTERS, not as a picture of one.
 *
 * The first version of this sent a bitmap, for a good reason: a bitmap can draw ₦, and the code
 * pages these printers ship with cannot. The paper that came back said otherwise. A 203dpi head
 * printing a browser-rendered image gives thin, smudged text; the same printer's BUILT-IN font is
 * sharp, because the glyphs live in its ROM at exactly the dot pitch of the head.
 *
 * The shop chose the sharp one, holding both. So this lays the receipt out in ESC/POS text.
 *
 * WHAT IT COSTS, said plainly: ₦ becomes N. There is no code page on this class of printer that
 * has the naira sign, and the alternative is the picture that was rejected. Every amount is still
 * unmistakably an amount, and a Nigerian shop's receipt reading "N78,800" is what every other till
 * in the market prints.
 *
 * WHAT IT BUYS: sharp letters, no upload, no public URL, no download for anything to fail at, and a
 * receipt that arrives in a few hundred bytes instead of fifty kilobytes. Most of the ways the image
 * route could break do not exist on this one.
 *
 * ONE SOURCE OF CONTENT, two layouts. Both this and the picture are built from the same
 * `ReceiptImageInput` the sell screen assembles, so the figures cannot disagree — which is the trap
 * the codebase already fell into once, when a shared image showed one lumped "extra charge" while
 * the paper itemised transport and loading separately. What differs here is only how it is set out.
 *
 * THE SIZE TAGS are the printer app's, from its own printed reference:
 *
 *     #ss#    small letter                #sl#    large letter
 *     #ssh#   small, double height        #slh#   large, double height
 *     #ssw#   small, double width         #slw#   large, double width
 *     #sshw#  small, double both          #slhw#  large, double both
 *     #lf#    line feed                   #cutt#  cut, if the device has a blade
 */

/** Columns at each size on a 576-dot head: the small font is 9 dots wide, the large one 12. */
interface Widths {
  small: number;
  smallDouble: number;
  large: number;
  largeDouble: number;
}

function columnsFor(dots: number): Widths {
  return {
    small: Math.floor(dots / 9),
    smallDouble: Math.floor(dots / 18),
    large: Math.floor(dots / 12),
    largeDouble: Math.floor(dots / 24),
  };
}

/**
 * ₦ IS NOT PRINTABLE HERE, so it is spelled.
 *
 * Done in one place rather than at every call site, because a single missed one prints a replacement
 * box in the middle of a figure and looks like corruption rather than a limitation. Anything else
 * outside plain ASCII goes the same way — a curly quote in a shop's own footer would otherwise come
 * out as noise.
 */
function printable(text: string): string {
  return text
    .replace(/₦/g, 'N')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ')
    // Anything still not ASCII would print as whatever the printer's code page happens to hold.
    .replace(/[^\x20-\x7e]/g, '');
}

/** Centred by padding, because the app's tag list has no alignment command. */
function centre(text: string, cols: number): string {
  const t = printable(text).slice(0, cols);
  const left = Math.max(0, Math.floor((cols - t.length) / 2));
  return ' '.repeat(left) + t;
}

/**
 * A label on the left and a figure hard against the right edge.
 *
 * The whole readability of a receipt is this: a column of amounts that line up. When the two will
 * not fit on one line the LABEL gives way, not the figure — a truncated amount is a wrong receipt,
 * a truncated label is still obvious from the line above it.
 */
function spread(left: string, right: string, cols: number): string {
  const r = printable(right);
  const l = printable(left).slice(0, Math.max(0, cols - r.length - 1));
  const gap = Math.max(1, cols - l.length - r.length);
  return l + ' '.repeat(gap) + r;
}

/** Wrapped on words, so a long product name does not lose its tail. */
function wrap(text: string, cols: number): string[] {
  const words = printable(text).split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > cols && line) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out.length > 0 ? out : [''];
}

/**
 * The receipt, as one instruction for the printer app.
 *
 * `dots` is the head's own width — 576 on an 80mm roll, 384 on a 58mm one — and every column count
 * below is derived from it, so a shop on narrow paper gets a narrower layout rather than a wrapped
 * mess.
 */
export type TextSize = 'ss' | 'ssh' | 'ssw' | 'sshw' | 'sl' | 'slh' | 'slw' | 'slhw';

/** How many characters a size fits on a line, so a layout can be built against it. */
export function columnsAt(size: TextSize, dots: number): number {
  const base = size.startsWith('ss') ? 9 : 12;
  const doubleWide = size.endsWith('w');
  return Math.floor(dots / (doubleWide ? base * 2 : base));
}

export function receiptAsEscPos(
  input: ReceiptImageInput,
  dots: number,
  /*
   * The size the BODY prints at — the shop's choice, previewed in Settings.
   *
   * Only the body: the shop's name stays big and the fine print stays small whatever this says,
   * because a receipt where every line is the same size has no shape and nothing to find quickly.
   */
  bodySize: TextSize = 'sshw',
): string {
  const c = columnsFor(dots);
  const bodyCols = columnsAt(bodySize, dots);
  const out: string[] = [];

  /** One line at a given size. The size tag is repeated per line: the app treats it as a switch,
   *  and relying on it to persist across a feed is the kind of assumption that prints one giant
   *  paragraph when it turns out to be wrong. */
  const line = (size: string, text: string) => out.push(`#${size}#${text}#lf#`);
  const blank = () => out.push('#ss# #lf#');
  const rule = () => line('ss', '-'.repeat(c.small));

  // ── The shop, as big as the paper allows ──────────────────────────────────
  line('sshw', centre(input.shopName, c.smallDouble));
  if (input.header) {
    for (const l of wrap(input.header, c.small)) line('ss', centre(l, c.small));
  }
  rule();

  // ── When, which receipt, and who ──────────────────────────────────────────
  for (const m of input.meta) line('ss', printable(m));
  rule();

  /*
   * ── THE ITEMS ─────────────────────────────────────────────────────────────
   *
   * The name in the size the shop said reads best, and the arithmetic under it at a size that fits
   * "20 Bottle x N3,700" and the amount on one line. Two sizes rather than one because the name is
   * what a customer checks and the working is what they check it against.
   */
  for (const l of input.lines) {
    for (const part of wrap(l.name, bodyCols)) line(bodySize, part);
    line('sl', spread(`  ${l.detail}`, l.amount, c.large));
  }
  rule();

  /*
   * ── THE MONEY ─────────────────────────────────────────────────────────────
   *
   * The ones a shop and a customer argue about — the total, what is owed — at double size, and the
   * rest at large. A receipt where every line shouts is a receipt where nothing stands out.
   */
  for (const t of input.totals) {
    if (t.value === '') {
      // A heading inside the totals, like "Still with you". No figure to line up.
      blank();
      line(bodySize, printable(t.label));
      continue;
    }
    if (t.strong) line(bodySize, spread(t.label, t.value, bodyCols));
    else line('sl', spread(t.label, t.value, c.large));
  }
  rule();

  if (input.note) {
    for (const l of wrap(input.note, c.small)) line('ss', l);
    blank();
  }

  /*
   * The bank details, line for line as the shop typed them. NOT wrapped on words: an account number
   * broken across two lines is an account number somebody will mistype.
   */
  if (input.transferDetails) {
    for (const l of input.transferDetails.split('\n')) line('ss', printable(l).slice(0, c.small));
    blank();
  }

  if (input.footer) {
    for (const l of wrap(input.footer, c.small)) line('ss', centre(l, c.small));
  }

  /*
   * Clear of the tear bar, then a cut for the printers that have a blade. `#cutt#` is documented as
   * "per device" — the ones without a cutter ignore it, and the feeds above are what leave those a
   * receipt somebody can tear off straight.
   */
  blank();
  blank();
  blank();
  out.push('#cutt#');

  return `#escps#${out.join('')}`;
}

'use client';

import type { ReceiptImageInput } from '@/lib/share';

/**
 * A RECEIPT IN THE PRINTER'S OWN LETTERS, not as a picture of one.
 *
 * The first version sent a bitmap, for a good reason: a bitmap can draw ₦ and no code page on this
 * class of printer can. The paper settled it. A 203dpi head printing a browser-rendered image gives
 * thin, smudged text, because the image is resampled to reach the head's dot pitch; the printer's
 * BUILT-IN font is sharp, its glyphs already living in ROM at exactly that pitch. Shown both, the
 * shop chose sharp. So ₦ prints as N, which is said on screen rather than discovered on paper.
 *
 * ── WHY COLUMNS ARE MEASURED AND NOT CALCULATED ──────────────────────────────────
 *
 * The whole readability of a receipt is a column of amounts that line up, and lining them up means
 * padding a label out so the figure lands on the right-hand edge. That requires knowing exactly how
 * many characters fit on a line — and getting it wrong does not look like a rounding error, it
 * wraps: the amount drops onto the next line, indented by the padding, and the receipt turns into a
 * ladder.
 *
 * The first version calculated them from the head's dot pitch: 576 dots, a 9-dot small font and a
 * 12-dot large one, so 64 and 48. The small font WAS 64 — a rule of 64 dashes fits the paper
 * exactly. The large one was not: every line padded to 48 wrapped, and a shop comparing the preview
 * with the paper found two different documents.
 *
 * There is no way to ask a printer how wide its fonts are, and these are not standard parts. So the
 * shop MEASURES it, once, from a ruler this prints, and the number is saved with the printer. The
 * preview then uses the same number, which is what makes the preview worth looking at.
 */

export type TextSize = 'ss' | 'ssh' | 'ssw' | 'sshw' | 'sl' | 'slh' | 'slw' | 'slhw';

/** Every part of a receipt that can be set to its own size. */
export interface ReceiptLayout {
  shopName: TextSize;
  header: TextSize;
  meta: TextSize;
  itemName: TextSize;
  itemDetail: TextSize;
  totals: TextSize;
  strongTotals: TextSize;
  bank: TextSize;
  footer: TextSize;
  /**
   * HOW MANY CHARACTERS ACTUALLY FIT, at the two base fonts, measured from a ruler.
   *
   * Everything else derives: a double-width size is half its base. Two numbers rather than eight,
   * because the doubling is the one thing about these printers that is reliable.
   */
  charsSmall: number;
  charsLarge: number;
}

/**
 * Defaults that came off a real 80mm roll rather than out of the spec sheet.
 *
 * The small font measured 64 on the printer this was built against, matching the arithmetic. The
 * large one did NOT measure 48 — lines padded to 48 wrapped — so it defaults lower, and low rather
 * than high on purpose: a few unused columns look like a slightly narrow receipt, while one column
 * too many wraps every amount onto its own line.
 */
export function defaultLayout(dots: number): ReceiptLayout {
  const small = Math.floor(dots / 9);
  return {
    shopName: 'sshw',
    header: 'ss',
    meta: 'sl',
    itemName: 'sshw',
    itemDetail: 'sl',
    totals: 'sl',
    strongTotals: 'sshw',
    bank: 'sl',
    footer: 'ss',
    charsSmall: small,
    /*
     * HALF the small count, not three quarters.
     *
     * The arithmetic says a 12-dot font in 576 dots is 48 columns, and 48 is what the first version
     * used. Every line padded to 48 wrapped on the roll this was measured against. Reading the
     * paper back: the address line of 52 small characters fits, so the small font really is 64 —
     * and "Nigerian Breweries (NBL) crates" at 31 medium characters fills the width, which puts the
     * medium font at 32, not 48.
     *
     * So the app's `#sl#` is a double-width size on this printer whatever its name suggests. Half
     * is also the safe direction to be wrong in: a few unused columns look like a slightly narrow
     * receipt, while one column too many wraps every amount onto its own line and turns the receipt
     * into a ladder. The shop can raise it with the ruler if their printer fits more.
     */
    charsLarge: Math.floor(small / 2),
  };
}

/** How many characters a size fits, from what the shop measured. */
export function columnsAt(size: TextSize, layout: ReceiptLayout): number {
  const base = size.startsWith('ss') ? layout.charsSmall : layout.charsLarge;
  // Double WIDTH halves the count. Double height costs paper, not columns.
  return Math.max(8, Math.floor(size.endsWith('w') ? base / 2 : base));
}

/**
 * ₦ IS NOT PRINTABLE HERE, so it is spelled — and so is every fraction.
 *
 * Halves and quarters are how a shop sells: half a crate, three-quarters of a bag. "0.5 Crate" is
 * arithmetic notation and nobody at a counter reads it that way; a shop asked for 1/2, 1/4 and 3/4
 * and they are right. The vulgar glyphs ½ ¼ ¾ are no use either — CP437 has two of the three and
 * the printer's code page is not something this can rely on — so they are spelled in ASCII, which
 * every one of these printers has.
 */
function printable(text: string): string {
  return (
    text
      .replace(/₦/g, 'N')
      // The glyphs, if anything upstream produced them.
      .replace(/½/g, '1/2')
      .replace(/¼/g, '1/4')
      .replace(/¾/g, '3/4')
      /*
       * And the decimals, which is what `formatQty` actually produces. Matched with a boundary in
       * front so a PRICE is never touched: "N9,600.50" is money and must stay money, while "0.5
       * Crate" and "2.5" are quantities. The leading whole number is kept — 2.5 becomes "2 1/2".
       */
      .replace(/(^|[\s(])(\d*)\.25(?![\d])/g, (_m, pre, whole) => `${pre}${whole ? whole + ' ' : ''}1/4`)
      .replace(/(^|[\s(])(\d*)\.5(?![\d])/g, (_m, pre, whole) => `${pre}${whole ? whole + ' ' : ''}1/2`)
      .replace(/(^|[\s(])(\d*)\.75(?![\d])/g, (_m, pre, whole) => `${pre}${whole ? whole + ' ' : ''}3/4`)
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[×]/g, 'x')
      .replace(/[–—]/g, '-')
      .replace(/ /g, ' ')
      // Anything still outside plain ASCII would print as whatever the code page happens to hold.
      .replace(/[^\x20-\x7e]/g, '')
  );
}

/** Exported so the preview spells things exactly as the paper will. */
export const forPrinter = printable;

function centre(text: string, cols: number): string {
  const t = printable(text).slice(0, cols);
  return ' '.repeat(Math.max(0, Math.floor((cols - t.length) / 2))) + t;
}

/**
 * A label on the left and a figure hard against the right edge.
 *
 * When the two will not fit on one line the LABEL gives way, not the figure: a truncated amount is
 * a wrong receipt, a truncated label is still obvious from the line above it.
 */
function spread(left: string, right: string, cols: number): string {
  const r = printable(right);
  const l = printable(left).slice(0, Math.max(0, cols - r.length - 1));
  return l + ' '.repeat(Math.max(1, cols - l.length - r.length)) + r;
}

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

/** One line, as the printer will receive it: a size, some text, a feed. */
export interface PrintedLine {
  size: TextSize;
  text: string;
}

/**
 * THE RECEIPT AS LINES — the one description both the printer and the preview read.
 *
 * Returned as lines rather than as a finished instruction so the preview cannot drift: it renders
 * exactly these, and `asInstruction` below tags exactly these. A preview built from a second layout
 * would agree with the paper until the day it did not, and nobody would know which was wrong.
 */
export function receiptLines(input: ReceiptImageInput, layout: ReceiptLayout): PrintedLine[] {
  const out: PrintedLine[] = [];
  const at = (size: TextSize) => columnsAt(size, layout);
  const put = (size: TextSize, text: string) => out.push({ size, text });
  const blank = () => put('ss', '');
  const rule = () => put('ss', '-'.repeat(at('ss')));

  put(layout.shopName, centre(input.shopName, at(layout.shopName)));
  if (input.header) {
    for (const l of wrap(input.header, at(layout.header))) put(layout.header, centre(l, at(layout.header)));
  }
  rule();

  for (const m of input.meta) put(layout.meta, printable(m));
  rule();

  for (const l of input.lines) {
    for (const part of wrap(l.name, at(layout.itemName))) put(layout.itemName, part);
    put(layout.itemDetail, spread(`  ${l.detail}`, l.amount, at(layout.itemDetail)));
  }
  rule();

  for (const t of input.totals) {
    if (t.value === '') {
      // A heading inside the totals, like "Still with you". No figure to line up.
      blank();
      put(layout.strongTotals, printable(t.label));
      continue;
    }
    const size = t.strong ? layout.strongTotals : layout.totals;
    put(size, spread(t.label, t.value, at(size)));
  }
  rule();

  if (input.note) {
    for (const l of wrap(input.note, at(layout.footer))) put(layout.footer, l);
    blank();
  }

  /*
   * The bank details line for line as the shop typed them, NOT wrapped on words: an account number
   * broken across two lines is an account number somebody will mistype.
   */
  if (input.transferDetails) {
    for (const l of input.transferDetails.split('\n')) {
      put(layout.bank, printable(l).slice(0, at(layout.bank)));
    }
    blank();
  }

  if (input.footer) {
    for (const l of wrap(input.footer, at(layout.footer))) put(layout.footer, centre(l, at(layout.footer)));
  }

  blank();
  blank();
  blank();
  return out;
}

/** The same lines, tagged for the printer app. */
export function asInstruction(lines: PrintedLine[]): string {
  /*
   * The size tag goes on EVERY line. The app treats it as a switch, and relying on it to persist
   * across a feed is the kind of assumption that prints one giant paragraph when it turns out to be
   * wrong.
   */
  const body = lines.map((l) => `#${l.size}#${l.text === '' ? ' ' : l.text}#lf#`).join('');
  // `#cutt#` is documented as "per device": printers without a blade ignore it, and the blank lines
  // above are what leave those a receipt somebody can tear off straight.
  return `#escps#${body}#cutt#`;
}

export function receiptAsEscPos(input: ReceiptImageInput, layout: ReceiptLayout): string {
  return asInstruction(receiptLines(input, layout));
}

/**
 * A RULER, so the shop can measure what the arithmetic cannot predict.
 *
 * Printed at both base fonts with a scale every ten characters. The shop reads off the last number
 * that fitted before the line wrapped, types it into the setting, and from then on the preview and
 * the paper are the same document. One tap, once per printer.
 */
export function rulerTicket(): string {
  const scale = (n: number) => {
    let s = '';
    for (let i = 1; i <= n; i += 1) s += i % 10 === 0 ? String((i / 10) % 10) : '.';
    return s;
  };
  const lines: PrintedLine[] = [
    { size: 'sshw', text: 'RULER' },
    { size: 'ss', text: 'Small letters. Read the last number' },
    { size: 'ss', text: 'before this line wraps:' },
    { size: 'ss', text: scale(80) },
    { size: 'ss', text: '' },
    { size: 'ss', text: 'Large letters:' },
    { size: 'sl', text: scale(80) },
    { size: 'ss', text: '' },
    { size: 'ss', text: 'Each dot is one character.' },
    { size: 'ss', text: 'A digit marks every ten.' },
    { size: 'ss', text: '' },
    { size: 'ss', text: '' },
  ];
  return asInstruction(lines);
}

'use client';

import type { ReceiptImageInput } from '@/lib/share';
import { spellFractions } from '@/lib/format';

/**
 * A RECEIPT IN THE PRINTER'S OWN LETTERS, not as a picture of one.
 *
 * The first version sent a bitmap, for a good reason: a bitmap can draw ₦ and no code page on this
 * class of printer can. The paper settled it. A 203dpi head printing a browser-rendered image gives
 * thin, smudged text, because the image is resampled to reach the head's dot pitch; the printer's
 * BUILT-IN font is sharp, its glyphs already living in ROM at exactly that pitch.
 *
 * ── A LINE IS SPANS, NOT ONE SIZE ────────────────────────────────────────────────
 *
 * It was one size per line, which is how a receipt printer is usually driven and is not enough. A
 * shop reading "3 1/2 Crate" wants the 3 big and the 1/2 small — the whole number is the quantity
 * and the fraction qualifies it, and at the same size they read as one figure, "31/2". The size
 * tags are inline switches, so mixing them within a line is something the printer can do.
 *
 * What it costs is the arithmetic. Padding an amount out to the right-hand edge means knowing how
 * wide the line is SO FAR, and once a line carries two sizes that is no longer a character count.
 * So widths are worked out in DOTS — a size's characters are `total / columns` dots wide — and the
 * padding is done with the smallest space the printer has, which is the finest adjustment it
 * offers.
 *
 * ── AND COLUMNS ARE MEASURED, NOT CALCULATED ─────────────────────────────────────
 *
 * The first version calculated them from the head's dot pitch: 576 dots, a 9-dot small font and a
 * 12-dot large one, so 64 and 48. The small font WAS 64 — a rule of 64 dashes fits exactly. The
 * large one was not: every line padded to 48 wrapped, and a shop comparing the preview with the
 * paper found two documents. A printer cannot be asked how wide its fonts are, and these are not
 * standard parts, so the shop measures it once from a ruler this prints.
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
     * The arithmetic says a 12-dot font in 576 dots is 48 columns, and 48 is what the first
     * version used. Every line padded to 48 wrapped on the roll this was measured against. Reading
     * the paper back: an address line of 52 small characters fits, so small really is 64 — and 31
     * medium characters fill the width, which puts medium at 32. Half is also the safe direction
     * to be wrong in: spare columns look like a narrow receipt, one column too many wraps every
     * amount onto its own line.
     */
    charsLarge: Math.floor(small / 2),
  };
}

export function columnsAt(size: TextSize, layout: ReceiptLayout): number {
  const base = size.startsWith('ss') ? layout.charsSmall : layout.charsLarge;
  // Double WIDTH halves the count. Double height costs paper, not columns.
  return Math.max(8, Math.floor(size.endsWith('w') ? base / 2 : base));
}

/** The head's own width in dots, derived from what the shop measured at the small font. */
export function dotsOf(layout: ReceiptLayout): number {
  return layout.charsSmall * 9;
}

/**
 * ₦ IS NOT PRINTABLE HERE, so it is spelled — and so is every fraction.
 *
 * Halves and quarters are how a shop sells. "0.5 Crate" is arithmetic notation and nobody at a
 * counter reads it that way. The vulgar glyphs ½ ¼ ¾ are no use either: CP437 has two of the three
 * and the printer's code page is not something this can rely on.
 */
function printable(text: string): string {
  return text
    .replace(/₦/g, 'N')
    .replace(/½/g, '1/2')
    .replace(/¼/g, '1/4')
    .replace(/¾/g, '3/4')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[×]/g, 'x')
    .replace(/[–—]/g, '-')
    // Written as an escape, not as the character itself: a literal non-breaking space in
    // source is invisible to whoever reads this next, and lint is right to refuse it.
    .replace(/\u00a0/g, ' ')
    .replace(/[^\x20-\x7e]/g, '');
}

/** A decimal quantity written the way a shop says it: 0.5 → "1/2", 2.5 → "2 1/2". */
export function asFraction(text: string): string {
  /*
   * The printer's flattening, then the SHARED spelling.
   *
   * The substitution used to live here, so the PDF, the shared picture and the customer's link
   * had no way to reach it without also flattening their naira signs to "N". It moved to
   * `format.ts`; this is that plus what only the printer needs.
   */
  return spellFractions(printable(text));
}

/** Exported so anything else that shows a quantity can spell it the way the paper will. */
export const forPrinter = asFraction;

// ─────────────────────────────────────────────────────────────────────────────

/** A run of characters at one size. A line is a list of these. */
export interface PrintedSpan {
  size: TextSize;
  text: string;
}

export interface PrintedLine {
  spans: PrintedSpan[];
}

function spanDots(span: PrintedSpan, layout: ReceiptLayout, dots: number): number {
  return span.text.length * (dots / columnsAt(span.size, layout));
}

/**
 * One step down in ACTUAL WIDTH, which is not the same as one step down in the same family.
 *
 * A first version kept the families apart — `sl` dropped to `sl`, which is no drop at all, so the
 * fraction on a medium-sized line came out the same size as the number it qualifies and "3 1/2"
 * still read as "31/2". Caught by asking the probe to compare the two sizes rather than to trust
 * that a table called `down` went down.
 *
 * On this printer the small font is 64 columns and the medium is 32, so SMALL IS THE NARROWER of
 * the two whatever their names suggest. The order here is by measured width, which is the only
 * thing that matters to a reader.
 */
function dropASize(size: TextSize): TextSize {
  const down: Record<TextSize, TextSize> = {
    sshw: 'ssw',
    ssw: 'ss',
    ssh: 'ss',
    ss: 'ss',
    slhw: 'slw',
    slw: 'sl',
    slh: 'sl',
    // The small font is narrower than the medium one; there is nothing below it.
    sl: 'ss',
  };
  return down[size];
}

/**
 * A FRACTION IS SMALLER THAN THE NUMBER IT QUALIFIES.
 *
 * "3 1/2 Crate" reads as one figure when the 3 and the 1/2 are the same size — a customer glances
 * and sees "31/2". The whole number is the quantity and the fraction qualifies it, so the fraction
 * drops a size, which is what every printed price list does.
 *
 * ONLY WHEN THERE IS A WHOLE NUMBER. "1/2 Crate" on its own IS the quantity, and shrinking it would
 * make the one figure on the line the smallest thing on it.
 */
function withSmallFraction(text: string, size: TextSize): PrintedSpan[] {
  const smaller = dropASize(size);
  const out: PrintedSpan[] = [];
  const pattern = /(\d+) (1\/2|1\/4|3\/4)/g;
  let at = 0;
  let m: RegExpExecArray | null = pattern.exec(text);
  while (m !== null) {
    if (m.index > at) out.push({ size, text: text.slice(at, m.index) });
    out.push({ size, text: m[1] });
    out.push({ size: smaller, text: ` ${m[2]}` });
    at = m.index + m[0].length;
    m = pattern.exec(text);
  }
  if (at < text.length) out.push({ size, text: text.slice(at) });
  return out.length > 0 ? out : [{ size, text }];
}

// ─────────────────────────────────────────────────────────────────────────────

export function receiptLines(input: ReceiptImageInput, layout: ReceiptLayout): PrintedLine[] {
  const dots = dotsOf(layout);
  const out: PrintedLine[] = [];
  const cols = (size: TextSize) => columnsAt(size, layout);
  const put = (spans: PrintedSpan[]) => out.push({ spans });
  const one = (size: TextSize, text: string) => put([{ size, text }]);
  const blank = () => one('ss', '');
  const rule = () => one('ss', '-'.repeat(cols('ss')));
  /*
   * A DOUBLE RULE where the receipt changes subject: under the letterhead, under who and when,
   * before the money, and under what they are still holding. Every break used to be the same
   * dashed line, so the paper read as one list with occasional interruptions.
   */
  const ruleDouble = () => one('ss', '='.repeat(cols('ss')));

  /** Centred by padding, because the printer app's tag list has no alignment command. */
  const centre = (text: string, size: TextSize) => {
    const t = asFraction(text).slice(0, cols(size));
    return ' '.repeat(Math.max(0, Math.floor((cols(size) - t.length) / 2))) + t;
  };

  /**
   * WRAPPED, NEVER CUT.
   *
   * These were sliced to the column count. A shop's own name came out as "Jimstech innovations
   * Nigeria lim" and a container line as "Nigerian Breweries (NBL) crate" with the count pushed
   * off the end — a receipt losing the last word of the thing it describes.
   */
  const wrap = (text: string, width: number): string[] => {
    const words = asFraction(text).split(/\s+/).filter(Boolean);
    const rows: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length <= width) {
        line = next;
        continue;
      }
      if (line) {
        rows.push(line);
        line = word;
      }
      /*
       * A single word longer than the paper — an account name with no spaces, a long product code.
       * Broken rather than dropped: losing the tail of an account number is worse than an ugly
       * break.
       */
      while (line.length > width) {
        rows.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    if (line) rows.push(line);
    return rows.length > 0 ? rows : [''];
  };

  /**
   * A label on the left and a figure hard against the right edge.
   *
   * Measured in DOTS, because a line can carry two sizes now, and padded with the smallest space
   * the printer has. When the two will not fit the LABEL wraps and the figure takes its own line,
   * right aligned — a truncated amount is a wrong receipt, and a figure crowded against a word is
   * one somebody misreads.
   */
  const spread = (labelSpans: PrintedSpan[], value: string, size: TextSize) => {
    const right = asFraction(value);
    const rightDots = right.length * (dots / cols(size));
    const spaceDots = dots / cols('ss');
    const usedDots = labelSpans.reduce((sum, s) => sum + spanDots(s, layout, dots), 0);

    if (usedDots + rightDots + spaceDots <= dots) {
      const gap = Math.max(1, Math.round((dots - usedDots - rightDots) / spaceDots));
      put([...labelSpans, { size: 'ss', text: ' '.repeat(gap) }, { size, text: right }]);
      return;
    }

    /*
     * IT DOES NOT FIT, so the label wraps INSIDE ITS OWN COLUMN and the number stays put.
     *
     * This used to wrap the label across the full width and then put the value alone on the next
     * line, right-aligned. "Nigerian Breweries (NBL) crates" came out with the 5 stranded on a
     * line of its own under it, reading as a quantity belonging to nothing.
     *
     * Roughly two thirds for the words and a third for the figure. A count is a few characters
     * and a maker's name is many, so giving them equal halves would wrap the name for no reason;
     * giving the words everything is what produced the stranded number.
     */
    const labelCols = Math.max(4, Math.floor(cols(size) * 0.65));
    const flat = labelSpans.map((s) => s.text).join('');
    const rows = wrap(flat, labelCols);

    rows.forEach((row, i) => {
      if (i > 0) {
        // Continuation lines are words only; the figure was settled on the first row.
        one(size, row);
        return;
      }
      const rowDots = row.length * (dots / cols(size));
      const gap = Math.max(1, Math.round((dots - rowDots - rightDots) / spaceDots));
      put([{ size, text: row }, { size: 'ss', text: ' '.repeat(gap) }, { size, text: right }]);
    });
  };

  // ── The shop ────────────────────────────────────────────────────────────────
  one(layout.shopName, centre(input.shopName, layout.shopName));
  if (input.banner) {
    // As large as the shop's name, on its own rows: it is the first thing the paper says.
    for (const l of wrap(input.banner, cols(layout.shopName))) {
      one(layout.shopName, centre(l, layout.shopName));
    }
  }
  if (input.header) {
    for (const l of wrap(input.header, cols(layout.header))) {
      one(layout.header, centre(l, layout.header));
    }
  }
  ruleDouble();

  // ── Who and when ────────────────────────────────────────────────────────────
  for (const m of input.meta) {
    for (const row of wrap(m, cols(layout.meta))) one(layout.meta, row);
  }
  ruleDouble();

  /*
   * ── THE ITEMS, each closed by its own rule ──────────────────────────────────
   *
   * A shop asked for a divider after every item and a heavy one before the total. Four items ran
   * together as eight lines with nothing separating one purchase from the next, which on a long
   * receipt is where a customer loses their place. The LAST item is closed by the heavy rule that
   * opens the money, not by a light one as well.
   */
  input.lines.forEach((l, i) => {
    for (const part of wrap(l.name, cols(layout.itemName))) one(layout.itemName, part);
    spread(
      withSmallFraction(`  ${asFraction(l.qty ?? l.detail)}`, layout.itemDetail),
      l.amount,
      layout.itemDetail,
    );
    if (i < input.lines.length - 1) rule();
  });
  // Closed only when there were any: a slip with no items (a bank account) is not two heavy rules.
  if (input.lines.length > 0) ruleDouble();

  /*
   * ── ENTRIES (a statement) ───────────────────────────────────────────────────
   *
   * "Sale to the left and the date to the right, on the same line; under it the double line; the
   * items, numbered one, two, three; a double line; Total to the left and the sale's amount to the
   * right. A payment, a charge and the rest between two single lines." Each entry stands alone, with
   * a gap after it, so a month of them reads as a list of events rather than one run of text.
   */
  for (const b of input.blocks ?? []) {
    spread([{ size: layout.totals, text: asFraction(b.title) }], b.right ?? '', layout.totals);
    if (b.items && b.items.length > 0) {
      ruleDouble();
      b.items.forEach((it, i) => {
        for (const part of wrap(`${i + 1}. ${it.name}`, cols(layout.itemDetail))) one(layout.itemDetail, part);
        spread(withSmallFraction(`   ${asFraction(it.qty)}`, layout.itemDetail), it.amount, layout.itemDetail);
        if (i < b.items!.length - 1) rule();
      });
      ruleDouble();
    } else {
      if (b.heavy) ruleDouble();
      else rule();
    }
    for (const r of b.rows ?? []) {
      spread(withSmallFraction(asFraction(r.label), layout.totals), r.value, layout.totals);
    }
    if (b.total) spread([{ size: layout.totals, text: b.total.label }], b.total.value, layout.totals);
    if (!(b.items && b.items.length > 0)) rule();
    blank();
  }
  if ((input.blocks ?? []).length > 0) ruleDouble();

  // ── The money, then what they are still holding ─────────────────────────────
  /*
   * A RULE UNDER EACH THING THEY ARE STILL HOLDING, and a heavy one to close the list.
   *
   * The money above is one running sum and reads as a block. What is still with the customer is a
   * LIST of separate debts — five NBL crates, half a Goldberg crate — and run together with no
   * dividers they read as one entry that has wrapped. This is the half of a receipt that gets
   * argued over months later, so each line is closed off on its own.
   *
   * The last one is NOT given a light rule: the heavy rule that ends the section does that job,
   * and two lines together would read as a mistake.
   */
  let inHolding = false;
  input.totals.forEach((t, i) => {
    if (t.value === '') {
      // A heading inside the totals — the money is finished, so the heavy line goes here.
      ruleDouble();
      one(layout.strongTotals, asFraction(t.label));
      /*
       * And a light rule under the heading itself, so it reads as the head of a list rather than
       * as the first entry in one. Without it "Still with you" sat flush against the first thing
       * they are holding and the two ran together.
       */
      rule();
      inHolding = true;
      return;
    }
    const size = t.strong ? layout.strongTotals : layout.totals;
    // The value can be a fraction too — "Goldberg 60cl crate 1/2" — so it gets the same treatment.
    spread(withSmallFraction(asFraction(t.label), size), t.value, size);

    if (inHolding && i < input.totals.length - 1) rule();
  });
  ruleDouble();

  if (input.note) {
    for (const l of wrap(input.note, cols(layout.footer))) one(layout.footer, l);
    blank();
  }

  /*
   * The bank details, line for line as the shop typed them — wrapped, not cut. An account name
   * losing its last word is a name somebody cannot match to a transfer.
   */
  if (input.transferDetails) {
    for (const raw of input.transferDetails.split('\n')) {
      for (const row of wrap(raw, cols(layout.bank))) one(layout.bank, row);
    }
    blank();
  }

  if (input.footer) {
    for (const l of wrap(input.footer, cols(layout.footer))) {
      one(layout.footer, centre(l, layout.footer));
    }
  }

  blank();
  blank();
  blank();
  return out;
}

/** The same lines, tagged for the printer app. */
export function asInstruction(lines: PrintedLine[]): string {
  const body = lines
    .map((l) => {
      /*
       * The size tag goes on EVERY span. The app treats it as a switch, and relying on it to
       * persist — across a feed, or across the span beside it — is the kind of assumption that
       * prints one giant paragraph when it turns out to be wrong.
       */
      const text = l.spans.map((s) => `#${s.size}#${s.text}`).join('');
      return `${text.trim() === '' ? '#ss# ' : text}#lf#`;
    })
    .join('');
  // `#cutt#` is "per device": printers without a blade ignore it, and the blank lines above leave
  // those a receipt somebody can tear off straight.
  return `#escps#${body}#cutt#`;
}

export function receiptAsEscPos(input: ReceiptImageInput, layout: ReceiptLayout): string {
  return asInstruction(receiptLines(input, layout));
}

/**
 * A RULER, so the shop can measure what the arithmetic cannot predict.
 *
 * Printed at both base fonts with a scale every ten characters. The shop reads off the last number
 * that fitted before the line wrapped and types it in. One tap, once per printer.
 */
export function rulerTicket(): string {
  const scale = (n: number) => {
    let s = '';
    for (let i = 1; i <= n; i += 1) s += i % 10 === 0 ? String((i / 10) % 10) : '.';
    return s;
  };
  const say = (size: TextSize, text: string): PrintedLine => ({ spans: [{ size, text }] });
  return asInstruction([
    say('sshw', 'RULER'),
    say('ss', 'Small letters. Read the last number'),
    say('ss', 'before this line wraps:'),
    say('ss', scale(80)),
    say('ss', ''),
    say('ss', 'Medium letters:'),
    say('sl', scale(80)),
    say('ss', ''),
    say('ss', 'Each dot is one character.'),
    say('ss', 'A digit marks every ten.'),
    say('ss', ''),
    say('ss', ''),
  ]);
}

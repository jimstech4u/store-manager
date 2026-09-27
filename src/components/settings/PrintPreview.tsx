'use client';

import { useEffect, useState } from 'react';
import { columnsAt, type PrintedLine, type ReceiptLayout } from '@/lib/escpos-text';
import styles from './PrintPreview.module.css';

/**
 * The same stack the stylesheet uses, because the measurement has to be of the font that will
 * actually draw the receipt. Two lists that drift apart would give a ratio for a font nobody sees.
 */
const MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Menlo, Consolas, monospace";

/**
 * WHAT THE ROLL WILL SAY, before a roll is spent finding out.
 *
 * IT RENDERS THE PRINTER'S OWN LINES — not a layout that resembles them, the exact array that
 * `asInstruction` tags and sends. There is no second description to drift, which matters because
 * the first version DID drift: it showed amounts lined up on the right while the paper wrapped them
 * onto the next line.
 *
 * ── WHY THE CHARACTER WIDTH IS MEASURED ──────────────────────────────────────────
 *
 * A receipt in the printer's built-in font is monospaced, so a faithful preview is arithmetic: the
 * same text at the same characters-per-line. The trap is that a monospaced glyph is NARROWER than
 * its font size — around 0.6 of it, and the exact figure depends on which font the browser picked
 * from the stack. Sizing a line at `width / columns` therefore drew it at about 60% of the paper,
 * so the preview sat short of the right-hand edge and a shop reading it expected a gap on the
 * paper that would not be there.
 *
 * So the ratio is MEASURED from the font actually in use, once, and every line is sized against
 * it. Then a line of 32 wide characters and one of 64 small ones are the same width on screen,
 * exactly as they are on the roll.
 */
export function PrintPreview({
  lines,
  layout,
}: {
  lines: PrintedLine[];
  layout: ReceiptLayout;
}) {
  /*
   * How wide one character is, as a fraction of the font size. Starts at the usual 0.6 so the
   * first paint is close, then corrected from the real font — a preview that jumps visibly on load
   * would be its own kind of wrong.
   *
   * MEASURED ON A CANVAS, not with a hidden element. The first version rendered a hundred zeros
   * off-screen and measured the box: it worked, and it put a hundred zeros into the page's text.
   * `aria-hidden` keeps a screen reader off it and does nothing about `innerText` — so the
   * receipt's own text, and anything copying it, carried the ruler. A canvas has no document to
   * pollute.
   */
  const [ratio, setRatio] = useState(0.6);
  useEffect(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return;
    ctx.font = `16px ${MONO}`;
    // A hundred characters, so a sub-pixel error in the measurement is sub-pixel in the ratio.
    const measured = ctx.measureText('0'.repeat(100)).width / 100 / 16;
    if (measured > 0.3 && measured < 1) setRatio(measured);
  }, []);

  return (
    <div className={styles.paper} aria-label="How this will print">
      {lines.map((line, i) => {
        /*
         * A line is sized by its WIDEST span, because every span on it shares one font size on
         * screen — the printer changes size mid-line and a browser text run cannot. Taking the
         * widest keeps the line from overflowing the paper; the narrower spans then read slightly
         * larger than they will print, which is the harmless direction to be wrong in.
         */
        const widest = line.spans.reduce(
          (fewest, s) => Math.min(fewest, columnsAt(s.size, layout)),
          Number.POSITIVE_INFINITY,
        );
        const cols = Number.isFinite(widest) ? widest : columnsAt('ss', layout);
        const tall = line.spans.some((s) => s.size.endsWith('h') || s.size.endsWith('hw'));
        const heavy = line.spans.some((s) => s.size.startsWith('sl'));
        const text = line.spans.map((s) => s.text).join('');

        return (
          <pre
            key={i}
            className={styles.line}
            style={{
              fontSize: `calc(var(--print-line) / ${cols} / ${ratio})`,
              lineHeight: tall ? 1.7 : 1.15,
              fontWeight: heavy ? 600 : 500,
            }}
          >
            {text === '' ? ' ' : text}
          </pre>
        );
      })}
    </div>
  );
}

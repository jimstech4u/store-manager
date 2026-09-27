'use client';

import { useEffect, useRef, useState } from 'react';
import { columnsAt, type PrintedLine, type PrintedSpan, type ReceiptLayout } from '@/lib/escpos-text';
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
 * ── AND WHY EVERY SPAN IS SIZED SEPARATELY ───────────────────────────────────────
 *
 * This used to size a whole LINE at one font size, picked from whichever span had the fewest
 * columns, and concatenate the text. Two things were wrong with that, and both showed on a phone:
 *
 *  - IT OVERFLOWED. A line of ten double-width characters and forty small ones was drawn as fifty
 *    double-width characters — half again as wide as the paper — so the preview scrolled sideways
 *    and the shop could not see the right-hand edge at all, which is the one part of a receipt
 *    where the amounts live. Reported as "preview did not account to show within the screen width
 *    of the physical device".
 *  - AND IT UNDID THE ONE THING THE SPANS ARE FOR. Spans exist so a fraction can print smaller
 *    than the number it qualifies — "3" large, "1/2" small. Rendering the line at one size drew
 *    them the same, so the preview disagreed with the paper about the very detail the spans were
 *    added for.
 *
 * Each span is now drawn at its own size, so a line's width on screen is the sum of its parts,
 * exactly as the print head lays it down.
 */

/** What the printer does to a glyph at this size, as multiples of the base cell. */
function stretch(size: PrintedSpan['size']): { wide: number; tall: number } {
  return {
    wide: size.endsWith('w') ? 2 : 1,
    tall: size.endsWith('h') || size.endsWith('hw') ? 2 : 1,
  };
}

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

  /*
   * THE WIDTH OF THE PAPER IS THE WIDTH THIS HAS ON THE SCREEN, measured.
   *
   * It was a fixed `30rem`, dropping to `21rem` under a 420px media query — a guess at how much
   * room the component would be given, made by a stylesheet that cannot see where it was put. On a
   * phone the guess was too wide, every line overflowed, and the card grew a horizontal scrollbar
   * that hid the right-hand column. A media query cannot fix that: the same component sits in a
   * full-width settings page and in a narrow receipt card, at the same viewport.
   *
   * So it is observed. The preview is then exactly as wide as the space it was handed, whatever
   * that turns out to be, and nothing inside it ever needs to scroll.
   */
  const paperRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = paperRef.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={styles.paper} aria-label="How this will print">
      {/* The measured box: full width inside the paper's padding, so the lines match the roll. */}
      <div ref={paperRef} className={styles.roll}>
        {width > 0 &&
          lines.map((line, i) => {
            const spans = line.spans.length > 0 ? line.spans : [{ size: 'ss' as const, text: ' ' }];

            /*
             * One cell is the paper divided by how many of that size fit across it — the printer's
             * own arithmetic. The font size that draws a cell that wide is that over the measured
             * glyph ratio.
             */
            const sized = spans.map((s) => {
              const cell = width / columnsAt(s.size, layout);
              const { wide, tall } = stretch(s.size);
              return {
                span: s,
                font: cell / ratio,
                /*
                 * Font size sets width AND height together, and the printer does not: `ssh` is
                 * twice as tall at the same width, `ssw` twice as wide at the same height. The
                 * font size above is chosen to get the WIDTH right, so the height is corrected
                 * here — from the bottom, because a double-height character grows up off the
                 * baseline rather than straddling it.
                 */
                scaleY: tall / wide,
                height: (cell / ratio) * (tall / wide),
              };
            });

            const rowHeight = sized.reduce((tallest, s) => Math.max(tallest, s.height), 0);

            return (
              <div key={i} className={styles.line} style={{ height: `${rowHeight * 1.2}px` }}>
                {sized.map((s, j) => (
                  <span
                    key={j}
                    className={styles.run}
                    style={{
                      fontSize: `${s.font}px`,
                      transform: s.scaleY === 1 ? undefined : `scaleY(${s.scaleY})`,
                      fontWeight: s.span.size.startsWith('sl') ? 600 : 500,
                    }}
                  >
                    {s.span.text}
                  </span>
                ))}
              </div>
            );
          })}
      </div>
    </div>
  );
}

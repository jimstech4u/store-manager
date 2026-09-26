'use client';

import { columnsAt, type PrintedLine, type ReceiptLayout } from '@/lib/escpos-text';
import styles from './PrintPreview.module.css';

/**
 * WHAT THE ROLL WILL SAY, before a roll is spent finding out.
 *
 * IT RENDERS THE PRINTER'S OWN LINES. Not a layout that resembles them — the exact array that
 * `asInstruction` tags and sends. There is no second description to drift, which matters because
 * the first version of this DID drift: it showed amounts lined up on the right while the paper
 * wrapped them onto the next line, and a shop comparing the two found two different documents.
 *
 * The remaining assumption is the one thing a preview cannot know by itself — how many characters
 * the printer fits on a line — and that is now measured off a ruler rather than calculated. The
 * preview uses the measured number, so when it is right the two agree, and when it is wrong they
 * are wrong together and the shop can see it and fix it.
 *
 * A receipt in the printer's built-in font is monospaced by definition: every glyph is the same
 * number of dots wide. So a faithful preview is arithmetic, not rendering — the same text, in a
 * monospaced face, at the same characters per line.
 */
export function PrintPreview({
  lines,
  layout,
}: {
  lines: PrintedLine[];
  layout: ReceiptLayout;
}) {
  return (
    <div className={styles.paper} aria-label="How this will print">
      {lines.map((l, i) => {
        const cols = columnsAt(l.size, layout);
        const tall = l.size.endsWith('h') || l.size.endsWith('hw');
        return (
          <pre
            key={i}
            className={styles.line}
            style={{
              /*
               * Every size fills the SAME paper width; only the character count differs. `ch` would
               * do this too, but sizing by the count keeps the arithmetic identical to the
               * printer's: one line of 32 wide characters and one of 64 small ones are the same
               * width on the roll, and they are the same width here.
               */
              fontSize: `calc(var(--print-line) / ${cols})`,
              lineHeight: tall ? 1.7 : 1.15,
              fontWeight: l.size.startsWith('sl') ? 600 : 500,
            }}
          >
            {l.text === '' ? ' ' : l.text}
          </pre>
        );
      })}
    </div>
  );
}

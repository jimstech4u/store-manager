'use client';

import { useMemo } from 'react';
import { columnsAt, receiptAsEscPos, type TextSize } from '@/lib/escpos-text';
import { dotsFor } from '@/lib/escpos';
import styles from './PrintPreview.module.css';

/**
 * WHAT THE ROLL WILL SAY, before a roll is spent finding out.
 *
 * A receipt printed in the printer's own letters is monospaced by definition — every glyph is the
 * same number of dots wide — so a faithful preview is not a rendering problem, it is an arithmetic
 * one: the same text, in a monospaced font, at the same number of characters per line.
 *
 * THE PREVIEW IS BUILT FROM THE INSTRUCTION ITSELF, not from a second layout that resembles it.
 * `receiptAsEscPos` produces the exact string the printer receives; this un-tags it and shows the
 * lines. So a preview that is wrong is a print that is wrong, which is the only kind of preview
 * worth having — the alternative is two layouts that agree until the day they do not.
 *
 * The sizes are the printer's, from the app's own reference: small is 9 dots wide, large is 12, and
 * the double-width variants take twice that. On a 576-dot head that is 64, 48 or 32 characters to a
 * line, and the preview scales each line the same way the head will.
 */
export function PrintPreview({
  payload,
  paperMm,
  bodySize,
}: {
  /** The same receipt payload the sell screen builds. */
  payload: Parameters<typeof receiptAsEscPos>[0];
  paperMm: number;
  bodySize: TextSize;
}) {
  const dots = dotsFor(paperMm);

  const lines = useMemo(() => {
    const raw = receiptAsEscPos(payload, dots, bodySize);
    /*
     * Split back into (size, text) pairs. Every line this produces is `#size#text#lf#`, so the
     * instruction is its own description and nothing here needs to know the layout rules.
     */
    return raw
      .replace(/^#escps#/, '')
      .split('#lf#')
      .filter((chunk) => chunk.length > 0 && chunk !== '#cutt#')
      .map((chunk) => {
        const at = chunk.indexOf('#', 1);
        const size = (chunk.slice(1, at) || 'ss') as TextSize;
        return { size, text: chunk.slice(at + 1) };
      });
  }, [payload, dots, bodySize]);

  return (
    <div className={styles.paper} aria-label="How this will print">
      {/*
        A fixed character width, scaled per line by how wide that size's glyphs are. `ch` is the
        width of a "0" in the current font, which in a monospaced face is every character — so a
        line of 32 double-width characters and a line of 64 small ones come out the same width on
        screen, exactly as they will on paper.
      */}
      {lines.map((l, i) => {
        const cols = columnsAt(l.size, dots);
        const tall = l.size.endsWith('h') || l.size.endsWith('hw');
        return (
          <pre
            key={i}
            className={styles.line}
            style={{
              // Every size fills the same paper width; only the character count differs.
              fontSize: `calc(var(--print-line) / ${cols})`,
              lineHeight: tall ? 1.6 : 1.15,
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

import { Fragment } from 'react';
import { formatQtySpoken } from '@/lib/format';
import styles from './Qty.module.css';

/**
 * A quantity, with its fraction set smaller than the whole.
 *
 * "the 1/2 was suppose to be smaller than the whole amount likewise for others like 1/4 or 3/4."
 *
 * A shop reads "5 1/2 crates" as five crates and a bit. Set at one size the two halves of that
 * compete — the "1/2" is three characters and a slash, so it takes more width than the figure it
 * qualifies and the eye lands on the wrong one. Smaller, it reads the way it is said: the whole
 * number is the quantity and the fraction modifies it.
 *
 * WHY NOT IN `formatQtySpoken`. That returns a STRING, and a string cannot carry two sizes. It is
 * also what the receipt, the PDF and the shared page use, where there is one size and "1/2" in
 * plain ASCII is exactly right. This is the screen's version of the same sentence, so the two
 * cannot drift: the text still comes from `formatQtySpoken` and is only split for display.
 */
export function Qty({
  value,
  className,
}: {
  value: string | number | null | undefined;
  className?: string;
}) {
  const said = formatQtySpoken(value);

  /*
   * Split on the fraction, not on the space.
   *
   * "5 1/2" and a bare "1/2" both occur — half a crate has no whole part, and treating the space
   * as the separator would render nothing at all for it.
   */
  const parts = said.split(/(\d\/\d)/);

  return (
    <span className={className}>
      {parts.map((part, i) =>
        /^\d\/\d$/.test(part) ? (
          <span key={i} className={styles.part}>
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </span>
  );
}

'use client';

import { mediaUrl } from '@/lib/stacks/storefront';
import { formatMoney } from '@/lib/format';
import styles from './ReceiptPreview.module.css';

/**
 * What a receipt will look like on paper, shown while the settings are being edited.
 *
 * The point is to catch mistakes before a customer does. A header with a typo, a bank account with
 * a transposed digit, a logo that is unreadable at 40mm — all of them are obvious here and
 * invisible in a form made of separate text fields. Shops print hundreds of these; the first one
 * to reveal a wrong account number has already sent somebody's money somewhere else.
 *
 * Rendered at the ACTUAL paper width, scaled for the screen. 40mm and 80mm are genuinely different
 * layouts — a line that wraps on one fits on the other — so previewing at some convenient size
 * would defeat the exercise.
 *
 * Sample figures, deliberately. Real ones would change under the person editing and make it hard
 * to tell what is the setting and what is today's trade.
 */
export function ReceiptPreview({
  widthMm,
  header,
  footer,
  logoPath,
  logoWidthPct = 60,
  shopName,
  transfer,
}: {
  widthMm: number;
  header?: string | null;
  footer?: string | null;
  logoPath?: string | null;
  logoWidthPct?: number;
  shopName: string;
  transfer?: string | null;
}) {
  const logo = mediaUrl(logoPath);

  return (
    <div className={styles.wrap}>
      <p className={styles.caption}>
        How it prints on {widthMm}mm paper
      </p>

      <div
        className={styles.paper}
        // The paper's real width in millimetres. The browser converts it, so what is on screen is
        // the true proportion of the roll rather than an approximation in pixels.
        style={{ width: `${widthMm}mm` }}
      >
        {logo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logo}
            alt=""
            className={styles.logo}
            style={{ width: `${logoWidthPct}%` }}
          />
        )}

        <p className={styles.shop}>{shopName}</p>
        {header && <p className={styles.header}>{header}</p>}

        <div className={styles.rule} />

        <div className={styles.line}>
          <span>Coca-Cola PET 60cl</span>
        </div>
        <div className={styles.line}>
          <span className={styles.qty}>2 Pack × {formatMoney(4500)}</span>
          <span className={styles.amount}>{formatMoney(9000)}</span>
        </div>
        <div className={styles.line}>
          <span>Trophy 60cl</span>
        </div>
        <div className={styles.line}>
          <span className={styles.qty}>½ Crate × {formatMoney(4100)}</span>
          <span className={styles.amount}>{formatMoney(4100)}</span>
        </div>

        <div className={styles.rule} />

        <div className={styles.line}>
          <span>Transport</span>
          <span className={styles.amount}>{formatMoney(2000)}</span>
        </div>
        <div className={`${styles.line} ${styles.total}`}>
          <span>Total</span>
          <span className={styles.amount}>{formatMoney(15100)}</span>
        </div>
        <div className={styles.line}>
          <span>Paid (cash)</span>
          <span className={styles.amount}>{formatMoney(10000)}</span>
        </div>
        <div className={styles.line}>
          <span>Balance</span>
          <span className={styles.amount}>{formatMoney(5100)}</span>
        </div>

        <div className={styles.rule} />

        <div className={styles.line}>
          <span className={styles.total}>Still with you</span>
        </div>
        <div className={styles.line}>
          <span>NBL crate</span>
          <span className={styles.amount}>3</span>
        </div>

        {transfer && <div className={styles.transfer}>{transfer}</div>}
        {footer && <p className={styles.footer}>{footer}</p>}
      </div>
    </div>
  );
}

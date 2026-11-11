import { formatDateTime, formatMoney } from '@/lib/format';
import type { PaperLogo, ReceiptImageInput } from '@/lib/share';

/**
 * A PAYMENT AS A SLIP — pure, no screen and no browser, so the payment page and the agent print the
 * same paper in the same words: "PAYMENT RECEIPT", or "MONEY GIVEN BACK" when the shop paid out.
 * Built from what the shop recorded, never from what was typed.
 */
export interface PaymentSlip {
  paymentId: string;
  customerName: string;
  amount: number;
  method: string;
  reference: string | null;
  direction: 'in' | 'out';
  at: string;
  /** The whole account, `customer_balance_total`; null when it could not be read. */
  balance: number | null;
}

export function paymentDocument(
  p: PaymentSlip,
  shopName: string,
  opts: { header?: string | null; footer?: string | null; logo?: PaperLogo | null; now?: boolean } = {},
): ReceiptImageInput {
  const gave = p.direction === 'out';
  const now = opts.now ? ' now' : '';
  return {
    shopName,
    banner: gave ? 'MONEY GIVEN BACK' : 'PAYMENT RECEIPT',
    header: opts.header ?? null,
    footer: opts.footer ?? null,
    logo: opts.logo ?? null,
    meta: [formatDateTime(p.at), p.customerName, `#${p.paymentId.slice(0, 8).toUpperCase()}`],
    lines: [
      {
        name: gave ? 'Given back' : 'Payment received',
        detail: `by ${p.method}${p.reference ? ` · ${p.reference}` : ''}`,
        qty: `by ${p.method}`,
        amount: formatMoney(p.amount),
      },
    ],
    totals: [
      { label: gave ? 'Given back' : 'Paid', value: formatMoney(p.amount), strong: true },
      ...(p.balance === null
        ? []
        : [
            {
              label: p.balance > 0.005 ? `Still owes${now}` : p.balance < -0.005 ? `In credit${now}` : `Balance${now}`,
              value: formatMoney(Math.abs(p.balance)),
              strong: true,
            },
          ]),
    ],
  };
}

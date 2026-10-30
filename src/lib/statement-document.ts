import { formatDate, formatMoney, formatQtySpoken, shapeWord } from '@/lib/format';
import { owedRowsFromReceipt, rollUpOwed } from '@/lib/empties-rollup';
import type { DocBlock, ReceiptImageInput } from '@/lib/share';

/**
 * A CUSTOMER'S STATEMENT AS ENTRIES (`DocBlock`) — pure, shared by the statement page and the
 * WhatsApp assistant. A sale is its title and date, its items numbered — the quantity and what each
 * came to, no price each — and its total; a payment, a charge, a deposit or the opening balance is
 * its title and date with what it was between single rules. The totals under them are the account's
 * own, whatever is ticked.
 */
export type Kind = 'sales' | 'items' | 'payments' | 'charges' | 'deposits' | 'empties';
export const KINDS: { kind: Kind; label: string }[] = [
  { kind: 'sales', label: 'Sales' },
  { kind: 'items', label: 'Items on each sale' },
  { kind: 'payments', label: 'Payments' },
  { kind: 'charges', label: 'Charges and opening balance' },
  { kind: 'deposits', label: 'Deposits' },
  { kind: 'empties', label: 'Empties' },
];

export interface StatementEvent {
  occurred_at: string;
  kind: string;
  label: string;
  detail: string | null;
  amount: string | null;
  qty_units: string | null;
  ref_table: string | null;
  ref_id: string | null;
}
export interface Statement {
  customer: { id: string; name: string; business: string | null; phone: string | null } | null;
  opening: number;
  closing: number;
  events: StatementEvent[];
  items: {
    sale_id: string;
    product_name: string;
    entered_qty: string;
    unit_name: string | null;
    unit_plural: string | null;
    unit_price: string;
    line_total: string;
  }[];
  empties: unknown;
}

const groupOf = (kind: string): Kind | null =>
  kind === 'sale'
    ? 'sales'
    : kind === 'payment' || kind === 'excess' || kind === 'refund'
      ? 'payments'
      : kind === 'charge' || kind === 'opening'
        ? 'charges'
        : kind.startsWith('deposit_')
          ? 'deposits'
          : kind.startsWith('empties_')
            ? 'empties'
            : null;

export function statementDocument(
  st: Statement,
  opts: { shopName: string; periodLabel: string; hasStart: boolean; on: Set<Kind>; printedAt?: string },
): ReceiptImageInput {
  const { on } = opts;
  const blocks: DocBlock[] = [];
  const sum = { sold: 0, charged: 0, paid: 0 };
  for (const e of st.events) {
    const g = groupOf(e.kind);
    const amount = e.amount == null ? null : Number(e.amount);
    if (amount != null) {
      if (e.kind === 'sale') sum.sold += amount;
      else if (e.kind === 'charge' || e.kind === 'opening') sum.charged += amount;
      else if (e.kind === 'payment' || e.kind === 'excess') sum.paid += amount;
    }
    if (!g || !on.has(g)) continue;
    const lowers = e.kind === 'payment' || e.kind === 'excess';
    const money = amount != null ? `${lowers ? '-' : ''}${formatMoney(Math.abs(amount))}` : '';
    const when = formatDate(e.occurred_at);

    if (e.kind === 'sale') {
      const tag = e.ref_id ? ` #${e.ref_id.slice(0, 8).toUpperCase()}` : '';
      const items = on.has('items') && e.ref_id ? st.items.filter((x) => x.sale_id === e.ref_id) : [];
      blocks.push(
        items.length > 0
          ? {
              title: `Sale${tag}`,
              right: when,
              items: items.map((l) => ({
                name: l.product_name,
                qty: `${formatQtySpoken(l.entered_qty)}${
                  l.unit_name ? ` ${shapeWord(l.entered_qty, l.unit_name, l.unit_plural)}` : ''
                }`,
                amount: formatMoney(Number(l.line_total)),
              })),
              total: { label: 'Total', value: money },
            }
          : { title: `Sale${tag}`, right: when, rows: [{ label: 'Total', value: money }] },
      );
      continue;
    }
    blocks.push({
      title: e.label,
      right: when,
      heavy: e.kind === 'opening',
      rows: [{ label: e.detail ?? (e.qty_units ? `${formatQtySpoken(e.qty_units)}` : ''), value: money }],
    });
  }
  const still = on.has('empties')
    ? rollUpOwed(owedRowsFromReceipt(st.empties)).filter((l) => l.side === 'they_hold')
    : [];
  return {
    shopName: opts.shopName,
    banner: 'STATEMENT',
    header: null,
    footer: null,
    meta: [
      st.customer?.name ?? '',
      st.customer?.phone ?? '',
      opts.periodLabel,
      `Printed ${opts.printedAt ?? new Date().toLocaleString()}`,
    ].filter(Boolean),
    lines: [],
    blocks,
    totals: [
      ...(opts.hasStart ? [{ label: 'Owed at the start', value: formatMoney(st.opening) }] : []),
      { label: 'Sold', value: formatMoney(sum.sold) },
      ...(sum.charged > 0.005 ? [{ label: 'Charged', value: formatMoney(sum.charged) }] : []),
      { label: 'Paid', value: formatMoney(sum.paid) },
      {
        label: st.closing < -0.005 ? 'We owe you' : 'Owed at the end',
        value: formatMoney(Math.abs(st.closing)),
        strong: true,
      },
      ...(still.length > 0
        ? [
            { label: 'Still with you', value: '', strong: true },
            ...still.map((l) => ({ label: `${l.label} ${l.unit.toLowerCase()}`, value: l.said })),
          ]
        : []),
    ],
    note: null,
    transferDetails: null,
  };
}

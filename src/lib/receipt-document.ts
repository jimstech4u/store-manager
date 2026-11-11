import { formatDate, formatDateTime, formatMoney, formatQtySpoken, pluralUnit } from '@/lib/format';
import { owedRowsFromReceipt, rollUpOwed } from '@/lib/empties-rollup';
import type { PaperLogo, ReceiptImageInput } from '@/lib/share';

/**
 * ONE READING OF A RECEIPT, AND THE PAPER IT MAKES — pure, no screen and no browser, so the receipt
 * page, the put-together page, receipt history, the customer's link and the WhatsApp assistant all
 * print the same document in the same words.
 */
export interface SaleDetail {
  sale: {
    id: string;
    occurred_at: string;
    total: string;
    fee_amount: string;
    fee_label: string | null;
    note: string | null;
    transfer_details: string | null;
    /** 1 until somebody corrects it. Every correction bumps it. */
    revision: number | null;
    /** 'posted' or 'voided'. `sale_detail` returns the whole row, so it was always here. */
    status?: string | null;
    cancelled_reason?: string | null;
  };
  /*
   * WHAT THIS REPLACES, when it replaces something.
   *
   * Null on revision 1, which is the common case and prints exactly as it always did.
   */
  corrected: { replaced_at: string; reason: string; was_total: string } | null;
  customer: { id: string; name: string; phone: string; balance: string } | null;
  /** Named additions to the bill — transport, loading — each answerable on its own. */
  charges: { label: string; amount: string }[];
  /**
   * Money held against the containers going out, summed over the lines.
   *
   * `sale_detail` did not return this — or the charges — until 0183, while the customer's own web
   * copy of the same sale returned both. So a receipt could total N5,000 over N4,500 of goods and
   * print nothing to account for the difference.
   */
  deposit_total?: string | number | null;
  /**
   * Put down as a deposit AT this sale (0244) — the customer's money, held for them. Not in the
   * sale's total: it is paid alongside it, so it is said beside it.
   */
  deposit_taken?: string | number | null;
  /** Of that deposit, what is still to pay (0247). */
  deposit_unpaid?: string | number | null;
  /** The change (0246): what was owed at this sale, and each time some was given back, and how. */
  change?: { owed: number | string; given: { amount: number | string; method: string | null }[] } | null;
  /** What the customer still holds of the shop's, per pool, after this sale. */
  /** What this receipt sent out, one row per product shape (0140). Rolled up for printing. */
  empties: unknown;
  /** What the customer owed once this sale was recorded, as at the sale (0149). */
  account?: { owed_after: string | number } | null;
  lines: {
    id: string;
    product_id: string;
    product_name: string;
    base_unit: string;
    entered_qty: string;
    pack_name: string | null;
    /**
     * THE SHAPE IT WAS SOLD IN — "Crate", "Pack", "Can".
     *
     * `pack_name` is the retired one-pack-per-product model and is null for everything this shop
     * sells, so the line fell through to `base_unit`, a fallback word off a global list, and
     * printed "1 pieces" over a line that was one crate (0201).
     */
    unit_name: string | null;
    unit_plural: string | null;
    base_qty: string;
    unit_price: string;
    line_total: string;
  }[];
  payments: { id: string; amount: string; method: string; reference: string | null }[];
  /*
   * RECEIPTS PUT TOGETHER (0254, `merged_receipts`): the receipts this one paper is made of, when it
   * is the merged view of several. Absent on a receipt.
   */
  merged_parts?: { id: string; occurred_at: string; total: string }[] | null;
}

/**
 * THE RECEIPT'S PAPER, from one reading of it — what the screen draws, the printer is sent, and the
 * picture and the PDF are made of. A function of the reading alone, so the receipt page and the
 * merged-receipts page (0254) print the same document in the same words.
 */
export function receiptDocument(
  paper: SaleDetail,
  shopName: string,
  settings: { header: string | null; footer: string | null; logo?: PaperLogo | null } | null,
): ReceiptImageInput {
  const { sale, customer, lines, payments, charges, corrected } = paper;
  const parts = paper.merged_parts ?? [];
  /*
   * STILL WITH YOU, said the way the counter says it — and ALL of it, not just today's.
   *
   * Everything the customer holds as at this sale: what earlier receipts sent out, less what came
   * back, plus this one (0149). Whole ones add across a maker, parts stay with their product: 3½
   * Goldberg and 2½ Gulder is "5 NBL crates, ½ Goldberg crate, ½ Gulder crate". Applied by the same
   * function the empties pages use — so paper and screen cannot disagree.
   */
  const stillWithYou = rollUpOwed(owedRowsFromReceipt(paper.empties));
  const paid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const owing = Number(sale.total) - paid;
  /*
   * WHAT THE GOODS CAME TO, AND WHAT WAS ADDED TO THEM.
   *
   * `extras` is the gap between the two, and it is what decides whether the breakdown is worth
   * printing: a plain sale shows one total, a sale carrying transport or a crate deposit shows the
   * steps. Derived from the total rather than by adding the parts up, so a receipt cannot print an
   * arithmetic that fails to reach its own bottom line.
   */
  const itemsTotal = lines.reduce((sum, l) => sum + Number(l.line_total), 0);
  const deposit = Number(paper.deposit_total ?? 0) || 0;
  const depositTaken = Number(paper.deposit_taken ?? 0) || 0;
  const changeGiven = (paper.change?.given ?? []).map((g) => ({ amount: Number(g.amount) || 0, method: g.method ?? 'cash' }));
  const changeOwed = Math.max(
    (Number(paper.change?.owed ?? 0) || 0) - changeGiven.reduce((sum, g) => sum + g.amount, 0),
    0,
  );
  /*
   * ONE LINE PER WAY OF PAYING. "Paid (cash) N30,000, Paid (cash) N1,150" read as two lots of cash
   * and made the cash look like more than it was; the drawer counts cash once. References are kept
   * together on the line so a transfer can still be matched to the bank.
   */
  const paidBy = payments.reduce<{ method: string; amount: number; refs: string[] }[]>((acc, p) => {
    const hit = acc.find((x) => x.method === p.method);
    const ref = p.reference ? String(p.reference) : null;
    if (hit) {
      hit.amount += Number(p.amount);
      if (ref) hit.refs.push(ref);
    } else {
      acc.push({ method: p.method, amount: Number(p.amount), refs: ref ? [ref] : [] });
    }
    return acc;
  }, []);
  const extras = Number(sale.total) - itemsTotal;
  /*
   * THE ACCOUNT, AS AT THIS SALE: what they owed before it, what it left, and where that puts them.
   *
   * «16,500 (old) + 1,000 (new) = 17,500». Read as at the sale rather than today, so a receipt
   * reprinted next month still says what it said when it was handed over.
   */
  const owedAfter = paper.account ? Number(paper.account.owed_after) || 0 : null;
  const owedBefore = owedAfter === null ? null : owedAfter - owing;




  /**
   * What gets drawn, for the picture and the PDF alike.
   *
   * One definition on purpose: these two were about to be separate copies of the same twenty-line
   * object, and the moment a charge or a line of the header changed, one of them would have
   * silently kept the old shape.
   */
  /**
   * What to call one of these on the paper.
   *
   * THE SHAPE FIRST, because that is what the seller chose and what the customer was handed.
   * `pack_name` is kept behind it for receipts written under the older pack model, and
   * `base_unit` last — it is a fallback word off a global list and saying "pieces" over a crate
   * is how a receipt stops matching the goods.
   */
  const unitWord = (l: SaleDetail['lines'][number]) => {
    // Up to one is one: "½ crate", not "½ crates" (format.ts `shapeWord`).
    const many = Number(l.entered_qty) > 1;
    const shape = many ? (l.unit_plural ?? l.unit_name) : l.unit_name;
    return shape ?? l.pack_name ?? pluralUnit(l.base_unit, Number(l.entered_qty));
  };

  const receiptPayload = () => ({
    shopName,
    header: settings?.header,
    footer: settings?.footer,
    logo: settings?.logo ?? null,
    meta: [
    formatDateTime(sale.occurred_at),
    `#${sale.id.slice(0, 8).toUpperCase()}`,
    ...(customer ? [customer.name] : []),
    // PUT TOGETHER (0254): which receipts this one paper is made of, oldest first.
    ...(parts.length > 1
      ? [
          `${parts.length} receipts put together: ${parts
            .map((p) => `#${p.id.slice(0, 8).toUpperCase()} ${formatDate(p.occurred_at)}`)
            .join(', ')}`,
        ]
      : []),
    /*
     * A CORRECTED RECEIPT SAYS SO, ON THE PAPER.
     *
     * `sale_detail` has returned `corrected` — when it was replaced, why, and what the total used
     * to be — for as long as corrections have existed, and this screen destructured it and
     * rendered none of it. So the shop could correct a sale and hand over a receipt that looked
     * exactly like a first printing, while the customer still held the original showing a
     * different total and no way to tell which one was current.
     *
     * The old total is the useful half. "Corrected" alone invites the question this answers.
     */
    ...(corrected
      ? [`Corrected — was ${formatMoney(corrected.was_total)}`]
      : []),
    ],
    lines: lines.map((l) => ({
    name: l.product_name,
    detail: `${formatQtySpoken(l.entered_qty)} ${
    unitWord(l)
    } x ${formatMoney(l.unit_price)}`,
    // The same thing without the unit price, for the paper — see ShareLine.qty.
    qty: `${formatQtySpoken(l.entered_qty)} ${
    unitWord(l)
    }`,
    amount: formatMoney(l.line_total),
    })),
    totals: [
      /*
       * THE GOODS ON THEIR OWN, when something else was added to them.
       *
       * Only then: with no charge and no deposit this is the same figure as the total, and a
       * receipt that says N4,500 twice invites the question of why. With them, it is the first
       * step of an arithmetic the customer can follow to the end — which is the whole job of the
       * block below, and what "a full payment breakdown" was asking for.
       */
      ...(extras > 0.005
        ? [{ label: 'Items', value: formatMoney(itemsTotal) }]
        : []),
      // Every named charge on its own line, exactly as the printed page shows them. This used to
      // read `sale.fee_amount`, so a receipt shared as a picture or a PDF showed one lumped
      // "extra charge" while the paper itemised transport and loading separately — two documents
      // for one sale, disagreeing.
      ...(charges ?? []).map((c) => ({ label: c.label, value: formatMoney(c.amount) })),
      ...((charges ?? []).length === 0 && Number(sale.fee_amount) > 0
        ? [{ label: sale.fee_label || 'Extra charge', value: formatMoney(sale.fee_amount) }]
        : []),
      /*
       * WHAT WAS HELD AGAINST THE CRATES, said as a deposit and not as part of the goods.
       *
       * It is the customer's money, not the shop's takings, and it comes back when the containers
       * do. Printing the total with it folded in and no line for it is how a shop ends up arguing
       * about a figure neither side has in writing.
       */
      ...(deposit > 0.005
        ? [{ label: 'Deposit on containers', value: formatMoney(deposit) }]
        : []),
      { label: 'Total', value: formatMoney(sale.total), strong: true },
      /*
       * A DEPOSIT PUT DOWN WITH THIS SALE (0244) — handed over with the payment, held for them,
       * and back to them when the containers are. Said here, beside the total it was paid with.
       */
      ...(depositTaken > 0.005
        ? [{ label: 'Deposit, held for you', value: formatMoney(depositTaken) }]
        : []),
      ...(Number(paper.deposit_unpaid ?? 0) > 0.005
        ? [{ label: 'Deposit still to pay', value: formatMoney(Number(paper.deposit_unpaid)) }]
        : []),
      /*
       * EVERY PAYMENT, with its reference where there is one.
       *
       * A transfer without its reference is unmatchable against a bank statement — which is the
       * one thing a customer holding the receipt and a shop holding the statement both need.
       */
      ...paidBy.map((p) => ({
        label: `Paid (${p.method})${p.refs.length ? ` ${p.refs.join(', ')}` : ''}`,
        value: formatMoney(p.amount),
      })),
      // What it adds up to, once there is more than one of them to add up.
      ...(paidBy.length > 1
        ? [{ label: 'Paid in all', value: formatMoney(paid) }]
        : []),
      ...(owing > 0 ? [{ label: parts.length > 1 ? 'Left on these sales' : 'Left on this sale', value: formatMoney(owing) }] : []),
      // THE CHANGE (0246): what went back, and how; and what is still owed to them on this paper.
      ...changeGiven.map((g) => ({ label: `Change given (${g.method})`, value: formatMoney(g.amount) })),
      ...(changeOwed > 0.005
        ? [{ label: 'Change owed to you', value: formatMoney(changeOwed), strong: true }]
        : []),
      ...(owedBefore !== null && owedBefore > 0.005
        ? [{ label: 'Owed before', value: formatMoney(owedBefore) }]
        : []),
      ...(owedAfter !== null && owedAfter > 0.005
        ? [{ label: 'Total owed', value: formatMoney(owedAfter), strong: true }]
        : owing > 0
          ? [{ label: 'Balance', value: formatMoney(owing), strong: true }]
          : []),
      // What the customer still holds of the shop's. The crates are the half of an account that
      // gets disputed, precisely because nobody has anything in writing about them.
      ...(stillWithYou.length > 0
        ? [{ label: 'Still with you', value: '', strong: true }]
        : []),
      ...stillWithYou.map((e) => ({
        label: `${e.label} ${e.unit.toLowerCase()}`,
        value: e.said,
      })),
    ],
    note: sale.note,
    /*
     * THE BANK DETAILS, ONLY WHERE SOMEBODY ACTUALLY TRANSFERRED.
     *
     * Two conditions, and both matter. The shop decides in Settings whether its account may appear
     * on receipts at all — that decision is already baked into `sale.transfer_details`, which the
     * server snapshots at settle time. The second is this one: an account number on a receipt paid
     * in cash is an invitation to pay again. A customer holding it has no way to tell it is not a
     * request, and the shop finds out when the money arrives twice.
     *
     * Snapshotted per sale rather than read live, so an old receipt keeps the account it was
     * printed with even after the shop changes banks.
     */
    transferDetails: payments.some((p) => p.method === 'transfer')
      ? sale.transfer_details
      : null,
    });

  return receiptPayload();
}

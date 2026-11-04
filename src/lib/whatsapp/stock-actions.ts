import type { ToolDef } from '@/lib/whatsapp/llm';
import { stockInShapes } from '@/lib/shape-quantities';
import {
  customerName, hold, money, num, pick, product, refuse, rpc, say, shapesOf,
  type Args, type Ctx,
} from '@/lib/whatsapp/actions';

/**
 * RECONCILING, AS THE COUNT SCREEN DOES IT. Server only.
 *
 * A count is the shelf at a moment; the records say what should have been there. When they differ,
 * the shop says what happened to the difference — in its own words, each a treatment the ledger
 * knows — and the parts must add up to it exactly before the day can close. And containers that are
 * never coming back are written off, as the empties screen does, with a fee if one was paid.
 */

export const STOCK_ACTION_TOOLS: ToolDef[] = [
  {
    name: 'count_status',
    description:
      "Where an item's count stands today: whether it was counted and by whom, what the records expected, what was counted, the difference, whether it is settled, and the reasons the shop can give for it.",
    parameters: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
  },
  {
    name: 'propose_settle_count',
    description:
      'Propose settling the difference a count found: what happened to it, in parts that add up to the whole difference, each with one of the reasons count_status lists (e.g. "Broken or spoiled", "Sold, but nobody entered it"). Closes the day for that item on YES.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: { reason: { type: 'string' }, qty: { type: 'number' }, unit: { type: 'string' } },
            required: ['reason', 'qty'],
          },
        },
        note: { type: 'string' },
      },
      required: ['product_id', 'parts'],
    },
  },
  {
    name: 'propose_empties_written_off',
    description:
      'Propose writing off containers a customer holds that are never coming back: broken, lost, or paid for. Give the fee if they paid for them.',
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' }, product_id: { type: 'string' }, unit: { type: 'string' },
        qty: { type: 'number' }, reason: { type: 'string' }, fee: { type: 'number' },
      },
      required: ['customer_id', 'product_id', 'qty', 'reason'],
    },
  },
];

interface Period {
  id: string;
  status: string;
  counted_at: string | null;
  actual_closing_qty: number | null;
  expected_at_count: number | null;
  expected_closing_qty: number | null;
  variance_qty: number | null;
}

async function openPeriod(ctx: Ctx, productId: string): Promise<Period | null> {
  const { data } = await ctx.db
    .from('stock_periods')
    .select('id, status, counted_at, actual_closing_qty, expected_at_count, expected_closing_qty, variance_qty')
    .eq('product_id', productId).eq('status', 'open').maybeSingle();
  return (data as Period | null) ?? null;
}

/** A base quantity in the shop's own shapes: "3 crates 4 bottles". */
async function inShapes(ctx: Ctx, productId: string, base: number): Promise<string> {
  const shapes = (await shapesOf(ctx, productId)).filter((s) => s.is_counted !== false);
  if (shapes.length === 0) return String(base);
  return stockInShapes(shapes.map((s) => ({ name: s.unit_name, plural: s.unit_plural, baseQty: num(s.base_qty), onHandBase: base })));
}

async function reasonsFor(ctx: Ctx, variance: number) {
  const all = await rpc<{ label: string; treatment: string; direction: string; hint: string | null }[]>(
    ctx, 'variance_reasons_for', { p_store_id: ctx.storeId });
  // Only what can be true of THIS gap: nothing is stolen when there is more on the shelf.
  return all.filter((r) => (variance < 0 ? r.direction !== 'over' : r.direction !== 'short'));
}

/** What the count says now, in words the agent can repeat. */
export async function countReport(ctx: Ctx, productId: string) {
  const p = await product(ctx, productId);
  const period = await openPeriod(ctx, productId);
  const counted = period?.counted_at && period.actual_closing_qty !== null;
  const variance = num(period?.variance_qty);
  const today = counted ? new Date(period!.counted_at!).toDateString() === new Date().toDateString() : false;
  return {
    item: p?.name,
    counted_today: today,
    counted_at: period?.counted_at ?? null,
    records_expected: counted ? await inShapes(ctx, productId, num(period!.expected_at_count ?? period!.expected_closing_qty)) : undefined,
    on_the_shelf: counted ? await inShapes(ctx, productId, num(period!.actual_closing_qty)) : undefined,
    difference: counted && variance !== 0 ? `${await inShapes(ctx, productId, Math.abs(variance))} ${variance < 0 ? 'short' : 'over'}` : counted ? 'none' : undefined,
    needs_settling: Boolean(counted && variance !== 0),
    reasons_it_can_be: counted && variance !== 0 ? (await reasonsFor(ctx, variance)).map((r) => r.label) : undefined,
  };
}

export async function proposeStock(ctx: Ctx, name: string, a: Args): Promise<unknown> {
  if (name === 'count_status') return countReport(ctx, String(a.product_id ?? ''));

  if (name === 'propose_settle_count') {
    const id = String(a.product_id ?? '');
    const p = await product(ctx, id);
    if (!p) return refuse('That item was not found. Use find_items first.');
    const period = await openPeriod(ctx, id);
    const variance = num(period?.variance_qty);
    if (!period?.counted_at || variance === 0) return refuse(`${p.name} has no difference to settle. Count it first.`);
    const reasons = await reasonsFor(ctx, variance);
    const shapes = await shapesOf(ctx, id);
    const parts: Args[] = [];
    const words: string[] = [];
    let sum = 0;
    for (const part of (Array.isArray(a.parts) ? a.parts : []) as Args[]) {
      const said = String(part.reason ?? '').trim().toLowerCase();
      const reason = reasons.find((r) => r.label.toLowerCase() === said) ??
        reasons.find((r) => r.label.toLowerCase().includes(said) || said.includes(r.label.toLowerCase()));
      if (!reason) return refuse(`"${String(part.reason)}" is not a reason for this. It can be: ${reasons.map((r) => r.label).join('; ')}.`);
      const shape = pick(shapes, part.unit, (s) => s.is_counted !== false);
      if (!shape) return refuse(`${p.name} is not counted in "${String(part.unit)}".`);
      const base = num(part.qty) * num(shape.base_qty);
      if (!(base > 0)) return refuse('Each reason needs how many.');
      sum += base;
      parts.push({ qty: base, reason: reason.treatment, label: reason.label });
      words.push(`• ${say(num(part.qty), shape)} — ${reason.label}`);
    }
    if (parts.length === 0) return refuse('What happened to the difference?');
    const gap = Math.abs(variance);
    if (Math.abs(sum - gap) > 0.0001) {
      return refuse(`Those add up to ${await inShapes(ctx, id, sum)}, but the count is off by ${await inShapes(ctx, id, gap)}. Every one has to be accounted for.`);
    }
    return hold(ctx, 'settle_count', { period_id: period.id, product_id: id, parts, note: a.note ?? null }, [
      `*Settle the count of ${p.name}?*`,
      `Records expected ${await inShapes(ctx, id, num(period.expected_at_count ?? period.expected_closing_qty))}, counted ${await inShapes(ctx, id, num(period.actual_closing_qty))}: ${await inShapes(ctx, id, gap)} ${variance < 0 ? 'short' : 'over'}`,
      ...words,
      'The day closes for this item.',
    ].join('\n'));
  }

  if (name === 'propose_empties_written_off') {
    const who = await customerName(ctx, a.customer_id);
    if (!who) return refuse('Use find_customer first.');
    const id = String(a.product_id ?? '');
    const p = await product(ctx, id);
    if (!p) return refuse('That item was not found. Use find_items first.');
    const shape = pick(await shapesOf(ctx, id), a.unit, (s) => s.is_returnable);
    if (!shape || !shape.is_returnable) return refuse(`${p.name} has no returnable shape.`);
    const qty = num(a.qty);
    if (!(qty > 0)) return refuse('How many are not coming back?');
    /*
     * ONLY WHAT THEY HOLD, asked before the YES. The server refuses more, and rightly, but a person who
     * has already said yes to writing off a crate the customer never had has been told the wrong thing.
     */
    const held = await rpc<{ product_unit_id: string; owed: number | string; side: string }[]>(
      ctx, 'customer_empties_owed', { p_store_customer_id: a.customer_id });
    const owed = held
      .filter((h) => h.product_unit_id === shape.product_unit_id && (h.side ?? 'they_hold') === 'they_hold')
      .reduce((t, h) => t + num(h.owed), 0);
    if (qty > owed + 0.0001) {
      return refuse(owed > 0
        ? `${who} only holds ${say(owed, shape)} of ${p.name}, so no more than that can be written off.`
        : `${who} holds no ${shape.unit_plural.toLowerCase()} of ${p.name}, so there is nothing to write off.`);
    }
    if (!String(a.reason ?? '').trim()) return refuse('Why are they not coming back: broken, lost, paid for?');
    const fee = num(a.fee);
    const said = `${p.name}: ${say(qty, shape)}`;
    return hold(ctx, 'empties_written_off', {
      customer_id: a.customer_id, parts: [{ product_unit_id: shape.product_unit_id, qty }], reason: String(a.reason).trim(), said,
      fee: fee > 0 ? fee : null,
    }, [
      `*Write off ${who}'s empties?*`,
      `${say(qty, shape)} of ${p.name} not coming back`,
      `Why: ${String(a.reason)}`,
      ...(fee > 0 ? [`Fee paid: ${money(fee)}`] : []),
    ].join('\n'));
  }

  return refuse(`No action called ${name}`);
}

export async function executeStock(ctx: Ctx, action: string, a: Args): Promise<{ text: string } | null> {
  if (action === 'settle_count') {
    await rpc(ctx, 'resolve_variance', { p_period_id: a.period_id, p_parts: a.parts, p_note: a.note ?? null });
    await rpc(ctx, 'close_stock_period', { p_period_id: a.period_id });
    return { text: 'Settled ✅ The count is explained and the day is closed for this item.' };
  }
  if (action === 'empties_written_off') {
    const r = await rpc<{ kept?: number | string; charged?: number | string } | null>(ctx, 'write_off_empties', {
      p_store_id: ctx.storeId, p_customer_id: a.customer_id, p_parts: a.parts, p_reason: a.reason, p_said: a.said, p_fee: a.fee ?? null,
    });
    const charged = num(r?.charged);
    return { text: `Written off ✅${charged > 0 ? ` ${money(charged)} recorded for them.` : ''}` };
  }
  return null;
}

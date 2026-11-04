import { randomUUID } from 'node:crypto';
import type { ToolDef } from '@/lib/whatsapp/llm';
import {
  customerName, decidedOnAccount, hold, methods, money, num, paymentGate, pick, product, qtyAllowed, refuse, rpc, sameSize, say, shapesOf,
  type Args, type Ctx, type Shape,
} from '@/lib/whatsapp/actions';

/**
 * AN ORDER BUILT IN A CHAT IS AN OPEN ORDER ON THE TILL, FROM ITS FIRST ITEM (0267). Server only.
 *
 * "The AI cannot keep the order, the price and the quantity without hallucinating; the draft solves
 * that." A model's memory of twelve lines and three changes of mind is a guess. So every change is
 * saved to a real open order (`save_draft_order`, as the till saves a tab), every answer is read
 * back from it, and the customer can follow it by its code. Changing an open order moves no stock
 * and no money, so it needs no YES; SELLING it does, like any sale.
 *
 * The chat remembers only which order it is working on (`whatsapp_links.working_draft_id`).
 */

export const ORDER_TOOLS: ToolDef[] = [
  {
    name: 'order_start',
    description:
      'Start an order to build up in this chat. It is an open order on the till with a code the customer can follow, so items, quantities and prices are kept for you. Use it whenever they list items for a customer, say order or draft, or add to an order over several messages. code carries on an open order already on the till.',
    parameters: { type: 'object', properties: { customer_id: { type: 'string', description: 'From find_customer; leave out if none yet' }, code: { type: 'string' } } },
  },
  {
    name: 'order_set',
    description:
      'Put an item on the working order, or change one already on it: the quantity (0 takes it off), the shape, or the price. Always answer from the order this returns, never from memory.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'From find_items' },
        qty: { type: 'number' },
        unit: { type: 'string', description: 'crate, pack, bottle… Leave out for the usual one.' },
        price: { type: 'number', description: 'Each, in naira. Leave out for the shop price.' },
        written: { type: 'string', description: 'The line as the customer wrote it, when it settles a held line.' },
      },
      required: ['product_id', 'qty'],
    },
  },
  {
    name: 'order_hold',
    description:
      'Hold a line of the order that cannot be placed yet: a name that matches nothing or several items, no quantity, or an unclear shape. It is kept with the order (not in your memory) and shown under to_confirm until order_set settles it or order_skip leaves it off. choices are the item ids it could be.',
    parameters: {
      type: 'object',
      properties: {
        written: { type: 'string', description: 'The line as written, e.g. "Coke 1" or "Dudu"' },
        qty: { type: 'number' },
        unit: { type: 'string' },
        why: { type: 'string', description: 'What has to be asked: which item, how many, which shape' },
        choices: { type: 'array', items: { type: 'string' } },
      },
      required: ['written', 'why'],
    },
  },
  {
    name: 'order_skip',
    description: 'Leave a held line off the order, when they say so.',
    parameters: { type: 'object', properties: { written: { type: 'string' } }, required: ['written'] },
  },
  {
    name: 'order_customer',
    description: 'Put the working order on a customer, or change who it is for.',
    parameters: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] },
  },
  {
    name: 'order_show',
    description: 'The working order exactly as saved: each item, quantity, price, the total, its code and the link to send the customer.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'order_sell',
    description: 'When they are ready, sell the working order. It is shown to them for YES. paid as in propose_sale; leave it out when nothing is paid.',
    parameters: {
      type: 'object',
      properties: {
        paid: { type: 'array', items: { type: 'object', properties: { amount: { type: 'number' }, method: { type: 'string', enum: ['cash', 'transfer', 'pos'] } }, required: ['amount', 'method'] } },
        rest_on_account: { type: 'boolean', description: 'Only once they have said so: true when what is not paid now goes on the customer\'s account.' },
      },
    },
  },
];

interface Draft {
  id: string;
  code: string;
  share_token: string | null;
  status: string;
  store_customer_id: string | null;
  label: string | null;
  fee_amount: number;
  fee_label: string | null;
  note: string | null;
}
interface Line {
  product_id: string;
  entered_qty: number;
  sale_unit_id: string | null;
  unit_price: number;
  line_total: number;
  containers_out: number;
  deposit_charged: number;
}

async function working(ctx: Ctx): Promise<Draft | null> {
  const { data: link } = await ctx.service
    .from('whatsapp_links').select('working_draft_id').eq('wa_phone', ctx.phone).is('revoked_at', null).maybeSingle();
  const id = (link as { working_draft_id: string | null } | null)?.working_draft_id;
  if (!id) return null;
  const { data } = await ctx.db
    .from('draft_orders')
    .select('id, code, share_token, status, store_customer_id, label, fee_amount, fee_label, note')
    .eq('id', id).eq('store_id', ctx.storeId).maybeSingle();
  const d = data as Draft | null;
  return d && d.status === 'open' ? d : null;
}

async function remember(ctx: Ctx, draftId: string | null) {
  // A new order, or none: the lines held for the last one are not this one's.
  await ctx.service.from('whatsapp_links').update({ working_draft_id: draftId, order_questions: [] }).eq('wa_phone', ctx.phone).is('revoked_at', null);
}

interface Held {
  written: string;
  qty?: number | null;
  unit?: string | null;
  why: string;
  choices?: string[];
}
const sameLine = (a: string, b: string) =>
  a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function heldLines(ctx: Ctx): Promise<Held[]> {
  const { data } = await ctx.service.from('whatsapp_links').select('order_questions').eq('wa_phone', ctx.phone).is('revoked_at', null).maybeSingle();
  return ((data as { order_questions?: Held[] } | null)?.order_questions ?? []) as Held[];
}
async function keepHeld(ctx: Ctx, held: Held[]) {
  await ctx.service.from('whatsapp_links').update({ order_questions: held }).eq('wa_phone', ctx.phone).is('revoked_at', null);
}

async function linesOf(ctx: Ctx, draftId: string): Promise<Line[]> {
  const { data } = await ctx.db
    .from('draft_order_lines')
    .select('product_id, entered_qty, sale_unit_id, unit_price, line_total, containers_out, deposit_charged')
    .eq('draft_order_id', draftId).order('position');
  return ((data ?? []) as Line[]).map((l) => ({
    ...l, entered_qty: num(l.entered_qty), unit_price: num(l.unit_price), line_total: num(l.line_total),
    containers_out: num(l.containers_out), deposit_charged: num(l.deposit_charged),
  }));
}

/** The lines as `save_draft_order` takes them: the whole order, every time, as the till sends it. */
async function save(ctx: Ctx, d: Draft | null, lines: Line[], customerId: string | null, label: string | null) {
  const shapes = new Map<string, Shape>();
  for (const l of lines) for (const s of await shapesOf(ctx, l.product_id)) shapes.set(s.product_unit_id, s);
  return rpc<string>(ctx, 'save_draft_order', {
    p_store_id: ctx.storeId,
    p_draft_id: d?.id ?? null,
    p_customer_id: customerId,
    p_label: label,
    p_fee_amount: d?.fee_amount ?? 0,
    p_fee_label: d?.fee_label ?? null,
    p_note: d?.note ?? null,
    p_client_uuid: d ? null : randomUUID(),
    // Not mentioned, so kept: a charge or deposit taken on the till survives a change made here.
    p_charges: null,
    p_deposits: null,
    p_lines: lines.map((l) => {
      const s = l.sale_unit_id ? shapes.get(l.sale_unit_id) : undefined;
      return {
        product_id: l.product_id, qty: l.entered_qty, pack_id: null, sale_unit_id: l.sale_unit_id,
        base_qty: l.entered_qty * num(s?.base_qty ?? 1), unit_price: l.unit_price, line_total: l.line_total,
        containers_out: l.containers_out, deposit_charged: l.deposit_charged,
      };
    }),
  });
}

/** The order as saved, in words: what the model answers from. */
async function view(ctx: Ctx, d: Draft) {
  const lines = await linesOf(ctx, d.id);
  const items = [];
  const comingBack: string[] = [];
  for (const l of lines) {
    const p = await product(ctx, l.product_id);
    const s = (await shapesOf(ctx, l.product_id)).find((x) => x.product_unit_id === l.sale_unit_id);
    if (s?.is_returnable) comingBack.push(s.unit_plural.toLowerCase());
    items.push({
      product_id: l.product_id,
      item: p?.name ?? 'Item',
      qty: s ? say(l.entered_qty, s) : String(l.entered_qty),
      each: money(l.unit_price),
      total: money(l.line_total),
    });
  }
  const goods = lines.reduce((t, l) => t + l.line_total, 0);
  const base = process.env.NEXT_PUBLIC_APP_URL ?? '';
  return {
    code: d.code,
    for: d.label ?? (await customerName(ctx, d.store_customer_id)) ?? 'nobody yet',
    items,
    total: money(goods + num(d.fee_amount)),
    link_for_customer: d.share_token ? `${base}/t/${encodeURIComponent(d.share_token)}` : `${base}/track?code=${encodeURIComponent(d.code)}`,
    // What could not be placed yet, kept with the order: asked about one at a time.
    ...(await heldLines(ctx).then(async (held) => (held.length > 0 ? {
      to_confirm: await Promise.all(held.map(async (h) => ({
        written: h.written, qty: h.qty ?? undefined, why: h.why,
        choices: h.choices?.length ? await Promise.all(h.choices.map(async (id) => ({ id, name: (await product(ctx, id))?.name ?? 'Item' }))) : undefined,
      }))),
    } : {}))),
    // Said while the order is built, as the till says it: not a refusal yet, a thing to settle before selling.
    ...(comingBack.length > 0 && !d.store_customer_id
      ? { needs_a_customer: `The ${[...new Set(comingBack)].join(' and ')} come back empty, so it needs a customer before it can be sold. Ask who it is for.` }
      : {}),
    note: 'Saved on the till. Answer from this, not from memory.',
  };
}

export async function runOrder(ctx: Ctx, name: string, a: Args): Promise<unknown> {
  if (name === 'order_start') {
    if (a.code) {
      const { data } = await ctx.db.rpc('draft_order_by_code', { p_store_id: ctx.storeId, p_code: String(a.code) });
      const found = ((data ?? []) as { id: string }[])[0];
      if (!found) return refuse(`There is no open order with the code ${String(a.code)}.`);
      await remember(ctx, found.id);
    } else {
      const who = a.customer_id ? await customerName(ctx, a.customer_id) : null;
      if (a.customer_id && !who) return refuse('That customer is not in this shop. Use find_customer first.');
      const id = await save(ctx, null, [], (a.customer_id as string) ?? null, who);
      await remember(ctx, id);
    }
    const d = await working(ctx);
    return d ? view(ctx, d) : refuse('The order could not be opened.');
  }

  const d = await working(ctx);
  if (!d) return refuse('There is no order being built in this chat. Start one with order_start.');

  if (name === 'order_show') return view(ctx, d);

  if (name === 'order_hold') {
    const held = (await heldLines(ctx)).filter((h) => !sameLine(h.written, String(a.written ?? '')));
    held.push({
      written: String(a.written ?? '').trim(),
      qty: a.qty != null ? num(a.qty) : null,
      unit: a.unit ? String(a.unit) : null,
      why: String(a.why ?? 'which item'),
      choices: Array.isArray(a.choices) ? (a.choices as string[]).slice(0, 8) : undefined,
    });
    await keepHeld(ctx, held);
    return view(ctx, d);
  }

  if (name === 'order_skip') {
    await keepHeld(ctx, (await heldLines(ctx)).filter((h) => !sameLine(h.written, String(a.written ?? ''))));
    return view(ctx, d);
  }

  if (name === 'order_customer') {
    const who = await customerName(ctx, a.customer_id);
    if (!who) return refuse('That customer is not in this shop. Use find_customer first.');
    await save(ctx, d, await linesOf(ctx, d.id), String(a.customer_id), who);
    return view(ctx, (await working(ctx)) ?? d);
  }

  if (name === 'order_set') {
    const id = String(a.product_id ?? '');
    const p = await product(ctx, id);
    if (!p) return refuse('That item was not found. Use find_items first.');
    const shapes = await shapesOf(ctx, id);
    const lines = await linesOf(ctx, d.id);
    const at = lines.findIndex((l) => l.product_id === id);
    const shape = a.unit ? pick(shapes, a.unit, (s) => s.is_sold !== false)
      : (at >= 0 ? shapes.find((s) => s.product_unit_id === lines[at].sale_unit_id) ?? null : null) ?? pick(shapes, null, (s) => s.is_sold !== false);
    if (!shape) return refuse(`${p.name} is not sold in "${String(a.unit)}".`);
    const qty = num(a.qty);
    if (qty > 0) {
      const wrongQty = sameSize(p.name, shapes, shape) ?? qtyAllowed(p.name, qty, shape);
      if (wrongQty) return refuse(wrongQty);
    }
    if (a.written) await keepHeld(ctx, (await heldLines(ctx)).filter((h) => !sameLine(h.written, String(a.written))));
    if (qty <= 0) {
      if (at >= 0) lines.splice(at, 1);
    } else {
      let price = a.price != null ? num(a.price) : at >= 0 && lines[at].sale_unit_id === shape.product_unit_id ? lines[at].unit_price : null;
      if (price === null) {
        const r = await rpc<{ suggested?: string | number | null } | null>(ctx, 'resolve_price', {
          p_product_id: id, p_qty: qty, p_sale_unit_id: shape.product_unit_id, p_customer_id: d.store_customer_id,
        });
        price = r?.suggested != null ? num(r.suggested) : shape.price_per_unit != null ? num(shape.price_per_unit) : null;
      }
      if (price === null) return refuse(`${p.name} has no price. What is the price per ${shape.unit_name.toLowerCase()}?`);
      const line: Line = {
        product_id: id, entered_qty: qty, sale_unit_id: shape.product_unit_id, unit_price: price,
        line_total: Math.round(qty * price * 100) / 100, containers_out: shape.is_returnable ? qty : 0,
        deposit_charged: at >= 0 ? lines[at].deposit_charged : 0,
      };
      if (at >= 0) lines[at] = line;
      else lines.push(line);
    }
    await save(ctx, d, lines, d.store_customer_id, d.label);
    return view(ctx, d);
  }

  if (name === 'order_sell') {
    const lines = await linesOf(ctx, d.id);
    if (lines.length === 0) return refuse('The order has nothing on it yet.');
    const held = await heldLines(ctx);
    if (held.length > 0) {
      return refuse(`These lines are not settled yet: ${held.map((h) => `"${h.written}" (${h.why})`).join('; ')}. Ask about them, or order_skip the ones they want left off.`);
    }
    // The app's own rules, before anybody is asked to say yes: what is finished, what needs counting.
    for (const l of lines) {
      const p = await product(ctx, l.product_id);
      if (num(p?.on_hand) <= 0) return refuse(`${p?.name ?? 'An item'} is finished: the records say none is left. Check the shelf; if there is some, count it first.`);
      if (await rpc<boolean>(ctx, 'needs_count_today', { p_product_id: l.product_id })) {
        return refuse(`${p?.name ?? 'An item'} has not been counted today, and it must be before it sells. Ask for today's count of it, then use propose_count.`);
      }
    }
    const v = await view(ctx, d);
    const total = lines.reduce((t, l) => t + l.line_total, 0) + num(d.fee_amount);
    const paid = methods(a.paid);
    const paidTotal = paid.reduce((t, p) => t + p.amount, 0);
    const comingBack: string[] = [];
    for (const l of lines) {
      const s = (await shapesOf(ctx, l.product_id)).find((x) => x.product_unit_id === l.sale_unit_id);
      if (s?.is_returnable) comingBack.push(s.unit_plural.toLowerCase());
    }
    const who = d.store_customer_id ? (d.label ?? (await customerName(ctx, d.store_customer_id))) : null;
    const gate = paymentGate({ who, total, paid, paidTotal, comingBack, restOnAccount: decidedOnAccount(ctx, a) });
    if (gate) return refuse(gate.includes('Who is it for') ? `${gate} Then order_customer.` : gate);
    return hold(ctx, 'order_sell', { draft_id: d.id, payments: paid, total }, [
      `*Sell order ${d.code}${d.store_customer_id ? ` to ${v.for}` : ''}?*`,
      ...v.items.map((i) => `• ${i.qty} ${i.item} — ${i.total}`),
      `*Total ${money(total)}*`,
      paid.length > 0 ? `Paid: ${paid.map((p) => `${money(p.amount)} ${p.method}`).join(', ')}` : 'Nothing paid yet',
      ...(d.store_customer_id && paidTotal < total - 0.005 ? [`${money(total - paidTotal)} goes on their account`] : []),
    ].join('\n'));
  }

  return refuse(`No order tool called ${name}`);
}

/** The YES on a working order: settled exactly as the till settles one. */
export async function sellOrder(ctx: Ctx, a: Args): Promise<string> {
  const sale = await rpc<string>(ctx, 'settle_draft_with_deposit', {
    p_draft_id: a.draft_id, p_payments: a.payments ?? [], p_client_uuid: randomUUID(), p_deposit: null, p_deposit_reason: null,
  });
  await remember(ctx, null);
  return sale;
}

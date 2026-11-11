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
    name: 'order_add_list',
    description:
      'Put a WHOLE LIST on the working order in one call — a typed order, a photo of one, a forwarded list. ' +
      'When the list is in their message (typed or forwarded), set from_message true and do NOT copy the lines: the shop reads them from the message itself. Only for a photo or file, pass every line in lines. Never one call per line. ' +
      'The shop matches each line itself (its taught words first, then the item search), places what is plain, and holds what is not (a name that fits several items or none, no quantity, a shape the item is not sold in) under to_confirm. ' +
      'Answer from what it returns, then ask about the held lines one at a time.',
    parameters: {
      type: 'object',
      properties: {
        customer: {
          type: 'string',
          description: 'Who the list is for, as they wrote it ("Valuemart"). Found here — no find_customer or order_start needed. A different customer from the working order opens a new order for them.',
        },
        customer_id: { type: 'string', description: 'Instead of customer, when you already have the id.' },
        from_message: { type: 'boolean', description: 'True when the list is the text of their message: the lines are read from it here.' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              written: { type: 'string', description: 'The line exactly as written, e.g. "Goldberg 2" or "Malta Guiness can 1"' },
              name: { type: 'string', description: 'The item name in it, as written (misspelling and all)' },
              qty: { type: 'number', description: 'How many, when the line says' },
              unit: { type: 'string', description: 'crate, pack, bottle, can… only when the line says it' },
            },
            required: ['written'],
          },
        },
      },
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
      /*
       * AN EMPTY ORDER ALREADY OPEN IS REUSED, not joined by another (11 Nov). "Prepare Arewa order",
       * sent twice because the first got no answer, opened two orders; neither had anything on it,
       * and both sat on the till. An open order with nothing on it, for the same customer or for
       * nobody yet, is this order.
       */
      const current = await working(ctx);
      const reusable =
        current &&
        (await linesOf(ctx, current.id)).length === 0 &&
        (current.store_customer_id === null || current.store_customer_id === ((a.customer_id as string) ?? null));
      if (reusable && current) {
        if (a.customer_id && current.store_customer_id !== a.customer_id) {
          await save(ctx, current, [], String(a.customer_id), who);
        }
        await keepHeld(ctx, []);
      } else {
        const id = await save(ctx, null, [], (a.customer_id as string) ?? null, who);
        await remember(ctx, id);
        ctx.opened = id;
      }
    }
    const d = await working(ctx);
    return d ? view(ctx, d) : refuse('The order could not be opened.');
  }

  /*
   * A LIST FOR SOMEBODY ELSE IS A NEW ORDER (11 Nov). Two lists sent one after the other, the second
   * without an order_start, went onto the first customer's order. Saying who it is for settles it: a
   * different customer from the working order opens theirs, in the same call.
   */
  if (name === 'order_add_list' && !a.customer_id && a.customer) {
    /*
     * THE CUSTOMER BY NAME, IN THE SAME CALL (11 Nov). Each round with a model is eight to twelve
     * seconds on the free tiers, and a list cost four of them — find the customer, open the order,
     * add the lines, answer — so Valuemart's ran out of the minute. One name that fits one customer
     * is that customer; several, or none, is asked about, never guessed.
     */
    // The name only: "Market for DCC", "Valuemart's order", "Order for Arewa" are how it is written.
    const asked = String(a.customer)
      .trim()
      .replace(/^(?:prepare\s+)?(?:the\s+)?(?:market|order|list|goods)\s+(?:for|from)\s+/i, '')
      .replace(/['’]s?\s+(?:order|market|list|goods)$/i, '')
      .replace(/\s+(?:order|market|list)$/i, '')
      .trim();
    const rows = await rpc<{ id: string; display_name: string }[]>(ctx, 'list_customers', {
      p_store_id: ctx.storeId, p_query: asked, p_after_name: null, p_after_id: null, p_limit: 6, p_filter: null,
    });
    const exact = rows.filter((r) => r.display_name.trim().toLowerCase() === asked.toLowerCase());
    const one = rows.length === 1 ? rows[0] : exact.length === 1 ? exact[0] : null;
    if (!one) {
      return refuse(
        rows.length === 0
          ? `No customer called "${asked}". Ask who it is, or whether to add them as a new customer; nothing was put on an order yet.`
          : `"${asked}" could be ${rows.map((r) => r.display_name).join(', ')}. Ask which, offering the names as options; nothing was put on an order yet.`,
      );
    }
    a.customer_id = one.id;
  }
  if (name === 'order_add_list' && a.customer_id) {
    const current = await working(ctx);
    if (!current || current.store_customer_id !== String(a.customer_id)) {
      const started = await runOrder(ctx, 'order_start', { customer_id: a.customer_id });
      if ((started as { error?: string }).error) return started;
    }
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

  if (name === 'order_add_list') return addList(ctx, d, a);

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

/** A line of a list, read: the item name, how many, and a shape when it says one. */
interface ListLine {
  written: string;
  name: string;
  qty: number | null;
  unit: string | null;
}

const FRACTIONS: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75 };

/**
 * "Goldberg 2", "2 Goldberg", "Malta Guiness can 1", "Laqua - 20", "½ crate trophy": the number at
 * either end is how many, the rest is the item. Used when the model passed only what was written.
 */
export function readLine(raw: { written?: unknown; name?: unknown; qty?: unknown; unit?: unknown }): ListLine {
  // WhatsApp puts invisible joiners in front of list lines ("2. ⁠Buoda Banji"): they are not part of the name.
  const written = String(raw.written ?? '').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/^\s*(?:[-•*]|\d+[.)])\s+/, '').trim();
  const number = (t: string) => (t in FRACTIONS ? FRACTIONS[t] : t.includes('/') ? Number(t.split('/')[0]) / Number(t.split('/')[1]) : Number(t));
  let name = raw.name != null && String(raw.name).trim() !== '' ? String(raw.name).trim() : written;
  let qty = raw.qty != null && Number.isFinite(Number(raw.qty)) ? Number(raw.qty) : null;
  if (qty === null || name === written) {
    const NUM = '(\\d+(?:\\.\\d+)?|\\d+\\/\\d+|[½¼¾])';
    const tail = written.match(new RegExp(`^(.*?)[\\s:x×-]*${NUM}\\s*$`, 'i'));
    const head = written.match(new RegExp(`^${NUM}\\s*(?:x\\s*)?(.+)$`, 'i'));
    if (tail && tail[1].trim()) {
      if (qty === null) qty = number(tail[2]);
      if (name === written) name = tail[1].trim();
    } else if (head && head[2].trim()) {
      if (qty === null) qty = number(head[1]);
      if (name === written) name = head[2].trim();
    }
  }
  // A shape said FIRST is the shape ("crates of trophy", "½ crate trophy"); said last it may be the
  // item's own name ("Malta Guiness can"), so that is left to the search.
  let unit = raw.unit ? String(raw.unit) : null;
  const led = name.match(/^(crates?|packs?|cartons?|bottles?|pieces?|trays?|bags?|sachets?)\s+(?:of\s+)?(.+)$/i);
  if (led && !unit) {
    unit = led[1].replace(/s$/i, '');
    name = led[2];
  }
  return { written: written || name, name: name.replace(/[\s:-]+$/, ''), qty, unit };
}

const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/** Run `fn` over the list a few at a time: twenty-four lines at once is twenty-four searches at once. */
async function inTurn<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

type Placed = { kind: 'placed'; line: ListLine; productId: string; shape: Shape; qty: number; price: number; name: string };
type Held2 = { kind: 'held'; line: ListLine; why: string; choices?: string[] };

/**
 * A WHOLE LIST, MATCHED BY THE SHOP AND SAVED ONCE (11 Nov).
 *
 * "Valuemart's order" was twenty-four lines and got no answer at all; Arewa's twelve came back as
 * raw tool calls. The model was finding and placing each line itself — a lookup and a save per line,
 * fifty steps through a loop that stops at eight. The matching is not a judgement: the shop's taught
 * words, then the item search, then the item's own shapes and prices. So it is done here, every line
 * together, and saved in one write; the model only reads the answer and asks about what is held.
 *
 * NEVER A GUESS — the shop's rule. A line is placed only when it names exactly one item: a taught
 * word for one item, or a search with one result, or several results of which exactly one carries
 * every word written. Anything else is held with its choices, to be asked one at a time.
 */
async function addList(ctx: Ctx, d: Draft, a: Args): Promise<unknown> {
  /*
   * THE LINES FROM THE MESSAGE ITSELF (11 Nov). Copying twenty-four lines into a call is fifteen
   * hundred words for a model to write, and on the free tiers that alone ran past the minute
   * (Valuemart's list: both NVIDIA models timed out mid-copy). The message is already here, so the
   * model only says so; a photo, which only it can read, still comes as lines.
   */
  const fromText = (text: string) =>
    text
      .split(/\n/)
      .map((w) => readLine({ written: w }))
      // The heading ("Valuemart's order", "Prepare Arewa order") is not a line to sell.
      .filter((l) => l.name !== '' && !(l.qty === null && /\b(order|market|list)\b/i.test(l.name)));
  const raw = Array.isArray(a.lines) ? (a.lines as Record<string, unknown>[]) : [];
  const lines = a.from_message && ctx.said?.now
    ? fromText(ctx.said.now)
    : typeof a.text === 'string'
      ? fromText(a.text)
      : raw.map(readLine).filter((l) => l.name !== '');
  if (lines.length === 0) {
    return refuse('No lines were found. Set from_message true for a list in their message, or pass every line in lines.');
  }

  const resolved = await inTurn(lines, 6, async (line): Promise<Placed | Held2> => {
    const [found, meant] = await Promise.all([
      rpc<{ id: string; name: string }[]>(ctx, 'search_products', { p_store_id: ctx.storeId, p_query: line.name, p_limit: 6, p_offset: 0 }),
      rpc<{ product_id: string; name: string }[]>(ctx, 'product_name_meanings', { p_store_id: ctx.storeId, p_phrase: line.name }),
    ]);
    let id: string | null = null;
    let choices: string[] = [];
    if (meant.length === 1) id = meant[0].product_id;
    else if (meant.length > 1) choices = meant.map((m) => m.product_id);
    else if (found.length === 1) id = String(found[0].id);
    else if (found.length > 1) {
      const asked = words(line.name);
      const full = found.filter((f) => asked.every((w) => words(f.name).includes(w)));
      if (full.length === 1) id = String(full[0].id);
      else choices = found.map((f) => String(f.id));
    }
    if (!id) {
      return choices.length > 0
        ? { kind: 'held', line, why: 'which item', choices: choices.slice(0, 6) }
        : { kind: 'held', line, why: 'no item by that name: ask what it is, then teach it with name_means' };
    }
    const p = await product(ctx, id);
    if (!p) return { kind: 'held', line, why: 'no item by that name' };
    if (line.qty === null || !(line.qty > 0)) return { kind: 'held', line, why: 'how many', choices: [id] };
    const shapes = await shapesOf(ctx, id);
    const shape = pick(shapes, line.unit, (s) => s.is_sold !== false);
    if (!shape) return { kind: 'held', line, why: `which shape: ${p.name} is not sold in "${line.unit}"`, choices: [id] };
    const wrong = sameSize(p.name, shapes, shape) ?? qtyAllowed(p.name, line.qty, shape);
    if (wrong) return { kind: 'held', line, why: wrong, choices: [id] };
    const r = await rpc<{ suggested?: string | number | null } | null>(ctx, 'resolve_price', {
      p_product_id: id, p_qty: line.qty, p_sale_unit_id: shape.product_unit_id, p_customer_id: d.store_customer_id,
    });
    const price = r?.suggested != null ? num(r.suggested) : shape.price_per_unit != null ? num(shape.price_per_unit) : null;
    if (price === null) return { kind: 'held', line, why: `no price: what is the price per ${shape.unit_name.toLowerCase()}?`, choices: [id] };
    return { kind: 'placed', line, productId: id, shape, qty: line.qty, price, name: p.name };
  });

  // Onto what is already on the order: the same item in the same shape is the same line, and a list
  // that names an item twice means both together.
  const current = await linesOf(ctx, d.id);
  const touched = new Set<string>();
  for (const r of resolved) {
    if (r.kind !== 'placed') continue;
    const key = `${r.productId}:${r.shape.product_unit_id}`;
    const at = current.findIndex((l) => l.product_id === r.productId && l.sale_unit_id === r.shape.product_unit_id);
    const qty = at >= 0 && touched.has(key) ? current[at].entered_qty + r.qty : r.qty;
    const line: Line = {
      product_id: r.productId, entered_qty: qty, sale_unit_id: r.shape.product_unit_id, unit_price: r.price,
      line_total: Math.round(qty * r.price * 100) / 100, containers_out: r.shape.is_returnable ? qty : 0,
      deposit_charged: at >= 0 ? current[at].deposit_charged : 0,
    };
    if (at >= 0) current[at] = line;
    else current.push(line);
    touched.add(key);
  }
  if (touched.size > 0) await save(ctx, d, current, d.store_customer_id, d.label);

  const held = (await heldLines(ctx)).filter((h) => !resolved.some((r) => sameLine(h.written, r.line.written)));
  for (const r of resolved) {
    if (r.kind === 'held') held.push({ written: r.line.written, qty: r.line.qty, unit: r.line.unit, why: r.why, choices: r.choices });
  }
  await keepHeld(ctx, held);

  const placed = resolved.filter((r): r is Placed => r.kind === 'placed');
  return {
    list: {
      lines: lines.length,
      placed: placed.length,
      held: resolved.length - placed.length,
      placed_lines: placed.map((r) => `${r.line.written} → ${say(r.qty, r.shape)} ${r.name}`),
    },
    ...(await view(ctx, (await working(ctx)) ?? d)),
  };
}

/**
 * AN ORDER OPENED THIS TURN AND LEFT EMPTY IS CLOSED (11 Nov). Arewa's and DCC's orders were opened,
 * nothing reached them, and they sat on the till as empty tabs. Anything held for it stays a question
 * only while there is an order to ask it about.
 */
export async function closeIfEmpty(ctx: Ctx): Promise<boolean> {
  if (!ctx.opened) return false;
  const d = await working(ctx);
  if (!d || d.id !== ctx.opened) return false;
  if ((await linesOf(ctx, d.id)).length > 0 || (await heldLines(ctx)).length > 0) return false;
  await ctx.db.rpc('cancel_draft_order', { p_draft_id: d.id });
  await remember(ctx, null);
  return true;
}

/** The working order in a few words, for a reply that has to be written without the model. */
export async function workingSummary(ctx: Ctx): Promise<string | null> {
  const d = await working(ctx);
  if (!d) return null;
  const lines = await linesOf(ctx, d.id);
  const held = await heldLines(ctx);
  if (lines.length === 0 && held.length === 0) return null;
  const total = lines.reduce((t, l) => t + l.line_total, 0) + num(d.fee_amount);
  return `Order ${d.code}${d.label ? ` for ${d.label}` : ''}: ${lines.length} item${lines.length === 1 ? '' : 's'} on it, ${money(total)}` +
    (held.length > 0 ? `, ${held.length} line${held.length === 1 ? '' : 's'} still to check` : '') + '.';
}

/** The YES on a working order: settled exactly as the till settles one. */
export async function sellOrder(ctx: Ctx, a: Args): Promise<string> {
  const sale = await rpc<string>(ctx, 'settle_draft_with_deposit', {
    p_draft_id: a.draft_id, p_payments: a.payments ?? [], p_client_uuid: randomUUID(), p_deposit: null, p_deposit_reason: null,
  });
  await remember(ctx, null);
  return sale;
}

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney, formatQtySpoken, shapeWord } from '@/lib/format';
import type { ToolDef } from '@/lib/whatsapp/llm';
import { executeCapability } from '@/lib/agent/gateway';
import { sellOrder } from '@/lib/whatsapp/orders';
import { countReport, executeStock, proposeStock } from '@/lib/whatsapp/stock-actions';

/**
 * THE ASSISTANT PROPOSES; THE PERSON'S "YES" DOES IT. Server only.
 *
 * A model decides nothing here. Each `propose_*` tool has the SERVER work the action out — which
 * item, which shape, which price, what it comes to, whether it is finished or needs counting — and
 * write it to `whatsapp_pending` with the exact summary the person will see. The route sends that
 * summary, not the model's words, and only a YES read by the route (`execute`) runs it, as the
 * member, through the functions the app itself calls. So a model that misunderstands can only ever
 * show somebody a wrong summary; and their permissions, the count gate and every other rule in the
 * database still stand.
 */
export interface Ctx {
  db: SupabaseClient; // the member, on their own session
  service: SupabaseClient; // the bot's own tables only
  storeId: string;
  userId: string;
  phone: string;
  /** Set when a tool has proposed: the turn ends and this is what is sent. */
  proposed: string | null;
  /** What was just said, both ways: lets a rule check the person decided, not the model. */
  said?: { lastOut: string; now: string; done?: string[] };
}

const lineItem = { type: 'object', properties: {
  product_id: { type: 'string', description: 'From find_items' },
  unit: { type: 'string', description: 'The shape, e.g. crate, pack, bottle. Leave out for the usual one.' },
  qty: { type: 'number' },
  price: { type: 'number', description: 'Each, in naira. Leave out to use the shop price.' },
}, required: ['product_id', 'qty'] };
const payment = { type: 'object', properties: {
  amount: { type: 'number' }, method: { type: 'string', enum: ['cash', 'transfer', 'pos'] },
}, required: ['amount', 'method'] };

const GOODS_MOVED = {
  type: 'boolean',
  description: 'Only when the shop has told you: true if the goods really went out or came back since the count, false if only the paper was wrong.',
};

export const ACTION_TOOLS: ToolDef[] = [
  {
    name: 'propose_sale',
    description:
      'Propose recording a sale. Use find_items first (and find_customer if a customer is named). A sale not fully paid needs a customer. Leave "paid" empty if nothing was paid.',
    parameters: { type: 'object', properties: {
      customer_id: { type: 'string' },
      lines: { type: 'array', items: lineItem },
      paid: { type: 'array', items: payment },
      charges: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, amount: { type: 'number' } }, required: ['label', 'amount'] } },
      rest_on_account: { type: 'boolean', description: 'Only once they have said so: true when what is not paid now goes on the customer\'s account.' },
    }, required: ['lines'] },
  },
  {
    name: 'propose_payment',
    description: 'Propose recording money a customer paid towards their account.',
    parameters: { type: 'object', properties: {
      customer_id: { type: 'string' }, amount: { type: 'number' },
      method: { type: 'string', enum: ['cash', 'transfer', 'pos'] }, reference: { type: 'string' },
    }, required: ['customer_id', 'amount', 'method'] },
  },
  {
    name: 'propose_delivery',
    description:
      'Propose recording stock that came in. Needs the supplier (find_supplier) and each item\'s quantity and cost price from the invoice; ask for whatever is missing, never guess a cost. An invoice photo can supply them.',
    parameters: { type: 'object', properties: {
      supplier: { type: 'string', description: 'Supplier name' },
      invoice: { type: 'string' },
      lines: { type: 'array', items: { type: 'object', properties: {
        product_id: { type: 'string' }, unit: { type: 'string' }, qty: { type: 'number' },
        cost: { type: 'number', description: 'Cost each, in naira, as on the invoice' },
        free_qty: { type: 'number' }, expires_on: { type: 'string', description: 'YYYY-MM-DD' },
      }, required: ['product_id', 'qty', 'cost'] } },
      fees: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, amount: { type: 'number' } }, required: ['label', 'amount'] } },
      rebate: { type: 'number' },
    }, required: ['supplier', 'lines'] },
  },
  {
    name: 'propose_charge',
    description: 'Propose adding a charge to what a customer owes (not a sale), or, with owed_to_them, recording money the shop owes them.',
    parameters: { type: 'object', properties: {
      customer_id: { type: 'string' }, amount: { type: 'number' }, reason: { type: 'string' }, owed_to_them: { type: 'boolean' },
    }, required: ['customer_id', 'amount', 'reason'] },
  },
  {
    name: 'propose_money_back',
    description: 'Propose recording money the shop gave back to a customer.',
    parameters: { type: 'object', properties: {
      customer_id: { type: 'string' }, amount: { type: 'number' },
      method: { type: 'string', enum: ['cash', 'transfer', 'pos'] }, reason: { type: 'string' },
    }, required: ['customer_id', 'amount', 'method'] },
  },
  {
    name: 'propose_deposit',
    description: 'Propose taking a deposit from a customer, held for them.',
    parameters: { type: 'object', properties: {
      customer_id: { type: 'string' }, amount: { type: 'number' }, reason: { type: 'string' },
    }, required: ['customer_id', 'amount'] },
  },
  {
    name: 'propose_empties_back',
    description: 'Propose recording empties a customer brought back.',
    parameters: { type: 'object', properties: {
      customer_id: { type: 'string' }, product_id: { type: 'string' }, unit: { type: 'string' }, qty: { type: 'number' },
    }, required: ['customer_id', 'product_id', 'qty'] },
  },
  {
    name: 'propose_expense',
    description: 'Propose recording money the shop spent.',
    parameters: { type: 'object', properties: {
      amount: { type: 'number' }, note: { type: 'string', description: 'What it was for' },
      category: { type: 'string' }, method: { type: 'string', enum: ['cash', 'transfer', 'pos'] }, paid_to: { type: 'string' },
    }, required: ['amount', 'note'] },
  },
  {
    name: 'propose_count',
    description: "Propose recording a count of an item on the shelf, in its shapes, e.g. 12 crates and 3 bottles. If it was already counted today, counting again needs a reason.",
    parameters: { type: 'object', properties: {
      product_id: { type: 'string' },
      counted: { type: 'array', items: { type: 'object', properties: { unit: { type: 'string' }, qty: { type: 'number' } }, required: ['qty'] } },
      reason: { type: 'string', description: 'Only to count again today: why.' },
    }, required: ['product_id', 'counted'] },
  },
  {
    name: 'propose_new_customer',
    description: 'Propose adding a new customer. Check find_customer first.',
    parameters: { type: 'object', properties: {
      name: { type: 'string' }, phone: { type: 'string' }, business: { type: 'string' },
    }, required: ['name', 'phone'] },
  },
  {
    name: 'propose_edit_receipt',
    description:
      'Propose correcting a saved receipt (from recent_receipts). Give only what changes: the new quantity of an item (0 removes it), a new price, or a new item with its quantity. Money paid during the correction goes in paid. Needs a reason.',
    parameters: { type: 'object', properties: {
      sale_id: { type: 'string' },
      changes: { type: 'array', items: lineItem },
      paid: { type: 'array', items: payment },
      reason: { type: 'string' },
      goods_moved: GOODS_MOVED,
    }, required: ['sale_id', 'changes', 'reason'] },
  },
  {
    name: 'propose_cancel_receipt',
    description: 'Propose cancelling a receipt (from recent_receipts), with the reason. Stock goes back; money paid becomes credit.',
    parameters: { type: 'object', properties: { sale_id: { type: 'string' }, reason: { type: 'string' }, goods_moved: GOODS_MOVED }, required: ['sale_id', 'reason'] },
  },
];

export type Args = Record<string, unknown>;
export type Shape = {
  product_id: string; product_unit_id: string; unit_name: string; unit_plural: string; base_qty: string | number;
  is_default: boolean; is_returnable: boolean; is_sold?: boolean; is_bought?: boolean; is_counted?: boolean;
  price_per_unit: string | number | null;
  whole_digit?: boolean; allow_quarter?: boolean; allow_half?: boolean; allow_three_quarter?: boolean;
};

/**
 * THE QUANTITIES A SHAPE ALLOWS, as the till enforces them: whole numbers, and halves, quarters or
 * three-quarters only where the shop ticked them. "1½ crates" of something sold only in whole crates
 * is refused before anybody says yes, with what IS allowed.
 */
/**
 * A shape the same size as another of the item's is a setup fault (0270). Only the ACCIDENTAL one is
 * refused, as the server does (0271): Zetar's priceless Piece, never its Pack. When neither stands out
 * the server decides, at the sale.
 */
export function sameSize(name: string, shapes: Shape[], s: Shape): string | null {
  const twin = shapes.find((x) => x.product_unit_id !== s.product_unit_id && num(x.base_qty) === num(s.base_qty) &&
    s.price_per_unit == null && x.price_per_unit != null);
  return twin
    ? `${name}'s ${s.unit_name} is set up as the same size as its ${twin.unit_name}, so it would sell at the wrong price and take the wrong stock. It has to be fixed in the item's shapes first.`
    : null;
}

export function qtyAllowed(name: string, qty: number, s: Shape): string | null {
  const whole = Math.floor(qty);
  const part = Math.round((qty - whole) * 100) / 100;
  const ok =
    (part === 0 && s.whole_digit !== false) ||
    (part === 0.5 && s.allow_half === true) ||
    (part === 0.25 && s.allow_quarter === true) ||
    (part === 0.75 && s.allow_three_quarter === true);
  if (ok) return null;
  const allowed = [
    s.whole_digit !== false ? 'whole numbers' : null,
    s.allow_half ? 'halves' : null,
    s.allow_quarter ? 'quarters' : null,
    s.allow_three_quarter ? 'three quarters' : null,
  ].filter(Boolean);
  return `${name} is sold by the ${s.unit_name.toLowerCase()} in ${allowed.join(', ') || 'set amounts'}: ${qty} is not allowed. Ask how many.`;
}

export const money = (n: number) => formatMoney(n);
export const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const say = (qty: number, s: Shape) => `${formatQtySpoken(qty)} ${shapeWord(qty, s.unit_name, s.unit_plural).toLowerCase()}`;
export const refuse = (error: string) => ({ error });

/**
 * COUNTED SINCE THE SALE (0263): a count saw the shelf as it really was, so only the person knows
 * whether this moves stock. Null when there is nothing to ask, or the question to put to them.
 */
async function askAboutGoods(ctx: Ctx, saleId: string, lines: Args[], goodsMoved: unknown): Promise<string | null> {
  if (typeof goodsMoved === 'boolean') return null;
  const touched = await rpc<{ product_name: string }[]>(ctx, 'correction_touches_a_count', { p_sale_id: saleId, p_lines: lines });
  if (touched.length === 0) return null;
  return `${touched.map((t) => t.product_name).join(', ')} counted after this receipt. Ask them: did the goods go out or come back since that count, or was only the paper wrong? Then propose it again with goods_moved.`;
}

const goodsLine = (goodsMoved: unknown) =>
  goodsMoved === false ? ['Only the paper was wrong: the stock stays as counted'] : goodsMoved === true ? ['The goods moved: the stock changes'] : [];

export async function rpc<T>(ctx: Ctx, fn: string, params: Args): Promise<T> {
  const { data, error } = await ctx.db.rpc(fn, params);
  if (error) throw new Error(error.message);
  return data as T;
}

export async function hold(ctx: Ctx, action: string, args: Args, summary: string) {
  await ctx.service
    .from('whatsapp_pending')
    .update({ done_at: new Date().toISOString(), outcome: 'replaced' })
    .eq('wa_phone', ctx.phone)
    .is('done_at', null);
  /*
   * AND THE MESSAGE IT CAME FROM. "New customer Daddy Rotimi, wants 50 water at 1,250, paid 62,500
   * POS" is two things; the YES on the first ended the turn and the sale was never asked about. With
   * the message kept, the agent goes back to it after the YES and does what is left.
   */
  const { error } = await ctx.service.from('whatsapp_pending').insert({
    wa_phone: ctx.phone, store_id: ctx.storeId, user_id: ctx.userId, action, summary,
    args: { ...args, _asked: ctx.said?.now ?? null, _done: ctx.said?.done ?? [] },
  });
  if (error) throw new Error(error.message);
  ctx.proposed = summary;
  return { proposed: true };
}

const shapesCache = new WeakMap<Ctx, Shape[]>();
export async function shapesOf(ctx: Ctx, productId: string): Promise<Shape[]> {
  let all = shapesCache.get(ctx);
  if (!all) {
    all = await rpc<Shape[]>(ctx, 'product_selling_units', { p_store_id: ctx.storeId });
    shapesCache.set(ctx, all);
  }
  return all.filter((s) => s.product_id === productId);
}

/** The shape named, or the one the shop usually uses for this. Null when the word matches nothing. */
export function pick(shapes: Shape[], word: unknown, role: (s: Shape) => boolean): Shape | null {
  const usable = shapes.filter(role);
  const pool = usable.length > 0 ? usable : shapes;
  const w = typeof word === 'string' ? word.trim().toLowerCase().replace(/s$/, '') : '';
  if (w) {
    return pool.find((s) => s.unit_name.toLowerCase() === w || s.unit_plural.toLowerCase().replace(/s$/, '') === w) ?? null;
  }
  return pool.find((s) => s.is_default) ?? [...pool].sort((a, b) => num(b.base_qty) - num(a.base_qty))[0] ?? null;
}

export async function product(ctx: Ctx, id: string) {
  const rows = await rpc<{ id: string; name: string; on_hand: string }[]>(ctx, 'get_product', { p_product_id: id });
  return rows?.[0] ?? null;
}

export async function customerName(ctx: Ctx, id: unknown): Promise<string | null> {
  if (typeof id !== 'string' || !id) return null;
  const a = await rpc<{ customer?: { name?: string } } | null>(ctx, 'customer_account', { p_store_customer_id: id });
  return a?.customer?.name ?? null;
}

/**
 * THE TILL'S OWN GATES, before anybody is asked to say yes (TakePayment, and the server's trigger on
 * sale lines). Containers that come back need somebody to owe them; money not paid needs somebody to
 * owe it. And what is left unpaid is ASKED about, never assumed: "₦7,000 remains — on their account,
 * or is another payment coming?" A part payment that silently became a debt is the shop finding out
 * at the end of the month.
 */
/**
 * THE PERSON DECIDED, NOT THE MODEL. A model asked once whether the rest went on the account, and the
 * next time set it there itself. So "on their account" counts only when they were just asked, or say
 * it themselves in this message.
 */
export function decidedOnAccount(ctx: Ctx, a: Args): boolean {
  if (a.rest_on_account !== true) return false;
  const now = (ctx.said?.now ?? '').toLowerCase();
  const lastOut = ctx.said?.lastOut ?? '';
  return /\bremains\b/.test(lastOut) || /\b(account|owe|owing|credit|later|balance|rest)\b/.test(now);
}

export function paymentGate(g: {
  who: string | null;
  total: number;
  paid: { amount: number; method: string }[];
  paidTotal: number;
  comingBack: string[];
  restOnAccount: boolean;
}): string | null {
  const rest = g.total - g.paidTotal;
  if (!g.who && g.comingBack.length > 0) {
    return `The ${[...new Set(g.comingBack)].join(' and ')} on this sale come back empty, so it needs a customer to owe them. Who is it for?`;
  }
  if (g.paidTotal > g.total + 0.005 && !g.who) {
    return 'That is more than the sale comes to, and with no customer it cannot be held as credit. Who is it for?';
  }
  if (rest > 0.005) {
    if (!g.who) return `It comes to ${money(g.total)}${g.paidTotal > 0 ? ` and ${money(g.paidTotal)} is paid` : ''}: ${money(rest)} is not paid, so it needs a customer to owe it. Who is it for?`;
    if (!g.restOnAccount) {
      return `It comes to ${money(g.total)}${g.paid.length > 0 ? `; paid ${g.paid.map((p) => `${money(p.amount)} ${p.method}`).join(' and ')}` : '; nothing paid yet'}. ` +
        `${money(rest)} remains. Ask them: does the ${money(rest)} go on ${g.who}'s account, or is another payment coming (cash, transfer or POS)? ` +
        'Then propose again with that payment added to paid, or with rest_on_account true.';
    }
  }
  return null;
}

export function methods(list: unknown): { amount: number; method: string }[] {
  return (Array.isArray(list) ? list : [])
    .map((p) => ({ amount: num((p as Args).amount), method: String((p as Args).method ?? 'cash') }))
    .filter((p) => p.amount > 0);
}

export async function propose(ctx: Ctx, name: string, a: Args): Promise<unknown> {
  switch (name) {
    case 'propose_sale': {
      const lines = Array.isArray(a.lines) ? (a.lines as Args[]) : [];
      if (lines.length === 0) return refuse('Which items, and how many?');
      const who = await customerName(ctx, a.customer_id);
      if (a.customer_id && !who) return refuse('That customer is not in this shop. Use find_customer first.');

      const out: Args[] = [];
      const words: string[] = [];
      let goods = 0;
      const comingBack: string[] = [];
      for (const l of lines) {
        const id = String(l.product_id ?? '');
        const p = await product(ctx, id);
        if (!p) return refuse('That item was not found. Use find_items first.');
        const qty = num(l.qty);
        if (!(qty > 0)) return refuse(`How many ${p.name}?`);
        const shape = pick(await shapesOf(ctx, id), l.unit, (s) => s.is_sold !== false);
        if (!shape) return refuse(`${p.name} is not sold in "${String(l.unit)}".`);
        if (shape.is_returnable) comingBack.push(shape.unit_plural.toLowerCase());
        const wrongQty = sameSize(p.name, await shapesOf(ctx, id), shape) ?? qtyAllowed(p.name, qty, shape);
        if (wrongQty) return refuse(wrongQty);
        // The app's own rules, before anybody is asked to say yes.
        if (num(p.on_hand) <= 0) {
          return refuse(`${p.name} is finished: the records say none is left. Check the shelf; if there is some, count it first.`);
        }
        if (await rpc<boolean>(ctx, 'needs_count_today', { p_product_id: id })) {
          return refuse(`${p.name} has not been counted today, and it must be before it sells. Ask for today's count of it, then use propose_count.`);
        }
        let price = l.price != null ? num(l.price) : null;
        if (price === null) {
          const r = await rpc<{ suggested?: string | number | null } | null>(ctx, 'resolve_price', {
            p_product_id: id, p_qty: qty, p_sale_unit_id: shape.product_unit_id, p_customer_id: a.customer_id ?? null,
          });
          price = r?.suggested != null ? num(r.suggested) : shape.price_per_unit != null ? num(shape.price_per_unit) : null;
        }
        if (price === null) return refuse(`${p.name} has no price. What is the price per ${shape.unit_name.toLowerCase()}?`);
        const total = Math.round(qty * price * 100) / 100;
        goods += total;
        out.push({
          product_id: id, qty, pack_id: null, sale_unit_id: shape.product_unit_id,
          base_qty: qty * num(shape.base_qty), unit_price: price, line_total: total,
          containers_out: shape.is_returnable ? qty : 0, deposit_charged: 0,
        });
        words.push(`• ${say(qty, shape)} ${p.name} — ${money(total)}`);
      }
      const charges = (Array.isArray(a.charges) ? (a.charges as Args[]) : [])
        .map((c) => ({ label: String(c.label ?? 'Charge'), amount: num(c.amount), note: null }))
        .filter((c) => c.amount > 0);
      const extra = charges.reduce((s, c) => s + c.amount, 0);
      const total = goods + extra;
      const paid = methods(a.paid);
      const paidTotal = paid.reduce((s, p) => s + p.amount, 0);
      const gate = paymentGate({ who, total, paid, paidTotal, comingBack, restOnAccount: decidedOnAccount(ctx, a) });
      if (gate) return refuse(gate);
      const summary = [
        `*Record this sale${who ? ` to ${who}` : ''}?*`,
        ...words,
        ...charges.map((c) => `• ${c.label} — ${money(c.amount)}`),
        `*Total ${money(total)}*`,
        paid.length > 0 ? `Paid: ${paid.map((p) => `${money(p.amount)} ${p.method}`).join(', ')}` : 'Nothing paid yet',
        ...(who && paidTotal < total - 0.005 ? [`${money(total - paidTotal)} goes on their account`] : []),
      ].join('\n');
      return hold(ctx, 'sale', { customer_id: a.customer_id ?? null, label: who, lines: out, charges, payments: paid, total }, summary);
    }

    case 'propose_payment': {
      const who = await customerName(ctx, a.customer_id);
      if (!who) return refuse('Use find_customer first.');
      const amount = num(a.amount);
      if (!(amount > 0)) return refuse('How much did they pay?');
      return hold(ctx, 'payment', { customer_id: a.customer_id, amount, method: a.method, reference: a.reference ?? null },
        `*Record a payment?*\n${who} paid ${money(amount)} by ${String(a.method)}`);
    }

    case 'propose_delivery': {
      const suppliers = await rpc<{ id: string; name: string }[]>(ctx, 'store_suppliers', { p_store_id: ctx.storeId, p_include_archived: false });
      // "Random supplier" is Random: the word supplier is how people say it, not part of the name.
      const typed = String(a.supplier ?? '').trim().toLowerCase().replace(/\s+suppliers?$/, '');
      const supplier = typed
        ? suppliers.find((s) => s.name.toLowerCase() === typed) ??
          suppliers.find((s) => s.name.toLowerCase().includes(typed) || typed.includes(s.name.toLowerCase()))
        : undefined;
      if (typed && !supplier) {
        return refuse(
          `${typed ? `"${String(a.supplier)}" is not one of the shop's suppliers. ` : ''}The shop has: ${suppliers.map((s) => s.name).join(', ')}. ` +
          'Ask them which one; never pick one for them. If it is a new supplier, add it first with find_capability "add a supplier".',
        );
      }
      const lines = Array.isArray(a.lines) ? (a.lines as Args[]) : [];
      if (lines.length === 0) return refuse('Which items came in?');
      const payload: Args[] = [];
      const words: string[] = [];
      let goods = 0;
      for (const l of lines) {
        const id = String(l.product_id ?? '');
        const p = await product(ctx, id);
        if (!p) return refuse('That item was not found. Use find_items first.');
        const shape = pick(await shapesOf(ctx, id), l.unit, (s) => s.is_bought === true);
        if (!shape) return refuse(`${p.name} does not come in "${String(l.unit)}".`);
        const qty = num(l.qty);
        const cost = num(l.cost);
        if (!(qty > 0)) return refuse(`How many ${p.name} came in?`);
        if (!(cost > 0)) return refuse(`What did ${p.name} cost per ${shape.unit_name.toLowerCase()}?`);
        const free = num(l.free_qty);
        goods += qty * cost;
        payload.push({
          product_id: id, qty, free_qty: free, base_factor: num(shape.base_qty), pack_id: null, unit_cost: cost,
          expires_on: typeof l.expires_on === 'string' && l.expires_on ? l.expires_on : null,
        });
        words.push(`• ${say(qty, shape)} ${p.name}${free > 0 ? ` + ${formatQtySpoken(free)} free` : ''} at ${money(cost)} — ${money(qty * cost)}`);
      }
      const fees = (Array.isArray(a.fees) ? (a.fees as Args[]) : [])
        .map((f) => ({ label: String(f.label ?? 'Fee'), amount: num(f.amount) }))
        .filter((f) => f.amount > 0);
      const rebate = num(a.rebate);
      const total = goods + fees.reduce((s, f) => s + f.amount, 0) - rebate;
      const summary = [
        `*Record this delivery${supplier ? ` from ${supplier.name}` : ''}?*`,
        ...(a.invoice ? [`Invoice ${String(a.invoice)}`] : []),
        ...words,
        ...fees.map((f) => `• ${f.label} — ${money(f.amount)}`),
        ...(rebate > 0 ? [`• Rebate — -${money(rebate)}`] : []),
        `*Total ${money(total)}*`,
      ].join('\n');
      return hold(ctx, 'delivery', { supplier: supplier?.name ?? null, invoice: a.invoice ?? null, lines: payload, fees, rebate, count: lines.length }, summary);
    }

    case 'propose_charge': {
      const who = await customerName(ctx, a.customer_id);
      if (!who) return refuse('Use find_customer first.');
      const amount = num(a.amount);
      if (!(amount > 0) || !String(a.reason ?? '').trim()) return refuse('How much, and what is it for?');
      const owed = a.owed_to_them === true;
      return hold(ctx, 'charge', { customer_id: a.customer_id, amount, reason: String(a.reason).trim(), owed_to_them: owed },
        owed
          ? `*Record that the shop owes ${who} ${money(amount)}?*\nFor: ${String(a.reason)}`
          : `*Charge ${who} ${money(amount)}?*\nFor: ${String(a.reason)}`);
    }

    case 'propose_money_back': {
      const who = await customerName(ctx, a.customer_id);
      if (!who) return refuse('Use find_customer first.');
      const amount = num(a.amount);
      if (!(amount > 0)) return refuse('How much went back?');
      return hold(ctx, 'money_back', { customer_id: a.customer_id, amount, method: a.method, reason: a.reason ?? null },
        `*Record money given back?*\n${money(amount)} to ${who} by ${String(a.method)}`);
    }

    case 'propose_deposit': {
      const who = await customerName(ctx, a.customer_id);
      if (!who) return refuse('Use find_customer first.');
      const amount = num(a.amount);
      if (!(amount > 0)) return refuse('How much is the deposit?');
      return hold(ctx, 'deposit', { customer_id: a.customer_id, amount, reason: a.reason ?? null },
        `*Take a deposit?*\n${money(amount)} held for ${who}${a.reason ? `\nFor: ${String(a.reason)}` : ''}`);
    }

    case 'propose_empties_back': {
      const who = await customerName(ctx, a.customer_id);
      if (!who) return refuse('Use find_customer first.');
      const id = String(a.product_id ?? '');
      const p = await product(ctx, id);
      if (!p) return refuse('That item was not found. Use find_items first.');
      const shape = pick(await shapesOf(ctx, id), a.unit, (s) => s.is_returnable);
      if (!shape || !shape.is_returnable) return refuse(`${p.name} has no returnable shape.`);
      const qty = num(a.qty);
      if (!(qty > 0)) return refuse('How many came back?');
      return hold(ctx, 'empties_back', { customer_id: a.customer_id, product_unit_id: shape.product_unit_id, qty },
        `*Record empties back?*\n${who} brought back ${say(qty, shape)} of ${p.name}`);
    }

    case 'propose_expense': {
      const amount = num(a.amount);
      if (!(amount > 0) || !String(a.note ?? '').trim()) return refuse('How much, and what was it for?');
      const method = String(a.method ?? 'cash');
      return hold(ctx, 'expense', { amount, note: String(a.note).trim(), category: a.category ?? null, method, paid_to: a.paid_to ?? null },
        `*Record this expense?*\n${money(amount)} — ${String(a.note)} (${method})${a.paid_to ? `\nPaid to ${String(a.paid_to)}` : ''}`);
    }

    case 'propose_count': {
      const id = String(a.product_id ?? '');
      const p = await product(ctx, id);
      if (!p) return refuse('That item was not found. Use find_items first.');
      const shapes = await shapesOf(ctx, id);
      const counted = Array.isArray(a.counted) ? (a.counted as Args[]) : [];
      if (counted.length === 0) return refuse('How many are on the shelf?');
      let base = 0;
      const words: string[] = [];
      for (const c of counted) {
        const shape = pick(shapes, c.unit, (s) => s.is_counted !== false);
        if (!shape) return refuse(`${p.name} is not counted in "${String(c.unit)}".`);
        const qty = num(c.qty);
        base += qty * num(shape.base_qty);
        words.push(say(qty, shape));
      }
      // Once a day from the till; again only with a reason, by somebody allowed to correct a count.
      const already = (await rpc<{ counted_at: string | null; counted_by_name: string | null; counted_qty: number | null }[]>(
        ctx, 'todays_counts', { p_product_ids: [id] }))?.[0];
      const again = Boolean(already?.counted_at);
      const reason = String(a.reason ?? '').trim();
      if (again && !reason) {
        return refuse(`${p.name} was already counted today${already?.counted_by_name ? ` by ${already.counted_by_name}` : ''}. To count it again, say why (an owner or manager only).`);
      }
      return hold(ctx, 'count', { product_id: id, counted: base, reason: again ? reason : null },
        `*Record ${again ? 'a fresh' : "today's"} count?*\n${p.name}: ${words.join(', ')} on the shelf${again ? `\nWhy again: ${reason}` : ''}`);
    }

    case 'propose_new_customer': {
      const name2 = String(a.name ?? '').trim();
      const phone = String(a.phone ?? '').trim();
      if (!name2 || !phone) return refuse('What is their name and phone number?');
      /*
       * A PHONE THEY GAVE, NEVER ONE MADE UP. A customer needs one, so a model filled in 00000000000
       * for Daddy Rotimi rather than ask. The number has to be in what they sent.
       */
      const digits = phone.replace(/\D/g, '');
      const sent = (ctx.said?.now ?? '').replace(/\D/g, '');
      if (digits.length < 7 || /^(\d)\1+$/.test(digits) || !sent.includes(digits.slice(-7))) {
        return refuse(`What is ${name2}'s phone number? A customer needs one, and it has to be theirs: ask for it.`);
      }
      return hold(ctx, 'new_customer', { name: name2, phone, business: a.business ?? null },
        `*Add this customer?*\n${name2} — ${phone}${a.business ? `\n${String(a.business)}` : ''}`);
    }

    case 'propose_edit_receipt': {
      const id = String(a.sale_id ?? '');
      const d = await rpc<{
        status?: string;
        total?: string | number;
        customer?: { id?: string; name?: string } | null;
        lines?: Args[];
      } | null>(ctx, 'sale_document', { p_sale_id: id });
      if (!d?.lines) return refuse('That receipt was not found. Use recent_receipts first.');
      if (d.status && d.status !== 'posted') return refuse('That receipt has been cancelled, so it cannot be corrected.');
      if (!String(a.reason ?? '').trim()) return refuse('Why is it being corrected?');
      const changes = Array.isArray(a.changes) ? (a.changes as Args[]) : [];
      if (changes.length === 0) return refuse('What should change on it?');

      // The receipt's own lines, as the correction screen starts from them.
      const lines: Args[] = d.lines.map((l) => ({
        product_id: l.product_id, sale_unit_id: l.sale_unit_id, entered_qty: num(l.entered_qty), base_qty: num(l.base_qty),
        unit_price: num(l.unit_price), line_total: num(l.line_total), containers_out: num(l.containers_out),
        name: l.product_name,
      }));
      const said: string[] = [];
      for (const c of changes) {
        const pid = String(c.product_id ?? '');
        const p = await product(ctx, pid);
        if (!p) return refuse('That item was not found. Use find_items first.');
        const shapes = await shapesOf(ctx, pid);
        const shape = pick(shapes, c.unit, (s) => s.is_sold !== false);
        const at = lines.findIndex(
          (l) => l.product_id === pid && (!c.unit || !shape || l.sale_unit_id === shape.product_unit_id),
        );
        const qty = num(c.qty);
        if (at >= 0 && qty <= 0) {
          lines.splice(at, 1);
          said.push(`• ${p.name} — taken off`);
          continue;
        }
        if (qty <= 0) return refuse(`${p.name} is not on that receipt.`);
        const lineShape = at >= 0 ? shapes.find((s) => s.product_unit_id === lines[at].sale_unit_id) ?? shape : shape;
        if (!lineShape) return refuse(`${p.name} is not sold in "${String(c.unit)}".`);
        let price = c.price != null ? num(c.price) : at >= 0 ? num(lines[at].unit_price) : null;
        if (price === null) {
          const r = await rpc<{ suggested?: string | number | null } | null>(ctx, 'resolve_price', {
            p_product_id: pid, p_qty: qty, p_sale_unit_id: lineShape.product_unit_id, p_customer_id: d.customer?.id ?? null,
          });
          price = r?.suggested != null ? num(r.suggested) : lineShape.price_per_unit != null ? num(lineShape.price_per_unit) : null;
        }
        if (price === null) return refuse(`${p.name} has no price. What is the price per ${lineShape.unit_name.toLowerCase()}?`);
        const row = {
          product_id: pid, sale_unit_id: lineShape.product_unit_id, entered_qty: qty, base_qty: qty * num(lineShape.base_qty),
          unit_price: price, line_total: Math.round(qty * price * 100) / 100,
          containers_out: lineShape.is_returnable ? qty : 0, name: p.name,
        };
        if (at >= 0) lines[at] = row;
        else lines.push(row);
        said.push(`• ${say(qty, lineShape)} ${p.name} at ${money(price)} — ${money(row.line_total as number)}`);
      }
      if (lines.length === 0) return refuse('That would leave nothing on the receipt. To remove it all, cancel the receipt instead.');
      const ask = await askAboutGoods(ctx, id, lines, a.goods_moved);
      if (ask) return refuse(ask);
      const was = num(d.total);
      const extras = was - d.lines.reduce((s, l) => s + num(l.line_total), 0);
      const total = lines.reduce((s, l) => s + num(l.line_total), 0) + extras;
      const paid = methods(a.paid);
      return hold(ctx, 'edit_receipt', {
        sale_id: id, reason: String(a.reason).trim(), customer_id: d.customer?.id ?? null, payments: paid,
        goods_moved: typeof a.goods_moved === 'boolean' ? a.goods_moved : null,
        lines: lines.map(({ name: _name, ...l }) => l),
      }, [
        `*Correct receipt #${id.slice(0, 8).toUpperCase()}?*`,
        ...(d.customer?.name ? [d.customer.name] : []),
        ...said,
        `It said ${money(was)}; it will say *${money(total)}*`,
        ...(paid.length > 0 ? [`Paid now: ${paid.map((p) => `${money(p.amount)} ${p.method}`).join(', ')}`] : []),
        ...goodsLine(a.goods_moved),
        `Why: ${String(a.reason)}`,
      ].join('\n'));
    }

    case 'propose_cancel_receipt': {
      const id = String(a.sale_id ?? '');
      const d = await rpc<{ sale?: { total?: string | number }; customer?: { name?: string } | null } | null>(ctx, 'sale_detail', { p_sale_id: id });
      if (!d?.sale) return refuse('That receipt was not found. Use recent_receipts first.');
      if (!String(a.reason ?? '').trim()) return refuse('Why is it being cancelled?');
      const ask = await askAboutGoods(ctx, id, [], a.goods_moved);
      if (ask) return refuse(ask);
      return hold(ctx, 'cancel_receipt', { sale_id: id, reason: String(a.reason).trim(), goods_moved: typeof a.goods_moved === 'boolean' ? a.goods_moved : null },
        [
          `*Cancel receipt #${id.slice(0, 8).toUpperCase()}?*`,
          `${d.customer?.name ?? 'Walk-in'} — ${money(num(d.sale.total))}`,
          a.goods_moved === false ? 'Money paid becomes their credit.' : 'The stock goes back on the shelf; money paid becomes their credit.',
          ...goodsLine(a.goods_moved),
          `Why: ${String(a.reason)}`,
        ].join('\n'));
    }

    default:
      if (name === 'count_status' || name === 'propose_settle_count' || name === 'propose_empties_written_off') return proposeStock(ctx, name, a);
      return refuse(`No action called ${name}`);
  }
}

/** The YES: the action as it was shown, as the member, through the app's own functions. */
export async function execute(ctx: Ctx, action: string, a: Args): Promise<{ text: string; receipt?: string; payment?: string }> {
  const s = ctx.storeId;
  const receiptLink = async (saleId: string) => {
    const token = await rpc<string>(ctx, 'create_share_link', {
      p_store_id: s, p_kind: 'receipt', p_ref_id: saleId, p_expires_in: '30 days',
    });
    return `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/r/${token}?print=1`;
  };

  switch (action) {
    case 'sale': {
      const clientUuid = randomUUID();
      const draft = await rpc<string>(ctx, 'save_draft_order', {
        p_store_id: s, p_draft_id: null, p_customer_id: a.customer_id ?? null, p_label: a.label ?? null,
        p_fee_amount: 0, p_fee_label: null, p_charges: a.charges ?? [], p_deposits: [], p_note: null,
        p_client_uuid: clientUuid, p_lines: a.lines,
      });
      try {
        const sale = await rpc<string>(ctx, 'settle_draft_with_deposit', {
          p_draft_id: draft, p_payments: a.payments ?? [], p_client_uuid: clientUuid, p_deposit: null, p_deposit_reason: null,
        });
        return { text: `Recorded ✅ *${money(num(a.total))}*, receipt #${sale.slice(0, 8).toUpperCase()}\nTo print: ${await receiptLink(sale)}`, receipt: sale };
      } catch (e) {
        // Nothing sold: the open order does not stay on somebody's till.
        await ctx.db.rpc('cancel_draft_order', { p_draft_id: draft });
        throw e;
      }
    }
    case 'order_sell': {
      const sale = await sellOrder(ctx, a);
      return { text: `Sold ✅ *${money(num(a.total))}*, receipt #${sale.slice(0, 8).toUpperCase()}\nTo print: ${await receiptLink(sale)}`, receipt: sale };
    }
    case 'settle_count':
    case 'empties_written_off':
      return (await executeStock(ctx, action, a)) ?? { text: 'Done ✅' };
    case 'capability':
      return executeCapability({ db: ctx.db, service: ctx.service, storeId: ctx.storeId, userId: ctx.userId }, a);
    case 'payment': {
      const paid = await rpc<string>(ctx, 'record_payment', {
        p_store_id: s, p_customer_id: a.customer_id, p_amount: a.amount, p_method: a.method,
        p_reference: a.reference ?? null, p_client_uuid: randomUUID(), p_bank_account_id: null,
      });
      return { text: `Recorded ✅ ${money(num(a.amount))} received, payment #${String(paid).slice(0, 8).toUpperCase()}.`, payment: paid };
    }
    case 'delivery':
      await rpc(ctx, 'record_purchase', {
        p_store_id: s, p_lines: a.lines, p_supplier: a.supplier, p_invoice_ref: a.invoice ?? null,
        p_delivery: 0, p_distribution: 0, p_charges: a.fees ?? [], p_rebate: a.rebate ?? 0, p_client_uuid: randomUUID(),
      });
      return { text: `Recorded ✅ The stock is in, and each item's cost now includes the fees.` };
    case 'charge':
      await rpc(ctx, 'record_customer_charge', {
        p_store_id: s, p_customer_id: a.customer_id, p_amount: a.amount, p_reason: a.reason, p_owed_to_them: a.owed_to_them === true,
      });
      return { text: 'Recorded ✅' };
    case 'money_back': {
      const back = await rpc<string>(ctx, 'record_money_back', {
        p_store_id: s, p_customer_id: a.customer_id, p_amount: a.amount, p_method: a.method,
        p_reason: a.reason ?? null, p_client_uuid: randomUUID(), p_bank_account_id: null,
      });
      return { text: 'Recorded ✅', payment: back };
    }
    case 'deposit':
      await rpc(ctx, 'take_customer_deposit', {
        p_store_id: s, p_customer_id: a.customer_id, p_amount: a.amount, p_reason: a.reason ?? null,
      });
      return { text: 'Recorded ✅ The deposit is held for them.' };
    case 'empties_back':
      await rpc(ctx, 'record_customer_empties', {
        p_store_id: s, p_customer_id: a.customer_id, p_product_unit_id: a.product_unit_id, p_direction: 'returned',
        p_qty: a.qty, p_reason: null, p_side: 'they_hold', p_ref_table: null,
      });
      return { text: 'Recorded ✅' };
    case 'expense':
      await rpc(ctx, 'record_expense', {
        p_store_id: s, p_amount: a.amount, p_note: a.note, p_category: a.category ?? null, p_method: a.method ?? 'cash',
        // No date: the server's now. An explicit null reached the column and was refused.
        p_paid_to: a.paid_to ?? null, p_member_user_id: null,
      });
      return { text: 'Recorded ✅' };
    case 'count': {
      if (a.reason) {
        const period = await rpc<string>(ctx, 'ensure_open_period', { p_product_id: a.product_id });
        await rpc(ctx, 'enter_stock_count', { p_period_id: period, p_counted: a.counted, p_reason: a.reason });
      } else {
        await rpc(ctx, 'count_from_till', { p_product_id: a.product_id, p_counted: a.counted });
      }
      // What the count found, said at once: the shop is standing at the shelf now.
      const r = await countReport(ctx, String(a.product_id));
      return {
        text: [
          `Counted ✅ Records expected ${r.records_expected ?? '?'}; on the shelf ${r.on_the_shelf ?? '?'}.`,
          r.needs_settling ? `That is ${r.difference}. Tell me what happened to them and I will settle it.` : 'Nothing is missing.',
        ].join('\n'),
      };
    }
    case 'new_customer':
      await rpc(ctx, 'upsert_customer', {
        p_store_id: s, p_phone: a.phone, p_display_name: a.name, p_business_name: a.business ?? null,
      });
      return { text: 'Added ✅' };
    case 'edit_receipt':
      await rpc(ctx, 'correct_sale', {
        p_take_back: null, p_cancel_deposit: false, p_sale_id: a.sale_id, p_reason: a.reason, p_lines: a.lines,
        p_customer_id: null, p_charges: null,
        p_payments: Array.isArray(a.payments) && a.payments.length > 0 ? a.payments : null,
        p_deposit: null, p_deposit_reason: null, p_goods_moved: a.goods_moved ?? null,
      });
      return { text: `Corrected ✅\nTo print: ${await receiptLink(String(a.sale_id))}`, receipt: String(a.sale_id) };
    case 'cancel_receipt':
      await rpc(ctx, 'void_sale', { p_sale_id: a.sale_id, p_reason: a.reason, p_goods_moved: a.goods_moved ?? null });
      return { text: a.goods_moved === false ? 'Cancelled ✅' : 'Cancelled ✅ The stock is back on the shelf.' };
    default:
      throw new Error(`Unknown action ${action}`);
  }
}

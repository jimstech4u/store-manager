import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney, formatQtySpoken, shapeWord } from '@/lib/format';
import type { ToolDef } from '@/lib/whatsapp/llm';

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
    description: "Propose recording today's count of an item on the shelf, in its shapes, e.g. 12 crates and 3 bottles.",
    parameters: { type: 'object', properties: {
      product_id: { type: 'string' },
      counted: { type: 'array', items: { type: 'object', properties: { unit: { type: 'string' }, qty: { type: 'number' } }, required: ['qty'] } },
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
    }, required: ['sale_id', 'changes', 'reason'] },
  },
  {
    name: 'propose_cancel_receipt',
    description: 'Propose cancelling a receipt (from recent_receipts), with the reason. Stock goes back; money paid becomes credit.',
    parameters: { type: 'object', properties: { sale_id: { type: 'string' }, reason: { type: 'string' } }, required: ['sale_id', 'reason'] },
  },
];

type Args = Record<string, unknown>;
type Shape = {
  product_id: string; product_unit_id: string; unit_name: string; unit_plural: string; base_qty: string | number;
  is_default: boolean; is_returnable: boolean; is_sold?: boolean; is_bought?: boolean; is_counted?: boolean;
  price_per_unit: string | number | null;
};

const money = (n: number) => formatMoney(n);
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const say = (qty: number, s: Shape) => `${formatQtySpoken(qty)} ${shapeWord(qty, s.unit_name, s.unit_plural).toLowerCase()}`;
const refuse = (error: string) => ({ error });

async function rpc<T>(ctx: Ctx, fn: string, params: Args): Promise<T> {
  const { data, error } = await ctx.db.rpc(fn, params);
  if (error) throw new Error(error.message);
  return data as T;
}

async function hold(ctx: Ctx, action: string, args: Args, summary: string) {
  await ctx.service
    .from('whatsapp_pending')
    .update({ done_at: new Date().toISOString(), outcome: 'replaced' })
    .eq('wa_phone', ctx.phone)
    .is('done_at', null);
  const { error } = await ctx.service.from('whatsapp_pending').insert({
    wa_phone: ctx.phone, store_id: ctx.storeId, user_id: ctx.userId, action, args, summary,
  });
  if (error) throw new Error(error.message);
  ctx.proposed = summary;
  return { proposed: true };
}

const shapesCache = new WeakMap<Ctx, Shape[]>();
async function shapesOf(ctx: Ctx, productId: string): Promise<Shape[]> {
  let all = shapesCache.get(ctx);
  if (!all) {
    all = await rpc<Shape[]>(ctx, 'product_selling_units', { p_store_id: ctx.storeId });
    shapesCache.set(ctx, all);
  }
  return all.filter((s) => s.product_id === productId);
}

/** The shape named, or the one the shop usually uses for this. Null when the word matches nothing. */
function pick(shapes: Shape[], word: unknown, role: (s: Shape) => boolean): Shape | null {
  const usable = shapes.filter(role);
  const pool = usable.length > 0 ? usable : shapes;
  const w = typeof word === 'string' ? word.trim().toLowerCase().replace(/s$/, '') : '';
  if (w) {
    return pool.find((s) => s.unit_name.toLowerCase() === w || s.unit_plural.toLowerCase().replace(/s$/, '') === w) ?? null;
  }
  return pool.find((s) => s.is_default) ?? [...pool].sort((a, b) => num(b.base_qty) - num(a.base_qty))[0] ?? null;
}

async function product(ctx: Ctx, id: string) {
  const rows = await rpc<{ id: string; name: string; on_hand: string }[]>(ctx, 'get_product', { p_product_id: id });
  return rows?.[0] ?? null;
}

async function customerName(ctx: Ctx, id: unknown): Promise<string | null> {
  if (typeof id !== 'string' || !id) return null;
  const a = await rpc<{ customer?: { name?: string } } | null>(ctx, 'customer_account', { p_store_customer_id: id });
  return a?.customer?.name ?? null;
}

function methods(list: unknown): { amount: number; method: string }[] {
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
      for (const l of lines) {
        const id = String(l.product_id ?? '');
        const p = await product(ctx, id);
        if (!p) return refuse('That item was not found. Use find_items first.');
        const qty = num(l.qty);
        if (!(qty > 0)) return refuse(`How many ${p.name}?`);
        const shape = pick(await shapesOf(ctx, id), l.unit, (s) => s.is_sold !== false);
        if (!shape) return refuse(`${p.name} is not sold in "${String(l.unit)}".`);
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
      if (!who && paidTotal < total - 0.005) return refuse('A sale that is not fully paid needs a customer. Who is it for?');
      if (!who && paidTotal > total + 0.005) return refuse('That is more than the sale comes to, and with no customer it cannot be held as credit. Who is it for?');
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
      const typed = String(a.supplier ?? '').trim().toLowerCase();
      const supplier = suppliers.find((s) => s.name.toLowerCase() === typed) ?? suppliers.find((s) => s.name.toLowerCase().includes(typed));
      if (!typed || !supplier) return refuse(`Which supplier? The shop has: ${suppliers.map((s) => s.name).join(', ')}.`);
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
        `*Record this delivery from ${supplier.name}?*`,
        ...(a.invoice ? [`Invoice ${String(a.invoice)}`] : []),
        ...words,
        ...fees.map((f) => `• ${f.label} — ${money(f.amount)}`),
        ...(rebate > 0 ? [`• Rebate — -${money(rebate)}`] : []),
        `*Total ${money(total)}*`,
      ].join('\n');
      return hold(ctx, 'delivery', { supplier: supplier.name, invoice: a.invoice ?? null, lines: payload, fees, rebate, count: lines.length }, summary);
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
      return hold(ctx, 'count', { product_id: id, counted: base },
        `*Record today's count?*\n${p.name}: ${words.join(', ')} on the shelf`);
    }

    case 'propose_new_customer': {
      const name2 = String(a.name ?? '').trim();
      const phone = String(a.phone ?? '').trim();
      if (!name2 || !phone) return refuse('What is their name and phone number?');
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
      const was = num(d.total);
      const extras = was - d.lines.reduce((s, l) => s + num(l.line_total), 0);
      const total = lines.reduce((s, l) => s + num(l.line_total), 0) + extras;
      const paid = methods(a.paid);
      return hold(ctx, 'edit_receipt', {
        sale_id: id, reason: String(a.reason).trim(), customer_id: d.customer?.id ?? null, payments: paid,
        lines: lines.map(({ name: _name, ...l }) => l),
      }, [
        `*Correct receipt #${id.slice(0, 8).toUpperCase()}?*`,
        ...(d.customer?.name ? [d.customer.name] : []),
        ...said,
        `It said ${money(was)}; it will say *${money(total)}*`,
        ...(paid.length > 0 ? [`Paid now: ${paid.map((p) => `${money(p.amount)} ${p.method}`).join(', ')}`] : []),
        `Why: ${String(a.reason)}`,
      ].join('\n'));
    }

    case 'propose_cancel_receipt': {
      const id = String(a.sale_id ?? '');
      const d = await rpc<{ sale?: { total?: string | number }; customer?: { name?: string } | null } | null>(ctx, 'sale_detail', { p_sale_id: id });
      if (!d?.sale) return refuse('That receipt was not found. Use recent_receipts first.');
      if (!String(a.reason ?? '').trim()) return refuse('Why is it being cancelled?');
      return hold(ctx, 'cancel_receipt', { sale_id: id, reason: String(a.reason).trim() },
        `*Cancel receipt #${id.slice(0, 8).toUpperCase()}?*\n${d.customer?.name ?? 'Walk-in'} — ${money(num(d.sale.total))}\nThe stock goes back on the shelf; money paid becomes their credit.\nWhy: ${String(a.reason)}`);
    }

    default:
      return refuse(`No action called ${name}`);
  }
}

/** The YES: the action as it was shown, as the member, through the app's own functions. */
export async function execute(ctx: Ctx, action: string, a: Args): Promise<{ text: string; receipt?: string }> {
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
        return { text: `Recorded ✅ *${money(num(a.total))}*\nTo print: ${await receiptLink(sale)}`, receipt: sale };
      } catch (e) {
        // Nothing sold: the open order does not stay on somebody's till.
        await ctx.db.rpc('cancel_draft_order', { p_draft_id: draft });
        throw e;
      }
    }
    case 'payment':
      await rpc(ctx, 'record_payment', {
        p_store_id: s, p_customer_id: a.customer_id, p_amount: a.amount, p_method: a.method,
        p_reference: a.reference ?? null, p_client_uuid: randomUUID(), p_bank_account_id: null,
      });
      return { text: `Recorded ✅ ${money(num(a.amount))} received.` };
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
    case 'money_back':
      await rpc(ctx, 'record_money_back', {
        p_store_id: s, p_customer_id: a.customer_id, p_amount: a.amount, p_method: a.method,
        p_reason: a.reason ?? null, p_client_uuid: randomUUID(), p_bank_account_id: null,
      });
      return { text: 'Recorded ✅' };
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
    case 'count':
      await rpc(ctx, 'count_from_till', { p_product_id: a.product_id, p_counted: a.counted });
      return { text: 'Counted ✅' };
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
        p_deposit: null, p_deposit_reason: null,
      });
      return { text: `Corrected ✅\nTo print: ${await receiptLink(String(a.sale_id))}`, receipt: String(a.sale_id) };
    case 'cancel_receipt':
      await rpc(ctx, 'void_sale', { p_sale_id: a.sale_id, p_reason: a.reason });
      return { text: 'Cancelled ✅ The stock is back on the shelf.' };
    default:
      throw new Error(`Unknown action ${action}`);
  }
}

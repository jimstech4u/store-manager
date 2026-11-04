import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolDef } from '@/lib/whatsapp/llm';
import { stockInShapes, type ShapeQuantity } from '@/lib/shape-quantities';
import { ACTION_TOOLS, hold, propose, type Ctx } from '@/lib/whatsapp/actions';
import { GATEWAY_TOOLS, runCapability } from '@/lib/agent/gateway';
import { documentPdf, documentPng } from '@/lib/whatsapp/paper';
import { sendPdf, sendPicture } from '@/lib/whatsapp/meta';
import { receiptDocument, type SaleDetail } from '@/lib/receipt-document';
import { KINDS, statementDocument, type Statement } from '@/lib/statement-document';
import type { ReceiptImageInput } from '@/lib/share';

/**
 * WHAT THE ASSISTANT CAN LOOK UP — each one an RPC the app already calls, made with the MEMBER'S OWN
 * session (`clientFor`), so their role and permissions decide what comes back, as in the app. Server
 * only. Read-only in this first phase: the answer to "how much Trophy is left", "who owes me", "send
 * me Mrs Adeola's statement", "print that receipt". Anything that CHANGES a record is a `propose_*`
 * tool (actions.ts): it only writes down what would happen, and the person's YES does it.
 *
 * Answers are kept small and plain — names, figures in naira, quantities in the shop's own shapes —
 * because they go back into a model's context and then into a chat.
 */
const PERIOD = { type: 'string', enum: ['today', 'yesterday', 'this_week', 'this_month', 'last_month', 'last_30_days', 'all_time'] };

export const TOOLS: ToolDef[] = [
  {
    name: 'find_items',
    description: 'Find items the shop sells by name or group, with what is left on the shelf and the selling prices.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Part of the item name, e.g. "trophy" or "coke"' } }, required: ['query'] },
  },
  {
    name: 'low_stock',
    description: 'Items that are running low or finished.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'sales_summary',
    description: 'Sales for a period: receipts, amount billed, amount paid, still owed.',
    parameters: {
      type: 'object',
      properties: { period: { type: 'string', enum: ['today', 'yesterday', 'this_week', 'this_month', 'last_month'] } },
      required: ['period'],
    },
  },
  {
    name: 'find_customer',
    description: 'Find customers by name or phone, with what each owes (positive) or is owed (negative).',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'customer_statement',
    description:
      "A customer's account for a period: what they owed at the start, every sale/payment/charge in it, what they owe at the end, and empties still with them. Dates are YYYY-MM-DD; leave both out for all time.",
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'recent_receipts',
    description: "A customer's most recent receipts with what is still open on each.",
    parameters: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] },
  },
  {
    name: 'receipt_link',
    description:
      'A link to one receipt that opens it on the phone, with a Print button that sends it to the shop printer app. Use when asked to send, share or print a receipt.',
    parameters: { type: 'object', properties: { sale_id: { type: 'string' } }, required: ['sale_id'] },
  },
  {
    name: 'who_owes',
    description: 'Everyone who owes the shop money, largest and oldest first.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'find_supplier',
    description: 'The suppliers the shop buys from.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'send_file',
    description:
      'Send a document into this chat as a PDF or a picture, on the shop\'s own letterhead. kind: statement (needs customer_id, optional from/to), receipt (needs sale_id), combined (needs sale_ids: one customer\'s receipts put together as one paper, the same items added up, the balance once; changes nothing), sales (needs period), who_owes, stock, customers (the same filter, min, max and quiet_days as filter_customers), item_debts (needs item_id: who_owes_for_item on paper). Use whenever they ask for a PDF, a picture, a file, or to print, share or merge receipts.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['statement', 'receipt', 'combined', 'sales', 'who_owes', 'stock', 'customers', 'item_debts'] },
        filter: { type: 'string', enum: ['owes', 'we_owe', 'deposit', 'empties', 'quiet'] },
        min: { type: 'number' },
        max: { type: 'number' },
        quiet_days: { type: 'number' },
        item_id: { type: 'string' },
        sale_ids: { type: 'array', items: { type: 'string' } },
        format: { type: 'string', enum: ['pdf', 'picture'] },
        customer_id: { type: 'string' },
        sale_id: { type: 'string' },
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        period: { type: 'string', enum: ['today', 'yesterday', 'this_week', 'this_month', 'last_month'] },
      },
      required: ['kind'],
    },
  },
  {
    name: 'find_receipt',
    description: 'Find a receipt from its number, like #1AC5EB6F. Use this first whenever they quote a receipt number: it gives the sale_id the other tools need.',
    parameters: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] },
  },
  {
    name: 'who_owes_for_item',
    description:
      'Who took an item and has not finished paying: each open receipt with that item on it, what they took, and what is open. Use for "who took X and still owes". item_id comes from find_items.',
    parameters: { type: 'object', properties: { item_id: { type: 'string' } }, required: ['item_id'] },
  },
  {
    name: 'who_bought_item',
    description: 'Who bought an item in a period, biggest buyer first, with how much and when last.',
    parameters: { type: 'object', properties: { item_id: { type: 'string' }, period: PERIOD }, required: ['item_id'] },
  },
  {
    name: 'customer_items',
    description: 'What one customer buys, in a period: each item, how much and for how much. Use for "what does X usually take".',
    parameters: { type: 'object', properties: { customer_id: { type: 'string' }, period: PERIOD }, required: ['customer_id'] },
  },
  {
    name: 'filter_customers',
    description:
      'Customers by what is true of them, largest first. filter: owes (they owe us), we_owe (we owe them), deposit (holding a deposit with us), empties (holding our containers), quiet (bought before, stopped). min and max are naira, on the amount the filter is about: "balance above 100k" is owes with min 100000. quiet_days is for quiet (default 30).',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['owes', 'we_owe', 'deposit', 'empties', 'quiet'] },
        min: { type: 'number' },
        max: { type: 'number' },
        quiet_days: { type: 'number' },
      },
      required: ['filter'],
    },
  },
  {
    name: 'reminder_link',
    description:
      'A WhatsApp link that opens a chat with this customer with a polite reminder of what they owe already typed, for the shop to send. You cannot message customers yourself: give the link and say tapping it opens the message.',
    parameters: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] },
  },
  {
    name: 'best_sellers',
    description: 'What sold in a period, ranked. by: money, profit or quantity. slowest true gives the least sold first.',
    parameters: {
      type: 'object',
      properties: { period: PERIOD, by: { type: 'string', enum: ['money', 'profit', 'quantity'] }, slowest: { type: 'boolean' } },
    },
  },
  {
    name: 'money_report',
    description: 'How a period went: sales, money that came in by method (cash, transfer, POS), what was spent and on what, and what was kept. Use for "how did today go" or closing the day.',
    parameters: { type: 'object', properties: { period: PERIOD } },
  },
  {
    name: 'what_to_order',
    description: 'Items that will run out soon at the rate they have been selling, soonest first, including ones already out. within_days defaults to 7.',
    parameters: { type: 'object', properties: { within_days: { type: 'number' } } },
  },
  {
    name: 'needs_attention',
    description: 'What needs looking at in the shop right now: things waiting for approval, online orders, low stock, what runs out soon, expiring stock, and old debts. Use for "what should I do today" or "anything I should know".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'suppliers_owed',
    description: 'Suppliers the shop owes money to, and how much.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'staff_report',
    description: 'What each member of staff did in a period: receipts, amount sold, corrections, deliveries, counts.',
    parameters: { type: 'object', properties: { period: PERIOD } },
  },
  {
    name: 'stock_value',
    description: 'What the stock on the shelf is worth at cost.',
    parameters: { type: 'object', properties: {} },
  },
  ...ACTION_TOOLS,
  // Everything else the shop can do, found when it is needed rather than carried in every prompt.
  ...GATEWAY_TOOLS,
];

/**
 * What the app asks of a page, asked of the tool. These read the same RPCs its reports do, and those
 * only check that somebody is a member: the app keeps profit and takings from staff by not opening
 * the page. Without this a staff member could ask the chat for what the app would not show them.
 */
const NEEDS: Record<string, string> = {
  best_sellers: 'reports.view',
  money_report: 'reports.view',
  staff_report: 'reports.view',
  stock_value: 'reports.view',
  suppliers_owed: 'stock.receive',
};

const naira = (n: unknown) => `₦${Math.round(Number(n) || 0).toLocaleString('en-NG')}`;
const LAGOS = 60 * 60_000; // Nigeria is UTC+1 all year.

function periodBounds(period: string): { from: string | null; to: string | null; label: string } {
  const now = new Date(Date.now() + LAGOS);
  const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d) - LAGOS).toISOString();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (period) {
    case 'yesterday':
      return { from: day(y, m, d - 1), to: day(y, m, d), label: 'yesterday' };
    case 'this_week': {
      const dow = (now.getUTCDay() + 6) % 7; // Monday first
      return { from: day(y, m, d - dow), to: null, label: 'this week' };
    }
    case 'this_month':
      return { from: day(y, m, 1), to: null, label: 'this month' };
    case 'last_month':
      return { from: day(y, m - 1, 1), to: day(y, m, 1), label: 'last month' };
    case 'last_30_days':
      return { from: day(y, m, d - 30), to: null, label: 'the last 30 days' };
    case 'all_time':
      return { from: null, to: null, label: 'all time' };
    default:
      return { from: day(y, m, d), to: null, label: 'today' };
  }
}

const dateBound = (s: unknown, endOfDay = false): string | null => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(`${s}T00:00:00Z`).getTime() - LAGOS + (endOfDay ? 86_400_000 : 0);
  return new Date(t).toISOString();
};

/** The shop's paper: its width, letterhead and footer. */
export async function paperOf(db: SupabaseClient, storeId: string) {
  const { data } = await db.rpc('ensure_store_settings', { p_store_id: storeId });
  const row = (Array.isArray(data) ? data[0] : data) as
    | { printer_width_mm?: string; receipt_header?: string | null; receipt_footer?: string | null }
    | null;
  return {
    width: Number(row?.printer_width_mm ?? 80) || 80,
    header: row?.receipt_header ?? null,
    footer: row?.receipt_footer ?? null,
  };
}

const plainDoc = (
  shopName: string,
  banner: string,
  meta: string[],
  lines: { name: string; detail: string; amount: string }[],
  totals: { label: string; value: string; strong?: boolean }[],
): ReceiptImageInput => ({ shopName, banner, header: null, footer: null, meta, lines, totals, note: null, transferDetails: null });

export async function runTool(
  db: SupabaseClient,
  storeId: string,
  name: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  shopName: string,
): Promise<unknown> {
  if (name.startsWith('propose_')) return propose(ctx, name, args);
  if (name === 'find_capability' || name === 'use_capability') {
    return runCapability({ db, service: ctx.service, storeId, userId: ctx.userId }, name, args, (action, a, summary) =>
      hold(ctx, action, a, summary));
  }

  if (NEEDS[name]) {
    const { data } = await db.rpc('member_permissions', { p_store_id: storeId, p_user_id: ctx.userId });
    const allowed = ((data ?? []) as { code: string; allowed: boolean }[]).some((p) => p.code === NEEDS[name] && p.allowed);
    if (!allowed) return { error: 'Your account in this shop does not include that. Ask the owner.' };
  }

  const rpc = async <T,>(fn: string, params: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(fn, params);
    if (error) throw new Error(error.message);
    return data as T;
  };

  /** A base quantity in the shop's own shapes: "3 crates 4 bottles". */
  const speaker = async () => {
    const shapes = await rpc<Record<string, unknown>[]>('product_selling_units', { p_store_id: storeId });
    return (productId: unknown, base: unknown) => {
      const q: ShapeQuantity[] = shapes
        .filter((s) => s.product_id === productId && s.is_counted !== false)
        .map((s) => ({ name: String(s.unit_name), plural: String(s.unit_plural), baseQty: Number(s.base_qty), onHandBase: Number(base) }));
      return q.length > 0 ? stockInShapes(q) : String(Number(base));
    };
  };
  const dayOf = (at: unknown) => String(at ?? '').slice(0, 10);
  const numberOf = (id: unknown) => `#${String(id).slice(0, 8).toUpperCase()}`;

  /** Every customer the filter holds, largest first: list_customers pages by name, 100 at a time. */
  const filtered = async (a: Record<string, unknown>) => {
    const filter = a.filter === 'we_owe' ? 'credit' : String(a.filter ?? 'owes');
    const rows: Record<string, unknown>[] = [];
    for (let page = 0; page < 20; page += 1) {
      const last = rows[rows.length - 1];
      const got = await rpc<Record<string, unknown>[]>('list_customers', {
        p_store_id: storeId, p_query: null, p_after_name: last?.display_name ?? null, p_after_id: last?.id ?? null, p_limit: 100,
        p_filter: filter, p_min_amount: a.min ?? null, p_max_amount: a.max ?? null, p_quiet_days: a.quiet_days ?? null,
      });
      rows.push(...got);
      if (got.length < 100) break;
    }
    const amount = (r: Record<string, unknown>) =>
      filter === 'deposit' ? Number(r.deposit_held) : filter === 'credit' ? -Number(r.balance) : Number(r.balance);
    return {
      filter,
      amount,
      rows:
        filter === 'quiet'
          ? rows.sort((x, y) => String(x.last_sale_at).localeCompare(String(y.last_sale_at)))
          : rows.sort((x, y) => amount(y) - amount(x)),
    };
  };

  /*
   * WHO OWES, AND SINCE WHEN. The balance is the customer's whole account: `debtors_aged` leaves out
   * what was carried over from the old book, which told the owner Olaoluwa owed ₦752,000 of ₦1,932,900.
   */
  const owedBy = async () => {
    const [{ rows }, aged] = await Promise.all([
      filtered({ filter: 'owes' }),
      rpc<Record<string, unknown>[]>('debtors_aged', { p_store_id: storeId }),
    ]);
    const days = new Map(aged.map((r) => [r.store_customer_id, r.days_old]));
    return rows.map((r) => ({ name: String(r.display_name), balance: Number(r.balance), days: days.get(r.id) ?? null }));
  };

  /** One line of who_owes_for_product: what they took of the item, in the words of the receipt. */
  const tookOf = (r: Record<string, unknown>) =>
    ((r.lines as { qty: number; unit: string | null }[]) ?? []).map((l) => `${Number(l.qty)} ${l.unit ?? ''}`.trim()).join(', ');

  switch (name) {
    case 'find_receipt': {
      // A receipt's number is the front of its id, so the receipts it can be are one range of ids.
      const hex = String(args.number ?? '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 8);
      if (hex.length < 6) return { error: 'A receipt number has eight letters and digits, like #1AC5EB6F.' };
      const start = hex.padEnd(8, '0');
      const end = hex.padEnd(8, 'f');
      const { data, error } = await db
        .from('sales')
        .select('id, occurred_at, total, status, store_customer_id')
        .eq('store_id', storeId)
        .gte('id', `${start}-0000-0000-0000-000000000000`)
        .lte('id', `${end}-ffff-ffff-ffff-ffffffffffff`)
        .limit(3);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) return { error: `There is no receipt ${numberOf(hex)} in this shop.` };
      return {
        receipts: data.map((r) => ({
          sale_id: r.id, number: numberOf(r.id), date: dayOf(r.occurred_at), total: naira(r.total),
          status: r.status === 'posted' ? 'standing' : 'cancelled',
        })),
      };
    }
    case 'who_owes_for_item': {
      const rows = await rpc<Record<string, unknown>[]>('who_owes_for_product', { p_store_id: storeId, p_product_id: String(args.item_id ?? '') });
      return {
        customers: new Set(rows.map((r) => r.customer_id)).size,
        open_on_these_receipts: naira(rows.reduce((t, r) => t + Number(r.open_on_receipt), 0)),
        receipts: rows.slice(0, 15).map((r) => ({
          customer: r.customer_name, customer_id: r.customer_id, sale_id: r.sale_id, number: numberOf(r.sale_id), date: dayOf(r.occurred_at),
          took: tookOf(r), worth: naira(r.line_total), receipt_total: naira(r.receipt_total),
          open_on_receipt: naira(r.open_on_receipt), owes_in_all: naira(r.balance),
        })),
        more_not_shown: Math.max(0, rows.length - 15),
        note: 'A receipt is open as a whole: a part payment does not say which item it paid for. Say so if a receipt holds more than this item.',
      };
    }
    case 'who_bought_item': {
      const b = periodBounds(String(args.period ?? 'this_month'));
      const [rows, say] = await Promise.all([
        rpc<Record<string, unknown>[]>('who_bought_product', { p_store_id: storeId, p_product_id: String(args.item_id ?? ''), p_from: b.from, p_to: b.to }),
        speaker(),
      ]);
      return {
        period: b.label,
        buyers: rows.slice(0, 15).map((r) => ({
          name: r.customer_name, took: say(args.item_id, r.sold_base), amount: naira(r.amount), receipts: r.receipts, last: dayOf(r.last_at),
        })),
        more_not_shown: Math.max(0, rows.length - 15),
      };
    }
    case 'customer_items': {
      const b = periodBounds(String(args.period ?? 'all_time'));
      const [rows, say] = await Promise.all([
        rpc<Record<string, unknown>[]>('customer_items', { p_store_customer_id: String(args.customer_id ?? ''), p_from: b.from, p_to: b.to }),
        speaker(),
      ]);
      return {
        period: b.label,
        items: rows.slice(0, 15).map((r) => ({
          name: r.product_name, took: say(r.product_id, r.sold_base), amount: naira(r.amount), receipts: r.receipts, last: dayOf(r.last_at),
        })),
        more_not_shown: Math.max(0, rows.length - 15),
      };
    }
    case 'filter_customers': {
      const { filter, amount, rows } = await filtered(args);
      return {
        count: rows.length,
        total: ['owes', 'credit', 'deposit'].includes(filter) ? naira(rows.reduce((t, r) => t + amount(r), 0)) : undefined,
        customers: rows.slice(0, 20).map((r) => ({
          id: r.id, name: r.display_name,
          owes: Number(r.balance) > 0 ? naira(r.balance) : undefined,
          we_owe_them: Number(r.balance) < 0 ? naira(-Number(r.balance)) : undefined,
          deposit: Number(r.deposit_held) > 0 ? naira(r.deposit_held) : undefined,
          last_bought: r.last_sale_at ? dayOf(r.last_sale_at) : undefined,
        })),
        more_not_shown: Math.max(0, rows.length - 20),
      };
    }
    case 'reminder_link': {
      const st = await rpc<Statement | null>('customer_statement_detail', {
        p_store_customer_id: String(args.customer_id ?? ''), p_from: null, p_to: null,
      });
      if (!st?.customer) return { error: 'That customer is not in this shop.' };
      if (!(Number(st.closing) > 0)) return { error: `${st.customer.name} owes nothing.` };
      const digits = (st.customer.phone ?? '').replace(/\D/g, '').replace(/^0/, '234');
      if (!digits) return { error: `There is no phone number for ${st.customer.name}.` };
      const words = `Hello ${st.customer.name}, this is ${shopName}. Your balance with us is ${naira(st.closing)}. Thank you for your business.`;
      return { link: `https://wa.me/${digits}?text=${encodeURIComponent(words)}`, owes: naira(st.closing), says: words };
    }
    case 'best_sellers': {
      const b = periodBounds(String(args.period ?? 'this_month'));
      const [rows, say] = await Promise.all([
        rpc<Record<string, unknown>[]>('sales_by_product', { p_store_id: storeId, p_from: b.from, p_to: b.to }),
        speaker(),
      ]);
      const key = args.by === 'profit' ? 'margin' : args.by === 'quantity' ? 'sold_base' : 'revenue';
      const sorted = [...rows].sort((x, y) => (Number(y[key]) - Number(x[key])) * (args.slowest ? -1 : 1));
      return {
        period: b.label,
        total_sold: naira(rows.reduce((t, r) => t + Number(r.revenue), 0)),
        total_profit: naira(rows.reduce((t, r) => t + Number(r.margin), 0)),
        items: sorted.slice(0, 12).map((r) => ({
          name: r.product_name, sold: say(r.product_id, r.sold_base), money: naira(r.revenue), profit: naira(r.margin), receipts: r.receipts,
        })),
      };
    }
    case 'money_report': {
      const b = periodBounds(String(args.period ?? 'today'));
      const range = { p_store_id: storeId, p_from: b.from, p_to: b.to };
      const [sales, money, methods, spent] = await Promise.all([
        rpc<Record<string, unknown>[]>('sales_summary', { ...range, p_staff: null, p_customer: null }),
        rpc<Record<string, unknown>[]>('money_summary', range),
        rpc<Record<string, unknown>[]>('takings_by_method', range),
        rpc<Record<string, unknown>[]>('expenses_by_category', range),
      ]);
      const s = sales?.[0] ?? {};
      const m = money?.[0] ?? {};
      return {
        period: b.label,
        receipts: Number(s.receipts) || 0,
        billed: naira(s.billed),
        came_in: naira(m.came_in),
        by_method: methods.map((r) => ({ method: r.method, amount: naira(r.amount) })),
        spent: naira(m.spent),
        spent_on: spent.map((r) => ({ what: r.category ?? 'Other', amount: naira(r.total) })),
        kept: naira(m.kept),
        still_owed_from_these_sales: naira(s.owing),
      };
    }
    case 'what_to_order': {
      const within = Number(args.within_days) || 7;
      const [rows, say] = await Promise.all([
        rpc<Record<string, unknown>[]>('stock_runway', { p_store_id: storeId, p_days: 14 }),
        speaker(),
      ]);
      const soon = rows.filter((r) => r.days_left != null && Number(r.days_left) <= within);
      return {
        based_on: 'what sold in the last 14 days',
        count: soon.length,
        items: soon.slice(0, 20).map((r) => ({
          name: r.name, left: say(r.product_id, r.on_hand), sold_in_14_days: say(r.product_id, r.sold_base),
          days_left: Number(r.days_left) <= 0 ? 'already out' : Number(r.days_left),
        })),
        more_not_shown: Math.max(0, soon.length - 20),
      };
    }
    case 'needs_attention': {
      const quiet = async <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
      const [waiting, online, low, runway, expiring, owed] = await Promise.all([
        quiet(rpc<Record<string, unknown> | null>('pending_review', { p_store_id: storeId })),
        quiet(rpc<number>('pending_online_orders_count', { p_store_id: storeId })),
        quiet(rpc<Record<string, unknown>[]>('low_stock_items', { p_store_id: storeId })),
        quiet(rpc<Record<string, unknown>[]>('stock_runway', { p_store_id: storeId, p_days: 14 })),
        quiet(rpc<Record<string, unknown>[]>('expiring_summary', { p_store_id: storeId, p_within_days: 30 })),
        quiet(owedBy()),
      ]);
      const out = (runway ?? []).filter((r) => Number(r.days_left) <= 0);
      const soon = (runway ?? []).filter((r) => r.days_left != null && Number(r.days_left) > 0 && Number(r.days_left) <= 3);
      const old = (owed ?? []).filter((r) => Number(r.days) > 30);
      return {
        waiting_for_approval: waiting ?? undefined,
        online_orders_waiting: online ?? undefined,
        low_stock_items: low?.length,
        selling_items_already_out: out.slice(0, 8).map((r) => r.name),
        running_out_within_3_days: soon.slice(0, 8).map((r) => ({ name: r.name, days_left: Number(r.days_left) })),
        expiring: expiring?.[0] ?? undefined,
        owed_over_30_days: { people: old.length, total: naira(old.reduce((t, r) => t + r.balance, 0)), biggest: old.slice(0, 5).map((r) => ({ name: r.name, owes: naira(r.balance), days: r.days })) },
      };
    }
    case 'suppliers_owed': {
      const rows = await rpc<Record<string, unknown>[]>('suppliers_with_accounts', { p_store_id: storeId });
      const owed = rows.filter((r) => Number(r.owed) > 0.005).sort((x, y) => Number(y.owed) - Number(x.owed));
      return { total: naira(owed.reduce((t, r) => t + Number(r.owed), 0)), suppliers: owed.map((r) => ({ name: r.name, owed: naira(r.owed), last: dayOf(r.last_at) })) };
    }
    case 'staff_report': {
      const b = periodBounds(String(args.period ?? 'today'));
      const rows = await rpc<Record<string, unknown>[]>('staff_activity', { p_store_id: storeId, p_from: b.from, p_to: b.to, p_user_id: null });
      return {
        period: b.label,
        staff: rows.map((r) => ({ name: r.who, receipts: r.receipts, sold: naira(r.sold), corrections: r.corrections, deliveries: r.deliveries, counts: r.counts })),
      };
    }
    case 'stock_value': {
      const rows = await rpc<Record<string, unknown>[]>('stock_worth', { p_store_id: storeId });
      const s = rows?.[0] ?? {};
      return { worth_at_cost: naira(s.total_value), of_which_estimated: naira(s.estimated_value), items_in_stock: s.items_in_stock };
    }
    case 'find_items': {
      const items = await rpc<Record<string, unknown>[]>('search_products', {
        p_store_id: storeId, p_query: String(args.query ?? ''), p_limit: 8, p_offset: 0,
      });
      if (items.length === 0) return { items: [], note: 'Nothing by that name.' };
      const shapes = await rpc<Record<string, unknown>[]>('product_selling_units', { p_store_id: storeId });
      return {
        items: items.map((p) => {
          const mine = shapes.filter((s) => s.product_id === p.id);
          const q: ShapeQuantity[] = mine
            .filter((s) => s.is_counted !== false)
            .map((s) => ({ name: String(s.unit_name), plural: String(s.unit_plural), baseQty: Number(s.base_qty), onHandBase: Number(s.on_hand_base ?? p.on_hand) }));
          return {
            id: p.id,
            name: p.name,
            left: q.length > 0 ? stockInShapes(q) : `${Number(p.on_hand)} ${p.base_unit}`,
            prices: mine
              .filter((s) => s.is_sold !== false && s.price_per_unit != null)
              .map((s) => `${s.unit_name} ${naira(s.price_per_unit)}`),
          };
        }),
      };
    }
    case 'low_stock': {
      const items = await rpc<Record<string, unknown>[]>('list_products', {
        p_store_id: storeId, p_after_name: null, p_after_id: null, p_limit: 40, p_filter: 'low',
      });
      return { items: items.map((p) => ({ name: p.name, on_hand_base_units: Number(p.on_hand), unit: p.base_unit })) };
    }
    case 'sales_summary': {
      const b = periodBounds(String(args.period ?? 'today'));
      const rows = await rpc<Record<string, unknown>[]>('sales_summary', {
        p_store_id: storeId, p_from: b.from, p_to: b.to, p_staff: null, p_customer: null,
      });
      const s = rows?.[0] ?? {};
      return {
        period: b.label,
        receipts: Number(s.receipts) || 0,
        billed: naira(s.billed),
        paid: naira(s.paid),
        still_owed: naira(s.owing),
        corrected: Number(s.corrected) || 0,
        cancelled: Number(s.voided) || 0,
      };
    }
    case 'find_customer': {
      const rows = await rpc<Record<string, unknown>[]>('list_customers', {
        p_store_id: storeId, p_query: String(args.query ?? ''), p_after_name: null, p_after_id: null, p_limit: 6, p_filter: null,
      });
      return {
        customers: rows.map((c) => ({
          id: c.id, name: c.display_name, phone: c.phone,
          owes: Number(c.balance) > 0 ? naira(c.balance) : null,
          we_owe_them: Number(c.balance) < 0 ? naira(-Number(c.balance)) : null,
        })),
      };
    }
    case 'customer_statement': {
      const st = await rpc<Record<string, unknown> | null>('customer_statement_detail', {
        p_store_customer_id: String(args.customer_id ?? ''),
        p_from: dateBound(args.from),
        p_to: dateBound(args.to, true),
      });
      if (!st) return { error: 'That customer is not in this shop.' };
      const events = (st.events as Record<string, unknown>[]) ?? [];
      return {
        customer: (st.customer as Record<string, unknown>)?.name,
        owed_at_start: args.from ? naira(st.opening) : undefined,
        owed_at_end: naira(st.closing),
        moves: events.slice(-25).map((e) => ({
          date: String(e.occurred_at).slice(0, 10),
          what: e.label,
          detail: e.detail ?? undefined,
          amount: e.amount != null ? naira(e.amount) : undefined,
        })),
        earlier_moves_not_shown: Math.max(0, events.length - 25),
        app_link: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/main`,
      };
    }
    case 'recent_receipts': {
      const rows = await rpc<Record<string, unknown>[]>('customer_statement', {
        p_store_customer_id: String(args.customer_id ?? ''), p_limit: 6,
      });
      return {
        receipts: rows.map((r) => ({
          sale_id: r.sale_id,
          number: `#${String(r.sale_id).slice(0, 8).toUpperCase()}`,
          date: String(r.occurred_at).slice(0, 10),
          total: naira(r.total),
          still_open: Number(r.outstanding) > 0.005 ? naira(r.outstanding) : 'paid',
        })),
      };
    }
    case 'receipt_link': {
      /*
       * A RECEIPT OF THIS SHOP, first. The share link is made for any id it is given, and a model once
       * passed a link's own token as the receipt: the printer link it sent opened nothing.
       */
      const { data: sale } = await db.from('sales').select('id').eq('store_id', storeId).eq('id', String(args.sale_id ?? '')).maybeSingle();
      if (!sale) return { error: 'That is not a receipt in this shop. Use find_receipt or recent_receipts for its id.' };
      const token = await rpc<string>('create_share_link', {
        p_store_id: storeId, p_kind: 'receipt', p_ref_id: String(args.sale_id ?? ''), p_expires_in: '30 days',
      });
      return { link: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/r/${token}?print=1` };
    }
    case 'who_owes': {
      const rows = await owedBy();
      return {
        total: naira(rows.reduce((s, r) => s + r.balance, 0)),
        people: rows.slice(0, 15).map((r) => ({ name: r.name, owes: naira(r.balance), days: r.days })),
        more_not_shown: Math.max(0, rows.length - 15),
      };
    }
    case 'find_supplier': {
      const rows = await rpc<{ name: string }[]>('store_suppliers', { p_store_id: storeId, p_include_archived: false });
      return { suppliers: rows.map((s) => s.name) };
    }
    case 'send_file': {
      const paper = await paperOf(db, storeId);
      const now = new Date(Date.now() + LAGOS).toISOString().slice(0, 16).replace('T', ' ');
      const kind = String(args.kind ?? '');
      let doc: ReceiptImageInput;
      let filename: string;
      if (kind === 'statement') {
        const from = dateBound(args.from);
        const st = await rpc<Statement | null>('customer_statement_detail', {
          p_store_customer_id: String(args.customer_id ?? ''), p_from: from, p_to: dateBound(args.to, true),
        });
        if (!st) return { error: 'That customer is not in this shop.' };
        doc = statementDocument(
          { ...st, opening: Number(st.opening) || 0, closing: Number(st.closing) || 0 },
          {
            shopName,
            periodLabel: args.from || args.to ? `${args.from ?? 'Start'} to ${args.to ?? 'today'}` : 'All time',
            hasStart: Boolean(from),
            on: new Set(KINDS.map((k) => k.kind)),
            printedAt: now,
          },
        );
        filename = `statement-${(st.customer?.name ?? 'customer').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`;
      } else if (kind === 'receipt') {
        const d = await rpc<SaleDetail | null>('sale_detail', { p_sale_id: String(args.sale_id ?? '') });
        if (!d) return { error: 'That receipt was not found.' };
        doc = receiptDocument(d, shopName, { header: paper.header, footer: paper.footer });
        filename = `receipt-${String(args.sale_id).slice(0, 8)}.pdf`;
      } else if (kind === 'combined') {
        const ids = Array.isArray(args.sale_ids) ? (args.sale_ids as string[]) : [];
        if (ids.length < 2) return { error: 'Which receipts should go together? Use recent_receipts.' };
        const d = await rpc<SaleDetail>('merged_receipts', { p_sale_ids: ids });
        doc = receiptDocument(d, shopName, { header: paper.header, footer: paper.footer });
        filename = 'receipts-together.pdf';
      } else if (kind === 'customers') {
        const { filter, amount, rows } = await filtered(args);
        const heading: Record<string, string> = {
          owes: 'WHO OWES', credit: 'WE OWE THEM', deposit: 'HOLDING A DEPOSIT', empties: 'HOLDING OUR EMPTIES', quiet: 'NOT BOUGHT LATELY',
        };
        doc = plainDoc(shopName, heading[filter] ?? 'CUSTOMERS',
          [`${rows.length} ${rows.length === 1 ? 'customer' : 'customers'}`, ...(args.min != null ? [`${naira(args.min)} or more`] : []), `Printed ${now}`],
          rows.map((r) => ({
            name: String(r.display_name),
            detail: [r.phone, r.last_sale_at ? `last bought ${dayOf(r.last_sale_at)}` : ''].filter(Boolean).join(', '),
            amount: filter === 'quiet' || filter === 'empties' ? '' : naira(amount(r)),
          })),
          filter === 'quiet' || filter === 'empties' ? [] : [{ label: 'Total', value: naira(rows.reduce((t, r) => t + amount(r), 0)), strong: true }]);
        filename = `customers-${filter}.pdf`;
      } else if (kind === 'item_debts') {
        const rows = await rpc<Record<string, unknown>[]>('who_owes_for_product', { p_store_id: storeId, p_product_id: String(args.item_id ?? '') });
        doc = plainDoc(shopName, 'STILL OWING', [`Printed ${now}`],
          rows.map((r) => ({
            name: String(r.customer_name),
            detail: `${numberOf(r.sale_id)} ${dayOf(r.occurred_at)}, took ${tookOf(r)}`,
            amount: naira(r.open_on_receipt),
          })),
          [{ label: 'Open on these receipts', value: naira(rows.reduce((t, r) => t + Number(r.open_on_receipt), 0)), strong: true }]);
        filename = 'still-owing.pdf';
      } else if (kind === 'sales') {
        const b = periodBounds(String(args.period ?? 'today'));
        const [sum, days] = await Promise.all([
          rpc<Record<string, unknown>[]>('sales_summary', { p_store_id: storeId, p_from: b.from, p_to: b.to, p_staff: null, p_customer: null }),
          rpc<Record<string, unknown>[]>('sales_by_day', { p_store_id: storeId, p_from: b.from, p_to: b.to, p_staff: null }),
        ]);
        const s = sum?.[0] ?? {};
        doc = plainDoc(shopName, 'SALES', [`Sales ${b.label}`, `Printed ${now}`],
          (days ?? []).map((d) => ({ name: String(d.day), detail: `${Number(d.receipts) || 0} receipts, paid ${naira(d.paid)}`, amount: naira(d.billed) })),
          [
            { label: 'Billed', value: naira(s.billed), strong: true },
            { label: 'Paid', value: naira(s.paid) },
            { label: 'Still owed', value: naira(s.owing) },
          ]);
        filename = `sales-${String(args.period ?? 'today')}.pdf`;
      } else if (kind === 'who_owes') {
        const rows = await owedBy();
        const total = rows.reduce((t, r) => t + r.balance, 0);
        doc = plainDoc(shopName, 'WHO OWES', [`Printed ${now}`],
          rows.map((r) => ({ name: r.name, detail: r.days != null ? `${r.days} days` : 'old book', amount: naira(r.balance) })),
          [{ label: 'Owed to you', value: naira(total), strong: true }]);
        filename = 'who-owes.pdf';
      } else if (kind === 'stock') {
        const [items, shapes] = await Promise.all([
          rpc<Record<string, unknown>[]>('list_products', { p_store_id: storeId, p_after_name: null, p_after_id: null, p_limit: 500, p_filter: null }),
          rpc<Record<string, unknown>[]>('product_selling_units', { p_store_id: storeId }),
        ]);
        doc = plainDoc(shopName, 'STOCK AND PRICES', [`${items.length} items`, `Printed ${now}`],
          items.map((p) => {
            const mine = shapes.filter((s) => s.product_id === p.id);
            const q: ShapeQuantity[] = mine
              .filter((s) => s.is_counted !== false)
              .map((s) => ({ name: String(s.unit_name), plural: String(s.unit_plural), baseQty: Number(s.base_qty), onHandBase: Number(s.on_hand_base ?? p.on_hand) }));
            const prices = mine.filter((s) => s.is_sold !== false && s.price_per_unit != null).map((s) => `${s.unit_name} ${naira(s.price_per_unit)}`);
            return { name: String(p.name), detail: [q.length > 0 ? `${stockInShapes(q)} left` : `${Number(p.on_hand)} left`, ...prices].join(', '), amount: '' };
          }),
          []);
        filename = 'stock.pdf';
      } else {
        return { error: `No document called ${kind}` };
      }
      if (args.format === 'picture') await sendPicture(ctx.phone, await documentPng(doc, paper.width));
      else await sendPdf(ctx.phone, documentPdf(doc, paper.width), filename);
      return { sent: true, note: 'It is already in the chat. Say so in one short line.' };
    }
    default:
      return { error: `No tool called ${name}` };
  }
}

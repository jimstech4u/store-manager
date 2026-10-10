import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolDef } from '@/lib/whatsapp/llm';
import { stockInShapes, type ShapeQuantity } from '@/lib/shape-quantities';

/**
 * WHAT THE ASSISTANT CAN LOOK UP — each one an RPC the app already calls, made with the MEMBER'S OWN
 * session (`clientFor`), so their role and permissions decide what comes back, as in the app. Server
 * only. Read-only in this first phase: the answer to "how much Trophy is left", "who owes me", "send
 * me Mrs Adeola's statement", "print that receipt".
 *
 * Answers are kept small and plain — names, figures in naira, quantities in the shop's own shapes —
 * because they go back into a model's context and then into a chat.
 */
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
];

const naira = (n: unknown) => `₦${Math.round(Number(n) || 0).toLocaleString('en-NG')}`;
const LAGOS = 60 * 60_000; // Nigeria is UTC+1 all year.

function periodBounds(period: string): { from: string; to: string | null; label: string } {
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
    default:
      return { from: day(y, m, d), to: null, label: 'today' };
  }
}

const dateBound = (s: unknown, endOfDay = false): string | null => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(`${s}T00:00:00Z`).getTime() - LAGOS + (endOfDay ? 86_400_000 : 0);
  return new Date(t).toISOString();
};

export async function runTool(
  db: SupabaseClient,
  storeId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const rpc = async <T,>(fn: string, params: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(fn, params);
    if (error) throw new Error(error.message);
    return data as T;
  };

  switch (name) {
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
      const token = await rpc<string>('create_share_link', {
        p_store_id: storeId, p_kind: 'receipt', p_ref_id: String(args.sale_id ?? ''), p_expires_in: '30 days',
      });
      return { link: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/r/${token}?print=1` };
    }
    case 'who_owes': {
      const rows = await rpc<Record<string, unknown>[]>('debtors_aged', { p_store_id: storeId });
      const total = rows.reduce((s, r) => s + (Number(r.balance) || 0), 0);
      return {
        total: naira(total),
        people: rows.slice(0, 15).map((r) => ({ name: r.customer_name, owes: naira(r.balance), days: r.days_old })),
        more_not_shown: Math.max(0, rows.length - 15),
      };
    }
    default:
      return { error: `No tool called ${name}` };
  }
}

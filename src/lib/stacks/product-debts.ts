'use client';

import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';
import { ACCOUNT_DERIVED_SCOPE } from '@/lib/stacks/customer-account';

/**
 * WHO TOOK THIS, AND WHO STILL OWES FOR IT (0262) — an item's own customers. A receipt says how much
 * of it is open, not which item that money was for, so a part-paid receipt is listed whole and the
 * figure beside the item is what they took of it. The balance is the customer's whole account,
 * old-book debt included, and is what the open figures are held to.
 */
export interface ItemDebt {
  saleId: string;
  occurredAt: string;
  customerId: string;
  customerName: string;
  phone: string | null;
  took: string;
  worth: number;
  receiptTotal: number;
  open: number;
  balance: number;
}

export interface ItemBuyer {
  customerId: string | null;
  customerName: string;
  soldBase: number;
  amount: number;
  receipts: number;
  lastAt: string;
}

export function useItemDebts(storeId: string | null, productId: string | null) {
  return useResource<{ name: string; debts: ItemDebt[]; buyers: ItemBuyer[] }>({
    key: `item-debts:${productId ?? 'none'}`,
    scope: ACCOUNT_DERIVED_SCOPE,
    enabled: Boolean(storeId && productId),
    deps: [storeId ?? '', productId ?? ''],
    read: async () => {
      const db = getSupabase();
      const [item, owing, took] = await Promise.all([
        db.from('products').select('name').eq('id', productId as string).maybeSingle(),
        db.rpc('who_owes_for_product', { p_store_id: storeId, p_product_id: productId }),
        db.rpc('who_bought_product', { p_store_id: storeId, p_product_id: productId }),
      ]);
      if (item.error) throw item.error;
      if (owing.error) throw owing.error;
      if (took.error) throw took.error;
      return {
        name: String(item.data?.name ?? ''),
        debts: ((owing.data ?? []) as Record<string, unknown>[]).map((r) => ({
          saleId: String(r.sale_id),
          occurredAt: String(r.occurred_at),
          customerId: String(r.customer_id),
          customerName: String(r.customer_name),
          phone: (r.phone as string | null) ?? null,
          took: ((r.lines as { qty: number; unit: string | null }[]) ?? [])
            .map((l) => `${Number(l.qty)} ${l.unit ?? ''}`.trim())
            .join(', '),
          worth: Number(r.line_total) || 0,
          receiptTotal: Number(r.receipt_total) || 0,
          open: Number(r.open_on_receipt) || 0,
          balance: Number(r.balance) || 0,
        })),
        buyers: ((took.data ?? []) as Record<string, unknown>[]).map((r) => ({
          customerId: (r.customer_id as string | null) ?? null,
          customerName: String(r.customer_name),
          soldBase: Number(r.sold_base) || 0,
          amount: Number(r.amount) || 0,
          receipts: Number(r.receipts) || 0,
          lastAt: String(r.last_at),
        })),
      };
    },
  });
}

'use client';

import { useCallback, useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { useInvalidation, invalidate } from '@/lib/stacks/invalidation';
import { getSupabase } from '@/lib/supabase/client';

/**
 * Money that left the shop and bought no stock.
 *
 * Rent, fuel, the generator, transport, a staff advance, the union levy. Every way money could go
 * out was attached to something the shop bought or somebody it owed — a delivery, a supplier
 * payment, a deposit handed back — so a shop's takings were its profit and the arithmetic was wrong
 * by exactly the cost of running the place.
 *
 * NOT A SUPPLIER PAYMENT. That settles an account with somebody who has a balance on the other end
 * of it; an expense has no other end. Filing rent against a supplier would put it in that
 * supplier's statement and in what the shop owes them, and neither is true.
 */

export const EXPENSES_SCOPE = 'expenses';

export function expensesChanged() {
  invalidate(EXPENSES_SCOPE);
}

export interface Expense {
  id: string;
  amount: number;
  method: string;
  note: string;
  paidTo: string | null;
  categoryId: string | null;
  category: string | null;
  occurredAt: string;
  actor: string | null;
  /** Set when this row takes another back. */
  reversesId: string | null;
  /** True when something else has taken THIS one back. */
  reversed: boolean;
}

export interface ExpenseCategory {
  id: string;
  name: string;
  used: number;
}

export interface CategoryTotal {
  categoryId: string | null;
  category: string;
  entries: number;
  total: number;
}

export interface MoneySummary {
  billed: number;
  cameIn: number;
  spent: number;
  /** What came in less what went out — what an owner means by "how did we do". */
  kept: number;
}

export async function listExpenses(args: {
  storeId: string;
  from?: string | null;
  to?: string | null;
  categoryId?: string | null;
}): Promise<Expense[]> {
  const { data, error } = await getSupabase().rpc('list_expenses', {
    p_store_id: args.storeId,
    p_from: args.from ?? null,
    p_to: args.to ?? null,
    p_category: args.categoryId ?? null,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    amount: Number(r.amount) || 0,
    method: String(r.method ?? 'cash'),
    note: String(r.note ?? ''),
    paidTo: (r.paid_to as string | null) ?? null,
    categoryId: (r.category_id as string | null) ?? null,
    category: (r.category as string | null) ?? null,
    occurredAt: String(r.occurred_at),
    actor: (r.actor as string | null) ?? null,
    reversesId: (r.reverses_id as string | null) ?? null,
    reversed: Boolean(r.reversed),
  }));
}

export async function expensesByCategory(args: {
  storeId: string;
  from?: string | null;
  to?: string | null;
}): Promise<CategoryTotal[]> {
  const { data, error } = await getSupabase().rpc('expenses_by_category', {
    p_store_id: args.storeId,
    p_from: args.from ?? null,
    p_to: args.to ?? null,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    categoryId: (r.category_id as string | null) ?? null,
    category: String(r.category ?? ''),
    entries: Number(r.entries) || 0,
    total: Number(r.total) || 0,
  }));
}

export async function moneySummary(args: {
  storeId: string;
  from?: string | null;
  to?: string | null;
}): Promise<MoneySummary | null> {
  const { data, error } = await getSupabase().rpc('money_summary', {
    p_store_id: args.storeId,
    p_from: args.from ?? null,
    p_to: args.to ?? null,
  });
  if (error) throw error;
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    billed: Number(r.billed) || 0,
    cameIn: Number(r.came_in) || 0,
    spent: Number(r.spent) || 0,
    kept: Number(r.kept) || 0,
  };
}

/** What the shop has called things before, commonest first, so the composer can offer them. */
export function useExpenseCategories(storeId: string | null) {
  const [cats, demand, setCats] = useDemandState<ExpenseCategory[]>([], {
    key: `expense-categories:${storeId ?? 'none'}`,
    scope: EXPENSES_SCOPE,
    persist: true,
    deps: [storeId ?? ''],
    revalidateOnMount: false,
  });

  const load = useCallback(() => {
    if (!storeId) return;
    void demand(async ({ set }) => {
      const { data, error } = await getSupabase().rpc('expense_category_list', {
        p_store_id: storeId,
      });
      if (error) throw error;
      set(
        ((data ?? []) as Record<string, unknown>[]).map((r) => ({
          id: String(r.id),
          name: String(r.name ?? ''),
          used: Number(r.used) || 0,
        })),
      );
    });
  }, [storeId, demand]);

  useEffect(() => {
    load();
  }, [load]);

  useInvalidation(storeId ? EXPENSES_SCOPE : null, load);

  return { categories: cats, reload: load, setCategories: setCats };
}

/**
 * Record one.
 *
 * `category` is a NAME, not an id — the shop names it the first time it uses it and the server
 * finds the existing one on every later use, case-insensitively. Being told off for reusing a word
 * is the worst possible answer to somebody recording last week's fuel.
 */
export async function recordExpense(args: {
  storeId: string;
  amount: number;
  note: string;
  category?: string | null;
  method?: string;
  paidTo?: string | null;
  memberUserId?: string | null;
  occurredAt?: string | null;
}): Promise<string> {
  const { data, error } = await getSupabase().rpc('record_expense', {
    p_store_id: args.storeId,
    p_amount: args.amount,
    p_note: args.note,
    p_category: args.category ?? null,
    p_method: args.method ?? 'cash',
    p_paid_to: args.paidTo ?? null,
    p_member_user_id: args.memberUserId ?? null,
    p_occurred_at: args.occurredAt ?? null,
  });
  if (error) throw error;
  expensesChanged();
  return String(data);
}

/**
 * Take one back.
 *
 * Another row, never an edit — the table refuses both. An expense keyed at ₦50,000 instead of
 * ₦5,000 is exactly the mistake somebody makes at the end of a long day, and the trail showing the
 * money out and then back is more use than a figure that quietly changed.
 */
export async function reverseExpense(expenseId: string, reason: string): Promise<void> {
  const { error } = await getSupabase().rpc('reverse_expense', {
    p_expense_id: expenseId,
    p_reason: reason,
  });
  if (error) throw error;
  expensesChanged();
}

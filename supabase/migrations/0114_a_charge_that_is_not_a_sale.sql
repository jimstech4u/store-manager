-- 0114 — A charge that is not a sale, and money the shop owes back
--
-- `customer_balance` is sales minus payments, and has been since 0004. So the only way to make a
-- customer owe something is to sell them something, and the only way to owe THEM is to take a
-- payment larger than the bill.
--
-- Both of those happen in a shop and neither is a sale:
--
--   A CHARGE. A delivery run made after the goods went, a returned cheque, a levy the shop agrees
--   to pass on. Recording it as a sale puts a fictitious line through stock and the day's takings;
--   recording it as a negative payment says money moved when none did.
--
--   AN EXCESS. The shop owes the customer — an overpayment, a load brought back and credited, a
--   goodwill adjustment. It is on the account and it is not a deposit: a deposit is the customer's
--   money the shop is minding, an excess is the shop's money the customer is owed.
--
-- One table, two directions, append-only, with the reason required. A correction is another row.

create table if not exists public.customer_charges (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores (id) on delete cascade,
  store_customer_id uuid not null references public.store_customers (id) on delete restrict,

  /*
   *   charge — they owe the shop more.
   *   excess — the shop owes them.
   *
   * Two directions rather than a signed amount, so a row can never be read backwards. Every ledger
   * in this database that used a sign has been misread at least once: `deposit_ledger.direction`
   * was tested against a value it never held for four months, and every empties figure on the
   * customer's tracking page was negative for as long as the page existed.
   */
  direction   text not null check (direction in ('charge', 'excess')),
  amount      money_amt not null check (amount > 0),

  -- Required both ways. "Why do I owe another two thousand" is the question this table exists to
  -- answer, and a charge nobody can explain is one the shop will end up writing off.
  reason      text not null check (btrim(reason) <> ''),

  occurred_at timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists customer_charges_customer_idx
  on public.customer_charges (store_customer_id, occurred_at desc);

comment on table public.customer_charges is
  'What a customer owes, or is owed, that did not come from a sale or a payment. Kept apart from '
  'both: a charge through `sales` invents a line that moves stock, and a charge through `payments` '
  'claims money changed hands.';

create trigger no_mutation before update or delete on public.customer_charges
  for each row execute function public.tg_append_only();

alter table public.customer_charges enable row level security;

create policy customer_charges_read on public.customer_charges
  for select using (public.is_store_member(store_id));

create policy customer_charges_no_insert on public.customer_charges
  for insert with check (false);

-- ─── Writing one ────────────────────────────────────────────────────────────────────

create or replace function public.record_customer_charge(
  p_store_id    uuid,
  p_customer_id uuid,
  p_amount      money_amt,
  p_reason      text,
  p_owed_to_them boolean default false,
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if not public.has_permission(p_store_id, 'payments.record') then
    raise exception 'you do not have permission to change what is owed' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.store_customers
     where id = p_customer_id and store_id = p_store_id
  ) then
    raise exception 'that customer does not belong to this shop' using errcode = '42501';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'that is not an amount' using errcode = '22023';
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'say what it is for' using errcode = '22023';
  end if;

  insert into public.customer_charges (store_id, store_customer_id, direction, amount, reason,
                                       occurred_at)
  values (p_store_id, p_customer_id,
          case when p_owed_to_them then 'excess' else 'charge' end,
          p_amount, btrim(p_reason), coalesce(p_occurred_at, now()))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.record_customer_charge(uuid, uuid, money_amt, text, boolean, timestamptz) from public;
grant execute on function public.record_customer_charge(uuid, uuid, money_amt, text, boolean, timestamptz) to authenticated;

-- ─── And the balance counts them ────────────────────────────────────────────────────

/*
 * COPIED FROM 0004 AND ADDED TO — not rewritten.
 *
 * This function is read by the account screen, the People list, the debtor report and
 * `customer_balance_total`. 0058 rewrote a working function "more tidily", changed a parameter
 * order and took the till down; the rule since is to copy the definition and add the one term.
 *
 * The two existing terms are byte-for-byte what was running.
 */
create or replace function public.customer_balance(p_store_customer_id uuid)
returns money_amt
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (
    coalesce((select sum(s.total) from public.sales s
              where s.store_customer_id = p_store_customer_id and s.status = 'posted'), 0)
    - coalesce((select sum(case when p.direction = 'in' then p.amount else -p.amount end)
                from public.payments p
                where p.store_customer_id = p_store_customer_id), 0)
    -- A charge adds to what they owe; an excess is the shop owing them, so it subtracts.
    + coalesce((select sum(case when c.direction = 'charge' then c.amount else -c.amount end)
                from public.customer_charges c
                where c.store_customer_id = p_store_customer_id), 0)
  )::money_amt
  from public.store_customers sc
  where sc.id = p_store_customer_id
    and public.is_store_member(sc.store_id);
$$;

grant execute on function public.customer_balance(uuid) to authenticated;

-- Reading them back, newest first — the trace, the same shape the other two ledgers give.
create or replace function public.customer_charge_ledger(p_store_customer_id uuid)
returns table (
  id          uuid,
  direction   text,
  amount      money_amt,
  reason      text,
  occurred_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id, c.direction, c.amount, c.reason, c.occurred_at
    from public.customer_charges c
    join public.store_customers sc on sc.id = c.store_customer_id
   where c.store_customer_id = p_store_customer_id
     and public.is_store_member(sc.store_id)
   order by c.occurred_at desc, c.created_at desc;
$$;

revoke all on function public.customer_charge_ledger(uuid) from public;
grant execute on function public.customer_charge_ledger(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('record_customer_charge', 'customer_charge_ledger', 'customer_balance')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a charge function has % overloads', n;
    end if;
  end loop;
end;
$check$;

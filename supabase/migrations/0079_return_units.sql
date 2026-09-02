-- 0079 — What a return may be made in
--
-- «goldberg has to be returned in full crate or half»
-- «customer could return heineken full crate back to get gulder and not half»
--
-- A product already declares the units it is BOUGHT in and the units it is SOLD in (0067–0069). A
-- return is a third axis and had none: `return_empties` and `settle_empties` accept any quantity,
-- so a shop that only takes back whole crates could record seven loose bottles and find out later.
--
-- THE UNITS BELONG TO THE POOL, NOT THE PRODUCT, and that is what makes the cross-product case work
-- rather than being a special case. The obligation is settled against the pool — a Star bottle pays
-- back a Gulder bottle — so "one NBL crate" is the shape a return takes whichever product put it
-- there. Hang the units off the product and the same crate would mean different things depending on
-- which beer was in it, which is exactly the confusion `empties_categories` was created to end.

create table if not exists public.empties_return_units (
  id                  uuid primary key default gen_random_uuid(),
  empties_category_id uuid not null references public.empties_categories (id) on delete cascade,
  name                text not null,
  -- In the pool's own base unit. A crate of twelve is 12; a half crate is 6.
  base_qty            qty  not null check (base_qty > 0),
  is_default          boolean not null default false,
  sort_order          int not null default 0,
  created_at          timestamptz not null default now(),
  unique (empties_category_id, name)
);

create index if not exists empties_return_units_by_category
  on public.empties_return_units (empties_category_id, sort_order);

alter table public.empties_return_units enable row level security;

drop policy if exists return_units_read on public.empties_return_units;
create policy return_units_read on public.empties_return_units
  for select using (
    exists (
      select 1 from public.empties_categories ec
      where ec.id = empties_category_id and public.is_store_member(ec.store_id)
    )
  );

drop policy if exists return_units_write on public.empties_return_units;
create policy return_units_write on public.empties_return_units
  for all using (
    exists (
      select 1 from public.empties_categories ec
      where ec.id = empties_category_id and public.is_store_member(ec.store_id)
    )
  );

-- ─── Reading and writing them ───────────────────────────────────────────────────────

create or replace function public.return_units_for(p_category_id uuid)
returns table (id uuid, name text, base_qty qty, is_default boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select ru.id, ru.name, ru.base_qty, ru.is_default
    from public.empties_return_units ru
    join public.empties_categories ec on ec.id = ru.empties_category_id
   where ru.empties_category_id = p_category_id
     and public.is_store_member(ec.store_id)
   order by ru.sort_order, ru.base_qty desc;
$fn$;

revoke all on function public.return_units_for(uuid) from public;
grant execute on function public.return_units_for(uuid) to authenticated;

create or replace function public.save_return_units(
  p_category_id uuid,
  -- [{ name, base_qty, is_default }]
  p_units       jsonb
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store uuid;
  v_row   jsonb;
  v_n     int := 0;
begin
  select store_id into v_store from public.empties_categories where id = p_category_id;
  if v_store is null then
    raise exception 'That pool does not exist.' using errcode = '22023';
  end if;

  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'You do not have permission to change how empties come back.'
      using errcode = 'insufficient_privilege';
  end if;

  /*
   * Replaced wholesale, not merged.
   *
   * This is a small, complete list the shop is looking at while it edits — "full crate, half
   * crate" — and merging would leave a unit the shop had just deleted still accepting returns.
   * Deletable because nothing REFERENCES a return unit: a settled return records a quantity in the
   * pool's base units, so removing "half crate" tomorrow does not orphan yesterday's returns.
   */
  delete from public.empties_return_units where empties_category_id = p_category_id;

  for v_row in select * from jsonb_array_elements(coalesce(p_units, '[]'::jsonb))
  loop
    if coalesce(btrim(v_row ->> 'name'), '') = '' then
      continue;
    end if;
    if coalesce((v_row ->> 'base_qty')::qty, 0) <= 0 then
      raise exception 'How many does one % hold?', v_row ->> 'name' using errcode = '22023';
    end if;

    insert into public.empties_return_units (empties_category_id, name, base_qty, is_default, sort_order)
    values (p_category_id, btrim(v_row ->> 'name'), (v_row ->> 'base_qty')::qty,
            coalesce((v_row ->> 'is_default')::boolean, false), v_n);
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$fn$;

revoke all on function public.save_return_units(uuid, jsonb) from public;
grant execute on function public.save_return_units(uuid, jsonb) to authenticated;

-- ─── The rule, enforced where returns are recorded ──────────────────────────────────
--
-- A pool with no return units declared accepts any quantity — which is the behaviour every shop has
-- today, and the right default: a shop that has not said "whole crates only" has not said anything,
-- and refusing its returns would be inventing a rule it never made.
--
-- Once units ARE declared, a return must be a whole multiple of one of them. Not a sum across them:
-- "a full crate and a half" is two returns of one unit each as far as this is concerned, and both
-- are multiples, so the sum passes. What fails is seven loose bottles into a pool that only comes
-- back in twelves and sixes.

create or replace function public.return_is_allowed(p_category_id uuid, p_qty qty)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
    when not exists (
      select 1 from public.empties_return_units where empties_category_id = p_category_id
    ) then true
    else exists (
      select 1
        from public.empties_return_units ru
       where ru.empties_category_id = p_category_id
         and p_qty >= ru.base_qty
         and (p_qty % ru.base_qty) = 0
    )
  end;
$fn$;

revoke all on function public.return_is_allowed(uuid, qty) from public;
grant execute on function public.return_is_allowed(uuid, qty) to authenticated;

-- ─── `settle_empties` asks before it records ────────────────────────────────────────
--
-- Copied from 0076 verbatim with ONE addition — the check below — per the rule this project learnt
-- from 0058: rewriting a working function "more tidily" is how the till stopped saving.

create or replace function public.settle_empties(
  p_store_id      uuid,
  p_sale_id       uuid,
  p_returned      jsonb default '[]'::jsonb,
  p_apply_amount  money_amt default 0,
  p_refund_amount money_amt default 0,
  p_refund_mode   text default 'cash',
  p_note          text default null,
  p_occurred_at   timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_customer uuid;
  v_row      jsonb;
  v_cat      uuid;
  v_qty      qty;
  v_out      qty;
  v_returned qty := 0;
  v_held     money_amt;
  v_payment  uuid;
  v_shapes   text;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to settle empties' using errcode = '42501';
  end if;

  if p_refund_mode not in ('cash', 'credit', 'none') then
    raise exception 'unknown refund mode %', p_refund_mode using errcode = '22023';
  end if;

  select store_customer_id into v_customer
    from public.sales
   where id = p_sale_id and store_id = p_store_id;

  if v_customer is null then
    raise exception 'that receipt has no customer, so it has no empties account'
      using errcode = '22023';
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_returned, '[]'::jsonb))
  loop
    v_cat := (v_row ->> 'category_id')::uuid;
    v_qty := (v_row ->> 'qty')::qty;

    if v_qty is null or v_qty <= 0 then
      continue;
    end if;

    v_out := public.empties_outstanding(v_customer, v_cat);
    if v_qty > v_out then
      raise exception 'they owe % of that pool but % were offered', v_out, v_qty
        using errcode = '22023';
    end if;

    /*
     * THE SHAPE, not just the number.
     *
     * A shop that takes crates back whole does not want seven loose bottles recorded as settled —
     * it wants to be told, at the counter, while the customer is still there. The message names the
     * shapes it does take, because "not allowed" without them is a dead end.
     */
    if not public.return_is_allowed(v_cat, v_qty) then
      select string_agg(ru.name || ' (' || ru.base_qty || ')', ', ' order by ru.base_qty desc)
        into v_shapes
        from public.empties_return_units ru
       where ru.empties_category_id = v_cat;

      raise exception 'These come back in whole units: %. % does not make one.', v_shapes, v_qty
        using errcode = '22023';
    end if;

    insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                       direction, qty_units, deposit_per_unit,
                                       ref_table, ref_id, occurred_at, note)
    values (p_store_id, v_customer, v_cat, 'collected', -v_qty, 0,
            'sales', p_sale_id, p_occurred_at, coalesce(p_note, 'empties returned'));

    v_returned := v_returned + v_qty;
  end loop;

  select coalesce(sum(amount), 0) into v_held
    from public.deposit_holdings
   where ref_table = 'sales' and ref_id = p_sale_id;

  if p_apply_amount + p_refund_amount > v_held then
    raise exception 'only % is held against that receipt, but % was accounted for',
      v_held, p_apply_amount + p_refund_amount using errcode = '22023';
  end if;

  if p_apply_amount > 0 then
    insert into public.deposit_holdings (store_id, store_customer_id, amount, reason,
                                         ref_table, ref_id, note, occurred_at)
    values (p_store_id, v_customer, -p_apply_amount, 'applied_to_shortfall',
            'sales', p_sale_id, p_note, p_occurred_at);
  end if;

  if p_refund_amount > 0 and p_refund_mode <> 'none' then
    insert into public.deposit_holdings (store_id, store_customer_id, amount, reason,
                                         ref_table, ref_id, note, occurred_at)
    values (p_store_id, v_customer, -p_refund_amount, 'refunded',
            'sales', p_sale_id, p_note, p_occurred_at);

    insert into public.payments (store_id, store_customer_id, amount, method, direction,
                                 reference, occurred_at)
    values (p_store_id, v_customer, p_refund_amount, 'other',
            case when p_refund_mode = 'credit' then 'in' else 'out' end,
            'Deposit settled on receipt', p_occurred_at)
    returning id into v_payment;
  end if;

  return jsonb_build_object(
    'returned_units', v_returned,
    'applied', p_apply_amount,
    'refunded', p_refund_amount,
    'still_held', v_held - p_apply_amount - p_refund_amount,
    'payment_id', v_payment
  );
end;
$fn$;

revoke all on function
  public.settle_empties(uuid, uuid, jsonb, money_amt, money_amt, text, text, timestamptz) from public;
grant execute on function
  public.settle_empties(uuid, uuid, jsonb, money_amt, money_amt, text, text, timestamptz) to authenticated;

-- The overload check 0058 taught us to run.
do $$
declare n int;
begin
  select count(*) into n
    from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'settle_empties';
  if n <> 1 then
    raise exception 'settle_empties has % overloads; PostgREST answers 300 to every call', n;
  end if;
end;
$$;

-- 0125 — A supplier has an account, the same way a customer does
--
-- The shop keeps a ledger for everybody it sells to: what they owe, what they paid, what they are
-- holding. It kept nothing at all for the people it buys from — and the relationship is the same
-- one seen from the other side.
--
--     a customer owes the shop for goods       the shop owes a supplier for a load
--     a customer pays                          the shop pays
--     a customer holds the shop's crates       the shop holds the SUPPLIER'S crates
--
-- Deliveries were already recorded, so what was bought is known; nothing recorded what was PAID, so
-- "what do we owe NBL" had no answer, and 0123 gave the containers half an answer — what went back,
-- with nothing to weigh it against.
--
-- Two ledgers again, for the reason that keeps proving itself: money and goods settle separately,
-- on different days, by different people.

create table if not exists public.supplier_payments (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete restrict,

  /*
   *   paid   — the shop handed money over.
   *   charge — the shop owes more, and it did not come from a delivery: a levy, a shortfall
   *            settled later, a haulage bill.
   *   credit — the supplier owes the shop: a rebate, a returned load, an overpayment.
   *
   * Three directions rather than a signed amount, for the reason every ledger here has learnt:
   * `deposit_ledger.direction` was tested against a value it never held for four months and every
   * figure that depended on it was negative for as long as the screen existed.
   */
  direction   text not null check (direction in ('paid', 'charge', 'credit')),
  amount      money_amt not null check (amount > 0),
  method      text,
  reason      text,

  -- The delivery it belongs to, when it belongs to one.
  purchase_id uuid references public.purchases (id) on delete set null,

  occurred_at timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists supplier_payments_idx
  on public.supplier_payments (supplier_id, occurred_at desc);

comment on table public.supplier_payments is
  'Money between the shop and a supplier. `paid` is money out, `charge` is something owed that no '
  'delivery carried, `credit` is the supplier owing the shop. What was BOUGHT comes from '
  '`purchases`; this is everything else.';

create trigger no_mutation before update or delete on public.supplier_payments
  for each row execute function public.tg_append_only();

alter table public.supplier_payments enable row level security;

create policy supplier_payments_read on public.supplier_payments
  for select using (public.is_store_member(store_id));

create policy supplier_payments_none on public.supplier_payments
  for insert with check (false);

-- ─── Writing one ────────────────────────────────────────────────────────────────────

create or replace function public.record_supplier_payment(
  p_store_id    uuid,
  p_supplier_id uuid,
  p_amount      money_amt,
  p_direction   text default 'paid',
  p_method      text default null,
  p_reason      text default null,
  p_purchase_id uuid default null,
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare v_id uuid;
begin
  if not public.has_permission(p_store_id, 'payments.record') then
    raise exception 'you do not have permission to record this' using errcode = '42501';
  end if;

  -- The supplier must be this shop's. The hole 0097 closed, asked again at a new door.
  if not exists (
    select 1 from public.suppliers where id = p_supplier_id and store_id = p_store_id
  ) then
    raise exception 'that supplier does not belong to this shop' using errcode = '42501';
  end if;

  if p_direction not in ('paid', 'charge', 'credit') then
    raise exception '% is not something that happens on a supplier account', p_direction
      using errcode = '22023';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'that is not an amount' using errcode = '22023';
  end if;

  -- A payment explains itself by its amount and method; anything else needs saying.
  if p_direction <> 'paid' and btrim(coalesce(p_reason, '')) = '' then
    raise exception 'say what it is for' using errcode = '22023';
  end if;

  insert into public.supplier_payments (store_id, supplier_id, direction, amount, method, reason,
                                        purchase_id, occurred_at)
  values (p_store_id, p_supplier_id, p_direction, p_amount,
          nullif(btrim(coalesce(p_method, '')), ''),
          nullif(btrim(coalesce(p_reason, '')), ''),
          p_purchase_id, coalesce(p_occurred_at, now()))
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.record_supplier_payment(uuid, uuid, money_amt, text, text, text, uuid, timestamptz) from public;
grant execute on function public.record_supplier_payment(uuid, uuid, money_amt, text, text, text, uuid, timestamptz) to authenticated;

-- ─── The account ────────────────────────────────────────────────────────────────────

/*
 * WHAT THE SHOP OWES ONE SUPPLIER.
 *
 *     what the deliveries came to
 *   + anything charged that no delivery carried
 *   - what has been paid
 *   - anything the supplier owes back
 *
 * The mirror of `customer_balance`, which is sales minus payments. Positive means the shop owes
 * them, so it reads the same way round as a customer's balance does — a shop should not have to
 * remember which screen inverts the sign.
 */
create or replace function public.supplier_balance(p_supplier_id uuid)
returns money_amt
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select (
    /*
     * WHAT THE INVOICE CAME TO, summed from the lines.
     *
     * `purchases` has no total: it carries the fees and the rebate, and the goods live on
     * `purchase_lines`. The RAW cost is used, not the landed one — landed cost spreads haulage and
     * levies across the goods so a shelf figure is honest, and none of that is money owed to the
     * SUPPLIER. The rebate is theirs to give and comes off.
     */
    coalesce((
      select sum(
               (select coalesce(sum(pl.entered_qty * pl.unit_cost_raw), 0)
                  from public.purchase_lines pl where pl.purchase_id = pu.id)
               - coalesce(pu.rebate_amount, 0)
             )
        from public.purchases pu
       where pu.supplier_id = p_supplier_id
         and coalesce(pu.status, 'posted') <> 'voided'
    ), 0)
    + coalesce((
      select sum(case when sp.direction = 'charge' then sp.amount
                      when sp.direction = 'credit' then -sp.amount
                      else -sp.amount end)
        from public.supplier_payments sp
       where sp.supplier_id = p_supplier_id
    ), 0)
  )::money_amt
  from public.suppliers s
 where s.id = p_supplier_id
   and public.is_store_member(s.store_id);
$fn$;

grant execute on function public.supplier_balance(uuid) to authenticated;

-- Everybody the shop buys from, with what is owed and what is out — the list behind the account.
create or replace function public.suppliers_with_accounts(p_store_id uuid)
returns table (
  id          uuid,
  name        text,
  phone       text,
  owed        money_amt,
  deliveries  int,
  empties_out qty,
  last_at     timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select s.id, s.name, s.phone,
         public.supplier_balance(s.id),
         (select count(*)::int from public.purchases pu where pu.supplier_id = s.id),
         coalesce((
           select sum(se.qty) from public.supplier_empties se where se.supplier_id = s.id
         ), 0)::qty,
         greatest(
           (select max(pu.occurred_at) from public.purchases pu where pu.supplier_id = s.id),
           (select max(sp.occurred_at) from public.supplier_payments sp where sp.supplier_id = s.id)
         )
    from public.suppliers s
   where s.store_id = p_store_id
     and s.status = 'active'
     and public.is_store_member(p_store_id)
   order by public.supplier_balance(s.id) desc, s.name;
$fn$;

revoke all on function public.suppliers_with_accounts(uuid) from public;
grant execute on function public.suppliers_with_accounts(uuid) to authenticated;

/*
 * EVERYTHING THAT HAS HAPPENED WITH ONE SUPPLIER, newest first.
 *
 * Deliveries and money in one timeline, because that is the order a person remembers them in — the
 * load came on Tuesday and was paid for on Friday. Two separate lists make somebody do the
 * interleaving in their head.
 */
create or replace function public.supplier_history(p_supplier_id uuid)
returns table (
  kind        text,
  label       text,
  amount      money_amt,
  detail      text,
  occurred_at timestamptz,
  ref_id      uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select 'delivery', 'Delivery',
         (
      select coalesce(sum(pl.entered_qty * pl.unit_cost_raw), 0) - coalesce(pu.rebate_amount, 0)
        from public.purchase_lines pl
       where pl.purchase_id = pu.id
    )::money_amt,
         nullif(btrim(coalesce(pu.invoice_ref, '')), ''), pu.occurred_at, pu.id
    from public.purchases pu
    join public.suppliers s on s.id = pu.supplier_id
   where pu.supplier_id = p_supplier_id
     and public.is_store_member(s.store_id)

  union all

  select sp.direction,
         case sp.direction
           when 'paid' then 'Paid them'
           when 'charge' then 'Charged to you'
           else 'They owe you'
         end,
         sp.amount,
         coalesce(sp.reason, sp.method),
         sp.occurred_at,
         sp.id
    from public.supplier_payments sp
    join public.suppliers s on s.id = sp.supplier_id
   where sp.supplier_id = p_supplier_id
     and public.is_store_member(s.store_id)

  union all

  -- Containers are on the same timeline and carry no money, which is the point: a shop reading
  -- back a month sees the crates go with the lorry beside the invoice they went against.
  select 'empties', 'Containers went back', null::money_amt,
         p.name || ' · ' || se.qty || ' ' || su.plural,
         se.occurred_at, se.id
    from public.supplier_empties se
    join public.suppliers s on s.id = se.supplier_id
    join public.products p on p.id = se.product_id
    join public.product_units pun on pun.id = se.product_unit_id
    join public.store_units su on su.id = pun.store_unit_id
   where se.supplier_id = p_supplier_id
     and public.is_store_member(s.store_id)

   order by 5 desc;
$fn$;

revoke all on function public.supplier_history(uuid) from public;
grant execute on function public.supplier_history(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('record_supplier_payment', 'supplier_balance',
                          'suppliers_with_accounts', 'supplier_history')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a supplier-account function has % overloads', n;
    end if;
  end loop;
end;
$check$;

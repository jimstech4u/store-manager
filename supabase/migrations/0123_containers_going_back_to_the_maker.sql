-- 0123 — Containers going back to the maker, recorded on the delivery
--
-- The last leg of the loop, and the one place "account for anything" did not hold.
--
-- A shop could say what customers owe it (`customer_empties`) and what it counted in its own yard
-- (`empties_counts`, 0105). It could not say what went BACK — the crates that leave on the
-- brewery's lorry when the next load arrives. So the yard figure was a count with a date rather
-- than a balance, because a balance that only ever climbs is worse than no balance.
--
-- «this is for delivery record on that shape when we are also keeping account back to breweries or
--  supplier» — which is exactly where it belongs. Empties go back when the lorry comes, on the same
-- visit, counted by the same person against the same delivery note.
--
-- IN THE PRODUCT'S OWN SHAPE, like everything else since 0108. Forty Goldberg crates went back, not
-- "forty NBL crates" and not four hundred and eighty bottles.

create table if not exists public.supplier_empties (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,

  /*
   * WHAT WENT BACK, and in what.
   *
   * The shape rather than a pool, so this reconciles against the same rows a customer's return
   * writes: crates came in from customers as `customer_empties`, and left for the brewery here, in
   * the same unit, and the difference is what is standing in the yard.
   */
  product_id      uuid not null references public.products (id) on delete restrict,
  product_unit_id uuid not null references public.product_units (id) on delete restrict,
  qty             qty  not null check (qty > 0),

  -- The delivery it went back on, when there was one. Null for a lorry that came only for empties,
  -- which happens and must not be unrecordable.
  purchase_id uuid references public.purchases (id) on delete set null,
  supplier    text,
  note        text,

  occurred_at timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists supplier_empties_store_idx
  on public.supplier_empties (store_id, occurred_at desc);
create index if not exists supplier_empties_shape_idx
  on public.supplier_empties (store_id, product_unit_id);

comment on table public.supplier_empties is
  'Containers handed back to whoever made them, counted in the product shape they were kept in. '
  'The other end of `customer_empties`: what customers return comes into the yard, this is what '
  'leaves it, and the difference is what is standing there.';

create trigger no_mutation before update or delete on public.supplier_empties
  for each row execute function public.tg_append_only();

alter table public.supplier_empties enable row level security;

create policy supplier_empties_read on public.supplier_empties
  for select using (public.is_store_member(store_id));

create policy supplier_empties_no_insert on public.supplier_empties
  for insert with check (false);

-- ─── Recording one ──────────────────────────────────────────────────────────────────

create or replace function public.record_supplier_empties(
  p_store_id        uuid,
  p_product_unit_id uuid,
  p_qty             qty,
  p_purchase_id     uuid default null,
  p_supplier        text default null,
  p_note            text default null,
  p_occurred_at     timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id         uuid;
  v_product_id uuid;
  v_returnable boolean;
begin
  if not public.has_permission(p_store_id, 'stock.receive') then
    raise exception 'you do not have permission to record a delivery' using errcode = '42501';
  end if;

  -- The shape, its product, and whether it is a thing that comes back — read from the product
  -- rather than taken on trust, the same check `record_customer_empties` makes.
  select p.id, pu.is_returnable
    into v_product_id, v_returnable
    from public.product_units pu
    join public.products p on p.id = pu.product_id
   where pu.id = p_product_unit_id and p.store_id = p_store_id;

  if v_product_id is null then
    raise exception 'that shape does not belong to this shop' using errcode = '42501';
  end if;

  if not v_returnable then
    raise exception 'that shape is not marked as coming back — tick it on the product first'
      using errcode = '23514';
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'say how many' using errcode = '22023';
  end if;

  /*
   * DELIBERATELY NOT REFUSED FOR BEING MORE THAN THE YARD HOLDS.
   *
   * The yard figure is derived from what customers have brought back, and a shop's own stock of
   * empties predates this app — crates it has always had, crates bought with a load, crates that
   * came back before anybody was recording. Refusing would make the honest entry impossible on the
   * first day and every day after until the arithmetic caught up.
   *
   * A negative yard figure is meaningful here in a way a negative customer debt is not: it says
   * the shop has sent back more than it can account for, which is a real thing worth seeing.
   */
  insert into public.supplier_empties (store_id, product_id, product_unit_id, qty,
                                       purchase_id, supplier, note, occurred_at)
  values (p_store_id, v_product_id, p_product_unit_id, p_qty,
          p_purchase_id, nullif(btrim(coalesce(p_supplier, '')), ''),
          nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_occurred_at, now()))
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.record_supplier_empties(uuid, uuid, qty, uuid, text, text, timestamptz) from public;
grant execute on function public.record_supplier_empties(uuid, uuid, qty, uuid, text, text, timestamptz) to authenticated;

-- ─── And the yard finally balances ──────────────────────────────────────────────────

/*
 * WHAT IS STANDING IN THE YARD, as arithmetic rather than a count with a date.
 *
 * 0105 could only offer "forty crates, counted on the 8th", because nothing recorded containers
 * leaving for the brewery and a figure that only climbs is one nobody believes. Now:
 *
 *     what the last count found
 *   + what customers have brought back since
 *   - what has gone back to the maker since
 *
 * Counted FROM THE LAST COUNT, not from the beginning of time. A count is the shop putting its hand
 * up and saying what is actually there; everything before it is superseded, which is the whole
 * point of counting.
 */
create or replace function public.yard_empties(p_store_id uuid)
returns table (
  product_id      uuid,
  product_name    text,
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text,
  counted         qty,
  counted_at      timestamptz,
  back_from_customers qty,
  sent_to_maker   qty,
  in_yard         qty
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with shapes as (
    select pu.id, pu.product_id, p.name as product_name, su.name, su.plural
      from public.product_units pu
      join public.products p on p.id = pu.product_id
      join public.store_units su on su.id = pu.store_unit_id
     where p.store_id = p_store_id
       and pu.is_returnable
       and coalesce(p.status, 'active') = 'active'
  ),
  last_count as (
    select distinct on (ec.empties_category_id)
           ec.empties_category_id, ec.qty, ec.counted_at
      from public.empties_counts ec
     where ec.store_id = p_store_id
     order by ec.empties_category_id, ec.counted_at desc
  ),
  counted as (
    -- The count is against a POOL, which is the vocabulary 0105 was written in. Matched to a shape
    -- through the product's returnable link, which is the only bridge between the two.
    select pr.product_unit_id, lc.qty, lc.counted_at
      from last_count lc
      join public.product_returnables pr on pr.empties_category_id = lc.empties_category_id
     where pr.product_unit_id is not null
  )
  select s.product_id, s.product_name, s.id, s.name, s.plural,
         coalesce(c.qty, 0)::qty,
         c.counted_at,
         coalesce((
           select sum(ce.qty)
             from public.customer_empties ce
            where ce.product_unit_id = s.id
              and ce.direction = 'returned'
              and (c.counted_at is null or ce.occurred_at > c.counted_at)
         ), 0)::qty,
         coalesce((
           select sum(se.qty)
             from public.supplier_empties se
            where se.product_unit_id = s.id
              and (c.counted_at is null or se.occurred_at > c.counted_at)
         ), 0)::qty,
         (coalesce(c.qty, 0)
          + coalesce((
              select sum(ce.qty) from public.customer_empties ce
               where ce.product_unit_id = s.id and ce.direction = 'returned'
                 and (c.counted_at is null or ce.occurred_at > c.counted_at)
            ), 0)
          - coalesce((
              select sum(se.qty) from public.supplier_empties se
               where se.product_unit_id = s.id
                 and (c.counted_at is null or se.occurred_at > c.counted_at)
            ), 0))::qty
    from shapes s
    left join counted c on c.product_unit_id = s.id
   where public.is_store_member(p_store_id)
   order by s.product_name, s.name;
$fn$;

revoke all on function public.yard_empties(uuid) from public;
grant execute on function public.yard_empties(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('record_supplier_empties', 'yard_empties')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a yard function has % overloads', n;
    end if;
  end loop;
end;
$check$;

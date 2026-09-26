-- =====================================================================================
-- 0169 — A supplier's containers are counted by maker too
--
-- A supplier delivers Gulder, Goldberg and 33 Export and takes back "25 NBL crates". Nobody counts
-- which beer was in which crate, because it does not matter: an NBL crate is an NBL crate, and the
-- settlement is "I gave you Gulder, give me Gulder back" only down to the pool, never the product.
-- That is how a distributor's yard actually works, and it is why the yard screen and the customer
-- ledger have both had a maker grain since they were built.
--
-- `supplier_empties` never did. `product_id` and `product_unit_id` are NOT NULL, so the only thing
-- it can record is "3 Goldberg 60cl crates" — and the supplier form, having no way to say anything
-- else, asked for every returnable shape the shop has as its own numbered box. Dozens of boxes,
-- all of them zero, to record one number the shop already knows.
--
-- This gives it the two grains `customer_empties` has, and nothing more:
--
--   BY MAKER   `category_id` + `store_unit_id`  — 25 NBL crates
--   BY ITEM    `product_id`  + `product_unit_id` — 3 Goldberg 60cl crates
--
-- Exactly one of the two, enforced by a check rather than by convention, because a row that is
-- half of each is a row no reader can add up.
--
-- WHAT THIS DOES NOT CHANGE: the yard. `yard_empties` attributes movements to a SHAPE, and it does
-- that for customer maker-grain rows too — they are in the ledger, on the customer's account, and
-- outside the yard's per-shape columns. Suppliers now behave identically. Making the yard read
-- maker-grain movements is a separate question about the yard, and doing it here for one side only
-- would leave the two halves of the same screen disagreeing.
-- =====================================================================================

alter table public.supplier_empties
  add column if not exists category_id   uuid references public.product_categories(id),
  add column if not exists store_unit_id uuid references public.store_units(id);

alter table public.supplier_empties alter column product_id      drop not null;
alter table public.supplier_empties alter column product_unit_id drop not null;

comment on column public.supplier_empties.category_id is
  'For a maker-grain row: whose pool the containers belong to (NBL). Null on an item-grain row.';
comment on column public.supplier_empties.store_unit_id is
  'For a maker-grain row: what they are counted in (crates). Null on an item-grain row.';

/*
 * ONE GRAIN OR THE OTHER, never half of each and never neither.
 *
 * `not valid` so the constraint applies to everything written from now on without re-checking rows
 * already there — every existing row is item-grain and satisfies it anyway, but a validating scan
 * on a live table is a lock nobody asked for. Validated immediately afterwards, which takes a
 * weaker lock.
 */
alter table public.supplier_empties
  drop constraint if exists supplier_empties_one_grain;

alter table public.supplier_empties
  add constraint supplier_empties_one_grain check (
    (product_id is not null and product_unit_id is not null
      and category_id is null and store_unit_id is null)
    or
    (category_id is not null and store_unit_id is not null
      and product_id is null and product_unit_id is null)
  ) not valid;

alter table public.supplier_empties validate constraint supplier_empties_one_grain;

-- ── Recording a maker-grain movement ────────────────────────────────────────────────

/*
 * The mirror of `record_customer_empties_for_group`, and deliberately its mirror down to the
 * checks: the maker and the word must both belong to this shop. 0097 closed that hole for
 * customers; this is a new door into the same kind of ledger and it gets the same lock.
 */
create or replace function public.record_supplier_empties_for_group(
  p_store_id     uuid,
  p_supplier_id  uuid,
  p_category_id  uuid,
  p_store_unit_id uuid,
  p_qty          qty,
  p_side         text,
  p_direction    text default 'out',
  p_note         text default null,
  p_occurred_at  timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to record empties' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.suppliers where id = p_supplier_id and store_id = p_store_id
  ) then
    raise exception 'that supplier does not belong to this shop' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.product_categories where id = p_category_id and store_id = p_store_id
  ) then
    raise exception 'that maker does not belong to this shop' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.store_units where id = p_store_unit_id and store_id = p_store_id
  ) then
    raise exception 'that unit does not belong to this shop' using errcode = '42501';
  end if;

  if p_side not in ('we_hold', 'they_hold') then
    raise exception 'side must be we_hold or they_hold';
  end if;
  if p_direction not in ('out', 'returned', 'damaged') then
    raise exception 'direction must be out, returned or damaged';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'how many?';
  end if;

  insert into public.supplier_empties (
    store_id, supplier_id, category_id, store_unit_id, qty, side, direction, note, occurred_at
  )
  values (
    p_store_id, p_supplier_id, p_category_id, p_store_unit_id, p_qty, p_side, p_direction,
    nullif(btrim(coalesce(p_note, '')), ''), p_occurred_at
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.record_supplier_empties_for_group(uuid, uuid, uuid, uuid, qty, text, text, text, timestamptz) is
  'Record containers between the shop and a supplier at MAKER grain — "25 NBL crates" — the mirror of record_customer_empties_for_group.';

-- ── Reading both grains ─────────────────────────────────────────────────────────────

/*
 * `supplier_empties_sent` INNER JOINED products, so a maker-grain row would have been silently
 * dropped: the shop enters 25 NBL crates and the supplier's account shows nothing. Two halves now,
 * unioned, each labelled in the words the shop used to enter it.
 */
drop function if exists public.supplier_empties_sent(uuid);

create or replace function public.supplier_empties_sent(p_supplier_id uuid)
returns table (
  product_id      uuid,
  product_name    text,
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text,
  side            text,
  outstanding     qty,
  moved           qty,
  last_at         timestamptz,
  category_id     uuid,
  category_name   text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- By item: a shape of one product.
  select p.id, p.name, pu.id, su.name, su.plural, se.side,
         (coalesce(sum(se.qty) filter (where se.direction = 'out'), 0)
          - coalesce(sum(se.qty) filter (where se.direction in ('returned', 'damaged')), 0))::qty,
         coalesce(sum(se.qty) filter (where se.direction in ('returned', 'damaged')), 0)::qty,
         max(se.occurred_at),
         null::uuid, null::text
    from public.supplier_empties se
    join public.suppliers s on s.id = se.supplier_id
    join public.products p on p.id = se.product_id
    join public.product_units pu on pu.id = se.product_unit_id
    join public.store_units su on su.id = pu.store_unit_id
   where se.supplier_id = p_supplier_id
     and se.product_id is not null
     and public.is_store_member(s.store_id)
   group by p.id, p.name, pu.id, su.name, su.plural, se.side

  union all

  -- By maker: a pool counted in one word. No product and no shape, by design.
  select null::uuid, c.name, null::uuid, su.name, su.plural, se.side,
         (coalesce(sum(se.qty) filter (where se.direction = 'out'), 0)
          - coalesce(sum(se.qty) filter (where se.direction in ('returned', 'damaged')), 0))::qty,
         coalesce(sum(se.qty) filter (where se.direction in ('returned', 'damaged')), 0)::qty,
         max(se.occurred_at),
         c.id, c.name
    from public.supplier_empties se
    join public.suppliers s on s.id = se.supplier_id
    join public.product_categories c on c.id = se.category_id
    join public.store_units su on su.id = se.store_unit_id
   where se.supplier_id = p_supplier_id
     and se.category_id is not null
     and public.is_store_member(s.store_id)
   group by c.id, c.name, su.name, su.plural, se.side

  -- BY POSITION: a set-returning function's OUT parameters shadow the union's output names, so
  -- `order by side, product_name` is read as the parameters and refused. 6 is side, 2 is the name.
  order by 6, 2;
$$;

comment on function public.supplier_empties_sent(uuid) is
  'What is outstanding between the shop and one supplier, at both grains. A maker-grain row has a null product_id and carries category_id/category_name instead.';

/*
 * The history had the same inner join, so a maker-grain movement would never have appeared on the
 * supplier's timeline — recorded, counted in the outstanding figure, and invisible in the list of
 * what happened. One branch, reading whichever grain the row carries.
 */
create or replace function public.supplier_history(p_supplier_id uuid)
returns table (kind text, label text, amount money_amt, detail text, occurred_at timestamptz, ref_id uuid, actor text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with mine as (
    select s.id, s.store_id from public.suppliers s
     where s.id = p_supplier_id and public.is_store_member(s.store_id)
  ),
  events as (
    select 'delivery'::text as kind,
           coalesce('Delivery ' || nullif(p.invoice_ref, ''), 'Delivery') as label,
           coalesce((
             select sum(pl.base_qty * pl.unit_cost_landed)
               from public.purchase_lines pl where pl.purchase_id = p.id
           ), 0)::money_amt as amount,
           nullif(p.supplier_name, '') as detail,
           p.occurred_at,
           p.id as ref_id,
           p.created_by as actor_id
      from public.purchases p
      join mine m on m.store_id = p.store_id
     where p.supplier_id = m.id

    union all

    select sp.direction,
           case sp.direction
             when 'paid'   then 'Paid them'
             when 'charge' then 'They charged us'
             else 'They owe us'
           end,
           sp.amount,
           sp.reason,
           sp.occurred_at,
           sp.id,
           sp.created_by
      from public.supplier_payments sp
      join mine m on m.id = sp.supplier_id

    union all

    select 'empties'::text,
           case
             when se.side = 'we_hold' and se.direction = 'out'      then 'Their containers arrived'
             when se.side = 'we_hold'                                then 'Their containers went back'
             when se.direction = 'out'                               then 'Our containers went out'
             else 'Our containers came back'
           end,
           null::money_amt,
           -- Whichever grain it was entered at, said the way it was entered: "NBL · 25 crates"
           -- or "Goldberg 60cl · 3 crates".
           coalesce(pr.name, c.name) || ' · ' || se.qty::text || ' ' || coalesce(su.plural, gu.plural),
           se.occurred_at,
           se.id,
           se.created_by
      from public.supplier_empties se
      join mine m on m.id = se.supplier_id
      left join public.products pr on pr.id = se.product_id
      left join public.product_units pu on pu.id = se.product_unit_id
      left join public.store_units su on su.id = pu.store_unit_id
      left join public.product_categories c on c.id = se.category_id
      left join public.store_units gu on gu.id = se.store_unit_id
  )
  select e.kind, e.label, e.amount, e.detail, e.occurred_at, e.ref_id,
         coalesce(u.email::text, 'the shop')
    from events e
    left join auth.users u on u.id = e.actor_id
   order by e.occurred_at desc;
$$;

grant execute on function public.supplier_empties_sent(uuid) to authenticated;
grant execute on function public.record_supplier_empties_for_group(uuid, uuid, uuid, uuid, qty, text, text, text, timestamptz) to authenticated;

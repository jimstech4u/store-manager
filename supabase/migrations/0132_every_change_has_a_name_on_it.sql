-- 0132 — Every change has a name on it, and a shape cannot quietly change meaning
--
-- «ensure that traces and a person (actor) is tied to every record changes»
--
-- The row-level actor was already there: `created_by uuid default auth.uid()` is on the column of
-- every ledger, so a writer cannot forget it. Two things were not.
--
-- ─── ONE: the audit trigger stops at 0100 ───────────────────────────────────────────
--
-- `tg_audit` was attached to nine tables in 0002–0035 and to NOTHING added since. So the shape tree,
-- both empties ledgers, supplier money and the yard counts recorded who INSERTED a row and nothing
-- about who changed one afterwards.
--
-- `product_units` is the one that matters most, and it is the reason this migration exists rather
-- than being a tidy-up. A shape's `defined_qty` is how many bottles are in a crate. Change it from
-- 12 to 24 and every historical quantity ever recorded in crates silently means something else:
-- last month's sale of three crates becomes 72 bottles instead of 36, the margin on it changes, the
-- count that reconciled stops reconciling. Nothing raised, nothing logged, and no way to find out
-- afterwards that it had happened.
--
-- ─── TWO: which is why it is now refused outright ───────────────────────────────────
--
-- There is no correct in-place answer to "the crate used to hold 12 and now holds 24". Both facts
-- are true, of different crates. Once anything has MOVED in a shape, its definition is history and
-- the shop makes a new shape instead — the old one is retired and keeps meaning what it meant.
--
-- A TRIGGER rather than a check inside `save_product_units`: that function is long, it is the one
-- thing the catalogue cannot afford to break, and 0080 already came within one key name of erasing
-- every shape relationship in the shop while "improving" it. A trigger holds for every writer,
-- including ones written later.

-- ─── The audit trigger reaches the tables added since 0100 ──────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'product_units',
    'customer_empties',
    'supplier_empties',
    'supplier_payments',
    'suppliers',
    'empties_counts',
    'customer_charges',
    'staff_charges',
    'variance_resolutions',
    'stock_layers'
  ]
  loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists audit_changes on public.%I', t);
      execute format(
        'create trigger audit_changes after insert or update or delete on public.%I '
        'for each row execute function public.tg_audit()', t);
    end if;
  end loop;
end;
$$;

-- ─── A shape that has traded cannot change what it means ───────────────────────────

create or replace function public.tg_shape_definition_is_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_moves int;
  v_store uuid;
begin
  -- Only the two fields that change the MEANING of a recorded quantity. A shape may be renamed,
  -- retired, or have its roles changed freely — none of that reinterprets history.
  if new.defined_qty is not distinct from old.defined_qty
     and new.defined_against_id is not distinct from old.defined_against_id then
    return new;
  end if;

  select p.store_id into v_store from public.products p where p.id = new.product_id;

  /*
   * HAS ANYTHING ACTUALLY MOVED IN THIS SHAPE?
   *
   * Not "does the product have movements" — a product can have a shape nobody has ever sold in, and
   * correcting a typo in that one is exactly what a shop should be able to do. The question is
   * whether a recorded quantity would change meaning, so it is asked of the rows that name the
   * shape.
   */
  select count(*) into v_moves
    from (
      -- Parenthesised, because LIMIT binds to the whole UNION otherwise and this is a syntax error.
      (select 1 from public.sale_lines      where sale_unit_id    = new.id limit 1)
      union all
      (select 1 from public.customer_empties where product_unit_id = new.id limit 1)
      union all
      (select 1 from public.supplier_empties where product_unit_id = new.id limit 1)
      union all
      (select 1 from public.empties_counts   where product_unit_id = new.id limit 1)
    ) t;

  if v_moves > 0 then
    raise exception
      'This shape has already been used, so changing how many it holds would change what every '
      'past record means. Add a new shape instead and retire this one.'
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

drop trigger if exists shape_definition_is_history on public.product_units;
create trigger shape_definition_is_history
  before update on public.product_units
  for each row execute function public.tg_shape_definition_is_history();

comment on function public.tg_shape_definition_is_history() is
  'Refuses a change to defined_qty or defined_against_id once anything has been recorded in that '
  'shape. There is no correct in-place answer to "the crate used to hold 12 and now holds 24" — '
  'both are true, of different crates.';

-- ─── The supplier timeline says who ─────────────────────────────────────────────────

/*
 * `customer_history` has carried an actor since 0036 and both screens that read it show it.
 * `supplier_history` (0125) never had one, so the other side of the counter was anonymous.
 *
 * Read inside a SECURITY DEFINER function, joined from `auth.users` — a client-side join would
 * return nothing to a seller and the column would be silently blank for exactly the people most
 * likely to be asked "who recorded this".
 */
drop function if exists public.supplier_history(uuid);

create function public.supplier_history(p_supplier_id uuid)
returns table (
  kind        text,
  label       text,
  amount      money_amt,
  detail      text,
  occurred_at timestamptz,
  ref_id      uuid,
  actor       text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
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
           pr.name || ' · ' || se.qty::text || ' ' || su.plural,
           se.occurred_at,
           se.id,
           se.created_by
      from public.supplier_empties se
      join mine m on m.id = se.supplier_id
      join public.products pr on pr.id = se.product_id
      join public.product_units pu on pu.id = se.product_unit_id
      join public.store_units su on su.id = pu.store_unit_id
  )
  select e.kind, e.label, e.amount, e.detail, e.occurred_at, e.ref_id,
         coalesce(u.email::text, 'the shop')
    from events e
    left join auth.users u on u.id = e.actor_id
   order by e.occurred_at desc;
$fn$;

revoke all on function public.supplier_history(uuid) from public;
grant execute on function public.supplier_history(uuid) to authenticated;

-- ─── What each person has been doing ────────────────────────────────────────────────

/*
 * The same rows, filtered by WHO instead of by what — which is A6 and also a report, so it is built
 * once.
 *
 * A STAFF REPORT IS ABOUT A PERSON. Their own figures are theirs; everybody's figures are a
 * manager's. So the reader answers for `auth.uid()` unrestricted, and for anybody else only with
 * `staff.manage`. A shop where a seller can read the owner's takings is not a permission system.
 */
create or replace function public.staff_activity(
  p_store_id uuid,
  p_from     timestamptz,
  p_to       timestamptz,
  p_user_id  uuid default null
)
returns table (
  user_id       uuid,
  who           text,
  receipts      int,
  sold          money_amt,
  corrections   int,
  deliveries    int,
  counts        int,
  write_offs    int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with allowed as (
    select m.user_id, coalesce(u.email::text, 'Someone') as who
      from public.store_members m
      left join auth.users u on u.id = m.user_id
     where m.store_id = p_store_id
       and (p_user_id is null or m.user_id = p_user_id)
       and (public.has_permission(p_store_id, 'staff.manage') or m.user_id = auth.uid())
  )
  select a.user_id,
         a.who,
         coalesce((select count(*) from public.sales s
                    where s.store_id = p_store_id and s.created_by = a.user_id
                      and s.status = 'posted'
                      and s.occurred_at >= p_from and s.occurred_at < p_to), 0)::int,
         coalesce((select sum(s.total) from public.sales s
                    where s.store_id = p_store_id and s.created_by = a.user_id
                      and s.status = 'posted'
                      and s.occurred_at >= p_from and s.occurred_at < p_to), 0)::money_amt,
         coalesce((select count(*) from public.sale_revisions r
                    where r.store_id = p_store_id and r.amended_by = a.user_id
                      and r.amended_at >= p_from and r.amended_at < p_to), 0)::int,
         coalesce((select count(*) from public.purchases p
                    where p.store_id = p_store_id and p.created_by = a.user_id
                      and p.occurred_at >= p_from and p.occurred_at < p_to), 0)::int,
         coalesce((select count(*) from public.stock_periods sp
                    where sp.store_id = p_store_id and sp.counted_by = a.user_id
                      and sp.counted_at >= p_from and sp.counted_at < p_to), 0)::int,
         coalesce((select count(*) from public.stock_movements sm
                    where sm.store_id = p_store_id and sm.created_by = a.user_id
                      and sm.kind = 'damage'
                      and sm.occurred_at >= p_from and sm.occurred_at < p_to), 0)::int
    from allowed a
   order by 4 desc;
$fn$;

revoke all on function public.staff_activity(uuid, timestamptz, timestamptz, uuid) from public;
grant execute on function public.staff_activity(uuid, timestamptz, timestamptz, uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('supplier_history', 'staff_activity', 'tg_shape_definition_is_history')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$check$;

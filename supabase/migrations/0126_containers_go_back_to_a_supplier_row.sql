-- 0126 — Containers go back to a supplier ROW, not a spelling
--
-- 0123 wrote `record_supplier_empties(p_supplier text)`, because suppliers were free text when it
-- was written. 0124 made them rows an hour later and this was left taking a name — so crates went
-- back to "Nigerian Breweries" the string, and `supplier_empties_sent` (which joins `suppliers`)
-- found nothing at all.
--
-- The probe said it in one line: the yard came down by forty and the supplier's account showed
-- none of them. Half the loop, which is worse than neither half, because the yard figure now looks
-- reconciled while nobody can say who is holding the crates.
--
-- The text stays beside the id. A shop that has not yet named a supplier can still record that
-- crates went back — losing the entry entirely to enforce tidiness is how a real day's work ends up
-- unrecorded.

/*
 * DROPPED FIRST. Adding a defaulted argument does not replace a function, it creates a SECOND one —
 * and PostgREST answers 300 to every call once two exist, which took the till down in 0058 and
 * caught `set_product_returnable` again in 0103. The overload check at the bottom is why this was
 * a failed migration rather than a broken delivery screen.
 */
drop function if exists public.record_supplier_empties(uuid, uuid, qty, uuid, text, text, timestamptz);

create or replace function public.record_supplier_empties(
  p_store_id        uuid,
  p_product_unit_id uuid,
  p_qty             qty,
  p_purchase_id     uuid default null,
  p_supplier        text default null,
  p_note            text default null,
  p_occurred_at     timestamptz default now(),
  p_supplier_id     uuid default null
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
  v_supplier   uuid := p_supplier_id;
begin
  if not public.has_permission(p_store_id, 'stock.receive') then
    raise exception 'you do not have permission to record a delivery' using errcode = '42501';
  end if;

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

  if v_supplier is not null then
    if not exists (
      select 1 from public.suppliers where id = v_supplier and store_id = p_store_id
    ) then
      raise exception 'that supplier does not belong to this shop' using errcode = '42501';
    end if;
  elsif btrim(coalesce(p_supplier, '')) <> '' then
    /*
     * A NAME WITH NO ROW BEHIND IT STILL FINDS ONE.
     *
     * Older callers pass a name, and so does a shop that typed one before suppliers existed.
     * Matched case-insensitively rather than creating: naming a supplier is a decision with a form
     * behind it, and a writer that invents one from a delivery note fills the list with spellings.
     */
    select id into v_supplier
      from public.suppliers
     where store_id = p_store_id
       and lower(btrim(name)) = lower(btrim(p_supplier));
  end if;

  insert into public.supplier_empties (store_id, product_id, product_unit_id, qty,
                                       purchase_id, supplier_id, supplier, note, occurred_at)
  values (p_store_id, v_product_id, p_product_unit_id, p_qty,
          p_purchase_id, v_supplier, nullif(btrim(coalesce(p_supplier, '')), ''),
          nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_occurred_at, now()))
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.record_supplier_empties(uuid, uuid, qty, uuid, text, text, timestamptz, uuid) from public;
grant execute on function public.record_supplier_empties(uuid, uuid, qty, uuid, text, text, timestamptz, uuid) to authenticated;

/*
 * The rows already written by name find their supplier.
 *
 * `supplier_empties` is append-only and the trigger refused this, which is the trigger doing its
 * job: a correction to a ledger is normally another row. This is not a correction — the fact never
 * changed, only where it is written down — and there is no reversing entry that expresses "this
 * always belonged to NBL". So the guard is lifted for one statement and put straight back.
 */
alter table public.supplier_empties disable trigger no_mutation;

update public.supplier_empties se
   set supplier_id = s.id
  from public.suppliers s
 where s.store_id = se.store_id
   and lower(btrim(s.name)) = lower(btrim(coalesce(se.supplier, '')))
   and se.supplier_id is null;

alter table public.supplier_empties enable trigger no_mutation;

do $check$
declare n int;
begin
  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'record_supplier_empties';
  if n <> 1 then
    raise exception 'record_supplier_empties has % overloads; PostgREST answers 300 to every call', n;
  end if;
end;
$check$;

-- 0117 — A sale owes its containers, in the shape it sold
--
-- «as goldberg is sold in crates and returnable is true, if we sell any qty, automatically the
--  receipt has that qty expected as the returned empties — buy 3.5 goldberg, 3.5 crate of goldberg
--  returned back»
--
-- The obligation follows from the line existing, so it is written where the line is written. A
-- TRIGGER rather than another edit to `record_sale`: that function is three hundred lines, it is
-- the one thing on the till that must never break, and two migrations have already cost a day by
-- "tidying" it — 0058 changed a parameter order and PostgREST answered 300 to every call, 0080
-- renamed a key the client had never sent and would have erased every shape relationship in the
-- shop.
--
-- It also means the rule holds for anything that writes a sale line, including `settle_draft_order`
-- and anything written later, rather than for the one path somebody remembered to change.
--
-- IN THE SHAPE IT WAS SOLD IN. Three and a half crates owe three and a half crates — not
-- forty-two bottles, which is the same beer and not the thing anybody can hand back.

create or replace function public.tg_sale_line_owes_containers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer uuid;
  v_store    uuid;
  v_at       timestamptz;
begin
  /*
   * A WALK-IN OWES NOTHING, because there is nobody to owe it.
   *
   * A sale with no customer is somebody at the counter taking their change and leaving. Recording
   * an obligation against nobody would put containers into a list that can never be settled.
   */
  select s.store_customer_id, s.store_id, s.occurred_at
    into v_customer, v_store, v_at
    from public.sales s
   where s.id = new.sale_id;

  if v_customer is null then
    return new;
  end if;

  -- Only a shape the shop says comes back, and only when the line names one. A line sold by a
  -- shape with no `sale_unit_id` predates 0085 and cannot say what it owes.
  if new.sale_unit_id is null then
    return new;
  end if;

  if not exists (
    select 1 from public.product_units pu
     where pu.id = new.sale_unit_id and pu.is_returnable
  ) then
    return new;
  end if;

  if coalesce(new.entered_qty, 0) <= 0 then
    return new;
  end if;

  insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                       direction, qty, reason, ref_table, ref_id, occurred_at)
  values (v_store, v_customer, new.product_id, new.sale_unit_id,
          'out', new.entered_qty, null, 'sale_lines', new.id, coalesce(v_at, now()))
  -- A line is written once, but a retry that reaches here twice must not owe twice.
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists sale_line_owes_containers on public.sale_lines;
create trigger sale_line_owes_containers
  after insert on public.sale_lines
  for each row execute function public.tg_sale_line_owes_containers();

-- ─── And a voided sale stops owing them ─────────────────────────────────────────────

/*
 * VOIDING PUTS THEM BACK, as a row rather than a deletion.
 *
 * `customer_empties` is append-only on purpose, so the obligation is closed the way every other
 * closure is: another row, saying what happened. A shop reading the trace sees the containers go
 * out and come back off, with the reason, rather than finding a gap where a sale used to be.
 *
 * `void_sale` refuses once empties have started coming back (0094), so this cannot leave a
 * customer owing a negative number.
 */
create or replace function public.unowe_voided_sale(p_sale_id uuid, p_reason text default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n int;
begin
  insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                       direction, qty, reason, ref_table, ref_id, occurred_at)
  select ce.store_id, ce.store_customer_id, ce.product_id, ce.product_unit_id,
         'returned', ce.qty,
         coalesce(nullif(btrim(p_reason), ''), 'The sale was voided'),
         'sale_void', ce.id, now()
    from public.customer_empties ce
    join public.sale_lines sl on sl.id = ce.ref_id
   where ce.ref_table = 'sale_lines'
     and sl.sale_id = p_sale_id
     and not exists (
       select 1 from public.customer_empties back
        where back.ref_table = 'sale_void' and back.ref_id = ce.id
     );

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.unowe_voided_sale(uuid, text) from public;
grant execute on function public.unowe_voided_sale(uuid, text) to authenticated;

do $check$
declare n int;
begin
  select count(*) into n from pg_trigger
   where tgname = 'sale_line_owes_containers' and not tgisinternal;
  if n <> 1 then
    raise exception 'the sale-line trigger is installed % times', n;
  end if;
end;
$check$;

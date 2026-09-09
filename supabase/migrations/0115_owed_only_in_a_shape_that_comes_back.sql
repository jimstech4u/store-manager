-- 0115 — Owed only in a shape that actually comes back
--
-- The ledgers probe found it in one line: Goldberg's crate is NOT ticked returnable, and 563 rows
-- of `customer_empties` are owed against it.
--
--     Goldberg 60cl
--       Piece   base=1   returnable=false  sold=false
--       Crate   base=12  returnable=false  sold=true   counted=true
--
-- 0110 resolved a shared "NBL crate" pool by preferring the product the customer had actually
-- bought, and Goldberg has the most sales in this shop — so it won, on evidence that was about
-- SALES rather than about containers. The shape it landed on says, in the shop's own words, that
-- it does not come back.
--
-- Two things are wrong and only one of them is data.
--
-- The DATA is fixable: the crate does come back — that is what the whole pool recorded — so the
-- tick is set to what the shop has been doing all along. Left unticked, that Goldberg crate can
-- never appear in a return picker, so 563 rows of obligation would be visible on a screen and
-- impossible to settle.
--
-- The RULE is the more important half. `record_customer_empties` accepted any shape belonging to
-- the shop, so nothing stopped a container being owed in a shape the shop had said is not a
-- container. It checks now, and the check is the reason this cannot recur.

-- ─── The shapes that were owed against but never ticked ─────────────────────────────

/*
 * ONLY WHERE SOMETHING IS ACTUALLY OWED IN IT.
 *
 * Not every shape in the shop, and not every shape in a pool — only one that has an empties row
 * against it. Those are shapes containers have demonstrably gone out in, whatever the tick said,
 * and the tick is the thing that is out of date.
 */
update public.product_units pu
   set is_returnable = true
 where not pu.is_returnable
   and exists (
     select 1 from public.customer_empties ce where ce.product_unit_id = pu.id
   );

-- ─── And it cannot happen again ─────────────────────────────────────────────────────

create or replace function public.record_customer_empties(
  p_store_id       uuid,
  p_customer_id    uuid,
  p_product_unit_id uuid,
  p_direction      text,
  p_qty            qty,
  p_reason         text default null,
  p_ref_table      text default null,
  p_ref_id         uuid default null,
  p_occurred_at    timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id          uuid;
  v_product_id  uuid;
  v_returnable  boolean;
  v_owed        qty;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to record empties' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.store_customers
     where id = p_customer_id and store_id = p_store_id
  ) then
    raise exception 'that customer does not belong to this shop' using errcode = '42501';
  end if;

  if p_direction not in ('out', 'returned', 'damaged') then
    raise exception '% is not something that happens to a container', p_direction
      using errcode = '22023';
  end if;

  -- The shape, the shop it belongs to, AND whether it is a thing that comes back — all read from
  -- the product rather than taken on trust.
  select p.id, pu.is_returnable
    into v_product_id, v_returnable
    from public.product_units pu
    join public.products p on p.id = pu.product_id
   where pu.id = p_product_unit_id and p.store_id = p_store_id;

  if v_product_id is null then
    raise exception 'that shape does not belong to this shop' using errcode = '42501';
  end if;

  /*
   * A SHAPE THE SHOP SAYS DOES NOT COME BACK CANNOT BE OWED.
   *
   * This is the check that was missing, and 563 rows got in without it — every one of them owed in
   * a Goldberg crate the product form said was not returnable. An obligation in a shape no return
   * picker will ever offer is one the shop can see and never settle.
   *
   * Refused rather than silently ticking the shape: which shapes come back is the shop's answer,
   * given on the product form, and a write that quietly changes it is a write that edits the
   * catalogue behind somebody's back.
   */
  if not v_returnable then
    raise exception
      'that shape is not marked as coming back — tick it on the product first'
      using errcode = '23514';
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'say how many' using errcode = '22023';
  end if;

  if p_direction in ('returned', 'damaged') then
    select coalesce(sum(case when direction = 'out' then qty else -qty end), 0)
      into v_owed
      from public.customer_empties
     where store_customer_id = p_customer_id
       and product_unit_id = p_product_unit_id;

    if p_qty > v_owed then
      raise exception 'they only owe % of those', v_owed using errcode = '23514';
    end if;
  end if;

  insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                       direction, qty, reason, ref_table, ref_id, occurred_at)
  values (p_store_id, p_customer_id, v_product_id, p_product_unit_id, p_direction, p_qty,
          nullif(btrim(coalesce(p_reason, '')), ''), p_ref_table, p_ref_id,
          coalesce(p_occurred_at, now()))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.record_customer_empties(uuid, uuid, uuid, text, qty, text, text, uuid, timestamptz) from public;
grant execute on function public.record_customer_empties(uuid, uuid, uuid, text, qty, text, text, uuid, timestamptz) to authenticated;

do $said$
declare n int;
begin
  select count(*) into n
    from public.customer_empties ce
    join public.product_units pu on pu.id = ce.product_unit_id
   where not pu.is_returnable;

  if n > 0 then
    raise exception 'still % empties row(s) owed in a shape that does not come back', n;
  end if;

  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'record_customer_empties';
  if n <> 1 then
    raise exception 'record_customer_empties has % overloads', n;
  end if;
end;
$said$;

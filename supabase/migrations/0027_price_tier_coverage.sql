-- =====================================================================================
-- 0027 — Show the WHOLE price ladder, gaps included
--
-- Refusing overlaps (0024) stops two bands claiming the same quantity. It does nothing about the
-- opposite problem: quantities no band covers.
--
-- With bands at 5–100 and 101–1000, three ranges fall through to the list price — 1–4, and
-- everything above 1000. Those are usually intended. Sometimes they are a typo (1O1 instead of
-- 101) that leaves a silent hole where a seller believes a discount applies. Either way the
-- seller should SEE them, and a settings screen that lists only the rows in the table cannot
-- show what is not there.
--
-- So this returns the complete ladder from 1 upwards, with the fall-through ranges made explicit
-- and labelled. Every quantity is accounted for, which is what "clearly defined ranges" has to
-- mean if it is to be checkable at a glance.
-- =====================================================================================

create or replace function public.price_tier_coverage(
  p_product_id   uuid,
  p_sale_unit_id uuid default null
)
returns table (
  min_qty    qty,
  max_qty    qty,     -- null = unbounded ("and above")
  price      money_amt,
  source     text,    -- 'tier' | 'list'
  tier_id    uuid
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_store uuid;
  v_list  money_amt;
  v_prev  qty := 0;
  r       record;
begin
  select store_id into v_store from public.products where id = p_product_id;
  if v_store is null or not public.is_store_member(v_store) then
    return;
  end if;

  -- The price that applies wherever no band does.
  if p_sale_unit_id is not null then
    select su.price into v_list from public.product_sale_units su where su.id = p_sale_unit_id;
  end if;
  if v_list is null then
    select pp.price into v_list
    from public.product_prices pp
    where pp.product_id = p_product_id
    order by (pp.pack_id is null)
    limit 1;
  end if;

  for r in
    select t.id, t.min_qty, t.max_qty, t.price
    from public.product_price_tiers t
    where t.product_id = p_product_id
      and t.sale_unit_id is not distinct from p_sale_unit_id
    order by t.min_qty
  loop
    -- Anything between the previous band and this one falls through to the list price.
    if r.min_qty > v_prev + 1 then
      min_qty := v_prev + 1;
      max_qty := r.min_qty - 1;
      price   := v_list;
      source  := 'list';
      tier_id := null;
      return next;
    end if;

    min_qty := r.min_qty;
    max_qty := r.max_qty;
    price   := r.price;
    source  := 'tier';
    tier_id := r.id;
    return next;

    -- An unbounded band swallows everything above it; nothing can follow.
    if r.max_qty is null then
      return;
    end if;
    v_prev := r.max_qty;
  end loop;

  -- Everything above the last bounded band.
  min_qty := v_prev + 1;
  max_qty := null;
  price   := v_list;
  source  := 'list';
  tier_id := null;
  return next;
end;
$$;

grant execute on function public.price_tier_coverage(uuid, uuid) to authenticated;

-- ─── Guard the shape of a band as it is typed ───────────────────────────────────────
--
-- The overlap trigger already refuses a clash. These add the two other ways a hand-typed range
-- goes wrong, so the message names the problem instead of leaving a constraint violation to be
-- deciphered.

create or replace function public.tg_price_tier_sane()
returns trigger
language plpgsql
as $$
begin
  if new.max_qty is not null and new.max_qty < new.min_qty then
    raise exception 'The "to" quantity (%) cannot be less than the "from" quantity (%).',
      to_char(new.max_qty, 'FM999999990.####'), to_char(new.min_qty, 'FM999999990.####')
      using errcode = '22023';
  end if;

  if new.min_qty <= 0 then
    raise exception 'A range must start at 1 or more.' using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists price_tier_sane on public.product_price_tiers;
create trigger price_tier_sane
  before insert or update on public.product_price_tiers
  for each row execute function public.tg_price_tier_sane();

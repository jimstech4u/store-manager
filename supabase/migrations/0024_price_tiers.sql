-- =====================================================================================
-- 0024 — Quantity price ranges
--
-- From the domain expert, in their own numbers:
--
--     1 pack of Coca-Cola PET     ₦4,500 / pack
--     5 – 100 packs               ₦4,450 / pack
--     101 – 1000 packs            ₦4,420 / pack
--
-- Each an editable, deletable line. Explicit RANGES rather than open-ended thresholds, because a
-- seller reasons in bands ("between five and a hundred") and a list of `min_qty` thresholds
-- silently overlaps in ways that are hard to see when scanning a screen.
--
-- Two rules that matter more than the table shape:
--
--   · The tier is a SUGGESTION. The resolver says what the price list implies; it never sets the
--     price. A seller can still charge ₦4,500 for a thousand packs, and that must be recorded
--     faithfully — this product's whole pricing model is that the human decides and the system
--     keeps an honest record of what they decided.
--   · Margin is computed against landed cost regardless of which price was used, so a discount
--     never quietly hides a loss.
--
-- Tiers hang off a SALE UNIT, not just the product: "5 packs" and "5 pieces" are different
-- quantities of different things, and a tier that could not tell them apart would apply a
-- bulk-pack discount to five loose bottles.
-- =====================================================================================

create table if not exists public.product_price_tiers (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products (id) on delete cascade,

  /** Null means the tier applies when selling in the product's base unit. */
  sale_unit_id uuid references public.product_sale_units (id) on delete cascade,

  min_qty      qty not null check (min_qty > 0),
  /** Null is unbounded — "101 and above". */
  max_qty      qty,

  price        money_amt not null check (price >= 0),
  created_at   timestamptz not null default now(),

  constraint price_tier_range_valid check (max_qty is null or max_qty >= min_qty)
);

create index if not exists price_tiers_lookup
  on public.product_price_tiers (product_id, sale_unit_id, min_qty);

alter table public.product_price_tiers enable row level security;

create policy price_tiers_read on public.product_price_tiers
  for select to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and public.is_store_member(p.store_id)));

create policy price_tiers_write on public.product_price_tiers
  for all to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')))
  with check (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')));

-- ─── Overlap guard ──────────────────────────────────────────────────────────────────
--
-- Ranges are edited by hand, so overlaps are a matter of when, not if. Two bands covering the
-- same quantity would make the price depend on row order, which is the kind of bug that only
-- surfaces as an argument with a customer weeks later.

create or replace function public.tg_price_tier_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clash record;
begin
  select t.min_qty, t.max_qty into v_clash
  from public.product_price_tiers t
  where t.product_id = new.product_id
    and t.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
    and t.sale_unit_id is not distinct from new.sale_unit_id
    -- Two ranges overlap when each starts before the other ends. Nulls are treated as infinity.
    and new.min_qty <= coalesce(t.max_qty, 'infinity'::numeric)
    and coalesce(new.max_qty, 'infinity'::numeric) >= t.min_qty
  limit 1;

  if found then
    raise exception
      'That range overlaps an existing one (% to %). Adjust the numbers so each quantity falls in exactly one band.',
      to_char(v_clash.min_qty, 'FM999999990.####'),
      coalesce(to_char(v_clash.max_qty, 'FM999999990.####'), 'above')
      using errcode = '23505';
  end if;

  return new;
end;
$$;

drop trigger if exists price_tier_no_overlap on public.product_price_tiers;
create trigger price_tier_no_overlap
  before insert or update on public.product_price_tiers
  for each row execute function public.tg_price_tier_no_overlap();

-- ─── Resolver ───────────────────────────────────────────────────────────────────────
--
-- What the price list SUGGESTS for this quantity. Returns the tier that applies plus the
-- fallback, so the app can show both — "₦4,450 (bulk price, normally ₦4,500)" tells a seller why
-- the number moved, where a silently changed figure looks like a bug.

create or replace function public.resolve_price(
  p_product_id   uuid,
  p_qty          qty,
  p_sale_unit_id uuid default null,
  p_customer_id  uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_base     money_amt;
  v_tier     record;
  v_customer money_amt;
  v_store    uuid;
begin
  select store_id into v_store from public.products where id = p_product_id;
  if v_store is null or not public.is_store_member(v_store) then
    return null;
  end if;

  -- The ordinary price for this shape.
  if p_sale_unit_id is not null then
    select price into v_base from public.product_sale_units where id = p_sale_unit_id;
  end if;
  if v_base is null then
    select price into v_base
    from public.product_prices
    where product_id = p_product_id
    order by (pack_id is null)          -- prefer a pack price over a bare base-unit price
    limit 1;
  end if;

  -- A price agreed with this specific customer outranks the public list, but NOT a bulk band
  -- they have genuinely qualified for — so the better of the two wins, below.
  if p_customer_id is not null then
    select cp.price into v_customer
    from public.customer_prices cp
    where cp.store_customer_id = p_customer_id
      and cp.product_id = p_product_id
    limit 1;
  end if;

  select t.min_qty, t.max_qty, t.price into v_tier
  from public.product_price_tiers t
  where t.product_id = p_product_id
    and t.sale_unit_id is not distinct from p_sale_unit_id
    and p_qty >= t.min_qty
    and (t.max_qty is null or p_qty <= t.max_qty)
  order by t.min_qty desc
  limit 1;

  return jsonb_build_object(
    'base_price', v_base,
    'customer_price', v_customer,
    'tier_price', v_tier.price,
    'tier_min', v_tier.min_qty,
    'tier_max', v_tier.max_qty,
    -- What to prefill. Least of what applies, so a customer with a negotiated rate is never
    -- charged more than the bulk band they qualified for.
    'suggested', least(
      coalesce(v_tier.price, v_customer, v_base),
      coalesce(v_customer, v_tier.price, v_base)
    ),
    'reason', case
      when v_tier.price is not null and (v_customer is null or v_tier.price <= v_customer)
        then 'bulk'
      when v_customer is not null then 'customer'
      else 'list'
    end
  );
end;
$$;

/** Every band for a product, for the settings screen and the storefront's price indicators. */
create or replace function public.product_price_tiers_for(p_product_id uuid)
returns table (
  id           uuid,
  sale_unit_id uuid,
  sale_unit    text,
  min_qty      qty,
  max_qty      qty,
  price        money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id, t.sale_unit_id, su.name, t.min_qty, t.max_qty, t.price
  from public.product_price_tiers t
  join public.products p on p.id = t.product_id
  left join public.product_sale_units su on su.id = t.sale_unit_id
  where t.product_id = p_product_id
    and public.is_store_member(p.store_id)
  order by su.sort_order nulls first, t.min_qty;
$$;

grant execute on function public.resolve_price(uuid, qty, uuid, uuid)  to authenticated;
grant execute on function public.product_price_tiers_for(uuid)         to authenticated;

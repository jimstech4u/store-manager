-- =====================================================================================
-- 0163 — An order comes from a CUSTOMER, at the price they actually earned, and the shop
--        can read it before answering
--
-- Four things, all of them the same shape of mistake: the marketplace was written as though an
-- order were a message, when it is the beginning of a sale.
--
--   1. A SHOP COULD ORDER FROM ITSELF. The interface let an owner browsing the marketplace send
--      their own shop an order. Nothing catastrophic happened, but the order is meaningless: it
--      would arrive in their own queue, and accepting it would open a till against a customer
--      record for themselves. More to the point, an online order exists so that the person who
--      placed it can sign in later and follow it — and a shop following its own order is nobody
--      following anything.
--
--   2. THE SHOP COULD NOT SEE WHAT IT WAS ANSWERING. The queue showed a name, a count and a total,
--      with Accept and Decline under it. Deciding without seeing the lines is not deciding.
--
--   3. ACCEPTING LOST THE CUSTOMER. The order carried the shopper's name and number in its label,
--      as text, and accepting opened a till with no customer attached — so the sale was recorded
--      against nobody, and the shopper who created an account precisely so they could be followed
--      up was not on it.
--
--   4. BULK PRICES WERE IGNORED. A shop that sells American Cola at ₦3,700, or ₦3,600 from five
--      up, was being asked for five at ₦3,700. The till has honoured those bands since 0016. The
--      marketplace quietly did not, which means the marketplace was lying about the price.
-- =====================================================================================

-- ── The shopper, kept as fields rather than as a sentence ───────────────────────────

/*
 * The name and number were already on the order, inside `label`, as "Name · 08012345678". That is
 * fine for a human reading a list and useless for anything else — accepting an order has to hand
 * those two values to `upsert_customer`, and parsing them back out of a display string is the kind
 * of thing that works until somebody has a `·` in their name.
 */
alter table public.draft_orders
  add column if not exists online_name  text,
  add column if not exists online_phone text;

comment on column public.draft_orders.online_name is
  'For source=online: the shopper''s name, as given on their marketplace account. Kept as its own field because accepting the order creates the shop''s customer record from it.';
comment on column public.draft_orders.online_phone is
  'For source=online: the number the shop rings. See online_name.';

-- ── Placing an order ────────────────────────────────────────────────────────────────

create or replace function public.place_online_order(
  p_store_code text,
  p_lines      jsonb,
  p_note       text default null
)
returns table (code text, total money_amt, repriced integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store_id   uuid;
  v_account    public.customer_accounts%rowtype;
  v_draft_id   uuid;
  v_code       text;
  v_line       jsonb;
  v_position   integer := 0;
  v_repriced   integer := 0;
  v_total      numeric := 0;
  v_product    record;
  v_tier_price numeric;
  v_unit_price numeric;
  v_qty        numeric;
  v_shown      numeric;
begin
  if auth.uid() is null then
    raise exception 'Sign in to send this order';
  end if;

  select * into v_account from public.customer_accounts where user_id = auth.uid();
  if v_account.user_id is null then
    -- The checkout screen turns this into "tell the shop who you are", which is the actual ask.
    raise exception 'Finish your shopper account first';
  end if;

  select s.id into v_store_id
  from public.stores s
  where s.code = upper(btrim(p_store_code))
    and s.is_public
    and s.onboarded_at is not null;

  if v_store_id is null then
    raise exception 'That shop is not open on the marketplace';
  end if;

  /*
   * A SHOP CANNOT ORDER FROM ITSELF.
   *
   * Refused here rather than hidden in the interface, because the interface is not what decides
   * anything — and an owner has every other route to this function that a shopper does. Whoever
   * works at this shop, in any role, is served at the counter; an online order is for somebody who
   * is not in the building.
   */
  if public.is_store_member(v_store_id) then
    raise exception 'You work at this shop — start this sale at the till instead';
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'There is nothing in this order';
  end if;

  v_code := public.generate_draft_code(v_store_id);

  insert into public.draft_orders (
    store_id, label, code, status, source, note, online_name, online_phone
  )
  values (
    v_store_id,
    -- What the shop sees in its list. A name with no number is a name the shop cannot ring.
    v_account.display_name || ' · ' || v_account.phone,
    v_code,
    'open',
    'online',
    nullif(btrim(coalesce(p_note, '')), ''),
    v_account.display_name,
    v_account.phone
  )
  returning id into v_draft_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty := coalesce((v_line ->> 'qty')::numeric, 0);
    if v_qty <= 0 then
      continue;
    end if;

    select p.id,
           coalesce(su.price, pr.price) as price,
           su.id as sale_unit_id
      into v_product
    from public.products p
    join public.stores s on s.id = p.store_id
    left join lateral (
      select su2.id, su2.price from public.product_sale_units su2
      where su2.product_id = p.id order by su2.sort_order, su2.base_qty desc limit 1
    ) su on true
    left join lateral (
      select pp.price from public.product_prices pp
      where pp.product_id = p.id order by (pp.pack_id is null) limit 1
    ) pr on true
    where p.id = (v_line ->> 'product_id')::uuid
      and p.store_id = v_store_id
      and p.status = 'active'
      and p.confirmed_at is not null
      and s.is_public;

    -- Gone, withdrawn, or never this shop's. Skipped rather than fatal: the rest of the order is
    -- still a real order, and the shop can see what it was asked for.
    if v_product.id is null then
      continue;
    end if;

    v_unit_price := coalesce(v_product.price, 0);

    /*
     * THE BULK BAND THEY HAVE EARNED, by the same rule the till uses (`resolve_price`): the band
     * whose range contains this quantity, highest `min_qty` first, and only for the shape being
     * priced. A shop that sells five for less is a shop that sells five for less wherever the
     * order came from — quoting the single price and charging the band later would mean the
     * marketplace and the receipt disagreed, which is the one thing a price must never do.
     *
     * `is not distinct from` because both sides are legitimately null for a product sold in its
     * base unit, and `=` is null there.
     */
    select t.price into v_tier_price
    from public.product_price_tiers t
    where t.product_id = v_product.id
      and t.sale_unit_id is not distinct from v_product.sale_unit_id
      and v_qty >= t.min_qty
      and (t.max_qty is null or v_qty <= t.max_qty)
    order by t.min_qty desc
    limit 1;

    if v_tier_price is not null then
      v_unit_price := v_tier_price;
    end if;

    -- What the basket was SHOWN, only so the shopper can be told a price moved. Never used to
    -- price anything.
    v_shown := nullif(v_line ->> 'shown_price', '')::numeric;
    if v_shown is not null and v_shown <> v_unit_price then
      v_repriced := v_repriced + 1;
    end if;

    insert into public.draft_order_lines (
      draft_order_id, product_id, entered_qty, unit_price, line_total, position, sale_unit_id
    )
    values (
      v_draft_id, v_product.id, v_qty, v_unit_price, v_unit_price * v_qty,
      v_position, v_product.sale_unit_id
    );

    v_total := v_total + (v_unit_price * v_qty);
    v_position := v_position + 1;
    v_tier_price := null;
  end loop;

  if v_position = 0 then
    delete from public.draft_orders where id = v_draft_id;
    raise exception 'None of these are still for sale at that shop';
  end if;

  return query select v_code, v_total::money_amt, v_repriced;
end;
$$;

comment on function public.place_online_order(text, jsonb, text) is
  'A shopper asks one shop for one group of their basket. Refuses a caller who works at that shop. Prices every line from the shop''s own current price INCLUDING its bulk bands, never from the client. Returns the code, the total and how many lines were priced differently from what the basket showed.';

-- ── What the shop reads before it answers ───────────────────────────────────────────

/*
 * ONE ORDER, IN FULL.
 *
 * Accept and Decline under a line saying "4 items · ₦18,400" asks somebody to commit stock on the
 * strength of a total. This is what the shop actually needs: what was asked for, how much of it, at
 * what price, and whether they have it.
 */
create or replace function public.online_order_detail(p_draft_id uuid)
returns table (
  id            uuid,
  code          text,
  customer_name text,
  customer_phone text,
  note          text,
  status        text,
  created_at    timestamptz,
  total         money_amt,
  lines         jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.code,
         coalesce(d.online_name, d.label),
         d.online_phone,
         d.note,
         d.status,
         d.created_at,
         coalesce((select sum(l.line_total) from public.draft_order_lines l
                    where l.draft_order_id = d.id), 0) + d.fee_amount,
         coalesce((
           select jsonb_agg(
                    jsonb_build_object(
                      'product_id', l.product_id,
                      'name',       p.name,
                      'unit',       coalesce(su.name, p.base_unit),
                      'qty',        l.entered_qty,
                      'unit_price', l.unit_price,
                      'line_total', l.line_total,
                      -- What the shop last recorded having. Not a promise, and said as a number so
                      -- the person deciding can see "they want 8 and I have 3" for themselves.
                      'in_stock',   coalesce((select sum(m.qty_delta) from public.stock_movements m
                                               where m.product_id = l.product_id), 0)
                    ) order by l.position
                  )
           from public.draft_order_lines l
           join public.products p on p.id = l.product_id
           left join public.product_sale_units su on su.id = l.sale_unit_id
           where l.draft_order_id = d.id
         ), '[]'::jsonb)
  from public.draft_orders d
  where d.id = p_draft_id
    and d.source = 'online'
    and public.has_permission(d.store_id, 'sales.record')
$$;

comment on function public.online_order_detail(uuid) is
  'One marketplace order in full, for the shop deciding whether to accept it. Sell permission required.';

-- ── Accepting ───────────────────────────────────────────────────────────────────────

/*
 * ACCEPT, AND THE ORDER BECOMES A TILL WITH THE CUSTOMER ON IT.
 *
 * Accepting used to call `claim_draft_order` and nothing else, which opened the order at the counter
 * with no customer attached — so a sale made from it was recorded against nobody, and the shopper
 * who had made an account precisely so the shop could reach them was not on their own order.
 *
 * THE LINK IS MADE HERE, BY THE SHOP, and that is deliberate. A shopper's account is not joined to
 * `identities` when it is created: phone numbers are unique there, and letting somebody claim an
 * identity by typing its number would hand them that person's history at every shop. Accepting is
 * the moment a real person at this shop looks at a real order and says yes — which is exactly the
 * decision `upsert_customer` has always represented.
 */
create or replace function public.accept_online_order(p_draft_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order    public.draft_orders%rowtype;
  v_customer uuid;
begin
  select * into v_order from public.draft_orders where id = p_draft_id;

  if v_order.id is null or v_order.source <> 'online' then
    raise exception 'No such order';
  end if;
  if not public.has_permission(v_order.store_id, 'sales.record') then
    raise exception 'Not allowed to take sales at this shop';
  end if;
  if v_order.status <> 'open' then
    raise exception 'That order has already been answered';
  end if;

  /*
   * The shop's own record of this person, found or made. Nothing here reaches across to another
   * shop's record of them — `upsert_customer` is per-store, and the identity it resolves by phone
   * is the same one the counter resolves by when somebody walks in and gives their number.
   */
  if v_order.store_customer_id is null and coalesce(btrim(v_order.online_phone), '') <> '' then
    v_customer := public.upsert_customer(
      v_order.store_id,
      v_order.online_phone,
      coalesce(nullif(btrim(v_order.online_name), ''), 'Marketplace shopper'),
      null
    );
    update public.draft_orders set store_customer_id = v_customer where id = p_draft_id;
  end if;

  -- Claimed to whoever accepted it, exactly as reading a code aloud at the counter does.
  perform public.claim_draft_order(v_order.store_id, v_order.code);

  return p_draft_id;
end;
$$;

comment on function public.accept_online_order(uuid) is
  'Accept a marketplace order: attach the shop''s customer record for the shopper (creating it if this shop has not met them), then claim the draft to the till. Sell permission required.';

grant execute on function public.online_order_detail(uuid) to authenticated;
grant execute on function public.accept_online_order(uuid) to authenticated;

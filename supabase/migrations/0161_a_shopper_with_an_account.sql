-- =====================================================================================
-- 0161 — A shopper with an account, and the order they place
--
-- Up to here the marketplace has been anonymous: anyone can browse, and the basket lives on the
-- device with no account at all. That is deliberate — asking somebody to register before they can
-- keep a basket loses the basket and the shopper.
--
-- It stops being enough at the moment they want the goods. A shop cannot fulfil an order for
-- somebody it has no way to reach, and it will not hold stock for a name typed into a box. So
-- checkout is where an account is asked for, and only there.
--
-- THIS IS A THIRD KIND OF PERSON. The app already knows two: a shop owner, and a worker at a shop.
-- A shopper is neither — they have no store, no role and no permissions, and `/main` has nothing
-- for them. Signing in is shared (one password box, one answer to "who are you"); signing UP is
-- separate, because "open a shop" and "order from shops" are different intentions and asking one
-- form to serve both would ask every shopper to name a business.
--
-- WHAT IS DELIBERATELY *NOT* HERE: the account is not joined to `identities`, though a shopper has
-- a phone and `identities.phone` is unique. Claiming an identity by typing its phone number would
-- hand somebody every shop's record of that person — their debts, their deposits, their history —
-- for the price of knowing their number, and this project has no way to verify a phone. The link
-- from a shopper to a shop's customer record is made by the SHOP, at the till, by a person who
-- knows who walked in. That is what `customers.merge` has always been for.
-- =====================================================================================

-- ── Who the shopper is ──────────────────────────────────────────────────────────────

create table if not exists public.customer_accounts (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) > 0),
  -- Not unique, and not verified. See the note above: a phone here is how the shop reaches this
  -- person about this order, nothing more. Two accounts giving the same number is the shop's
  -- problem to sort out with the people concerned, not a reason to refuse one of them.
  phone        text not null check (length(btrim(phone)) >= 7),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.customer_accounts is
  'A shopper on the public marketplace: not a shop and not a worker. Deliberately holds only what a shop needs to answer an order — a name and a number to call.';

alter table public.customer_accounts enable row level security;

drop policy if exists customer_accounts_own on public.customer_accounts;
create policy customer_accounts_own on public.customer_accounts
  for select using (user_id = auth.uid());

/*
 * Write it through a function, not a policy.
 *
 * An INSERT policy would let a client set its own `user_id`, and every mutating path in this
 * database reads the caller from `auth.uid()` instead of believing an argument. Same rule here.
 */
create or replace function public.save_customer_account(p_name text, p_phone text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'Enter your name';
  end if;
  if length(btrim(coalesce(p_phone, ''))) < 7 then
    raise exception 'Enter a phone number a shop can reach you on';
  end if;

  insert into public.customer_accounts (user_id, display_name, phone)
  values (auth.uid(), btrim(p_name), btrim(p_phone))
  on conflict (user_id) do update
    set display_name = excluded.display_name,
        phone        = excluded.phone,
        updated_at   = now();
end;
$$;

comment on function public.save_customer_account(text, text) is
  'Create or update the signed-in shopper''s marketplace account. The caller is auth.uid(); there is no user id argument by design.';

/*
 * Whether this person is a shopper, and who they are.
 *
 * Returns nothing rather than raising when there is no account: "you have not made one" is an
 * ordinary answer that the checkout screen acts on, not an error.
 */
create or replace function public.my_customer_account()
returns table (display_name text, phone text, created_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.display_name, c.phone, c.created_at
  from public.customer_accounts c
  where c.user_id = auth.uid()
$$;

-- ── Placing an order ────────────────────────────────────────────────────────────────

/*
 * ONE SHOP'S PART OF A BASKET, ASKED FOR.
 *
 * Called once per seller, because the basket is grouped by seller and each group is a separate
 * order to a separate business. There is no "place the whole basket": that would be one call that
 * can half-succeed, and the shopper would have no way to know which half.
 *
 * PRICED HERE, NOT BY THE CALLER. The basket remembers what it was SHOWN, which may be days old
 * and is in any case a number the client could simply make up. Every line is re-priced from the
 * shop's own current price by exactly the expression `public_product` uses, so what the shop is
 * asked for is what the shop is asking. A price that has moved since the basket was filled is
 * reported back rather than hidden — the shopper should find out from us, not from a receipt.
 *
 * It creates an OPEN DRAFT ORDER and nothing else. No stock moves, nothing is owed, and the shop
 * has agreed to nothing until a person accepts it at the till.
 */
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

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'There is nothing in this order';
  end if;

  v_code := public.generate_draft_code(v_store_id);

  insert into public.draft_orders (store_id, label, code, status, source, note)
  values (
    v_store_id,
    -- What the shop sees in its list. A name with no number is a name the shop cannot ring.
    v_account.display_name || ' · ' || v_account.phone,
    v_code,
    'open',
    'online',
    nullif(btrim(coalesce(p_note, '')), '')
  )
  returning id into v_draft_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty := coalesce((v_line ->> 'qty')::numeric, 0);
    if v_qty <= 0 then
      continue;
    end if;

    /*
     * The shop's own current price for this product, by the same rule the public page displays:
     * a sale unit if the product has one, otherwise its plain price. `sale_unit_id` is carried so
     * that when the till settles this, it settles the unit that was actually priced.
     */
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

    -- A product listed with no price is sold at a price agreed on the day. It goes on the order at
    -- zero and the till fills it in — which is what "Ask" meant on the page it was added from.
    if v_product.price is null then
      v_product.price := 0;
    end if;

    v_shown := nullif(v_line ->> 'shown_price', '')::numeric;
    if v_shown is not null and v_shown <> v_product.price then
      v_repriced := v_repriced + 1;
    end if;

    insert into public.draft_order_lines (
      draft_order_id, product_id, entered_qty, unit_price, line_total, position, sale_unit_id
    )
    values (
      v_draft_id, v_product.id, v_qty, v_product.price, v_product.price * v_qty,
      v_position, v_product.sale_unit_id
    );

    v_total := v_total + (v_product.price * v_qty);
    v_position := v_position + 1;
  end loop;

  if v_position = 0 then
    -- Everything asked for has gone. Better an error and a basket still full than an empty order
    -- sitting in a shop's queue.
    delete from public.draft_orders where id = v_draft_id;
    raise exception 'None of these are still for sale at that shop';
  end if;

  return query select v_code, v_total::money_amt, v_repriced;
end;
$$;

comment on function public.place_online_order(text, jsonb, text) is
  'A shopper asks one shop for one group of their basket. Creates an open draft order marked online; prices every line from the shop''s own current price, never from the client. Returns the code, the total and how many lines were priced differently from what the basket showed.';

/*
 * What this shopper has asked for, and what came of it.
 *
 * `created_by` is already `auth.uid()` by default on every draft order, so a shopper's own orders
 * need no new column to find. Nothing here reads across to another person's orders, and nothing
 * here exposes a shop's ledger: a shopper sees the request they made and its outcome, which is
 * the whole of their business with it.
 */
create or replace function public.my_online_orders()
returns table (
  id          uuid,
  code        text,
  store_name  text,
  store_code  text,
  status      text,
  lines       bigint,
  total       money_amt,
  created_at  timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.code, s.name, s.code, d.status,
         (select count(*) from public.draft_order_lines l where l.draft_order_id = d.id),
         coalesce((select sum(l.line_total) from public.draft_order_lines l
                    where l.draft_order_id = d.id), 0) + d.fee_amount,
         d.created_at
  from public.draft_orders d
  join public.stores s on s.id = d.store_id
  where d.source = 'online'
    and d.created_by = auth.uid()
    and auth.uid() is not null
  order by d.created_at desc
  limit 100
$$;

comment on function public.my_online_orders() is
  'The signed-in shopper''s own marketplace orders, newest first.';

grant execute on function public.save_customer_account(text, text) to authenticated;
grant execute on function public.my_customer_account() to authenticated;
grant execute on function public.place_online_order(text, jsonb, text) to authenticated;
grant execute on function public.my_online_orders() to authenticated;

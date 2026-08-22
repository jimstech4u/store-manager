-- =====================================================================================
-- 0034 — Editing and removing records, and the shop's own bank accounts
--
-- Until now the app could CREATE a product or a customer and never change or retire one. Every
-- correction meant going to the database, which is not a workflow — it is the absence of one. A
-- shop mistypes a name on the first day and lives with it forever.
--
-- Three things here:
--
--  1. UPDATE and ARCHIVE for products and customers. Archive, never DELETE: both are referenced
--     by the sales ledger, which is append-only, and a real delete would either fail on the
--     foreign key or orphan history that has to reconcile. Archived records stop appearing in
--     pickers and keep answering for the sales they were part of.
--
--  2. BANK ACCOUNTS. A distributor collects transfers into more than one account and picks which
--     one to read out depending on the customer. Storing that as free text on each payment meant
--     retyping an account number at the counter — the single easiest number in this business to
--     get wrong, and the mistake is somebody else's money.
--
--  3. Payments remember WHICH account a transfer went to, so reconciliation against a bank
--     statement is possible at all.
-- =====================================================================================

-- ─── Archiving customers needs somewhere to record it ───────────────────────────────

alter table public.store_customers
  add column if not exists status text not null default 'active'
    check (status in ('active', 'archived'));

-- ─── Products ───────────────────────────────────────────────────────────────────────

/**
 * Edit a product's descriptive fields.
 *
 * Deliberately NOT a way to set `avg_unit_cost` or stock. Cost is derived from recorded
 * deliveries by the weighted-average rule and quantity from the movement ledger; letting a form
 * overwrite either would put a number on screen that no longer has anything behind it, and the
 * whole point of the ledger is that every figure can be traced to an event.
 *
 * NULL means "leave alone" for every optional field, so a screen that edits one thing does not
 * have to resend the rest correctly. `p_sku` and `p_barcode` need a way to be CLEARED, though,
 * which null cannot express — an empty string does that.
 */
create or replace function public.update_product(
  p_product_id  uuid,
  p_name        text default null,
  p_sku         text default null,
  p_barcode     text default null,
  p_category_id uuid default null,
  p_list_price  money_amt default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store uuid;
  v_pack  uuid;
begin
  select store_id into v_store from public.products where id = p_product_id;
  if v_store is null then
    raise exception 'that product no longer exists' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'you do not have permission to change products' using errcode = '42501';
  end if;

  update public.products
     set name        = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
         sku         = case when p_sku is null then sku
                            else nullif(trim(p_sku), '') end,
         barcode     = case when p_barcode is null then barcode
                            else nullif(trim(p_barcode), '') end,
         category_id = coalesce(p_category_id, category_id)
   where id = p_product_id;

  -- The price lives on product_prices against the display pack, not on the product, so it is
  -- updated separately and only when one was actually supplied.
  if p_list_price is not null then
    select coalesce(p.default_display_pack_id,
                    (select id from public.product_packs
                      where product_id = p_product_id order by base_unit_qty limit 1))
      into v_pack
      from public.products p where p.id = p_product_id;

    insert into public.product_prices (product_id, pack_id, price)
    values (p_product_id, v_pack, p_list_price)
    on conflict (product_id, pack_id) do update set price = excluded.price;
  end if;

  return p_product_id;
end;
$fn$;

/**
 * Retire a product.
 *
 * Refuses while stock is still on hand unless explicitly forced. Archiving drops the item out of
 * `list_products`, and with it out of the stock valuation — so archiving 200 packs by accident
 * makes the shop's stock silently worth less with nothing to show why. Forcing is allowed
 * because a written-off or discontinued line is a real case; it just has to be meant.
 */
create or replace function public.archive_product(
  p_product_id uuid,
  p_reason     text default null,
  p_force      boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store   uuid;
  v_on_hand qty;
begin
  select store_id into v_store from public.products where id = p_product_id;
  if v_store is null then
    raise exception 'that product no longer exists' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'you do not have permission to remove products' using errcode = '42501';
  end if;

  select coalesce(sum(qty_delta), 0) into v_on_hand
    from public.stock_movements where product_id = p_product_id;

  if v_on_hand <> 0 and not p_force then
    raise exception
      'there are still % of this item on the shelf', v_on_hand using errcode = '22023';
  end if;

  update public.products
     set status = 'archived',
         amend_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_product_id;

  return p_product_id;
end;
$fn$;

/** Bring one back. Undo has to exist, or archiving is a trap rather than a tidy-up. */
create or replace function public.restore_product(p_product_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare v_store uuid;
begin
  select store_id into v_store from public.products where id = p_product_id;
  if v_store is null then
    raise exception 'that product no longer exists' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'you do not have permission to change products' using errcode = '42501';
  end if;
  update public.products set status = 'active' where id = p_product_id;
  return p_product_id;
end;
$fn$;

-- ─── Customers ──────────────────────────────────────────────────────────────────────

create or replace function public.update_customer(
  p_customer_id   uuid,
  p_display_name  text default null,
  p_business_name text default null,
  p_notes         text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare v_store uuid;
begin
  select store_id into v_store from public.store_customers where id = p_customer_id;
  if v_store is null then
    raise exception 'that customer no longer exists' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_store, 'customers.manage') then
    raise exception 'you do not have permission to change customers' using errcode = '42501';
  end if;

  update public.store_customers
     set display_name  = coalesce(nullif(trim(coalesce(p_display_name, '')), ''), display_name),
         business_name = case when p_business_name is null then business_name
                              else nullif(trim(p_business_name), '') end,
         notes         = case when p_notes is null then notes
                              else nullif(trim(p_notes), '') end
   where id = p_customer_id;

  return p_customer_id;
end;
$fn$;

/**
 * Retire a customer.
 *
 * Refuses while they still owe money unless forced. A balance that disappears from the screen has
 * not been settled — it has been hidden, and the shop finds out months later when nobody can say
 * who has the crates.
 */
create or replace function public.archive_customer(
  p_customer_id uuid,
  p_force       boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store   uuid;
  v_balance money_amt;
begin
  select store_id into v_store from public.store_customers where id = p_customer_id;
  if v_store is null then
    raise exception 'that customer no longer exists' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_store, 'customers.manage') then
    raise exception 'you do not have permission to remove customers' using errcode = '42501';
  end if;

  select public.customer_balance(p_customer_id) into v_balance;

  if coalesce(v_balance, 0) <> 0 and not p_force then
    raise exception 'this customer still has a balance of %', v_balance using errcode = '22023';
  end if;

  update public.store_customers set status = 'archived' where id = p_customer_id;
  return p_customer_id;
end;
$fn$;

create or replace function public.restore_customer(p_customer_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare v_store uuid;
begin
  select store_id into v_store from public.store_customers where id = p_customer_id;
  if v_store is null then
    raise exception 'that customer no longer exists' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_store, 'customers.manage') then
    raise exception 'you do not have permission to change customers' using errcode = '42501';
  end if;
  update public.store_customers set status = 'active' where id = p_customer_id;
  return p_customer_id;
end;
$fn$;

-- ─── Bank accounts ──────────────────────────────────────────────────────────────────

create table if not exists public.store_bank_accounts (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references public.stores (id) on delete cascade,
  bank_name      text not null,
  account_name   text not null,
  account_number text not null,
  /** Read out first at the counter unless the seller picks another. */
  is_default     boolean not null default false,
  status         text not null default 'active' check (status in ('active', 'archived')),
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (store_id, account_number, bank_name)
);

create index if not exists store_bank_accounts_idx
  on public.store_bank_accounts (store_id, status, sort_order);

-- Exactly one default per shop, enforced by the database rather than by whichever screen wrote
-- last. Two defaults is not a display problem; it is two different answers to "where do I pay?".
create unique index if not exists store_bank_accounts_one_default
  on public.store_bank_accounts (store_id) where is_default and status = 'active';

drop trigger if exists touch_updated_at on public.store_bank_accounts;
create trigger touch_updated_at before update on public.store_bank_accounts
  for each row execute function public.tg_touch_updated_at();

drop trigger if exists audit on public.store_bank_accounts;
create trigger audit after insert or update or delete on public.store_bank_accounts
  for each row execute function public.tg_audit();

alter table public.store_bank_accounts enable row level security;

-- Any member can READ: a seller has to be able to read the account out to a customer. Only
-- `store.settings` can write, because changing the account number a shop collects money into is
-- the single highest-value edit in the product.
drop policy if exists bank_accounts_read on public.store_bank_accounts;
create policy bank_accounts_read on public.store_bank_accounts
  for select to authenticated using (public.is_store_member(store_id));

drop policy if exists bank_accounts_write on public.store_bank_accounts;
create policy bank_accounts_write on public.store_bank_accounts
  for all to authenticated
  using (public.has_permission(store_id, 'store.settings'))
  with check (public.has_permission(store_id, 'store.settings'));

/** Create or edit one account. Passing p_id edits; omitting it creates. */
create or replace function public.save_bank_account(
  p_store_id       uuid,
  p_bank_name      text,
  p_account_name   text,
  p_account_number text,
  p_is_default     boolean default false,
  p_id             uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare v_id uuid;
begin
  if not public.has_permission(p_store_id, 'store.settings') then
    raise exception 'you do not have permission to change bank accounts' using errcode = '42501';
  end if;

  if nullif(trim(coalesce(p_account_number, '')), '') is null then
    raise exception 'an account number is required' using errcode = '22023';
  end if;

  -- Stand the old default down BEFORE writing the new one, or the unique index rejects the write
  -- rather than the old default giving way.
  if p_is_default then
    update public.store_bank_accounts
       set is_default = false
     where store_id = p_store_id and is_default
       and (p_id is null or id <> p_id);
  end if;

  if p_id is null then
    insert into public.store_bank_accounts
      (store_id, bank_name, account_name, account_number, is_default)
    values (p_store_id, trim(p_bank_name), trim(p_account_name),
            trim(p_account_number), p_is_default)
    returning id into v_id;
  else
    update public.store_bank_accounts
       set bank_name      = trim(p_bank_name),
           account_name   = trim(p_account_name),
           account_number = trim(p_account_number),
           is_default     = p_is_default
     where id = p_id and store_id = p_store_id
    returning id into v_id;

    if v_id is null then
      raise exception 'that account no longer exists' using errcode = 'P0002';
    end if;
  end if;

  return v_id;
end;
$fn$;

create or replace function public.archive_bank_account(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare v_store uuid;
begin
  select store_id into v_store from public.store_bank_accounts where id = p_id;
  if v_store is null then
    raise exception 'that account no longer exists' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_store, 'store.settings') then
    raise exception 'you do not have permission to change bank accounts' using errcode = '42501';
  end if;
  -- Cleared as well as archived: a retired account must not stay the one the counter offers.
  update public.store_bank_accounts
     set status = 'archived', is_default = false
   where id = p_id;
  return p_id;
end;
$fn$;

create or replace function public.list_bank_accounts(p_store_id uuid)
returns table (
  id             uuid,
  bank_name      text,
  account_name   text,
  account_number text,
  is_default     boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select b.id, b.bank_name, b.account_name, b.account_number, b.is_default
    from public.store_bank_accounts b
   where b.store_id = p_store_id
     and b.status = 'active'
     and public.is_store_member(p_store_id)
   order by b.is_default desc, b.sort_order, b.bank_name;
$fn$;

-- ─── Payments remember where the money landed ───────────────────────────────────────

alter table public.payments
  add column if not exists bank_account_id uuid references public.store_bank_accounts (id);

-- One trailing parameter, and the OLD signature is dropped rather than left beside the new one.
-- Adding a defaulted argument creates a second overload, and PostgREST then refuses every call
-- with "function is not unique" — the same way `record_sale` and `create_or_get_academix_profile`
-- broke before.
drop function if exists public.record_payment(uuid, uuid, money_amt, text, text, timestamptz, uuid);

create or replace function public.record_payment(
  p_store_id        uuid,
  p_customer_id     uuid,
  p_amount          money_amt,
  p_method          text default 'cash',
  p_reference       text default null,
  p_occurred_at     timestamptz default now(),
  p_client_uuid     uuid default null,
  p_bank_account_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_payment_id uuid;
  v_remaining  money_amt;
  v_sale       record;
  v_applied    money_amt;
begin
  if not public.has_permission(p_store_id, 'payments.record') then
    raise exception 'you do not have permission to record a payment' using errcode = '42501';
  end if;

  insert into public.payments (store_id, store_customer_id, amount, method, reference,
                               occurred_at, client_uuid, bank_account_id)
  values (p_store_id, p_customer_id, p_amount, p_method, p_reference, p_occurred_at,
          p_client_uuid, p_bank_account_id)
  returning id into v_payment_id;

  v_remaining := p_amount;

  for v_sale in
    select s.id, s.total
      from public.sales s
     where s.store_customer_id = p_customer_id
       and s.status = 'posted'
     order by s.occurred_at asc
  loop
    exit when v_remaining <= 0;
    v_applied := least(v_remaining, v_sale.total);
    insert into public.payment_allocations (payment_id, sale_id, amount)
    values (v_payment_id, v_sale.id, v_applied);
    v_remaining := v_remaining - v_applied;
  end loop;

  return v_payment_id;
end;
$fn$;

-- ─── Grants ─────────────────────────────────────────────────────────────────────────

revoke all on function public.update_product(uuid, text, text, text, uuid, money_amt) from public;
revoke all on function public.archive_product(uuid, text, boolean)                     from public;
revoke all on function public.restore_product(uuid)                                    from public;
revoke all on function public.update_customer(uuid, text, text, text)                  from public;
revoke all on function public.archive_customer(uuid, boolean)                          from public;
revoke all on function public.restore_customer(uuid)                                   from public;
revoke all on function public.save_bank_account(uuid, text, text, text, boolean, uuid) from public;
revoke all on function public.archive_bank_account(uuid)                               from public;
revoke all on function public.list_bank_accounts(uuid)                                 from public;

grant execute on function public.update_product(uuid, text, text, text, uuid, money_amt) to authenticated;
grant execute on function public.archive_product(uuid, text, boolean)                     to authenticated;
grant execute on function public.restore_product(uuid)                                    to authenticated;
grant execute on function public.update_customer(uuid, text, text, text)                  to authenticated;
grant execute on function public.archive_customer(uuid, boolean)                           to authenticated;
grant execute on function public.restore_customer(uuid)                                   to authenticated;
grant execute on function public.save_bank_account(uuid, text, text, text, boolean, uuid)  to authenticated;
grant execute on function public.archive_bank_account(uuid)                                to authenticated;
grant execute on function public.list_bank_accounts(uuid)                                  to authenticated;
grant execute on function public.record_payment(uuid, uuid, money_amt, text, text, timestamptz, uuid, uuid) to authenticated;

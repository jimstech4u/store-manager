-- =====================================================================================
-- 0013 — Store settings, sale fees and notes, and settling a sale atomically
--
-- Supports the sale screen spec (STORE_MANAGER_PLAN.md §12): additional fees, a note, several
-- payment methods on one sale, change, printable transfer details, and role-gated settings that
-- sync rather than living in one phone's localStorage.
-- =====================================================================================

-- ─── Store settings ─────────────────────────────────────────────────────────────────
--
-- One row per store, in the database rather than localStorage: a shop's configuration belongs to
-- the shop, not to whichever phone happened to set it. Staff switch devices, phones get replaced,
-- and re-entering the printer width and bank details on every new device is exactly the kind of
-- friction that makes people stop using a tool.

create table if not exists public.store_settings (
  store_id            uuid primary key references public.stores (id) on delete cascade,

  -- Two physically different receipt layouts, not one scaled. 40mm fits about 32 characters and
  -- cannot hold a multi-column row, so it needs a stacked layout of its own.
  printer_width       text not null default '80mm'
                        check (printer_width in ('40mm', '58mm', '80mm', '100mm')),
  receipt_header      text,
  receipt_footer      text,

  -- Printed on the receipt so a customer paying later knows where to send it.
  transfer_bank_name  text,
  transfer_account_no text,
  transfer_account_name text,
  show_transfer_details boolean not null default false,

  amend_reason        text,
  updated_at          timestamptz not null default now()
);

create trigger touch_updated_at before update on public.store_settings
  for each row execute function public.tg_touch_updated_at();
create trigger audit after insert or update or delete on public.store_settings
  for each row execute function public.tg_audit();

alter table public.store_settings enable row level security;

-- Readable by any member (the printer width is needed to render a receipt), writable only with
-- store.settings — the role gate the spec asks for, enforced here rather than only in the UI.
create policy settings_read on public.store_settings
  for select to authenticated using (public.is_store_member(store_id));
create policy settings_write on public.store_settings
  for all to authenticated
  using (public.has_permission(store_id, 'store.settings'))
  with check (public.has_permission(store_id, 'store.settings'));

-- ─── Sale fees and notes ────────────────────────────────────────────────────────────
--
-- A fee here is charged TO the customer and raises the total. Deliberately not confused with the
-- delivery/distribution fees on a purchase, which are a cost the business absorbs into landed
-- cost — same word, opposite direction, and conflating them would corrupt margin.

alter table public.sales
  add column if not exists fee_amount  money_amt not null default 0 check (fee_amount >= 0),
  add column if not exists fee_label   text,
  add column if not exists note        text,
  -- Snapshot of the transfer details as printed. Kept per sale rather than read live from
  -- settings, so reprinting an old receipt shows the account it was actually issued with — a
  -- changed bank account must not silently rewrite past receipts.
  add column if not exists transfer_details text;

-- ─── Settle a sale ──────────────────────────────────────────────────────────────────
--
-- One call: create the sale, move the stock, create empties obligations, and record every
-- payment. Doing this as separate client calls means a dropped connection can leave a sale with
-- no payment recorded — the customer has paid and the system says they owe, which is the single
-- worst failure this product could have.
--
-- p_payments: [{amount, method, reference}]

create or replace function public.settle_sale(
  p_store_id     uuid,
  p_lines        jsonb,
  p_payments     jsonb default '[]'::jsonb,
  p_customer_id  uuid default null,
  p_fee_amount   money_amt default 0,
  p_fee_label    text default null,
  p_note         text default null,
  p_occurred_at  timestamptz default now(),
  p_client_uuid  uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale_id   uuid;
  v_pay       jsonb;
  v_amount    money_amt;
  v_settings  record;
  v_transfer  text;
  v_total     money_amt;
begin
  if p_client_uuid is not null then
    select id into v_sale_id from public.sales where client_uuid = p_client_uuid;
    if v_sale_id is not null then
      return v_sale_id;                     -- a retry, not a second sale
    end if;
  end if;

  -- record_sale checks the permission, moves stock and builds empties obligations.
  v_sale_id := public.record_sale(p_store_id, p_lines, p_customer_id, p_occurred_at, p_client_uuid);

  select * into v_settings from public.store_settings where store_id = p_store_id;
  if found and v_settings.show_transfer_details then
    v_transfer := concat_ws(E'\n',
      nullif(v_settings.transfer_bank_name, ''),
      nullif(v_settings.transfer_account_no, ''),
      nullif(v_settings.transfer_account_name, ''));
  end if;

  update public.sales
     set fee_amount       = coalesce(p_fee_amount, 0),
         fee_label        = nullif(trim(p_fee_label), ''),
         note             = nullif(trim(p_note), ''),
         transfer_details = v_transfer,
         total            = total + coalesce(p_fee_amount, 0)
   where id = v_sale_id
  returning total into v_total;

  -- Several payment methods on one sale: each becomes its own payment row, so the cash drawer
  -- and the bank can be reconciled separately later. record_payment allocates oldest-first.
  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    v_amount := (v_pay ->> 'amount')::money_amt;
    continue when coalesce(v_amount, 0) <= 0;

    if p_customer_id is null then
      -- A walk-in paying cash has no ledger to settle against, so the payment is recorded
      -- against the sale directly rather than a customer balance.
      insert into public.payments (store_id, store_customer_id, amount, method, reference, occurred_at)
      values (p_store_id, null, v_amount, coalesce(v_pay ->> 'method', 'cash'),
              nullif(v_pay ->> 'reference', ''), p_occurred_at);
    else
      perform public.record_payment(
        p_store_id, p_customer_id, v_amount,
        coalesce(v_pay ->> 'method', 'cash'),
        nullif(v_pay ->> 'reference', ''),
        p_occurred_at,
        null
      );
    end if;
  end loop;

  return v_sale_id;
end;
$$;

grant execute on function public.settle_sale(uuid, jsonb, jsonb, uuid, money_amt, text, text, timestamptz, uuid)
  to authenticated;

-- ─── Ensure a settings row exists ───────────────────────────────────────────────────

create or replace function public.ensure_store_settings(p_store_id uuid)
returns public.store_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.store_settings;
begin
  if not public.is_store_member(p_store_id) then
    raise exception 'not a member of this store' using errcode = '42501';
  end if;

  insert into public.store_settings (store_id)
  values (p_store_id)
  on conflict (store_id) do nothing;

  select * into v_row from public.store_settings where store_id = p_store_id;
  return v_row;
end;
$$;

grant execute on function public.ensure_store_settings(uuid) to authenticated;

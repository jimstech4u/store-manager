-- =====================================================================================
-- 0019 — Shareable receipts and reports
--
-- A receipt has to leave the app: sent to a customer on WhatsApp, kept as a record, shown to
-- someone who does not use this software and never will. Three ways out, and this migration
-- provides the one that needs a server:
--
--   1. a LINK anyone can open — works on every platform, nothing to download, and the recipient
--      can print or save it as a PDF themselves
--   2. an IMAGE, rendered on the device and handed to the native share sheet
--   3. PRINT / Save as PDF, already handled by the print stylesheet
--
-- SECURITY. This is public, unauthenticated access to a specific business record, so it is built
-- the way STORE_MANAGER_PLAN.md §9 committed to rather than retrofitted after something leaks:
--
--   · the token is 22 random characters from gen_random_bytes — not a sequential id, not derived
--     from the sale id, and not guessable by trying neighbours
--   · it grants ONE record. There is no listing endpoint, and no way to walk from one receipt to
--     another or to the store's other data
--   · it can be revoked, and it can expire
--   · what it returns is deliberately narrower than what staff see: no costs, no margin, no
--     customer balance. A customer's receipt is not a window into the shop's buying prices
--   · viewing is public; anything that CHANGES state through a link will require the
--     verification step described in §9, and is not part of this migration
-- =====================================================================================

create table if not exists public.share_links (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores (id) on delete cascade,

  -- What is being shared. Kept generic so reports can use the same mechanism as receipts.
  kind        text not null check (kind in ('receipt', 'statement', 'report')),
  ref_id      uuid not null,

  token       text not null unique,
  revoked_at  timestamptz,
  expires_at  timestamptz,

  view_count  int not null default 0,
  last_seen_at timestamptz,

  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists share_links_store_idx on public.share_links (store_id, kind, ref_id);

alter table public.share_links enable row level security;

-- Staff manage their own store's links. The public does NOT read this table — a viewer only ever
-- reaches the read function below, which takes a token and returns one record.
create policy share_links_read on public.share_links
  for select to authenticated using (public.is_store_member(store_id));
create policy share_links_write on public.share_links
  for all to authenticated
  using (public.has_permission(store_id, 'sales.record'))
  with check (public.has_permission(store_id, 'sales.record'));

-- ─── Issue a link ───────────────────────────────────────────────────────────────────

create or replace function public.create_share_link(
  p_store_id  uuid,
  p_kind      text,
  p_ref_id    uuid,
  p_expires_in interval default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text;
begin
  if not public.has_permission(p_store_id, 'sales.record') then
    raise exception 'you do not have permission to share this' using errcode = '42501';
  end if;

  -- Reuse a live link for the same record rather than minting a second: two valid links to one
  -- receipt means revoking one leaves the other working, which is not what "revoke" should mean.
  select token into v_token
    from public.share_links
   where store_id = p_store_id and kind = p_kind and ref_id = p_ref_id
     and revoked_at is null
     and (expires_at is null or expires_at > now())
   limit 1;

  if v_token is not null then
    return v_token;
  end if;

  -- 16 random bytes, base64url. ~128 bits: not guessable, and short enough for a URL that gets
  -- pasted into a chat.
  v_token := translate(encode(gen_random_bytes(16), 'base64'), '+/=', '-_');

  insert into public.share_links (store_id, kind, ref_id, token, expires_at)
  values (p_store_id, p_kind, p_ref_id, v_token,
          case when p_expires_in is null then null else now() + p_expires_in end);

  return v_token;
end;
$$;

create or replace function public.revoke_share_link(p_token text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store uuid;
begin
  select store_id into v_store from public.share_links where token = p_token;
  if v_store is null then
    return;                      -- already gone; nothing to do and nothing to reveal
  end if;

  if not public.has_permission(v_store, 'sales.record') then
    raise exception 'you do not have permission to revoke this' using errcode = '42501';
  end if;

  update public.share_links set revoked_at = now() where token = p_token;
end;
$$;

-- ─── Read a shared receipt (public) ─────────────────────────────────────────────────
--
-- The only function `anon` may call. Takes a token, returns one receipt, and returns NULL for
-- anything expired, revoked or unknown — the same answer for all three, so the response cannot
-- be used to work out whether a token ever existed.
--
-- Note what is absent: unit_cost_at_sale, margin, and the customer's overall balance. Those are
-- the shop's business, and a receipt handed to a customer must not disclose buying prices.

create or replace function public.read_shared_receipt(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link  record;
  v_out   jsonb;
begin
  select * into v_link
    from public.share_links
   where token = p_token
     and kind = 'receipt'
     and revoked_at is null
     and (expires_at is null or expires_at > now());

  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'shop', jsonb_build_object(
      'name', st.name,
      'header', ss.receipt_header,
      'footer', ss.receipt_footer,
      'printer_width_mm', coalesce(ss.printer_width_mm, 80)
    ),
    'sale', jsonb_build_object(
      'id', s.id,
      'occurred_at', s.occurred_at,
      'total', s.total,
      'fee_amount', s.fee_amount,
      'fee_label', s.fee_label,
      'note', s.note,
      'transfer_details', s.transfer_details
    ),
    'customer', case when sc.id is null then null
                     else jsonb_build_object('name', sc.display_name) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sl.id,
        'product_name', p.name,
        'base_unit', p.base_unit,
        'entered_qty', sl.entered_qty,
        'pack_name', pk.name,
        'unit_price', sl.unit_price,
        'line_total', sl.line_total
      ) order by sl.created_at)
      from public.sale_lines sl
      join public.products p on p.id = sl.product_id
      left join public.product_packs pk on pk.id = sl.entered_pack_id
      where sl.sale_id = s.id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'amount', pa.amount, 'method', pay.method, 'occurred_at', pay.occurred_at
      ) order by pay.occurred_at)
      from public.payment_allocations pa
      join public.payments pay on pay.id = pa.payment_id
      where pa.sale_id = s.id
    ), '[]'::jsonb)
  )
  into v_out
  from public.sales s
  join public.stores st on st.id = s.store_id
  left join public.store_settings ss on ss.store_id = s.store_id
  left join public.store_customers sc on sc.id = s.store_customer_id
  where s.id = v_link.ref_id;

  -- Recorded so a shop can see a receipt was opened. Deliberately not an audit of WHO opened it:
  -- the viewer is not authenticated and pretending otherwise would be a false record.
  update public.share_links
     set view_count = view_count + 1, last_seen_at = now()
   where id = v_link.id;

  return v_out;
end;
$$;

grant execute on function public.create_share_link(uuid, text, uuid, interval) to authenticated;
grant execute on function public.revoke_share_link(text)                       to authenticated;

-- The one public entry point. anon may call this and nothing else.
grant execute on function public.read_shared_receipt(text) to anon, authenticated;

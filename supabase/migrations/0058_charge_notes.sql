-- ════════════════════════════════════════════════════════════════════════════════════════════
-- A note on the charge it belongs to
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- There has always been ONE note on a sale, which works while there is one thing to explain. A
-- receipt with a delivery fee and a crate deposit has two, and "kegs to Ojoo, 3 crates held back"
-- is a sentence that has to be split by whoever reads it later — usually the person arguing about
-- the bill weeks afterwards.
--
-- The sale's own note stays: it is for the sale, not for any one line of it.

alter table public.draft_order_charges add column if not exists note text;
alter table public.sale_charges       add column if not exists note text;

-- ─── Drafts carry it ────────────────────────────────────────────────────────────────

create or replace function public.save_draft_order(
  p_store_id     uuid,
  p_draft_id     uuid default null,
  p_customer_id  uuid default null,
  p_label        text default null,
  p_fee_amount   money_amt default 0,
  p_fee_label    text default null,
  p_note         text default null,
  p_client_uuid  uuid default null,
  p_lines        jsonb default '[]'::jsonb,
  p_charges      jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.has_permission(p_store_id, 'sales.record') then
    raise exception 'you do not have permission to record a sale' using errcode = '42501';
  end if;

  if p_draft_id is not null then
    update public.draft_orders
       set store_customer_id = p_customer_id,
           label             = p_label,
           fee_amount        = coalesce(p_fee_amount, 0),
           fee_label         = p_fee_label,
           note              = p_note,
           held_by           = auth.uid(),
           updated_at        = now()
     where id = p_draft_id and status = 'open'
    returning id into v_id;
  end if;

  if v_id is null then
    insert into public.draft_orders
      (store_id, code, store_customer_id, label, fee_amount, fee_label, note, client_uuid, held_by)
    values
      (p_store_id, public.generate_draft_code(p_store_id), p_customer_id, p_label,
       coalesce(p_fee_amount, 0), p_fee_label, p_note, p_client_uuid, auth.uid())
    on conflict (store_id, client_uuid) where client_uuid is not null
      do update set updated_at = now()
    returning id into v_id;
  end if;

  delete from public.draft_order_lines where draft_order_id = v_id;
  insert into public.draft_order_lines
    (draft_order_id, product_id, entered_qty, entered_pack_id, unit_price, line_total,
     containers_out, position)
  select v_id,
         (l ->> 'product_id')::uuid,
         (l ->> 'qty')::qty,
         nullif(l ->> 'pack_id', '')::uuid,
         (l ->> 'unit_price')::money_amt,
         (l ->> 'line_total')::money_amt,
         coalesce((l ->> 'containers_out')::qty, 0),
         (row_number() over ())::int
    from jsonb_array_elements(p_lines) l;

  -- NULL means "the caller did not mention charges", which must not wipe them; an empty array
  -- means "there are none left", which must.
  if p_charges is not null then
    delete from public.draft_order_charges where draft_order_id = v_id;
    insert into public.draft_order_charges (draft_order_id, label, amount, note, sort_order)
    select v_id,
           coalesce(nullif(trim(c ->> 'label'), ''), 'Charge'),
           (c ->> 'amount')::money_amt,
           nullif(trim(c ->> 'note'), ''),
           (row_number() over ())::int
      from jsonb_array_elements(p_charges) c
     where coalesce((c ->> 'amount')::money_amt, 0) > 0;
  end if;

  return v_id;
end;
$$;

grant execute on function public.save_draft_order(uuid, uuid, uuid, text, money_amt, text, text, uuid, jsonb, jsonb) to authenticated;

-- ─── And the readers hand it back ───────────────────────────────────────────────────

create or replace function public.my_open_drafts(p_store_id uuid)
returns table (
  id uuid, code text, share_token text, label text, customer_id uuid, customer_name text,
  note text, fee_amount money_amt, fee_label text, charges jsonb,
  created_at timestamptz, lines jsonb
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select
    d.id, d.code, d.share_token, d.label, d.store_customer_id, c.display_name,
    d.note, d.fee_amount, d.fee_label,
    coalesce((select jsonb_agg(jsonb_build_object(
                       'label', ch.label, 'amount', ch.amount, 'note', ch.note)
                     order by ch.sort_order)
                from public.draft_order_charges ch where ch.draft_order_id = d.id), '[]'::jsonb),
    d.created_at,
    coalesce((select jsonb_agg(jsonb_build_object(
                       'product_id', l.product_id, 'product_name', p.name,
                       'qty', l.entered_qty, 'pack_id', l.entered_pack_id,
                       'unit_price', l.unit_price, 'line_total', l.line_total)
                     order by l.position, l.created_at)
                from public.draft_order_lines l
                join public.products p on p.id = l.product_id
               where l.draft_order_id = d.id), '[]'::jsonb)
  from public.draft_orders d
  left join public.store_customers c on c.id = d.store_customer_id
  where d.store_id = p_store_id
    and d.status = 'open'
    and (d.held_by = auth.uid() or d.held_by is null)
    and public.has_permission(p_store_id, 'sales.record')
  order by d.created_at;
$$;

grant execute on function public.my_open_drafts(uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Two identifiers, because they do two different jobs
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- THE SHORT CODE IS SPOKEN. Five characters, read aloud across a counter, typed into the track
-- page by somebody standing in the shop. It has to be short to be sayable, which means there are
-- not many of them — so it is released when an order is settled or cancelled and the next order
-- takes it. That recycling is what makes five characters enough.
--
-- THE TOKEN IS SENT. It goes in a link on WhatsApp and sits in somebody's chat history for
-- months. It must never be reused, because a link that quietly starts pointing at a stranger's
-- order is a privacy failure, not an inconvenience.
--
-- Conflating them was a real bug, and it was mine: making the code follow its order through to the
-- receipt meant a customer's old link resolved to whichever order held that code NOW. Their
-- ₦4,500 of drinks would show somebody else's ₦85,000 delivery.
--
-- So: the code answers only while an order is OPEN, which is exactly the window in which anybody
-- would read it out, and is safe because a code is unique among open orders. The token answers
-- for the whole life of the order and afterwards — open, settled, cancelled — and is what every
-- shared link carries.

alter table public.draft_orders
  add column if not exists share_token text;

/*
 * Long, random, and never recycled.
 *
 * 24 characters from a 32-letter alphabet is far beyond guessing, and unlike the spoken code
 * nobody ever has to read it out — so there is no reason for it to be short.
 */
/*
 * URL-SAFE, because this string goes in a link.
 *
 * Plain base64 contains `+`, `/` and `=`: the slash ends a path segment and the plus is read as a
 * space by some clients, so a share link could arrive pointing at nothing at all. Same entropy,
 * characters that survive being sent.
 */
update public.draft_orders
   set share_token = translate(encode(gen_random_bytes(18), 'base64'), '+/=', '-_')
 where share_token is null;

alter table public.draft_orders
  alter column share_token
  set default translate(encode(gen_random_bytes(18), 'base64'), '+/=', '-_');

alter table public.draft_orders
  alter column share_token set not null;

create unique index if not exists draft_orders_share_token on public.draft_orders (share_token);

-- ─── The spoken code: open orders only ──────────────────────────────────────────────
--
-- Back to what it was before the mistake. A settled or cancelled order does not answer to its old
-- code, because that code may already belong to somebody else.

create or replace function public.public_track_order(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'code', d.code,
    'token', d.share_token,
    'status', d.status,
    'shop', st.name,
    'updated_at', d.updated_at,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', p.name, 'qty', l.entered_qty,
               'unit', coalesce(pk.name, p.base_unit),
               'unit_price', l.unit_price, 'line_total', l.line_total
             ) order by l.position)
        from public.draft_order_lines l
        join public.products p on p.id = l.product_id
        left join public.product_packs pk on pk.id = l.entered_pack_id
       where l.draft_order_id = d.id
    ), '[]'::jsonb),
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount) order by c.sort_order)
        from public.draft_order_charges c where c.draft_order_id = d.id
    ), '[]'::jsonb),
    'total', (
      coalesce((select sum(l.line_total) from public.draft_order_lines l
                 where l.draft_order_id = d.id), 0)
      + coalesce(d.fee_amount, 0)
      + coalesce((select sum(c.amount) from public.draft_order_charges c
                   where c.draft_order_id = d.id), 0)
    )
  )
  from public.draft_orders d
  join public.stores st on st.id = d.store_id
  where upper(d.code) = upper(trim(p_code))
    and d.status = 'open';
$fn$;

grant execute on function public.public_track_order(text) to anon, authenticated;

-- ─── The sent token: the whole life of the order ────────────────────────────────────
--
-- The same three answers the code used to give, on an identifier that is safe to keep: what is
-- being built, the receipt it became, or a plain sentence saying it was cancelled.

create or replace function public.public_track_token(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with found as (
    select d.*, st.name as shop_name
      from public.draft_orders d
      join public.stores st on st.id = d.store_id
     where d.share_token = trim(p_token)
  )
  select case
    when f.status = 'cancelled' then
      jsonb_build_object(
        'code', f.code, 'token', f.share_token, 'status', 'cancelled',
        'shop', f.shop_name, 'updated_at', f.updated_at
      )

    when f.status = 'settled' then
      jsonb_build_object(
        'code', f.code, 'token', f.share_token, 'status', 'settled',
        'shop', f.shop_name, 'updated_at', f.updated_at,
        'sale_id', f.settled_sale_id,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'name', p.name, 'qty', sl.entered_qty,
                   'unit', coalesce(pk.name, p.base_unit),
                   'unit_price', sl.unit_price, 'line_total', sl.line_total
                 ) order by sl.created_at)
            from public.sale_lines sl
            join public.products p on p.id = sl.product_id
            left join public.product_packs pk on pk.id = sl.entered_pack_id
           where sl.sale_id = f.settled_sale_id
        ), '[]'::jsonb),
        'total', coalesce((select s.total from public.sales s where s.id = f.settled_sale_id), 0),
        'paid', coalesce((
          select sum(pa.amount) from public.payment_allocations pa
           where pa.sale_id = f.settled_sale_id
        ), 0)
      )

    else
      jsonb_build_object(
        'code', f.code, 'token', f.share_token, 'status', f.status,
        'shop', f.shop_name, 'updated_at', f.updated_at,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'name', p.name, 'qty', l.entered_qty,
                   'unit', coalesce(pk.name, p.base_unit),
                   'unit_price', l.unit_price, 'line_total', l.line_total
                 ) order by l.position)
            from public.draft_order_lines l
            join public.products p on p.id = l.product_id
            left join public.product_packs pk on pk.id = l.entered_pack_id
           where l.draft_order_id = f.id
        ), '[]'::jsonb),
        'charges', coalesce((
          select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount) order by c.sort_order)
            from public.draft_order_charges c where c.draft_order_id = f.id
        ), '[]'::jsonb),
        'total', (
          coalesce((select sum(l.line_total) from public.draft_order_lines l
                     where l.draft_order_id = f.id), 0)
          + coalesce(f.fee_amount, 0)
          + coalesce((select sum(c.amount) from public.draft_order_charges c
                       where c.draft_order_id = f.id), 0)
        )
      )
  end
  from found f;
$fn$;

revoke all on function public.public_track_token(text) from public;
grant execute on function public.public_track_token(text) to anon, authenticated;

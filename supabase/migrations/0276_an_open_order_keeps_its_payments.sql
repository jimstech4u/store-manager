-- 0276 - An open order keeps the money being taken on it
--
-- "we need to persist (online still) for the part payments breakdown just like we did for charges
-- and deposit on an order because when we are working on one order and start the next, that data is
-- lost, so we need to ensure that all actions persist."
--
-- The charges and deposits have lived on the open order since 0053 and 0182. The payments did not:
-- ₦30,000 cash and ₦14,400 by transfer typed on Take payment lived in that page's own state, so
-- going to the next customer, a reload or a dead phone lost them, and the seller counted the money
-- again. They are stored the way the deposits are: a list on the order, replaced whole on each save,
-- NULL meaning "not mentioned" and an empty array meaning "none left".
--
-- `pay_choices` holds the rest of what was decided on that page and is not a payment: whether an
-- overpayment clears the old balance, whether the change is given now or owed, how it went back,
-- and the amount still in the box. A shape the client owns, so it is jsonb.
--
-- save_draft_order gains two trailing parameters with defaults. It is DROPPED and created again
-- rather than replaced, because a new signature beside the old one is the overload that made
-- PostgREST answer 300 to every till save (0058). Every caller passes arguments by name.

create table public.draft_order_payments (
  id              uuid primary key default gen_random_uuid(),
  draft_order_id  uuid not null references public.draft_orders(id) on delete cascade,
  method          text not null check (method in ('cash', 'transfer', 'pos')),
  amount          numeric not null check (amount > 0),
  reference       text,
  bank_account_id uuid references public.store_bank_accounts(id) on delete set null,
  sort_order      integer not null default 0
);
create index draft_order_payments_order on public.draft_order_payments (draft_order_id);
alter table public.draft_order_payments enable row level security;
create policy draft_payments_rw on public.draft_order_payments for all using (
  exists (select 1 from public.draft_orders d
           where d.id = draft_order_payments.draft_order_id and public.is_store_member(d.store_id)));

alter table public.draft_orders add column pay_choices jsonb;

drop function public.save_draft_order(uuid, jsonb, uuid, uuid, text, money_amt, text, text, uuid, jsonb, jsonb);

CREATE FUNCTION public.save_draft_order(p_store_id uuid, p_lines jsonb, p_draft_id uuid DEFAULT NULL::uuid, p_customer_id uuid DEFAULT NULL::uuid, p_label text DEFAULT NULL::text, p_fee_amount money_amt DEFAULT 0, p_fee_label text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_client_uuid uuid DEFAULT NULL::uuid, p_charges jsonb DEFAULT NULL::jsonb, p_deposits jsonb DEFAULT NULL::jsonb, p_payments jsonb DEFAULT NULL::jsonb, p_pay_choices jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id   uuid := p_draft_id;
  v_line jsonb;
  v_pos  int := 0;
begin
  if not public.has_permission(p_store_id, 'sales.record') then
    raise exception 'you do not have permission to record sales' using errcode = '42501';
  end if;

  if v_id is null and p_client_uuid is not null then
    select id into v_id from public.draft_orders where client_uuid = p_client_uuid;
  end if;

  if v_id is null then
    insert into public.draft_orders (store_id, store_customer_id, label, code,
                                     fee_amount, fee_label, note, held_by, client_uuid, pay_choices)
    values (p_store_id, p_customer_id, nullif(trim(p_label), ''),
            public.generate_draft_code(p_store_id),
            coalesce(p_fee_amount, 0), nullif(trim(p_fee_label), ''),
            nullif(trim(p_note), ''), auth.uid(), p_client_uuid, p_pay_choices)
    returning id into v_id;
  else
    update public.draft_orders
       set store_customer_id = p_customer_id,
           label      = nullif(trim(p_label), ''),
           fee_amount = coalesce(p_fee_amount, 0),
           fee_label  = nullif(trim(p_fee_label), ''),
           note       = nullif(trim(p_note), ''),
           -- Not mentioned keeps what is there, as with the charges.
           pay_choices = coalesce(p_pay_choices, pay_choices)
     where id = v_id and status = 'open';

    if not found then
      raise exception 'that order is no longer open' using errcode = '22023';
    end if;
  end if;

  -- Replace the lines wholesale: the client's copy is the truth for an open draft, and merging
  -- would need conflict rules for a workspace that has no concurrent editors by design.
  delete from public.draft_order_lines where draft_order_id = v_id;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    insert into public.draft_order_lines (draft_order_id, product_id, entered_qty,
                                          entered_pack_id, unit_price, line_total,
                                          containers_out, position, deposit_charged,
                                          sale_unit_id)
    values (v_id,
            (v_line ->> 'product_id')::uuid,
            (v_line ->> 'qty')::qty,
            nullif(v_line ->> 'pack_id', '')::uuid,
            (v_line ->> 'unit_price')::money_amt,
            (v_line ->> 'line_total')::money_amt,
            coalesce((v_line ->> 'containers_out')::qty, 0),
            v_pos,
            -- Missing means nothing was taken, which is what a shop sending containers out on
            -- trust has done. It is not the same as the till failing to ask, but the draft cannot
            -- tell those apart and must not invent a figure to cover the difference.
            coalesce((v_line ->> 'deposit_charged')::money_amt, 0),
            /*
             * RESOLVED, not merely checked (0148).
             *
             * `line_shape` accepts the real id, translates a retired mirror id, and fills the only
             * shape a product is sold in when none was given. A bare subquery returned NULL for an
             * id it did not recognise, which is not a rejection however the comment read, and every
             * line the till saved lost its shape silently.
             */
            public.line_shape((v_line ->> 'product_id')::uuid,
                              nullif(v_line ->> 'sale_unit_id', '')::uuid,
                              null));
    v_pos := v_pos + 1;
  end loop;

  -- Named charges, replaced wholesale each save.
  --
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

  /*
   * AND THE DEPOSITS, on exactly the same terms.
   *
   * The same NULL-versus-empty rule, and for the same reason: a caller that does not mention
   * deposits must not clear the ones already taken, and a seller who removes the last one must.
   *
   * Nothing wrote these before. The whole list lived in the browser, so the money a shop collects
   * against crates — the reason a container ever comes back — survived exactly as long as the tab
   * did.
   */
  if p_deposits is not null then
    delete from public.draft_order_deposits where draft_order_id = v_id;
    insert into public.draft_order_deposits (draft_order_id, amount, note, sort_order)
    select v_id,
           (d ->> 'amount')::money_amt,
           nullif(trim(d ->> 'note'), ''),
           (row_number() over ())::int
      from jsonb_array_elements(p_deposits) d
     where coalesce((d ->> 'amount')::money_amt, 0) > 0;
  end if;

  /*
   * AND THE PAYMENTS BEING TAKEN (0276), on the same terms again. Not money the shop has: that is
   * written when the sale settles, from what the till sends then. This is what was typed, kept so
   * it survives the next customer. A bank account that is not this shop's is dropped, not trusted.
   */
  if p_payments is not null then
    delete from public.draft_order_payments where draft_order_id = v_id;
    insert into public.draft_order_payments (draft_order_id, method, amount, reference,
                                             bank_account_id, sort_order)
    select v_id,
           p ->> 'method',
           (p ->> 'amount')::money_amt,
           nullif(trim(p ->> 'reference'), ''),
           (select b.id from public.store_bank_accounts b
             where b.id = nullif(p ->> 'bank_account_id', '')::uuid and b.store_id = p_store_id),
           (row_number() over ())::int
      from jsonb_array_elements(p_payments) p
     where coalesce((p ->> 'amount')::money_amt, 0) > 0
       and p ->> 'method' in ('cash', 'transfer', 'pos');
  end if;

  return v_id;
end;
$function$;

grant execute on function public.save_draft_order(uuid, jsonb, uuid, uuid, text, money_amt, text, text, uuid, jsonb, jsonb, jsonb, jsonb) to authenticated, service_role;

drop function public.my_open_drafts(uuid);

CREATE FUNCTION public.my_open_drafts(p_store_id uuid)
 RETURNS TABLE(id uuid, code text, share_token text, label text, customer_id uuid, customer_name text, note text, fee_amount money_amt, fee_label text, charges jsonb, deposits jsonb, created_at timestamp with time zone, lines jsonb, payments jsonb, pay_choices jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    d.id, d.code, d.share_token, d.label, d.store_customer_id, c.display_name,
    d.note, d.fee_amount, d.fee_label,
    coalesce((select jsonb_agg(jsonb_build_object(
                       'label', ch.label, 'amount', ch.amount, 'note', ch.note)
                     order by ch.sort_order)
                from public.draft_order_charges ch where ch.draft_order_id = d.id), '[]'::jsonb),
    -- The deposits taken on it, which until now had nowhere to be taken from.
    coalesce((select jsonb_agg(jsonb_build_object('amount', dp.amount, 'note', dp.note)
                     order by dp.sort_order)
                from public.draft_order_deposits dp where dp.draft_order_id = d.id), '[]'::jsonb),
    d.created_at,
    coalesce((select jsonb_agg(jsonb_build_object(
                       'product_id', l.product_id, 'product_name', p.name,
                       -- The word the shop counts this in when no shape is chosen.
                       'base_unit', p.base_unit,
                       'qty', l.entered_qty, 'pack_id', l.entered_pack_id,
                       'pack_name', pk.name, 'pack_qty', pk.base_unit_qty,
                       'unit_price', l.unit_price, 'line_total', l.line_total,
                       /*
                        * THE SHAPE, AND WHAT ONE OF THEM IS WORTH.
                        *
                        * The id alone is not enough: the till needs the word to show and the base
                        * quantity to price and to take off the shelf. Half a twelve-pack is six and
                        * no pack multiple expresses that, so `base_qty` comes from the shape rather
                        * than being derived from the pack.
                        *
                        * Missing all three is what turned a crate back into a piece on a reload —
                        * at the crate's unit price, so the bill fell by twelve and nothing on the
                        * screen looked wrong.
                        */
                       'sale_unit_id', l.sale_unit_id,
                       'sale_unit_name', su.name,
                       'sale_unit_base_qty', pu.base_qty,
                       -- Empties the customer is walking out with, and what was taken against
                       -- them. Both were dropped, so a reload stopped the shop owing the
                       -- containers and stopped it holding the cash.
                       'containers_out', l.containers_out,
                       'deposit_charged', l.deposit_charged)
                     order by l.position, l.created_at)
                from public.draft_order_lines l
                join public.products p on p.id = l.product_id
                left join public.product_packs pk on pk.id = l.entered_pack_id
                left join public.product_units pu on pu.id = l.sale_unit_id
                left join public.store_units su on su.id = pu.store_unit_id
               where l.draft_order_id = d.id), '[]'::jsonb),
    -- The payments being taken on it (0276), and what was decided about the change.
    coalesce((select jsonb_agg(jsonb_build_object(
                       'method', py.method, 'amount', py.amount, 'reference', py.reference,
                       'bank_account_id', py.bank_account_id)
                     order by py.sort_order)
                from public.draft_order_payments py where py.draft_order_id = d.id), '[]'::jsonb),
    d.pay_choices
  from public.draft_orders d
  left join public.store_customers c on c.id = d.store_customer_id
  where d.store_id = p_store_id
    and d.status = 'open'
    and (d.held_by = auth.uid() or d.held_by is null)
    and public.has_permission(p_store_id, 'sales.record')
  order by d.created_at;
$function$;

grant execute on function public.my_open_drafts(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

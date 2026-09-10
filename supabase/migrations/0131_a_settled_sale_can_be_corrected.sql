-- 0131 — A settled sale can be corrected, and the old copy knows it was
--
-- «if a receipt is settled and then changes wants to happen, we need a permitted role to be able to
--  make good correct changes with back traces and version because old receipt is printed with old
--  record, and new receipt needs to show that old one existed and could be wrong»
--
-- «when recalling a walk-in sale that did not have anyone, because of outstanding in empties or
--  money, it has to now be added with a customer»
--
-- Until now a settled receipt with one wrong line had exactly one path: void it and key it again.
-- That loses the receipt number the customer is holding, loses the payment allocation, loses the
-- tracking link, and produces two documents where the shop made one sale.
--
-- ─── REVERSE AND RE-APPLY, not edit ─────────────────────────────────────────────────
--
-- The correction is not a diff. Every current line is reversed exactly the way `void_sale` reverses
-- one, and the new lines are then applied exactly the way a fresh sale applies them. Two reasons:
--
--   * every step is an APPEND. `stock_movements` and `customer_empties` are append-only by design,
--     and a shop reading the trace sees the goods go out, come back, and go out again in the new
--     quantity — which is what actually happened as far as the books are concerned.
--   * a diff has to be right about every field to be right at all. Reverse-and-reapply is right by
--     construction, and it reuses two code paths that are already proved.
--
-- WHAT SURVIVES: the sale id, so the customer's tracking link keeps working; the receipt code; and
-- the PAYMENTS. Money that was handed over was handed over — the same rule `void_sale` established,
-- and for the same reason: the drawer is right.
--
-- ─── AND AN OBLIGATION NEEDS SOMEBODY TO OWE IT ─────────────────────────────────────
--
-- A walk-in sale is somebody at the counter taking their change and leaving. Correct it into
-- something that leaves money owing or containers out and there is nobody on the other end of it:
-- the debt can never be chased and the crates can never be settled, so they sit on the "still out"
-- list for ever. So the amendment REFUSES unless a customer is named — and naming one on a sale
-- that had none writes the container obligation that the walk-in never had.

create table if not exists public.sale_revisions (
  id          uuid primary key default gen_random_uuid(),
  sale_id     uuid not null references public.sales (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,

  /** Which revision this WAS. Revision 1 is the original document. */
  revision    int not null,

  /*
   * THE WHOLE DOCUMENT, rendered, not a diff to reconstruct.
   *
   * A printed receipt is a thing somebody is holding. Six weeks later "what did the copy in their
   * hand say" has to be answerable exactly, and rebuilding it from a chain of diffs against a
   * schema that has moved on is how it stops being answerable.
   */
  document    jsonb not null,

  reason      text not null,
  amended_by  uuid default auth.uid(),
  amended_at  timestamptz not null default now()
);

create index if not exists sale_revisions_sale_idx
  on public.sale_revisions (sale_id, revision desc);

comment on table public.sale_revisions is
  'What a receipt said before it was corrected. The full rendered document, because a customer is '
  'holding a printed copy and "what did theirs say" must be answerable exactly.';

drop trigger if exists no_mutation on public.sale_revisions;
create trigger no_mutation before update or delete on public.sale_revisions
  for each row execute function public.tg_append_only();

alter table public.sale_revisions enable row level security;

drop policy if exists sale_revisions_read on public.sale_revisions;
create policy sale_revisions_read on public.sale_revisions
  for select using (public.is_store_member(store_id));

drop policy if exists sale_revisions_none on public.sale_revisions;
create policy sale_revisions_none on public.sale_revisions
  for insert with check (false);

-- ─── What a receipt says right now, as one document ─────────────────────────────────

create or replace function public.sale_document(p_sale_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'sale_id',   s.id,
    'revision',  coalesce(s.revision, 1),
    'status',    s.status,
    'total',     s.total,
    'fee_amount', s.fee_amount,
    'fee_label',  s.fee_label,
    'note',      s.note,
    'occurred_at', s.occurred_at,
    'customer',  case when c.id is null then null
                      else jsonb_build_object('id', c.id, 'name', c.display_name) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id',   l.product_id,
               'product_name', p.name,
               'sale_unit_id', l.sale_unit_id,
               'unit_name',    su.name,
               'entered_qty',  l.entered_qty,
               'base_qty',     l.base_qty,
               'unit_price',   l.unit_price,
               'line_total',   l.line_total,
               'containers_out', l.containers_out
             ) order by p.name)
        from public.sale_lines l
        join public.products p on p.id = l.product_id
        left join public.product_units pu on pu.id = l.sale_unit_id
        left join public.store_units su on su.id = pu.store_unit_id
       where l.sale_id = s.id
    ), '[]'::jsonb)
  )
    from public.sales s
    left join public.store_customers c on c.id = s.store_customer_id
   where s.id = p_sale_id
     and public.is_store_member(s.store_id);
$fn$;

revoke all on function public.sale_document(uuid) from public;
grant execute on function public.sale_document(uuid) to authenticated;

-- ─── The correction ─────────────────────────────────────────────────────────────────

create or replace function public.amend_sale(
  p_sale_id     uuid,
  p_reason      text,
  p_lines       jsonb default null,
  p_customer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_sale     record;
  v_line     record;
  v_new      jsonb;
  v_customer uuid;
  v_total    money_amt := 0;
  v_paid     money_amt := 0;
  v_owing    money_amt;
  v_out      numeric := 0;
  v_prod     uuid;
  v_unit     uuid;
  v_entered  numeric;
  v_base     numeric;
  v_price    numeric;
  v_ltotal   numeric;
  v_cout     numeric;
  v_cost     unit_cost;
  v_line_id  uuid;
  v_rev      int;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    raise exception 'that sale does not exist' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_sale.store_id, 'sales.amend') then
    raise exception 'you do not have permission to correct a sale' using errcode = '42501';
  end if;

  if v_sale.status <> 'posted' then
    raise exception 'that sale is %, so there is nothing to correct', v_sale.status
      using errcode = '22023';
  end if;

  -- A reason, always. "Why does this receipt differ from the one I was given" is asked weeks later
  -- by somebody who was not there, and it is the part that settles the argument.
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'say why this receipt is being corrected' using errcode = '22023';
  end if;

  /*
   * NOT IF THE CONTAINERS HAVE STARTED COMING BACK.
   *
   * The same guard `void_sale` keeps, and for the same reason: reversing four crates when three
   * have already been handed in leaves the customer owing minus one, which means nothing and
   * cannot be chased. The way out is to finish settling first, and the message says so.
   */
  if exists (
    select 1 from public.customer_empties
     where ref_table = 'sale_lines'
       and ref_id in (select id from public.sale_lines where sale_id = p_sale_id)
       and direction in ('returned', 'damaged')
  ) then
    raise exception
      'Some of the containers on this receipt have already come back. Settle the rest first, then correct it.'
      using errcode = '22023';
  end if;

  v_customer := coalesce(p_customer_id, v_sale.store_customer_id);
  v_new      := coalesce(p_lines, (public.sale_document(p_sale_id) -> 'lines'));

  /*
   * AND THE CUSTOMER, IF ONE IS BEING ATTACHED, HAS TO BE THIS SHOP'S.
   *
   * Permission in a store answers "may this person act here", never "is this customer theirs" —
   * the hole 0097 and 0098 closed across the trade writers. Asked where no optional argument can
   * skip it.
   */
  if p_customer_id is not null then
    if not exists (
      select 1 from public.store_customers
       where id = p_customer_id and store_id = v_sale.store_id
    ) then
      raise exception 'that customer is not yours' using errcode = '42501';
    end if;
  end if;

  -- ─── Keep what it says now, before anything changes it ────────────────────────────
  v_rev := coalesce(v_sale.revision, 1);
  insert into public.sale_revisions (sale_id, store_id, revision, document, reason)
  values (p_sale_id, v_sale.store_id, v_rev, public.sale_document(p_sale_id), btrim(p_reason));

  -- ─── Reverse everything the sale did ──────────────────────────────────────────────
  --
  -- Exactly as `void_sale` does it: a second movement saying what happened next, never an edit to
  -- the first. The original is a fact about Tuesday and stays one.
  for v_line in select * from public.sale_lines where sale_id = p_sale_id
  loop
    if v_line.base_qty <> 0 then
      insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                          ref_table, ref_id, occurred_at, note)
      values (v_sale.store_id, v_line.product_id, 'adjustment', v_line.base_qty,
              v_line.unit_cost_at_sale, 'sales', p_sale_id, now(),
              'receipt corrected: ' || btrim(p_reason));
    end if;

    -- The containers this line owed are no longer owed in that quantity.
    insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                         direction, qty, reason, ref_table, ref_id, side)
    select ce.store_id, ce.store_customer_id, ce.product_id, ce.product_unit_id,
           'returned', ce.qty, 'receipt corrected: ' || btrim(p_reason), 'sale_lines', ce.ref_id,
           ce.side
      from public.customer_empties ce
     where ce.ref_table = 'sale_lines' and ce.ref_id = v_line.id and ce.direction = 'out';

    perform public.refresh_period(public.ensure_open_period(v_line.product_id));
  end loop;

  delete from public.sale_lines where sale_id = p_sale_id;

  -- ─── And apply what it should have said ───────────────────────────────────────────
  update public.sales
     set store_customer_id = v_customer
   where id = p_sale_id;

  /*
   * AND THE MONEY ALREADY PAID FOLLOWS IT ONTO THE ACCOUNT.
   *
   * A walk-in's payment carries no customer, because there was nobody to carry. Attach a customer
   * to the receipt and leave the payment behind and `customer_balance` bills them for the whole
   * amount while the ₦8,000 they actually handed over sits against nobody — so somebody who owes
   * ₦4,000 is shown owing ₦12,000, and would be chased for it.
   *
   * Only payments ALLOCATED to this receipt, and only when the sale had no customer before: a
   * payment already belonging to somebody is not this correction's business.
   */
  if v_sale.store_customer_id is null and v_customer is not null then
    update public.payments p
       set store_customer_id = v_customer
      from public.payment_allocations a
     where a.payment_id = p.id
       and a.sale_id = p_sale_id
       and p.store_customer_id is null;
  end if;

  for v_line in select * from jsonb_array_elements(v_new) as t(l)
  loop
    v_prod    := (v_line.l ->> 'product_id')::uuid;
    v_unit    := nullif(v_line.l ->> 'sale_unit_id', '')::uuid;
    v_entered := coalesce((v_line.l ->> 'entered_qty')::numeric, (v_line.l ->> 'qty')::numeric);
    v_base    := (v_line.l ->> 'base_qty')::numeric;
    v_price   := coalesce((v_line.l ->> 'unit_price')::numeric, 0);
    v_ltotal  := coalesce((v_line.l ->> 'line_total')::numeric, v_entered * v_price);
    v_cout    := coalesce((v_line.l ->> 'containers_out')::numeric, 0);

    if not exists (
      select 1 from public.products where id = v_prod and store_id = v_sale.store_id
    ) then
      raise exception 'one of these items is not yours' using errcode = '42501';
    end if;

    -- The shape has to belong to the product; a client-authored id is never trusted, and the base
    -- quantity is derived from it when the caller did not send one.
    if v_unit is not null then
      if not exists (
        select 1 from public.product_units where id = v_unit and product_id = v_prod
      ) then
        raise exception 'that shape does not belong to that item' using errcode = '22023';
      end if;
      if v_base is null then
        select v_entered * base_qty into v_base from public.product_units where id = v_unit;
      end if;
    end if;
    v_base := coalesce(v_base, v_entered);

    select coalesce(avg_unit_cost, 0) into v_cost from public.products where id = v_prod;

    insert into public.sale_lines (sale_id, product_id, sale_unit_id, entered_qty, base_qty,
                                   unit_price, line_total, unit_cost_at_sale, containers_out)
    values (p_sale_id, v_prod, v_unit, v_entered, v_base, v_price, v_ltotal, v_cost, v_cout)
    returning id into v_line_id;

    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at, note)
    values (v_sale.store_id, v_prod, 'sale', -v_base, v_cost, 'sales', p_sale_id, now(),
            'receipt corrected: ' || btrim(p_reason));

    perform public.refresh_period(public.ensure_open_period(v_prod));

    v_total := v_total + v_ltotal;
  end loop;

  v_total := v_total + coalesce(v_sale.fee_amount, 0);

  update public.sales
     set total        = v_total,
         revision     = v_rev + 1,
         amend_reason = btrim(p_reason),
         updated_at   = now()
   where id = p_sale_id;

  /*
   * ─── AND AN OBLIGATION NEEDS SOMEBODY TO OWE IT ─────────────────────────────────
   *
   * Checked AFTER the new lines are in, because whether one exists is a fact about the corrected
   * receipt and not about the old one. A walk-in sale corrected into something that leaves money
   * owing or containers out has nobody on the other end: the debt cannot be chased and the crates
   * cannot be settled, so they would sit on the "still out" list for ever.
   */
  /*
   * WHAT HAS BEEN PAID AGAINST THIS RECEIPT, through `payment_allocations`.
   *
   * `payments` has no `ref_table`/`ref_id` — a payment is a sum of money that arrived, and which
   * receipts it settles is a separate fact, because one payment can clear three receipts and one
   * receipt can take four payments. A first draft of this function read a `payments.ref_id` that
   * does not exist; plpgsql does not check column names until the body RUNS, so it applied cleanly
   * and would have failed on the first real correction.
   */
  select coalesce(sum(a.amount), 0) into v_paid
    from public.payment_allocations a
   where a.sale_id = p_sale_id;

  v_owing := v_total - v_paid;

  select coalesce(sum(containers_out), 0) into v_out
    from public.sale_lines where sale_id = p_sale_id;

  if v_customer is null and (v_owing > 0 or v_out > 0) then
    raise exception
      'This receipt now leaves % owing and % containers out. Add a customer, because there has to be somebody to owe it.',
      v_owing, v_out
      using errcode = '22023';
  end if;

  /*
   * THE CONTAINERS ARE ALREADY WRITTEN, by the trigger, and must not be written again.
   *
   * `tg_sale_line_owes_containers` (0117) fires on INSERT and returns early when the sale has no
   * customer. The customer is attached ABOVE, before the new lines go in — so by the time the
   * trigger sees them there is somebody to owe the crates, and it does the job itself.
   *
   * A first version also inserted them here "because the walk-in never had them", which doubled
   * every obligation on a corrected walk-in: three crates became six. The probe caught it as
   * «8, expected 2 + 3». Attaching the customer before the lines is what makes the extra insert
   * both unnecessary and wrong.
   */

  return jsonb_build_object(
    'sale_id',      p_sale_id,
    'revision',     v_rev + 1,
    'total',        v_total,
    'paid',         v_paid,
    'owing',        v_owing,
    'customer_id',  v_customer
  );
end;
$fn$;

revoke all on function public.amend_sale(uuid, text, jsonb, uuid) from public;
grant execute on function public.amend_sale(uuid, text, jsonb, uuid) to authenticated;

-- ─── Reading what it used to say ────────────────────────────────────────────────────

create or replace function public.sale_revision_history(p_sale_id uuid)
returns table (
  revision   int,
  document   jsonb,
  reason     text,
  amended_at timestamptz,
  amended_by uuid,
  actor_name text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select r.revision, r.document, r.reason, r.amended_at, r.amended_by, u.email::text
    from public.sale_revisions r
    join public.sales s on s.id = r.sale_id
    left join auth.users u on u.id = r.amended_by
   where r.sale_id = p_sale_id
     and public.is_store_member(s.store_id)
   order by r.revision desc;
$fn$;

revoke all on function public.sale_revision_history(uuid) from public;
grant execute on function public.sale_revision_history(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('amend_sale', 'sale_document', 'sale_revision_history')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'an amend function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$check$;

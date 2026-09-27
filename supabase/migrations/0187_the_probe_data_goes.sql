-- 0187 — The probe data goes
--
-- Two kinds of rubbish, both written by test scripts pointed at the live project.
--
-- ONE: 501 sales, 919 stock movements, 454 payments and 236 products belonging to 50 shops that
-- no longer exist. `sales.store_id` has a validated `ON DELETE CASCADE` to `stores`, so those rows
-- should have gone with their shop — which means the shops were deleted with the triggers
-- suppressed, exactly the way this file has to work. Nothing in the app can reach them, because
-- every query scopes by the caller's store; what they break is the ability to reconcile the
-- database as a whole, and any global figure anybody ever computes from it.
--
-- TWO: the probe rows inside the REAL shop. 200 of Ashabi's 218 customers and 107 of its 222
-- products are test data — "ZZ Milk 196567", "Irekanmi vjj1m", "Unrelated 53526", "AAA Renamed
-- 204959". Those DO show up: in the customer list a seller searches, in the product picker at the
-- counter, and in every count and report.
--
-- WHAT SURVIVES IN ASHABI, checked before writing this: customers Gabriel and Valuemart, and 24
-- real products — the drinks the shop actually sells. Everything removed here matches a probe
-- naming pattern; nothing that looks like trade does.
--
-- THE AUDIT LOG IS UNTOUCHED AND ITS TRIGGERS STAY ON, so this purge records itself.
--
-- THE APPEND-ONLY GUARD IS LIFTED AND PUT BACK. `stock_movements` and `customer_empties` refuse
-- DELETE by design, and rightly: a ledger you can quietly edit is not a ledger. This is the one
-- sanctioned exception — a deliberate, recorded purge of rows that were never trade — and the
-- trigger is re-enabled at the end whatever happens, so the guard is off only for this statement.

do $purge$
declare
  v_removed jsonb := '{}'::jsonb;
  v_n       bigint;
begin
  -- ─── Off, for the length of this block ───────────────────────────────────────────
  alter table public.stock_movements  disable trigger no_mutation;
  alter table public.customer_empties disable trigger no_mutation;

  /*
   * THE AUDIT TRIGGERS STAY ON, and the audit log is not touched.
   *
   * The first draft of this silenced them, to save writing a few hundred rows about a cleanup.
   * That is precisely backwards: a bulk delete of trade records is the single thing most worth
   * having in an audit log, and a purge that erases its own tracks is indistinguishable from one
   * somebody did quietly. The rows it writes are the point, not the cost.
   *
   * `audit_log` rows belonging to the deleted shops are left where they are for the same reason.
   * An audit log that only covers things that still exist is not an audit log.
   */

  -- ─── Who is doomed ───────────────────────────────────────────────────────────────
  --
  -- Shops that no longer exist, plus the half-made ones the setup probe left behind. Held in a
  -- temp table so every delete below reads the same list.
  create temporary table doomed_store (id uuid primary key) on commit drop;
  insert into doomed_store (id)
  select distinct s.store_id from public.sales s
   where not exists (select 1 from public.stores st where st.id = s.store_id)
  union
  select distinct p.store_id from public.products p
   where not exists (select 1 from public.stores st where st.id = p.store_id)
  union
  select distinct c.store_id from public.store_customers c
   where not exists (select 1 from public.stores st where st.id = c.store_id)
  union
  select st.id from public.stores st where st.name like 'ZZ Half Made %';

  /*
   * The probe rows inside shops that ARE real.
   *
   * Matched on how the probes name things, which is the only signal there is — nothing marks a row
   * as test data. A trailing run of five or more digits is the giveaway: every probe mints a name
   * with a random suffix so repeated runs do not collide, and no shop names a customer that way.
   */
  create temporary table doomed_customer (id uuid primary key) on commit drop;
  insert into doomed_customer (id)
  select c.id from public.store_customers c
   where c.store_id in (select id from doomed_store)
      or c.display_name like 'ZZ %'
      or c.display_name ~ '^(Irekanmi|Unrelated|Repro Person|Probe|AAA|Sample|Demo|Test)( |$)'
      or c.display_name ~ '[0-9]{5,}$';

  create temporary table doomed_product (id uuid primary key) on commit drop;
  insert into doomed_product (id)
  select p.id from public.products p
   where p.store_id in (select id from doomed_store)
      or p.name like 'ZZ %'
      or p.name ~ '^(AAA|Probe|Sample|Demo|Test)( |$)'
      or p.name ~ '[0-9]{5,}';

  create temporary table doomed_sale (id uuid primary key) on commit drop;
  insert into doomed_sale (id)
  select s.id from public.sales s
   where s.store_id in (select id from doomed_store)
      or s.store_customer_id in (select id from doomed_customer)
      or exists (select 1 from public.sale_lines l
                  where l.sale_id = s.id and l.product_id in (select id from doomed_product));

  -- ─── Sales, and everything hanging off them ──────────────────────────────────────
  --
  -- `draft_orders.settled_sale_id` is NO ACTION, so it has to let go by hand before the sale can
  -- be removed. Everything else on a sale cascades.
  update public.draft_orders set settled_sale_id = null
   where settled_sale_id in (select id from doomed_sale);

  delete from public.stock_movements
   where (ref_table = 'sales' and ref_id in (select id from doomed_sale))
      or product_id in (select id from doomed_product)
      or store_id in (select id from doomed_store);
  get diagnostics v_n = row_count; v_removed := v_removed || jsonb_build_object('stock_movements', v_n);

  delete from public.customer_empties
   where store_customer_id in (select id from doomed_customer)
      or product_id in (select id from doomed_product)
      or store_id in (select id from doomed_store);
  get diagnostics v_n = row_count; v_removed := v_removed || jsonb_build_object('customer_empties', v_n);

  delete from public.sale_lines where sale_id in (select id from doomed_sale)
      or product_id in (select id from doomed_product);
  get diagnostics v_n = row_count; v_removed := v_removed || jsonb_build_object('sale_lines', v_n);

  delete from public.sales where id in (select id from doomed_sale);
  get diagnostics v_n = row_count; v_removed := v_removed || jsonb_build_object('sales', v_n);

  -- ─── Money attached to a doomed customer ─────────────────────────────────────────
  delete from public.payments where store_customer_id in (select id from doomed_customer)
      or store_id in (select id from doomed_store);
  get diagnostics v_n = row_count; v_removed := v_removed || jsonb_build_object('payments', v_n);

  delete from public.deposit_ledger    where store_customer_id in (select id from doomed_customer);
  delete from public.deposit_forfeits  where store_customer_id in (select id from doomed_customer);
  delete from public.deposit_holdings  where store_customer_id in (select id from doomed_customer);
  delete from public.customer_charges  where store_customer_id in (select id from doomed_customer);
  delete from public.customer_deposits where store_customer_id in (select id from doomed_customer);
  delete from public.opening_balances  where store_customer_id in (select id from doomed_customer)
      or product_id in (select id from doomed_product);

  -- ─── Drafts and purchases, which RESTRICT on the product ─────────────────────────
  delete from public.draft_order_lines where product_id in (select id from doomed_product)
      or draft_order_id in (select d.id from public.draft_orders d
                             where d.store_id in (select id from doomed_store));
  delete from public.draft_orders where store_id in (select id from doomed_store)
      or store_customer_id in (select id from doomed_customer);
  get diagnostics v_n = row_count; v_removed := v_removed || jsonb_build_object('draft_orders', v_n);

  delete from public.purchase_lines where product_id in (select id from doomed_product)
      or purchase_id in (select pu.id from public.purchases pu
                          where pu.store_id in (select id from doomed_store));
  delete from public.purchases where store_id in (select id from doomed_store);
  delete from public.supplier_empties where product_id in (select id from doomed_product)
      or store_id in (select id from doomed_store);

  -- ─── And the rows themselves ─────────────────────────────────────────────────────
  delete from public.store_customers where id in (select id from doomed_customer);
  get diagnostics v_n = row_count; v_removed := v_removed || jsonb_build_object('store_customers', v_n);

  delete from public.products where id in (select id from doomed_product);
  get diagnostics v_n = row_count; v_removed := v_removed || jsonb_build_object('products', v_n);

  -- Anything left that is keyed only by a store that no longer exists.
  delete from public.store_units       where store_id in (select id from doomed_store);
  delete from public.empties_categories where store_id in (select id from doomed_store);
  delete from public.stores            where id in (select id from doomed_store);
  get diagnostics v_n = row_count; v_removed := v_removed || jsonb_build_object('stores', v_n);

  raise notice 'purged %', v_removed;

  -- ─── Back on ─────────────────────────────────────────────────────────────────────
  alter table public.stock_movements  enable trigger no_mutation;
  alter table public.customer_empties enable trigger no_mutation;
end
$purge$;

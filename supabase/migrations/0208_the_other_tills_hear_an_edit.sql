-- 0208 - The tables a shop edits are heard by the other tills too
--
-- "we can edit any data in the app and we want to ensure that site used or using are updating as
-- well ... shapes and all of that".
--
-- `useLiveShop` turns another till's writes into the same invalidations a write on this device
-- would have made, so every screen re-reads. It has always worked, and it has only ever been able
-- to hear ELEVEN tables. Everything the shop has spent this week correcting lives outside them:
--
--     product_units           a shape: its price, whether it is sold, whether it comes back
--     product_price_tiers     the cheaper price for taking more
--     product_sale_units      the mirror the storefront and `resolve_price` read
--     stock_layers            a lot's expiry date
--     product_categories      the makers
--     product_category_links  which maker a product belongs to
--     payment_allocations     which receipt a payment settles — a reversal removes one (0205)
--     purchases, suppliers    a delivery, and who it came from
--     identities              a customer's phone number
--
-- So a price changed on the back till stayed old on the front one until somebody happened to leave
-- a screen and come back. On one device it was always right — `catalogChanged` invalidates the
-- derived scope — which is exactly what makes this the kind of fault that gets reported as "it
-- sometimes shows the old figure" and never reproduces for the person looking.
--
-- SAFE TO PUBLISH: every one of these has row security enabled with policies, and realtime applies
-- row security — a member hears only rows they could already read. That is the same reasoning 0153
-- used for the first eleven.
--
-- The payload is never data. It is a signal that something changed; the screens re-read the
-- figures from the server, which stays the only source of them.

do $$
declare
  t text;
begin
  foreach t in array array[
    'product_units',
    'product_price_tiers',
    'product_sale_units',
    'stock_layers',
    'product_categories',
    'product_category_links',
    'payment_allocations',
    'purchases',
    'suppliers',
    'identities'
  ]
  loop
    -- Idempotent: adding a table already in the publication is an error, not a no-op.
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

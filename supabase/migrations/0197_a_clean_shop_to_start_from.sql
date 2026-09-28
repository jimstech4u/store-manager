-- 0197 — A clean shop to start from
--
-- Everything in this database so far was written to find bugs, and it did its job. It is not
-- trade. Before the shop enters its real inventory it wants the slate clear: the schema and the
-- shop stay, the data goes.
--
-- WHAT SURVIVES, and why each one:
--
--   · ASHABI GLOBAL RESOURCES and its `store_settings` — the shop itself, as asked.
--   · Its OWNER row in `store_members`. Delete this and the owner cannot sign in to the shop
--     they just cleared, which would be a very fast way to lose the whole thing.
--   · Its bank accounts. They print on receipts and were configured deliberately. There are five
--     duplicate Zenith rows among them from probe runs — left for the shop to tidy in Settings,
--     because guessing which one is the real one is not this migration's business.
--   · `roles`, `role_permissions` and `units` — the vocabulary the software ships with, not this
--     shop's data.
--   · `audit_log`, untouched. It is the one table whose whole purpose is to remember, and a reset
--     that erases the record of everything before it is not a reset anybody can audit afterwards.
--
-- WHAT GOES: every sale, payment, customer, product, shape, price, delivery, supplier, count,
-- empty, deposit, expense and draft — plus the config the probes invented along the way. Seventy
-- one measuring words including `OCrate040662` and `MUnit239958`, forty one empties pools, and
-- four `probe.gate…@ashabiglobal.sm` staff logins. The shop's own words are recreated by the
-- import that follows, so none of them is worth keeping either.
--
-- ON `session_replication_role`: seven tables refuse deletes by design and the audit trigger
-- writes into a table that references the store being deleted, so the ordinary path cannot do
-- this. `replica` suspends both for the length of this statement and is restored at the end. It
-- is the same mechanism `scripts/scenarios/harness.mjs` uses to drop its benchmark shop, and it
-- is why that file says never to point it at a real one. This is the exception, taken
-- deliberately and once.

do $reset$
declare
  v_keep_store uuid := '7138327c-c81c-4486-a97c-92207b48b64e';  -- ASHABI GLOBAL RESOURCES
  v_tbl        text;
  v_n          bigint;
  v_total      bigint := 0;
begin
  if not exists (select 1 from public.stores where id = v_keep_store) then
    raise exception 'the shop to keep is not here — refusing to wipe anything';
  end if;

  set session_replication_role = replica;

  /*
   * EVERY TABLE THAT BELONGS TO A SHOP, emptied — read from the catalogue rather than listed.
   *
   * A hand-written list is a list that goes stale the next time a table is added, and the failure
   * mode is silent: rows nobody meant to keep, surviving because nobody remembered them. The
   * keep-list is short and explicit instead, which is the half worth being careful about.
   */
  for v_tbl in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relname not in (
         -- The shop, its settings, its people and its banks.
         'stores', 'store_settings', 'store_members', 'store_member_permissions',
         'store_bank_accounts',
         -- What the software ships with, not what this shop typed.
         'roles', 'role_permissions', 'units',
         -- The record of everything that came before, which a reset must not erase.
         'audit_log',
         -- Supabase's own migration bookkeeping, if it lives here.
         'schema_migrations'
       )
     order by c.relname
  loop
    execute format('delete from public.%I where true', v_tbl);
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    if v_n > 0 then
      raise notice '  cleared % (% rows)', v_tbl, v_n;
    end if;
  end loop;

  -- ─── And the rows kept back from the tables above ────────────────────────────────

  -- Every other shop, including the half-made ones.
  delete from public.stores where id <> v_keep_store;

  -- Every membership that is not this shop's OWNER: the probe staff logins, and anybody
  -- belonging to a store that no longer exists.
  delete from public.store_member_permissions
   where store_id <> v_keep_store
      or user_id in (select user_id from public.store_members
                      where store_id = v_keep_store and role_code <> 'owner');
  delete from public.store_members
   where store_id <> v_keep_store
      or role_code <> 'owner';

  delete from public.store_settings where store_id <> v_keep_store;
  delete from public.store_bank_accounts where store_id <> v_keep_store;

  set session_replication_role = default;

  raise notice 'cleared % rows; % keeps its settings, its owner and its banks',
    v_total, (select name from public.stores where id = v_keep_store);
end
$reset$;

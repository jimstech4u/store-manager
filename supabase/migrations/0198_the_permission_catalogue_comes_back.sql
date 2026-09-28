-- 0198 — The permission catalogue comes back
--
-- 0197 cleared every table that was not on a short keep-list, and `public.permissions` was not on
-- it. That was a mistake: it is reference data the software ships with, exactly like `roles` and
-- `role_permissions`, not anything this shop typed.
--
-- WHAT IT BROKE, immediately and quietly. `member_permissions` cross-joins `permissions` to build
-- the set the UI asks `can()` about. With the table empty the cross join returns nothing, the
-- client receives an empty set rather than null, and `can()` answers false to everything — so the
-- OWNER opened Settings and read "Shop settings are changed by the owner. You are signed in as
-- Owner." Most of the screen was simply missing.
--
-- `role_permissions` survived only because 0197 ran under `session_replication_role = replica`,
-- which suspends foreign keys as well as triggers; the `on delete cascade` from `permissions`
-- never fired. So the grants were intact and pointing at rows that no longer existed. That is the
-- cost of that switch, and the reason to reach for it once and carefully.
--
-- Re-seeded from the migrations that introduced each code — 0001 for the original sixteen, then
-- 0029, 0129, 0137 and 0145 — so the descriptions are the ones the staff screen has always shown.
-- Idempotent, and it asserts at the end that every granted code has a row, because a grant
-- pointing at a missing permission is the state this is repairing.

insert into public.permissions (code, description) values
  ('store.settings',   'Change store settings'),
  ('staff.manage',     'Invite, remove and re-role staff'),
  ('products.manage',  'Create and edit products, packs and pricing'),
  ('stock.receive',    'Record incoming stock and purchases'),
  ('stock.count',      'Enter physical counts and close CRODS periods'),
  ('stock.adjust',     'Record damages, losses and adjustments'),
  ('variance.resolve', 'Resolve a CRODS variance with a reason code'),
  ('period.reopen',    'Break a closed-period seal'),
  ('sales.record',     'Record a sale'),
  ('sales.amend',      'Amend or void a recorded sale'),
  ('payments.record',  'Record a customer payment'),
  ('customers.manage', 'Create and edit customer records'),
  ('customers.merge',  'Merge duplicate customer identities'),
  ('deposits.manage',  'Record empties returns and deposit refunds'),
  ('backfill.manage',  'Enter and edit opening balances'),
  ('reports.view',     'View reports and margins'),
  ('records.confirm',  'Confirm products, customers and stock entered by others'),
  ('counts.correct',   'Change a shelf count after it has been entered, with a reason'),
  ('expenses.record',  'Record money the shop spends — rent, fuel, transport, wages'),
  ('staff.charge',     'Charge a staff member for missing stock or cash, and settle it')
on conflict (code) do update set description = excluded.description;

do $check$
declare
  v_orphans text;
begin
  select string_agg(distinct rp.permission_code, ', ')
    into v_orphans
    from public.role_permissions rp
   where not exists (select 1 from public.permissions p where p.code = rp.permission_code);

  if v_orphans is not null then
    raise exception 'these grants still point at no permission: %', v_orphans;
  end if;

  raise notice 'the catalogue holds % permissions, and every grant resolves',
    (select count(*) from public.permissions);
end
$check$;

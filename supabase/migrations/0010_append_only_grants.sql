-- =====================================================================================
-- 0010 — Make append-only a PRIVILEGE, not just a trigger
--
-- Found by auditing grants rather than by a failing test, which is the point: the tests pass
-- because the trigger fires, and a passing test made the hole invisible.
--
-- Supabase grants ALL privileges on public tables to `anon` and `authenticated` by default. So
-- although public.tg_append_only() blocks every UPDATE and DELETE on the ledger tables, the
-- PERMISSION to attempt one was still granted. That leaves the product's core guarantee resting
-- on a single trigger: drop it by accident in a future migration, or attach it to a new ledger
-- table and forget, and history silently becomes editable again.
--
-- STORE_MANAGER_PLAN.md (C1) committed to enforcing this by privilege specifically so that
-- correctness would not depend on anyone remembering. That commitment was written down and then
-- not implemented — this migration closes the gap.
--
-- Two independent defences now:
--   1. no UPDATE/DELETE privilege        — the server refuses before a statement is planned
--   2. tg_append_only()                  — catches anything holding privileges anyway,
--                                          including service_role, which bypasses RLS but not
--                                          triggers
--
-- INSERT and SELECT are deliberately untouched: appending is the whole point, and reading
-- history is what makes a dispute settleable.
-- =====================================================================================

do $$
declare
  t text;
  ledger_tables text[] := array[
    'stock_movements',
    'deposit_ledger',
    'deposit_forfeits',
    'variance_resolutions',
    'audit_log'
  ];
begin
  foreach t in array ledger_tables loop
    execute format(
      'revoke update, delete, truncate on public.%I from anon, authenticated',
      t
    );
  end loop;
end;
$$;

-- Also revoke from PUBLIC, which is a separate grantee from anon/authenticated: a privilege
-- held via PUBLIC applies to every role including future ones, so leaving it would quietly
-- re-open this for any role added later.
do $$
declare
  t text;
  ledger_tables text[] := array[
    'stock_movements',
    'deposit_ledger',
    'deposit_forfeits',
    'variance_resolutions',
    'audit_log'
  ];
begin
  foreach t in array ledger_tables loop
    execute format('revoke update, delete, truncate on public.%I from public', t);
  end loop;
end;
$$;

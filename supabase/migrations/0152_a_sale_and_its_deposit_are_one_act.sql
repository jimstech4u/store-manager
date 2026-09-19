-- 0152 — A sale and the deposit taken with it are recorded together, or not at all
--
-- Take payment settled the sale with `settle_draft_order`, and THEN took the deposit with a second
-- call. Two transactions for one event: a deposit call that failed — a dropped connection, a
-- permission, anything — left the sale settled and the deposit nowhere, while the seller was holding
-- the customer's money. The screen reported an error, and pressing the button again settled nothing
-- new (the sale is idempotent) and took the deposit on a sale it could no longer see.
--
-- `settle_draft_with_deposit` does both in ONE transaction by calling the two writers that already exist, so each
-- keeps every check it has. If either refuses, neither is written.
--
-- RETRY-SAFE. `settle_draft_order` answers a repeat with the sale already recorded rather than
-- selling twice. The deposit follows the same rule: it is taken only by the call that actually
-- settles the order. A retry after a timeout finds the order already settled — by a transaction that
-- also took the deposit, because they were one — and takes nothing more.

create or replace function public.settle_draft_with_deposit(
  p_draft_id       uuid,
  p_payments       jsonb,
  p_occurred_at    timestamptz default null,
  p_client_uuid    uuid default null,
  p_deposit        money_amt default null,
  p_deposit_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_already  boolean;
  v_store    uuid;
  v_customer uuid;
  v_sale     uuid;
begin
  -- Locked, so two tills pressing the button at once queue here rather than both deciding they are
  -- the one that settles.
  select d.status = 'settled', d.store_id, d.store_customer_id
    into v_already, v_store, v_customer
    from public.draft_orders d
   where d.id = p_draft_id
     for update;

  -- The time is the server's unless one was given: `settle_draft_order` passes its argument straight
  -- through, so an explicit NULL here would reach the sale rather than fall back to its default.
  v_sale := public.settle_draft_order(
    p_draft_id, p_payments, coalesce(p_occurred_at, now()), p_client_uuid);

  if not coalesce(v_already, false) and coalesce(p_deposit, 0) > 0 then
    if v_customer is null then
      raise exception 'A deposit needs a customer to hold it for.' using errcode = '22023';
    end if;
    perform public.take_customer_deposit(v_store, v_customer, p_deposit, nullif(trim(p_deposit_reason), ''), null);
  end if;

  return v_sale;
end;
$fn$;

revoke all on function public.settle_draft_with_deposit(uuid, jsonb, timestamptz, uuid, money_amt, text) from public;
grant execute on function public.settle_draft_with_deposit(uuid, jsonb, timestamptz, uuid, money_amt, text) to authenticated;

do $check$
begin
  if (select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
       where ns.nspname = 'public' and pr.proname = 'settle_draft_with_deposit') <> 1 then
    raise exception 'settle_draft_with_deposit has more than one overload';
  end if;
end;
$check$;

-- 0151 — Broken or lost can take a damages fee, in the same breath
--
-- «we could save the user the stress of the double entries in both places to balance the account …
--  a check box in 'broken or lost' that says take damages fee for it, so when checked the amount box
--  shows up … this creates a record in deposit just like how 'keep some for breakage' is: how much =
--  4000, and why = the shapes entered (1 crate, 3 bottles) and the user's description»
--
-- Two ledgers, one event. A customer loses a crate of Goldberg and pays ₦4,000 for it. Until now
-- that was two separate entries on two screens — "Broken or lost" on the empties side, "Keep some for
-- breakage" on the deposit side — typed twice, described twice, and balanced by whoever remembered to
-- do the second one. Forgetting it leaves the containers written off and the money nowhere, which is
-- exactly the gap an account like this exists to close.
--
-- `write_off_empties` does both, in ONE transaction, by calling the writers that already exist. Each
-- keeps every check it has (permission, the customer is this shop's, the shape comes back, not more
-- than is owed, not more deposit than is held), so nothing is re-implemented and nothing is loosened.
-- If any part is refused, none of it is written.
--
-- WHERE THE FEE COMES FROM:
--   · out of their deposit, as far as it goes — recorded exactly as "Keep some for breakage" is: a
--     'retained' deposit row, income to the shop;
--   · anything beyond what is held is ADDED TO WHAT THEY OWE, as a charge on their account. Refusing
--     would be refusing a fee the customer has agreed to pay, and silently capping it at the deposit
--     would lose the rest.
--
-- Both money rows carry the same words: what was written off, in its shapes, and what happened —
-- "Goldberg 60cl: 1 crate 3 bottles — Customer lost it". The containers rows carry what happened.

create or replace function public.write_off_empties(
  p_store_id    uuid,
  p_customer_id uuid,
  p_parts       jsonb,
  p_reason      text,
  p_said        text,
  p_fee         money_amt default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_part    jsonb;
  v_rows    int := 0;
  v_held    numeric;
  v_kept    numeric := 0;
  v_charged numeric := 0;
  v_words   text;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Say what happened to them.' using errcode = '22023';
  end if;
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0 then
    raise exception 'Say which containers, and how many.' using errcode = '22023';
  end if;

  -- The containers. Every check `record_customer_empties` makes still applies to each part.
  for v_part in select * from jsonb_array_elements(p_parts)
  loop
    perform public.record_customer_empties(
      p_store_id,
      p_customer_id,
      (v_part ->> 'product_unit_id')::uuid,
      'damaged',
      (v_part ->> 'qty')::qty,
      trim(p_reason),
      null, null, null,
      'they_hold'
    );
    v_rows := v_rows + 1;
  end loop;

  -- The fee, when there is one.
  if coalesce(p_fee, 0) > 0 then
    v_words := coalesce(nullif(trim(p_said), '') || ' — ', '') || trim(p_reason);

    select coalesce(sum(case when direction = 'taken' then amount else -amount end), 0)
      into v_held
      from public.customer_deposits
     where store_customer_id = p_customer_id;

    v_kept := least(p_fee, greatest(v_held, 0));
    v_charged := p_fee - v_kept;

    if v_kept > 0 then
      perform public.settle_customer_deposit(
        p_store_id, p_customer_id, v_kept::money_amt, true, v_words, null);
    end if;

    if v_charged > 0 then
      perform public.record_customer_charge(
        p_store_id, p_customer_id, v_charged::money_amt,
        'Damages: ' || v_words, false, null);
    end if;
  end if;

  return jsonb_build_object('parts', v_rows, 'kept', v_kept, 'charged', v_charged);
end;
$fn$;

revoke all on function public.write_off_empties(uuid, uuid, jsonb, text, text, money_amt) from public;
grant execute on function public.write_off_empties(uuid, uuid, jsonb, text, text, money_amt) to authenticated;

do $check$
begin
  if (select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
       where ns.nspname = 'public' and pr.proname = 'write_off_empties') <> 1 then
    raise exception 'write_off_empties has more than one overload';
  end if;
end;
$check$;

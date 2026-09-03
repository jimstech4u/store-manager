-- 0090 — What happened to the ones that did not come back
--
-- «log what came back maybe 5 NBL crate and 3 bottles of goldberg and then we get asked for where
--  the 9 pieces so we can enter money paid for it or on trust»
--
-- Settling empties could record two of the three things that happen to a container. It came back.
-- It is still owed. Or it is GONE — and the only version of gone the function understood was one
-- covered by a deposit the shop was holding.
--
-- The commonest case in this trade is the other one: nothing was held, the containers went out on
-- trust, some are broken, and the customer pays for them at the counter. There was nowhere to put
-- that. The money had no record and the containers stayed outstanding for ever against a customer
-- who had already settled, so a shop's "still out" list quietly filled with obligations nobody
-- owed and nobody could clear.
--
-- `deposit_forfeits` has existed since 0004 for precisely this and has never once been written to —
-- a table, a trigger, an RLS policy and no writer. This is its writer.

CREATE OR REPLACE FUNCTION public.settle_empties(p_store_id uuid, p_sale_id uuid, p_returned jsonb DEFAULT '[]'::jsonb, p_apply_amount money_amt DEFAULT 0, p_refund_amount money_amt DEFAULT 0, p_refund_mode text DEFAULT 'cash'::text, p_note text DEFAULT NULL::text, p_occurred_at timestamp with time zone DEFAULT now(), p_paid_for jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_customer uuid;
  v_row      jsonb;
  v_cat      uuid;
  v_qty      qty;
  v_out      qty;
  v_returned qty := 0;
  v_held     money_amt;
  v_payment  uuid;
  v_shapes   text;
  v_paid     jsonb;    -- one pool's worth of "they will not be coming back"
  v_amount   money_amt;
  v_forfeit  qty := 0;
  v_income   money_amt := 0;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to settle empties' using errcode = '42501';
  end if;

  if p_refund_mode not in ('cash', 'credit', 'none') then
    raise exception 'unknown refund mode %', p_refund_mode using errcode = '22023';
  end if;

  select store_customer_id into v_customer
    from public.sales
   where id = p_sale_id and store_id = p_store_id;

  if v_customer is null then
    raise exception 'that receipt has no customer, so it has no empties account'
      using errcode = '22023';
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_returned, '[]'::jsonb))
  loop
    v_cat := (v_row ->> 'category_id')::uuid;
    v_qty := (v_row ->> 'qty')::qty;

    if v_qty is null or v_qty <= 0 then
      continue;
    end if;

    v_out := public.empties_outstanding(v_customer, v_cat);
    if v_qty > v_out then
      raise exception 'they owe % of that pool but % were offered', v_out, v_qty
        using errcode = '22023';
    end if;

    /*
     * THE SHAPE, not just the number.
     *
     * A shop that takes crates back whole does not want seven loose bottles recorded as settled —
     * it wants to be told, at the counter, while the customer is still there. The message names the
     * shapes it does take, because "not allowed" without them is a dead end.
     */
    if not public.return_is_allowed(v_cat, v_qty) then
      select string_agg(ru.name || ' (' || ru.base_qty || ')', ', ' order by ru.base_qty desc)
        into v_shapes
        from public.empties_return_units ru
       where ru.empties_category_id = v_cat;

      raise exception 'These come back in whole units: %. % does not make one.', v_shapes, v_qty
        using errcode = '22023';
    end if;

    insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                       direction, qty_units, deposit_per_unit,
                                       ref_table, ref_id, occurred_at, note)
    values (p_store_id, v_customer, v_cat, 'collected', -v_qty, 0,
            'sales', p_sale_id, p_occurred_at, coalesce(p_note, 'empties returned'));

    v_returned := v_returned + v_qty;
  end loop;

  /*
   * ─── AND THE ONES THAT ARE NOT COMING BACK ────────────────────────────────────────
   *
   * «we get asked for where the 9 pieces so we can enter money paid for it or on trust»
   *
   * Three things can happen to a container that did not return, and until now the screen could only
   * record one of them. It came back — handled above. It is still owed, and the customer will bring
   * it — handled by doing nothing, which is right. Or it is GONE, and either the customer paid for
   * it or the shop keeps part of the deposit it is holding.
   *
   * The deposit case already worked, through `p_apply_amount`. This is the other one: nothing was
   * held, the customer hands over money for what they broke or lost, and there was nowhere to put
   * it. So the containers stayed "still out" for ever, on a customer who had already settled — and
   * the shop's outstanding list slowly filled with obligations nobody owed.
   *
   * `deposit_forfeits` has existed since 0004 for exactly this and has never had a writer. Its own
   * comment says why it is a table rather than a subtraction: "it is income, and money that simply
   * vanished from a balance is money nobody can explain during a dispute."
   *
   * NO PAYMENT ROW. The money is not a payment against a sale or a balance — allocating it would
   * pay down whatever the customer happens to owe, which is not what they handed it over for. The
   * forfeit is the record of both the containers and the money.
   */
  for v_paid in select * from jsonb_array_elements(coalesce(p_paid_for, '[]'::jsonb))
  loop
    v_cat    := (v_paid ->> 'category_id')::uuid;
    v_qty    := (v_paid ->> 'qty')::qty;
    v_amount := coalesce((v_paid ->> 'amount')::money_amt, 0);

    -- Zero is a real answer everywhere else in this app; here it is not. A forfeit of nothing is
    -- not an event, and `deposit_forfeits` refuses it — `check (qty_units > 0)`.
    if v_qty is null or v_qty <= 0 then
      continue;
    end if;

    v_out := public.empties_outstanding(v_customer, v_cat);
    if v_qty > v_out then
      raise exception 'they owe % of that pool but % were written off', v_out, v_qty
        using errcode = '22023';
    end if;

    /*
     * DELIBERATELY NOT SHAPE-CHECKED.
     *
     * A return has to be a whole crate because that is how a crate goes back on a pallet. A
     * breakage is nine bottles, and telling a shop that nine is not a shape it accepts would be
     * refusing to record something that has already happened.
     */
    insert into public.deposit_forfeits (store_id, store_customer_id, empties_category_id,
                                         qty_units, amount, note, occurred_at)
    values (p_store_id, v_customer, v_cat, v_qty, v_amount,
            coalesce(p_note, 'paid for, not coming back'), p_occurred_at);

    -- And out of what they owe, because they no longer owe it.
    insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                       direction, qty_units, deposit_per_unit,
                                       ref_table, ref_id, occurred_at, note)
    values (p_store_id, v_customer, v_cat, 'collected', -v_qty, 0,
            'sales', p_sale_id, p_occurred_at,
            coalesce(p_note, 'paid for, not coming back'));

    v_forfeit := v_forfeit + v_qty;
    v_income  := v_income + v_amount;
  end loop;

  select coalesce(sum(amount), 0) into v_held
    from public.deposit_holdings
   where ref_table = 'sales' and ref_id = p_sale_id;

  if p_apply_amount + p_refund_amount > v_held then
    raise exception 'only % is held against that receipt, but % was accounted for',
      v_held, p_apply_amount + p_refund_amount using errcode = '22023';
  end if;

  if p_apply_amount > 0 then
    insert into public.deposit_holdings (store_id, store_customer_id, amount, reason,
                                         ref_table, ref_id, note, occurred_at)
    values (p_store_id, v_customer, -p_apply_amount, 'applied_to_shortfall',
            'sales', p_sale_id, p_note, p_occurred_at);
  end if;

  if p_refund_amount > 0 and p_refund_mode <> 'none' then
    insert into public.deposit_holdings (store_id, store_customer_id, amount, reason,
                                         ref_table, ref_id, note, occurred_at)
    values (p_store_id, v_customer, -p_refund_amount, 'refunded',
            'sales', p_sale_id, p_note, p_occurred_at);

    insert into public.payments (store_id, store_customer_id, amount, method, direction,
                                 reference, occurred_at)
    values (p_store_id, v_customer, p_refund_amount, 'other',
            case when p_refund_mode = 'credit' then 'in' else 'out' end,
            'Deposit settled on receipt', p_occurred_at)
    returning id into v_payment;
  end if;

  return jsonb_build_object(
    'returned_units', v_returned,
    'written_off_units', v_forfeit,
    'paid_for', v_income,
    'applied', p_apply_amount,
    'refunded', p_refund_amount,
    'still_held', v_held - p_apply_amount - p_refund_amount,
    'payment_id', v_payment
  );
end;
$function$;

-- The old signature has to go, or PostgREST sees two and answers 300 to every call — the failure
-- that stopped the till in 0058.
drop function if exists public.settle_empties(uuid, uuid, jsonb, money_amt, money_amt, text, text,
                                              timestamptz);

revoke all on function public.settle_empties(uuid, uuid, jsonb, money_amt, money_amt, text, text,
                                             timestamptz, jsonb) from public;
grant execute on function public.settle_empties(uuid, uuid, jsonb, money_amt, money_amt, text, text,
                                                timestamptz, jsonb) to authenticated;

do $check$
declare n int;
begin
  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'settle_empties';
  if n <> 1 then
    raise exception 'settle_empties has % overloads; every call would answer 300', n;
  end if;
end;
$check$;

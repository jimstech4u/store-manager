"""Add the products and empties pools the Irekanmi walkthrough needs.

Shop CONFIGURATION only — the catalogue a distributor would have set up before serving anybody.
The scenario itself (the customer, what they already owed, the sale, the settle, the empties that
did and did not come back) is deliberately NOT seeded: it is driven through the UI, because the
question being answered is whether a person can actually do this at a counter, and a seed proves
nothing about that.

Idempotent. Running it twice changes nothing.
"""
import io
import json
import sys
import urllib.request
import urllib.error

REF = "zinhzpgprhhqmyxmchhm"


def env(name):
    for line in io.open(".env.local", encoding="utf-8"):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


def run_sql(query):
    req = urllib.request.Request(
        "https://api.supabase.com/v1/projects/{}/database/query".format(REF),
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": "Bearer {}".format(env("SUPABASE_ACCESS_TOKEN")),
                 "User-Agent": "curl/8.4.0", "Content-Type": "application/json", "Accept": "*/*"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            body = r.read().decode()
            return json.loads(body) if body.strip() else []
    except urllib.error.HTTPError as e:
        sys.exit("sql failed: {} {}".format(e.code, e.read().decode()[:900]))


SQL = r"""
do $seed$
declare
  v_store uuid;
  v_uid   uuid;
  v_p     uuid;
  v_unit  uuid;
  v_cat   uuid;
begin
  select s.id, s.created_by into v_store, v_uid
    from public.stores s where s.name = 'ASHABI GLOBAL RESOURCES';
  if v_store is null then
    raise exception 'sample store not found — run seed-sample-store.py first';
  end if;

  -- Act as the owner so every RPC's permission check is exercised rather than bypassed.
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);

  -- ── Empties pools ───────────────────────────────────────────────────────────────
  --
  -- Trophy and Goldberg are both Nigerian Breweries, so they share ONE crate pool: a Goldberg
  -- crate settles a Trophy crate. That fungibility is the whole reason the obligation is tracked
  -- per pool and not per product.

  insert into public.empties_categories (store_id, name, kind, deposit)
  values (v_store, 'Guinness bottle', 'content', 150)
  on conflict (store_id, name) do nothing;

  insert into public.empties_categories (store_id, name, kind, deposit)
  values (v_store, 'Dispenser water bottle', 'container', 2000)
  on conflict (store_id, name) do nothing;

  -- ── Trophy: sold by the crate and the half crate ────────────────────────────────

  select id into v_p from public.products
   where store_id = v_store and name = 'Trophy 60cl';
  if v_p is null then
    v_p := public.create_product(v_store, 'Trophy 60cl', 'piece', 'Crate', 12, 8200, true);
    insert into public.product_sale_units (product_id, name, base_qty, price, sort_order)
    values (v_p, 'Crate', 12, 8200, 0),
           (v_p, 'Half crate', 6, 4100, 1);
    perform public.backfill_stock(v_store, v_p, 600, 620, current_date, true);
  end if;

  -- ── Goldberg ────────────────────────────────────────────────────────────────────

  select id into v_p from public.products
   where store_id = v_store and name = 'Goldberg 60cl';
  if v_p is null then
    v_p := public.create_product(v_store, 'Goldberg 60cl', 'piece', 'Crate', 12, 9000, true);
    insert into public.product_sale_units (product_id, name, base_qty, price, sort_order)
    values (v_p, 'Crate', 12, 9000, 0),
           (v_p, 'Half crate', 6, 4500, 1);
    perform public.backfill_stock(v_store, v_p, 720, 700, current_date, true);
  end if;

  -- ── American Cola: the bulk ladder ──────────────────────────────────────────────
  --
  -- ₦3,700 each, dropping to ₦3,600 from the sixth onwards. Entered as a tier rather than left to
  -- the seller to remember, because "we take ₦100 off over five" is a shop RULE and a rule a
  -- person has to apply by hand is a rule that gets applied inconsistently.

  select id into v_p from public.products
   where store_id = v_store and name = 'American Cola PET 60cl';
  if v_p is null then
    v_p := public.create_product(v_store, 'American Cola PET 60cl', 'piece', 'Bottle', 1, 3700, true);
    insert into public.product_sale_units (product_id, name, base_qty, price, sort_order)
    values (v_p, 'Bottle', 1, 3700, 0)
    returning id into v_unit;

    insert into public.product_price_tiers (product_id, sale_unit_id, min_qty, max_qty, price)
    values (v_p, v_unit, 6, 1000, 3600);

    perform public.backfill_stock(v_store, v_p, 400, 3300, current_date, true);
  end if;

  raise notice 'scenario catalogue ready';
end;
$seed$;
"""


def main():
    run_sql(SQL)

    rows = run_sql("""
      select p.name,
             coalesce(pk.name, '-')            as pack,
             coalesce(pk.base_unit_qty, 0)     as pack_qty,
             coalesce(pr.price, 0)             as price,
             coalesce((select sum(m.qty_delta) from public.stock_movements m
                        where m.product_id = p.id), 0) as on_hand,
             (select count(*) from public.product_sale_units u where u.product_id = p.id) as units,
             (select count(*) from public.product_price_tiers t where t.product_id = p.id) as tiers
        from public.products p
        left join public.product_packs pk on pk.id = p.default_display_pack_id
        left join public.product_prices pr on pr.product_id = p.id and pr.pack_id = pk.id
       where p.store_id = (select id from public.stores where name = 'ASHABI GLOBAL RESOURCES')
         and p.status = 'active'
       order by p.name
    """)
    print("catalogue:")
    for r in rows:
        print("  {name:28} {pack:6} x{pack_qty:<5} price {price:>9}  on hand {on_hand:>7}"
              "  units {units}  tiers {tiers}".format(**r))

    pools = run_sql("""
      select name, kind, deposit from public.empties_categories
       where store_id = (select id from public.stores where name = 'ASHABI GLOBAL RESOURCES')
       order by name
    """)
    print("\nempties pools:")
    for p in pools:
        print("  {name:26} {kind:10} deposit {deposit}".format(**p))


if __name__ == "__main__":
    main()

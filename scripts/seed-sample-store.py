"""Create the sample shop from .env.local, so the marketplace has something real in it.

Deliberately a script and not a migration: sample data is not schema, and a migration that
inserted a real business's bank details would run on every environment, including a customer's.

Idempotent — running it twice does nothing the second time.
"""
import json
import io
import os
import sys
import urllib.request
import urllib.error

REF = "zinhzpgprhhqmyxmchhm"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def env(name):
    path = os.path.join(HERE, ".env.local")
    for line in io.open(path, encoding="utf-8"):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


def run_sql(query):
    req = urllib.request.Request(
        "https://api.supabase.com/v1/projects/{}/database/query".format(REF),
        data=json.dumps({"query": query}).encode(),
        headers={
            "Authorization": "Bearer {}".format(env("SUPABASE_ACCESS_TOKEN")),
            "User-Agent": "curl/8.4.0",
            "Content-Type": "application/json",
            "Accept": "*/*",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            body = r.read().decode()
            return json.loads(body) if body.strip() else []
    except urllib.error.HTTPError as e:
        sys.exit("failed: {} {}".format(e.code, e.read().decode()[:700]))


def q(value):
    """Quote a literal for SQL.

    These values come from a local env file rather than a user, but building SQL by
    concatenation without escaping is not a habit worth keeping — a shop name with an
    apostrophe would otherwise break the seed.
    """
    if value is None or value == "":
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def main():
    email = env("SAMPLE_EMAIL")
    password = env("SAMPLE_PASSWORD")
    if not email or not password:
        sys.exit("SAMPLE_EMAIL / SAMPLE_PASSWORD missing from .env.local")

    store_name = env("SAMPLE_STORE") or "Sample Shop"
    description = (env("DESCRIPTION") or "").strip().rstrip(",").strip()
    location = (env("SAMPLE_LOCATION") or "").strip()
    phones = (env("SAMPLE_PHONE") or "").strip()
    paper = (env("PAPER_SIZE") or "80mm").replace("mm", "").strip() or "80"

    header = location + ((" | " + phones) if phones else "")

    script = """
do $seed$
declare
  v_uid   uuid;
  v_store uuid;
  v_cat_pet uuid; v_cat_beer uuid; v_cat_can uuid;
  v_p uuid; v_unit uuid;
  v_nbl uuid; v_crate uuid;
begin
  -- The owner account, confirmed immediately: this is seeded sample data, and leaving it
  -- waiting on an email would make the sample unusable.
  select id into v_uid from auth.users where email = {email};
  if v_uid is null then
    v_uid := gen_random_uuid();
    -- The token columns must be '' and never NULL. GoTrue scans them into non-nullable Go
    -- strings, so a row inserted with NULLs there cannot be read back and EVERY sign-in fails
    -- with "Database error querying schema" -- an error that names the schema rather than the
    -- row, and therefore sends you looking in the wrong place entirely.
    insert into auth.users (id, instance_id, email, encrypted_password, email_confirmed_at,
                            created_at, updated_at, aud, role,
                            raw_app_meta_data, raw_user_meta_data,
                            confirmation_token, recovery_token, email_change,
                            email_change_token_new, email_change_token_current,
                            phone_change, phone_change_token, reauthentication_token)
    values (v_uid, '00000000-0000-0000-0000-000000000000', {email},
            crypt({password}, gen_salt('bf')), now(), now(), now(),
            'authenticated', 'authenticated',
            jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
            '{{}}'::jsonb,
            '', '', '', '', '', '', '', '');
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);

  select s.id into v_store from public.stores s where s.name = {store_name};
  if v_store is not null then
    raise notice 'sample store already exists';
    return;
  end if;

  v_store := public.create_store({store_name}, 'ashabi-global');

  update public.stores
     set is_public = true,
         public_description = {description},
         onboarded_at = now()
   where id = v_store;

  perform public.ensure_store_code(v_store);
  perform public.ensure_store_settings(v_store);

  update public.store_settings
     set printer_width_mm      = {paper},
         receipt_header        = {header},
         receipt_footer        = 'Thank you for your patronage',
         show_transfer_details = true,
         transfer_bank_name    = {bank},
         transfer_account_name = {acct_name},
         transfer_account_no   = {acct_no}
   where store_id = v_store;

  insert into public.product_categories (store_id, name) values (v_store, 'PET')  returning id into v_cat_pet;
  insert into public.product_categories (store_id, name) values (v_store, 'Beer') returning id into v_cat_beer;
  insert into public.product_categories (store_id, name) values (v_store, 'Can')  returning id into v_cat_can;

  -- One fungible pool for the bottles, another for the crates they arrive in. A crate sale
  -- creates an obligation against both.
  insert into public.empties_categories (store_id, name, kind, deposit)
  values (v_store, 'NBL bottle', 'content', 125) returning id into v_nbl;
  insert into public.empties_categories (store_id, name, kind, deposit)
  values (v_store, 'NBL crate', 'container', 1500) returning id into v_crate;

  -- PET, carrying the bulk ladder from the pricing discussion.
  v_p := public.create_product(v_store, 'Coca-Cola PET 60cl', 'piece', 'Pack', 12, 4500, true);
  update public.products set category_id = v_cat_pet where id = v_p;
  -- 340 per PIECE, not per pack: backfill_stock takes the cost of one base unit. 3400 sat here
  -- originally and made a pack cost 40,800 against a 4,500 selling price, which also put the
  -- whole shop's stock valuation out by a factor of ten.
  perform public.backfill_stock(v_store, v_p, 2400, 340, current_date, true);
  insert into public.product_sale_units (product_id, name, base_qty, price, sort_order)
  values (v_p, 'Pack', 12, 4500, 0), (v_p, 'Half pack', 6, 2350, 1), (v_p, 'Piece', 1, 400, 2);
  select id into v_unit from public.product_sale_units where product_id = v_p and name = 'Pack';
  insert into public.product_price_tiers (product_id, sale_unit_id, min_qty, max_qty, price)
  values (v_p, v_unit, 5, 100, 4450), (v_p, v_unit, 101, 1000, 4420);

  v_p := public.create_product(v_store, 'Eva Water 75cl', 'piece', 'Pack', 12, 2400, true);
  update public.products set category_id = v_cat_pet where id = v_p;
  perform public.backfill_stock(v_store, v_p, 960, 180, current_date, true);
  insert into public.product_sale_units (product_id, name, base_qty, price, sort_order)
  values (v_p, 'Pack', 12, 2400, 0), (v_p, 'Piece', 1, 250, 1);

  -- Beer: the products that carry empties.
  v_p := public.create_product(v_store, 'Star Lager 60cl', 'piece', 'Crate', 12, 9600, true);
  update public.products set category_id = v_cat_beer where id = v_p;
  perform public.backfill_stock(v_store, v_p, 600, 700, current_date, true);
  insert into public.product_returnables (product_id, empties_category_id, qty_per_base_unit)
  values (v_p, v_nbl, 1), (v_p, v_crate, null);
  insert into public.product_sale_units (product_id, name, base_qty, price, sort_order)
  values (v_p, 'Crate', 12, 9600, 0), (v_p, 'Half crate', 6, 4900, 1), (v_p, 'Bottle', 1, 850, 2);

  v_p := public.create_product(v_store, 'Gulder 60cl', 'piece', 'Crate', 12, 9600, true);
  update public.products set category_id = v_cat_beer where id = v_p;
  perform public.backfill_stock(v_store, v_p, 480, 700, current_date, true);
  insert into public.product_returnables (product_id, empties_category_id, qty_per_base_unit)
  values (v_p, v_nbl, 1), (v_p, v_crate, null);
  insert into public.product_sale_units (product_id, name, base_qty, price, sort_order)
  values (v_p, 'Crate', 12, 9600, 0), (v_p, 'Bottle', 1, 850, 1);

  v_p := public.create_product(v_store, 'Malta Guinness Can 33cl', 'piece', 'Pack', 24, 12000, true);
  update public.products set category_id = v_cat_can where id = v_p;
  perform public.backfill_stock(v_store, v_p, 720, 430, current_date, true);
  insert into public.product_sale_units (product_id, name, base_qty, price, sort_order)
  values (v_p, 'Pack', 24, 12000, 0), (v_p, 'Can', 1, 550, 1);

  perform public.complete_onboarding(v_store);
  raise notice 'seeded';
end
$seed$;

select s.name, s.code, s.is_public,
       (select count(*) from public.products p where p.store_id = s.id) as products
from public.stores s where s.name = {store_name};
""".format(
        email=q(email),
        password=q(password),
        store_name=q(store_name),
        description=q(description),
        header=q(header),
        paper=paper,
        bank=q(env("TRANFER_BANK")),
        acct_name=q(env("TRANSFER_ACCOUNT")),
        acct_no=q(env("TRANSFER_ACCOUNT_NUMBER")),
    )

    rows = run_sql(script)
    for r in rows:
        print(
            "  {} | code {} | public={} | {} products".format(
                r["name"], r["code"], r["is_public"], r["products"]
            )
        )


if __name__ == "__main__":
    main()

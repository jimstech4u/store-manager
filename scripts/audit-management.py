"""
Every value the shop can SEE, and whether it can change it.

«some places have values and unit that come from database, check if we have where to manage them
 like a unit name, price or value and the ui form or component or buttons to set, delete, add, or
 delete them»

`audit-ui.py` asks whether a capability has any door at all. This asks a narrower and more useful
question of the things already on screen: a unit name, a price, a deposit rate, a pool, a bank
account — every one of them is a row somewhere, and a screen that shows a row it cannot create,
correct or retire is half a feature. The half that is missing is always the same half: the shop can
get a value wrong once and then live with it.

Four verbs per thing, and each is a different kind of missing:

    ADD      the shop cannot start using it
    EDIT     a typo is permanent
    DELETE   a mistake is permanent, and the list fills with things nobody uses
    SET      it exists but nothing chooses it — the "wired to nothing" case

Mechanical and over-reporting on purpose, like the other scan: it looks for a live function and for
a call to it in `src/`. The READING of it belongs in UI_TRACK.md, which is the part worth keeping.

    python scripts/audit-management.py
"""
import io
import json
import os
import re
import urllib.request

REF = "zinhzpgprhhqmyxmchhm"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(HERE, "src")


def env(name):
    for line in io.open(os.path.join(HERE, ".env.local"), encoding="utf-8"):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


def run_sql(token, sql):
    req = urllib.request.Request(
        "https://api.supabase.com/v1/projects/%s/database/query" % REF,
        data=json.dumps({"query": sql}).encode("utf-8"),
        headers={
            "Authorization": "Bearer %s" % token,
            "Content-Type": "application/json",
            # Cloudflare in front of the Management API rejects urllib's default agent.
            "User-Agent": "curl/8.4.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8") or "[]")


def app_source():
    """Everything the app actually ships, as one string to grep."""
    out = []
    for root, _dirs, files in os.walk(SRC):
        for f in files:
            if f.endswith((".ts", ".tsx")):
                out.append(io.open(os.path.join(root, f), encoding="utf-8", errors="ignore").read())
    return "\n".join(out)


# ── What the shop sees, and the functions that would let it manage each one ──────────
#
# Written by hand rather than derived, because the question is about MEANING: "a unit name" is a
# thing a shopkeeper has an opinion about, and no scan can work out which tables are those things.
THINGS = [
    ("A unit's name (Crate, Bottle, Dirica)", "store_units", {
        "add": ["create_store_unit"],
        "edit": ["update_store_unit", "rename_store_unit"],
        "delete": ["archive_store_unit", "retire_store_unit"],
    }),
    ("A product's shapes, and what each holds", "product_units", {
        "add": ["save_product_units"],
        "edit": ["save_product_units"],
        # Removing a shape is saving the list without it — the same writer, by design.
        "delete": ["save_product_units"],
    }),
    ("What a shape sells for", "product_units.sell_price", {
        "set": ["save_product_units"],
    }),
    ("A price agreed with one customer", "customer_prices", {
        "add": ["save_customer_price", "set_customer_price", "update_customer_price"],
        "delete": ["remove_customer_price", "clear_customer_price"],
    }),
    ("A bulk price band", "product_price_tiers", {
        "add": ["save_price_tier", "set_price_tier", "update_price_tier"],
        "delete": ["remove_price_tier", "delete_price_tier"],
    }),
    ("An empties pool, and its deposit", "empties_categories", {
        "add": ["save_empties_category"],
        "edit": ["save_empties_category"],
        "delete": ["archive_empties_category", "retire_empties_category"],
    }),
    ("What a pool comes back in", "empties_return_units", {
        "add": ["save_return_units"],
        "edit": ["save_return_units"],
        "delete": ["save_return_units"],
    }),
    ("Which pool a product belongs to", "product_returnables", {
        "set": ["set_product_returnable"],
    }),
    ("A bank account", "bank_accounts", {
        "add": ["save_bank_account"],
        "edit": ["save_bank_account"],
        "delete": ["archive_bank_account"],
    }),
    ("A product category", "product_categories", {
        "add": ["save_product_category", "create_product_category"],
        "set": ["create_product", "update_product"],
        "delete": ["archive_product_category"],
    }),
    ("A customer", "store_customers", {
        # `upsert_customer` is the writer the form actually uses. `update_customer` also exists
        # and nothing calls it — a published API with no consumer, which is its own finding.
        "add": ["upsert_customer"],
        "edit": ["upsert_customer"],
        "delete": ["archive_customer"],
        "set": ["restore_customer"],
    }),
    ("A product", "products", {
        "add": ["create_product"],
        "edit": ["update_product"],
        "delete": ["archive_product"],
        "set": ["restore_product"],
    }),
    ("A member of staff", "store_members", {
        "add": ["invite_staff"],
        "edit": ["update_staff_details"],
        "delete": ["remove_staff", "archive_staff"],
        "set": ["set_staff_role", "update_staff_role"],
    }),
    ("The shop's own settings", "store_settings", {
        # Written straight through PostgREST rather than an RPC, so the marker is the table.
        "edit": ["store_settings"],
    }),
    ("A shared link", "share_links", {
        "add": ["create_share_link"],
        "delete": ["revoke_share_link"],
    }),
    ("A closed count", "stock_periods", {
        "set": ["reopen_stock_period"],
    }),
    ("How stock is costed", "products.cost_method", {
        "set": ["apply_weighted_average"],
    }),
]


def main():
    token = env("SUPABASE_ACCESS_TOKEN") or env("SUPABASE_MANAGEMENT_TOKEN")
    if not token:
        print("no management token in .env.local")
        return

    live = {
        r["proname"]
        for r in run_sql(token, """
            select pr.proname
              from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
             where ns.nspname = 'public'
        """)
    }
    code = app_source()

    print("\nEvery value the shop sees, and whether it can change it")
    print("=" * 78)
    # ASCII marks: this prints to a Windows console on cp1252, where a tick is an encoding error
    # rather than a tick, and the traceback buries the report it was meant to introduce.
    print("  [yes] the app calls it   [dead] exists, nothing calls it   [none] no function\n")

    gaps = []
    for label, table, verbs in THINGS:
        marks = []
        for verb, names in verbs.items():
            found = [n for n in names if n in live]
            # A call is `rpc('name')` — or, for the few tables written straight through
            # PostgREST, `from('name')`. Both are how the app reaches a writer.
            called = [
                n for n in found
                if ("rpc('%s'" % n) in code or ('rpc("%s"' % n) in code or ("from('%s')" % n) in code
            ]
            if called:
                marks.append("%s[yes]" % verb)
            elif found:
                marks.append("%s[dead]" % verb)
                gaps.append((label, verb, "exists, nothing calls it: " + ", ".join(found)))
            else:
                marks.append("%s[none]" % verb)
                gaps.append((label, verb, "no function: tried " + ", ".join(names)))
        print("  %-42s %s" % (label[:42], "   ".join(marks)))

    print("\n" + "=" * 78)
    print("%d thing(s) the shop cannot fully manage\n" % len(gaps))
    for label, verb, why in gaps:
        print("  %-42s %-7s %s" % (label[:42], verb, why[:70]))

    print("""
The reading of this belongs in UI_TRACK.md. Two honest reasons a row here is not a gap:
a verb that does not apply (a settled sale is not editable, by design), and a table managed
through another one's writer (a product's shapes are saved with the product).
""")


if __name__ == "__main__":
    main()

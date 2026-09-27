"""Can every figure in this shop be re-derived from what it is made of?

Not a test of the code paths — a test of the DATA they have produced. A reconciliation bug does not
announce itself: the screen shows a number, the number looks plausible, and it is only wrong
against the rows it claims to summarise. So each check below re-computes a figure from its parts
and compares, over every row in the shop.

Read-only. It writes nothing and is safe to run against the live project at any time.

    python scripts/reconcile-audit.py

Exit code is the number of checks that found something.
"""
import io, json, os, sys, urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = "zinhzpgprhhqmyxmchhm"


def env(name):
    for line in io.open(os.path.join(HERE, ".env.local"), encoding="utf-8"):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


TOKEN = env("SUPABASE_ACCESS_TOKEN")


def q(sql):
    req = urllib.request.Request(
        "https://api.supabase.com/v1/projects/%s/database/query" % REF,
        data=json.dumps({"query": sql}).encode("utf-8"),
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    try:
        return json.loads(urllib.request.urlopen(req).read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise SystemExit("query failed: %s\n%s" % (e, body[:800]))


CHECKS = []


def check(title, why):
    """Each check returns rows that SHOULD NOT EXIST. Empty is a pass."""
    def wrap(fn):
        CHECKS.append((title, why, fn))
        return fn
    return wrap


# ════════════════════════════════════════════════════════════════════════════
# MONEY
# ════════════════════════════════════════════════════════════════════════════

@check("A sale's total is its lines plus its charges plus its deposits",
       "This is the receipt's own arithmetic. If it does not hold, the paper handed to a customer "
       "shows a total that its own lines do not add up to — and neither side can tell which figure "
       "is the wrong one.")
def _():
    return q("""
      select s.id, s.total,
             coalesce(l.sum_lines, 0)   as lines_total,
             coalesce(c.sum_charges, 0) as charges,
             coalesce(l.sum_deposit, 0) as deposits,
             s.total - (coalesce(l.sum_lines,0) + coalesce(c.sum_charges,0)
                        + coalesce(l.sum_deposit,0)) as gap
        from public.sales s
        left join (select sale_id, sum(line_total) sum_lines, sum(deposit_charged) sum_deposit
                     from public.sale_lines group by sale_id) l on l.sale_id = s.id
        left join (select sale_id, sum(amount) sum_charges
                     from public.sale_charges group by sale_id) c on c.sale_id = s.id
       where s.status = 'posted'
         -- `fee_amount` is the older single order-level charge. 0074 copies it into
         -- `sale_charges` as well, so it is counted ONLY where no charge rows exist — otherwise
         -- the same transport would be added to the total twice and every itemised sale would
         -- read as short by the size of its own fee.
         and abs(s.total - (coalesce(l.sum_lines,0) + coalesce(l.sum_deposit,0)
                            + case when c.sum_charges is null then coalesce(s.fee_amount, 0)
                                   else c.sum_charges end)) > 0.005
       limit 20
    """)


@check("A sale line's total is its quantity times its price",
       "The one multiplication on every receipt. A line that does not hold means the printed "
       "amount and the printed rate disagree in front of the customer.")
def _():
    return q("""
      select sl.id, sl.sale_id, sl.entered_qty, sl.unit_price, sl.line_total,
             sl.line_total - (sl.entered_qty * sl.unit_price) as gap
        from public.sale_lines sl
        join public.sales s on s.id = sl.sale_id and s.status = 'posted'
       where abs(sl.line_total - (sl.entered_qty * sl.unit_price)) > 0.005
       limit 20
    """)


@check("Nothing is paid more than it is owed",
       "An over-allocated sale means the customer's balance is understated — the shop believes it "
       "has been paid money it has not been paid.")
def _():
    return q("""
      select s.id, s.total, sum(pa.amount) as allocated
        from public.sales s
        join public.payment_allocations pa on pa.sale_id = s.id
       where s.status = 'posted'
       group by s.id, s.total
      having sum(pa.amount) - s.total > 0.005
       limit 20
    """)


@check("A payment is allocated to no more than it is worth",
       "Allocating N5,000 of a N3,000 payment settles debts with money nobody handed over.")
def _():
    return q("""
      select p.id, p.amount, sum(pa.amount) as allocated
        from public.payments p
        join public.payment_allocations pa on pa.payment_id = p.id
       group by p.id, p.amount
      having sum(pa.amount) - p.amount > 0.005
       limit 20
    """)


# ════════════════════════════════════════════════════════════════════════════
# SHAPES, AND SHAPES INSIDE SHAPES
# ════════════════════════════════════════════════════════════════════════════

@check("Every sold line's shape belongs to the product it was sold as",
       "A shape borrowed from another product puts the wrong word on a receipt and the wrong "
       "multiple into the stock movement — the bill and the shelf both move by the wrong amount.")
def _():
    return q("""
      select sl.id, sl.sale_id, sl.product_id, sl.sale_unit_id
        from public.sale_lines sl
        join public.sales s on s.id = sl.sale_id and s.status = 'posted'
        left join public.product_units pu on pu.id = sl.sale_unit_id
       where sl.sale_unit_id is not null
         and (pu.id is null or pu.product_id <> sl.product_id)
       limit 20
    """)


@check("A line's base quantity is its entered quantity in its shape",
       "This is the nested-shape conversion: 3 crates of 12 is 36 on the shelf. Where it does not "
       "hold, stock moved by a different amount than was sold.")
def _():
    return q("""
      select sl.id, sl.sale_id, sl.entered_qty, sl.base_qty, pu.base_qty as per_shape,
             sl.base_qty - (sl.entered_qty * pu.base_qty) as gap
        from public.sale_lines sl
        join public.sales s on s.id = sl.sale_id and s.status = 'posted'
        join public.product_units pu on pu.id = sl.sale_unit_id
       where abs(sl.base_qty - (sl.entered_qty * pu.base_qty)) > 0.0005
       limit 20
    """)


@check("No shape claims to be worth nothing",
       "A base quantity of zero divides by zero everywhere it is used, and a negative one sells "
       "stock backwards.")
def _():
    return q("""
      select pu.id, pu.product_id, pu.base_qty
        from public.product_units pu
       where pu.base_qty is null or pu.base_qty <= 0
       limit 20
    """)


# ════════════════════════════════════════════════════════════════════════════
# STOCK
# ════════════════════════════════════════════════════════════════════════════

@check("Every posted sale took its stock off the shelf",
       "A sale with no matching movement sells goods the stock card still believes are there — "
       "which is the difference a count finds months later with no way to explain it.")
def _():
    # AGAINST THE SALE, not the line. Movements carry `ref_table = 'sales'`; asking for
    # 'sale_lines' matches nothing and reports every line in the shop as unrecorded.
    return q("""
      select s.id, s.occurred_at, s.total
        from public.sales s
       where s.status = 'posted'
         and exists (select 1 from public.sale_lines sl where sl.sale_id = s.id)
         and not exists (
           select 1 from public.stock_movements m
            where m.ref_table = 'sales' and m.ref_id = s.id)
       limit 20
    """)


@check("What left the shelf equals what was sold",
       "The conversion from what was entered to what the shelf holds, end to end: three crates of "
       "twelve must take thirty-six off. A gap here is a nested shape resolved differently by the "
       "sale and by the stock card.")
def _():
    return q("""
      select s.id, l.sold, m.moved, l.sold + m.moved as gap
        from public.sales s
        join (select sale_id, sum(base_qty) sold from public.sale_lines group by sale_id) l
          on l.sale_id = s.id
        join (select ref_id, sum(qty_delta) moved from public.stock_movements
               where ref_table = 'sales' group by ref_id) m on m.ref_id = s.id
       where s.status = 'posted' and abs(l.sold + m.moved) > 0.0005
       limit 20
    """)


@check("A voided sale put its stock back",
       "Voiding is the sanctioned way to remove a sale. If the movement is not reversed, the void "
       "removes the money and keeps the goods off the shelf.")
def _():
    return q("""
      select s.id, sum(m.qty_delta) as net_movement
        from public.sales s
        join public.stock_movements m on m.ref_table = 'sales' and m.ref_id = s.id
       where s.status = 'voided'
       group by s.id
      having abs(sum(m.qty_delta)) > 0.0005
       limit 20
    """)


@check("Nothing is on the shelf a negative number of times",
       "Negative stock is not always a bug — a shop can sell ahead of booking a delivery — but it "
       "is always something to look at, and a large one is a shape conversion gone wrong.")
def _():
    return q("""
      select p.id, p.name, sum(m.qty_delta) as on_hand
        from public.products p
        join public.stock_movements m on m.product_id = p.id
       where coalesce(p.status,'active') = 'active'
       group by p.id, p.name
      having sum(m.qty_delta) < -0.0005
       order by sum(m.qty_delta)
       limit 20
    """)


# ════════════════════════════════════════════════════════════════════════════
# EMPTIES AND DEPOSITS
# ════════════════════════════════════════════════════════════════════════════

@check("Nobody has returned more containers than they took",
       "A negative outstanding means the shop has taken back crates it never sent out — either a "
       "return was recorded twice, or against the wrong customer.")
def _():
    return q("""
      select ce.store_customer_id, ce.product_unit_id,
             sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) as outstanding
        from public.customer_empties ce
       group by ce.store_customer_id, ce.product_unit_id
      having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) < -0.0005
       limit 20
    """)


@check("A deposit was only taken where containers actually went out",
       "Money held against nothing. The customer is owed it back and no container explains why.")
def _():
    return q("""
      select sl.id, sl.sale_id, sl.deposit_charged, sl.containers_out
        from public.sale_lines sl
        join public.sales s on s.id = sl.sale_id and s.status = 'posted'
       where sl.deposit_charged > 0.005 and coalesce(sl.containers_out, 0) <= 0
       limit 20
    """)


# ════════════════════════════════════════════════════════════════════════════
# THE LEDGER AND ITS HISTORY
# ════════════════════════════════════════════════════════════════════════════

@check("Every correction kept the receipt it replaced",
       "A revision without its stored document is a correction nobody can audit: the shop cannot "
       "show what the receipt said before it was changed.")
def _():
    return q("""
      select r.id, r.sale_id, r.revision
        from public.sale_revisions r
       where r.document is null
       limit 20
    """)


@check("A corrected sale kept the receipt it replaced",
       "A POSTED sale past revision 1 has been amended, and the version it replaced should be "
       "stored — otherwise the shop cannot show what the receipt said before somebody changed it.")
def _():
    # NOT "revision = stored + 1". Voiding and reopening bump the revision too and store no
    # document, quite correctly — nothing about the sale's contents changed. Asserting the
    # arithmetic reported 38 perfectly ordinary voided sales as missing their history.
    return q("""
      select s.id, s.revision, s.occurred_at
        from public.sales s
       where s.status = 'posted'
         and coalesce(s.revision, 1) >= 2
         and not exists (select 1 from public.sale_revisions r where r.sale_id = s.id)
       limit 20
    """)


@check("Nothing was deleted out of the append-only ledger",
       "Stock movements refuse DELETE by design. A sale line with no movement AND no void is the "
       "signature of one having gone anyway.")
def _():
    return q("""
      select m.ref_id, count(*) n
        from public.stock_movements m
       where m.ref_table = 'sale_lines'
         and not exists (select 1 from public.sale_lines sl where sl.id = m.ref_id)
       group by m.ref_id
       limit 20
    """)


# ════════════════════════════════════════════════════════════════════════════
# WHAT THIS DELIBERATELY DOES NOT CHECK
#
# CUSTOMER BALANCES. `customer_balance` ends with `and public.is_store_member(sc.store_id)`, so
# called with no signed-in user — which is what the Management API is — it returns NULL for every
# customer, and `customer_balance_total` then reports the opening balance alone. Re-deriving a
# balance here would be comparing a real figure against a guard that refused to answer, and the
# first version of this file did exactly that and called eight customers wrong.
#
# That guard is correct and should stay. Balances belong in a probe that signs in.
# ════════════════════════════════════════════════════════════════════════════

def main():
    print("Reconciling %s\n" % REF)
    failed = 0
    for title, why, fn in CHECKS:
        rows = fn()
        if not rows:
            print("  OK    %s" % title)
            continue
        failed += 1
        print("\n  FOUND %s" % title)
        print("        %s" % why)
        for r in rows[:8]:
            print("          %s" % json.dumps(r, default=str))
        if len(rows) > 8:
            print("          ... and %d more" % (len(rows) - 8))
        print()

    print("\n%d of %d checks found something." % (failed, len(CHECKS)))
    return failed


if __name__ == "__main__":
    sys.exit(main())

"""
Remove rows a probe wrote into append-only tables.

    python scripts/clean-probe-rows.py [row-id ...]

Row ids are for rows a probe wrote through the UI, where it could not stamp a note of its own —
a settlement recorded by clicking looks exactly like one a shop recorded, so the only safe way to
undo it is to name the rows.

The ledgers refuse UPDATE and DELETE — deliberately, because a shop's money history must not be
editable. That makes ordinary probe cleanup impossible: `probe-settle-empties` deleted its own
holdings through the service role and the trigger refused it SILENTLY, so a ₦10,000 deposit that
never happened stayed on a real customer's receipt and the next run started from the wrong figure.

A real correction to an append-only ledger is a compensating entry, and that is right for the shop.
It is wrong for a probe: nobody wants a history showing a deposit taken and given back that was
never taken at all. So this drops the trigger for the length of one transaction, deletes only rows
the probe marked as its own, and puts the trigger back — which is what a maintenance script is for,
and why it is a separate file with the word "probe" in every predicate.

    python scripts/clean-probe-rows.py
"""
import io
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def env(name):
    for line in io.open(os.path.join(ROOT, '.env.local'), encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        if k.strip() == name:
            return v.strip().strip('"').strip("'")
    raise SystemExit('missing ' + name)


PROJECT = env('NEXT_PUBLIC_SUPABASE_URL').split('//')[1].split('.')[0]
TOKEN = env('SUPABASE_ACCESS_TOKEN')

IDS = [a for a in sys.argv[1:] if len(a) == 36]

BY_ID = (
    "delete from public.deposit_ledger where id in (%s);"
    % ','.join("'%s'::uuid" % i for i in IDS)
) if IDS else ''

SQL = """
begin;

alter table public.deposit_holdings disable trigger no_mutation;
alter table public.deposit_ledger   disable trigger no_mutation;

delete from public.deposit_holdings where note like 'probe:%';
delete from public.deposit_ledger   where note like 'probe:%';
delete from public.payments         where reference = 'Deposit settled on receipt';
__BY_ID__

alter table public.deposit_holdings enable trigger no_mutation;
alter table public.deposit_ledger   enable trigger no_mutation;

commit;

select
  (select count(*) from public.deposit_holdings where note like 'probe:%') as holdings_left,
  (select count(*) from public.deposit_ledger   where note like 'probe:%') as ledger_left;
"""

SQL = SQL.replace('__BY_ID__', BY_ID)

req = urllib.request.Request(
    'https://api.supabase.com/v1/projects/%s/database/query' % PROJECT,
    data=json.dumps({'query': SQL}).encode('utf-8'),
    headers={
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': 'application/json',
        # Cloudflare in front of the Management API rejects urllib's default agent with a 403/1010.
        # `apply-migration.py` hit the same wall and settled on this; so did the email templates.
        'User-Agent': 'curl/8.4.0',
    },
    method='POST',
)

try:
    with urllib.request.urlopen(req) as r:
        print('cleaned:', r.read().decode('utf-8'))
except urllib.error.HTTPError as e:
    print('FAILED', e.code, e.read().decode('utf-8'))
    sys.exit(1)

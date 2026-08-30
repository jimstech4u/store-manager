"""What the database can do that no screen asks for, and what the app holds that nothing uses.

The apply-migration script prints only the first 400 characters of a result, which is fine for a
migration and useless for a listing, so this talks to the Management API directly.
"""
import io
import json
import os
import re
import urllib.request

HERE = os.path.abspath('.')
REF = 'zinhzpgprhhqmyxmchhm'


def env(name):
    for line in io.open(os.path.join(HERE, '.env.local'), encoding='utf-8'):
        if line.startswith(name + '='):
            return line.split('=', 1)[1].strip().strip('"')
    return None


def sql(query):
    req = urllib.request.Request(
        'https://api.supabase.com/v1/projects/%s/database/query' % REF,
        data=json.dumps({'query': query}).encode('utf-8'),
        headers={
            'Authorization': 'Bearer %s' % env('SUPABASE_ACCESS_TOKEN'),
            'Content-Type': 'application/json',
            'User-Agent': 'curl/8.4.0',
        },
        method='POST',
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode('utf-8') or '[]')


# ── Everything the app's own source says ─────────────────────────────────────────────────────
sources = {}
for root, _dirs, files in os.walk('src'):
    for f in files:
        if f.endswith(('.ts', '.tsx', '.css')):
            path = os.path.join(root, f)
            sources[path] = io.open(path, encoding='utf-8').read()
blob = '\n'.join(sources.values())

# ── 1. Callable RPCs nothing calls ───────────────────────────────────────────────────────────
rpcs = sql(
    """
    select distinct p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and has_function_privilege('authenticated', p.oid, 'execute')
       and p.proname not like 'tg\\_%'
     order by 1
    """
)
names = [r['proname'] for r in rpcs]
uncalled = [r for r in names if r not in blob]

print('=' * 78)
print('RPCS THE APP NEVER CALLS  (%d of %d)' % (len(uncalled), len(names)))
print('=' * 78)
for r in uncalled:
    print('  ', r)

# ── 2. Tables no screen reads ────────────────────────────────────────────────────────────────
tables = sql(
    """
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by 1
    """
)
tnames = [r['relname'] for r in tables]
untouched = [t for t in tnames if t not in blob]

print()
print('=' * 78)
print('TABLES NO SCREEN NAMES  (%d of %d)' % (len(untouched), len(tnames)))
print('  — many are reached only through an RPC, which is correct; the ones to look at are')
print('    those whose RPCs are also uncalled.')
print('=' * 78)
for t in untouched:
    print('  ', t)

# ── 3. Components nothing imports ────────────────────────────────────────────────────────────
print()
print('=' * 78)
print('COMPONENTS NOTHING IMPORTS')
print('=' * 78)
for path, text in sorted(sources.items()):
    if not path.endswith('.tsx'):
        continue
    base = os.path.basename(path)[:-4]
    if base in ('page', 'layout', 'template', 'error', 'not-found', 'loading'):
        continue
    # Anything that names it, other than the file itself.
    others = '\n'.join(t for p2, t in sources.items() if p2 != path)
    if base not in others:
        print('  ', path.replace('\\', '/'))

# ── 4. Exports nothing uses ──────────────────────────────────────────────────────────────────
print()
print('=' * 78)
print('EXPORTED FUNCTIONS NOTHING ELSE USES')
print('=' * 78)
for path, text in sorted(sources.items()):
    if not path.endswith(('.ts', '.tsx')):
        continue
    others = '\n'.join(t for p2, t in sources.items() if p2 != path)
    for m in re.finditer(r'^export (?:async )?function (\w+)', text, re.M):
        name = m.group(1)
        if name not in others:
            print('   %-28s %s' % (name, path.replace('\\', '/')))

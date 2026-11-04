/**
 * THE AGENT'S CRAWLER — Uber's AutoCrawler, for one database.
 *
 * Reads every function the app can call (`agent_catalogue`), and writes each to the registry
 * (`agent_tools`): its arguments, whether it changes anything, and the permission it checks. A new
 * function arrives switched OFF. One is offered to the agent only when `src/lib/agent/tool-review.json`
 * lists it, enabled, with the signature it was reviewed at. A function whose arguments have changed
 * since is switched off and marked stale until somebody reviews it again. Every change to a row is
 * written to `agent_tool_changes`.
 *
 *     node scripts/agent-crawl.mjs           # crawl and write
 *     node scripts/agent-crawl.mjs --check   # change nothing; fail if an enabled tool has gone stale
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const CHECK = process.argv.includes('--check');
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const review = JSON.parse(readFileSync('src/lib/agent/tool-review.json', 'utf8')).tools;

/** Arguments the server supplies itself: the shop from the session, a fresh id for idempotency. */
const INJECTED = new Set(['p_store_id', 'p_client_uuid']);

/** "p_id uuid, p_name text DEFAULT NULL::text" → [{ name, type, required }] */
function parseArgs(text) {
  if (!text.trim()) return [];
  return text.split(/, (?=p_)/).map((part) => {
    const m = part.match(/^(\w+)\s+(.+?)(\s+DEFAULT\s+.+)?$/);
    return { name: m[1], type: m[2].trim(), required: !m[3] };
  });
}

const { data: catalogue, error } = await admin.rpc('agent_catalogue');
if (error) throw new Error(error.message);
const { data: existing } = await admin.from('agent_tools').select('*');
const before = new Map((existing ?? []).map((r) => [r.name, r]));

/** The same value whatever order its keys came back in: jsonb reorders them. */
const canon = (v) =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined && v[k] !== null).map((k) => [k, canon(v[k])]))
      : v;
const comparable = (r) => JSON.stringify(canon({ ...r, discovered_at: null, updated_at: null, reviewed_at: null }));

const seen = new Map();
for (const f of catalogue) seen.set(f.name, [...(seen.get(f.name) ?? []), f]);

let added = 0;
let changed = 0;
const rows = [];
const changes = [];
const stale = [];
const missing = [];
for (const [name, versions] of seen) {
  // A function with two overloads is ambiguous to call by name; it is never offered.
  const f = versions[0];
  const r = review[name];
  const args = parseArgs(f.args).map((a) => ({
    ...a,
    injected: INJECTED.has(a.name) || undefined,
    hidden: (r?.hidden ?? []).includes(a.name) || undefined,
    description: r?.args?.[a.name]?.description,
  }));
  const isStale = Boolean(r?.enabled) && r.signature !== f.identity_args;
  if (isStale) stale.push(name);
  const row = {
    name,
    effect: f.effect,
    enabled: Boolean(r?.enabled) && !isStale && versions.length === 1,
    permission: r?.permission ?? f.permissions?.[0] ?? null,
    title: r?.title ?? null,
    description: r?.description ?? f.note ?? null,
    args,
    signature: f.identity_args,
    stale: isStale,
    reviewed_at: r ? (before.get(name)?.reviewed_at ?? new Date().toISOString()) : null,
    updated_at: new Date().toISOString(),
  };
  const old = before.get(name);
  if (old && comparable(old) === comparable({ ...old, ...row })) continue;
  if (!old) added += 1;
  else changed += 1;
  rows.push(row);
  changes.push({ name, before: old ?? null, after: row, note: old ? 'crawled' : 'discovered' });
}
if (!CHECK && rows.length) {
  const { error: upErr } = await admin.from('agent_tools').upsert(rows);
  if (upErr) throw new Error(upErr.message);
  const { error: chErr } = await admin.from('agent_tool_changes').insert(changes);
  if (chErr) throw new Error(chErr.message);
}
for (const name of Object.keys(review)) if (!seen.has(name)) missing.push(name);
// A function that no longer exists cannot be called: switched off, not deleted, so its history stays.
for (const [name, old] of before) {
  if (seen.has(name) || !old.enabled || CHECK) continue;
  await admin.from('agent_tools').update({ enabled: false, stale: true }).eq('name', name);
  await admin.from('agent_tool_changes').insert({ name, before: old, after: { ...old, enabled: false, stale: true }, note: 'gone' });
}

const { count: on } = await admin.from('agent_tools').select('name', { count: 'exact', head: true }).eq('enabled', true);
console.log(`${seen.size} functions; ${added} new, ${changed} changed; ${on} enabled for the agent`);
if (stale.length) console.log(`STALE (changed since review, switched off): ${stale.join(', ')}`);
if (missing.length) console.log(`REVIEWED BUT GONE: ${missing.join(', ')}`);
process.exit(CHECK && (stale.length || missing.length) ? 1 : 0);

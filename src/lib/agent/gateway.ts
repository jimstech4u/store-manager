import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolDef } from '@/lib/whatsapp/llm';

/**
 * THE AGENT'S GATEWAY — Uber's MCP gateway, for one database. Server only.
 *
 * Everything the app can do is a function in the database, and every one of them is in the registry
 * (`agent_tools`, written by `scripts/agent-crawl.mjs`). Only those reviewed and switched on in
 * `tool-review.json` reach the agent, and only those the person asking has the permission for. The
 * agent does not carry them all in its prompt — at Uber's scale or ours that is context and quota
 * spent for nothing — it SEARCHES for what it needs (`find_capability`) and then uses it
 * (`use_capability`), the progressive discovery Uber's Omni MCP does.
 *
 * Three rules hold whatever the agent sends:
 *   - the shop is the session's, never an argument the model chose (`p_store_id`), and anything the
 *     server makes for itself (`p_client_uuid`) is made here;
 *   - a READ runs at once, as the person, and only a trimmed answer goes back to the model;
 *   - a WRITE runs nothing: it is shown to the person in the server's words, with names in place of
 *     ids, and only their YES runs it — the same path every other action takes.
 * The database still checks permission and membership inside every function; this only stops the
 * agent offering what would be refused.
 */

export interface AgentArg {
  name: string;
  type: string;
  required: boolean;
  injected?: boolean;
  hidden?: boolean;
  description?: string;
}
export interface AgentTool {
  name: string;
  effect: 'read' | 'write';
  permission: string | null;
  title: string | null;
  description: string | null;
  args: AgentArg[];
}
export interface GatewayCtx {
  db: SupabaseClient; // the person, on their own session
  service: SupabaseClient; // the agent's own tables
  storeId: string;
  userId: string;
}
type Args = Record<string, unknown>;

const LAGOS = 60 * 60_000; // Nigeria is UTC+1 all year.

let cached: { at: number; tools: AgentTool[] } | null = null;

/** The enabled tools, re-read at most once a minute: switching one off reaches the agent within it. */
async function registry(service: SupabaseClient): Promise<AgentTool[]> {
  if (cached && Date.now() - cached.at < 60_000) return cached.tools;
  const { data, error } = await service
    .from('agent_tools')
    .select('name, effect, permission, title, description, args')
    .eq('enabled', true);
  if (error) throw new Error(error.message);
  cached = { at: Date.now(), tools: (data ?? []) as AgentTool[] };
  return cached.tools;
}

/** What THIS person may use: the registry, less what their role and their own ticks leave out. */
async function allowed(ctx: GatewayCtx): Promise<AgentTool[]> {
  const tools = await registry(ctx.service);
  const { data } = await ctx.db.rpc('member_permissions', { p_store_id: ctx.storeId, p_user_id: ctx.userId });
  const mine = new Set(((data ?? []) as { code: string; allowed: boolean }[]).filter((p) => p.allowed).map((p) => p.code));
  return tools.filter((t) => !t.permission || mine.has(t.permission));
}

const visible = (t: AgentTool) => t.args.filter((a) => !a.injected && !a.hidden);

function jsonType(type: string): string {
  if (/\[\]$/.test(type)) return 'array';
  if (/^(integer|bigint|smallint|numeric|money_amt|qty|unit_cost|real|double)/.test(type)) return 'number';
  if (type === 'boolean') return 'boolean';
  return 'string';
}

/** A capability as the model sees it: what it is, whether it changes anything, and what it takes. */
const describe = (t: AgentTool) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  changes_records: t.effect === 'write',
  args: visible(t).map((a) => ({ name: a.name, type: jsonType(a.type), required: a.required, description: a.description })),
});

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'who', 'how', 'can', 'you', 'our', 'their', 'from', 'this', 'that', 'want', 'give', 'show']);
const words = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ies|es|s)$/, ''));

/** The capabilities that best fit what was asked, by the words they share; never the whole list. */
function search(tools: AgentTool[], need: string): AgentTool[] {
  const want = words(need);
  return tools
    .map((t) => {
      const have = new Set(words(`${t.name.replace(/_/g, ' ')} ${t.title ?? ''} ${t.description ?? ''}`));
      return { t, score: want.filter((w) => have.has(w) || [...have].some((h) => h.startsWith(w) || w.startsWith(h))).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.t);
}

function dayBound(value: string, end: boolean): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(new Date(`${value}T00:00:00Z`).getTime() - LAGOS + (end ? 86_400_000 : 0)).toISOString();
}

/** The call's arguments, from what the model sent: the session's shop, nothing hidden, every one checked. */
function prepare(ctx: GatewayCtx, t: AgentTool, given: Args): { params: Args } | { error: string } {
  const params: Args = {};
  for (const a of t.args) {
    if (a.name === 'p_store_id') {
      params[a.name] = ctx.storeId;
      continue;
    }
    if (a.injected || a.hidden) continue;
    let v = given[a.name] ?? given[a.name.replace(/^p_/, '')];
    if (v === undefined || v === null || v === '') {
      if (a.required) return { error: `${t.title ?? t.name} needs ${a.description ?? a.name}.` };
      continue;
    }
    const kind = jsonType(a.type);
    if (kind === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) return { error: `${a.description ?? a.name} must be a number.` };
    } else if (kind === 'boolean') {
      v = v === true || v === 'true';
    } else if (a.type === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v))) {
      return { error: `${a.description ?? a.name}: that is not an id. Look it up first.` };
    } else if (a.type.startsWith('timestamp')) {
      v = dayBound(String(v), /(_to|_before|_until)$/.test(a.name));
    }
    params[a.name] = v;
  }
  return { params };
}

/** Only what the model needs back: thirty rows at most, long text cut. */
function project(result: unknown): unknown {
  const trim = (row: unknown) =>
    row && typeof row === 'object'
      ? Object.fromEntries(Object.entries(row as Args).map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v]))
      : row;
  if (Array.isArray(result)) {
    return { rows: result.slice(0, 30).map(trim), total: result.length, ...(result.length > 30 ? { more_not_shown: result.length - 30 } : {}) };
  }
  return trim(result);
}

export const GATEWAY_TOOLS: ToolDef[] = [
  {
    name: 'find_capability',
    description:
      'Search everything else the shop can do when none of your other tools fits — renaming items, changing prices, suppliers and paying them, customer details, expenses, staff, expiring stock, online orders and more. Say what they want in plain words. Returns the matching capabilities with what each needs.',
    parameters: { type: 'object', properties: { need: { type: 'string' } }, required: ['need'] },
  },
  {
    name: 'use_capability',
    description:
      'Use one capability returned by find_capability, with its args. A capability that reads answers at once. One that changes records is shown to them to confirm with YES, so never ask them to confirm yourself.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, args: { type: 'object' } },
      required: ['name'],
    },
  },
];

/** find_capability and use_capability. `hold` writes a proposal and ends the turn, as every action does. */
export async function runCapability(
  ctx: GatewayCtx,
  tool: string,
  args: Args,
  hold: (action: string, args: Args, summary: string) => Promise<unknown>,
): Promise<unknown> {
  const tools = await allowed(ctx);
  if (tool === 'find_capability') {
    const found = search(tools, String(args.need ?? ''));
    return found.length > 0
      ? { capabilities: found.map(describe) }
      : { capabilities: [], note: 'Nothing matches. These are what can be done:', titles: tools.map((t) => t.title ?? t.name) };
  }

  const t = tools.find((x) => x.name === String(args.name ?? ''));
  if (!t) return { error: 'That capability is not available to you. Use find_capability.' };
  const given = (args.args && typeof args.args === 'object' ? args.args : {}) as Args;
  const prep = prepare(ctx, t, given);
  if ('error' in prep) return prep;

  if (t.effect === 'read') {
    const { data, error } = await ctx.db.rpc(t.name, prep.params);
    if (error) return { error: error.message };
    return project(data);
  }

  // A change: shown in names, run only on YES.
  const ids = Object.values(prep.params).filter(
    (v): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) && v !== ctx.storeId,
  );
  const { data: named } = ids.length
    ? await ctx.db.rpc('agent_names', { p_store_id: ctx.storeId, p_ids: ids })
    : { data: [] };
  const label = new Map(((named ?? []) as { id: string; label: string }[]).map((n) => [n.id, n.label]));
  for (const id of ids) if (!label.has(id)) return { error: 'One of those records is not in this shop. Look it up first.' };
  const lines = visible(t)
    .filter((a) => prep.params[a.name] !== undefined)
    .map((a) => {
      const v = prep.params[a.name];
      const shown = typeof v === 'string' && label.has(v) ? label.get(v) : a.type.startsWith('money') ? `₦${Number(v).toLocaleString('en-NG')}` : String(v);
      return `${(a.description ?? a.name).split(':')[0]}: ${shown}`;
    });
  return hold('capability', { name: t.name, params: prep.params }, [`*${t.title ?? t.name}?*`, ...lines].join('\n'));
}

/** The YES: still enabled, still theirs, run as them. */
export async function executeCapability(ctx: GatewayCtx, a: Args): Promise<{ text: string }> {
  const t = (await allowed(ctx)).find((x) => x.name === a.name && x.effect === 'write');
  if (!t) throw new Error('that can no longer be done from here');
  const params = { ...(a.params as Args), p_store_id: undefined } as Args;
  for (const arg of t.args) {
    if (arg.name === 'p_store_id') params[arg.name] = ctx.storeId;
    if (arg.name === 'p_client_uuid') params[arg.name] = randomUUID();
  }
  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
  const { error } = await ctx.db.rpc(t.name, params);
  if (error) throw new Error(error.message);
  return { text: `Done ✅ ${t.title ?? ''}`.trim() };
}

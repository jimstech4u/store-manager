/**
 * A PROVIDER RUNS OUT HALFWAY THROUGH AN ANSWER — and the person still gets it.
 *
 * "Support and switch live on quota reached, and easy to auto switch from a list." Stands in for
 * Meta on 3199 and for a first provider on 3198, which starts answering (asks for a lookup) and then
 * returns 429. The real next provider has to carry on from the lookup, in a model that refuses another
 * model's tool calls unless they are handed over as notes. Start the app with:
 *
 *   LLM_PROVIDERS=[{stub at http://localhost:3198, then the real gemini}]
 *   WHATSAPP_GRAPH_URL=http://localhost:3199 WHATSAPP_APP_SECRET=probe-secret …
 *
 *     node scripts/probe-whatsapp-failover.mjs [http://localhost:3100]
 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sent = [];
const meta = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const j = JSON.parse(body || '{}');
      const said = j.text?.body ?? j.interactive?.body?.text;
      if (said) sent.push({ to: j.to, text: said });
    } catch {
      // Not ours to judge.
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((r) => meta.listen(3199, r));

// The first provider: one lookup, then out of quota.
let llmCalls = 0;
const stub = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    llmCalls += 1;
    if (llmCalls === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'call_stub_1', type: 'function', function: { name: 'find_items', arguments: '{"query":"trophy bottle"}' } },
      ] } }] }));
      return;
    }
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
    res.end('{"error":{"message":"quota"}}');
  });
});
await new Promise((r) => stub.listen(3198, r));

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PHONE = `997${Date.now().toString().slice(-9)}`;
const post = (text) => {
  const raw = JSON.stringify({ entry: [{ changes: [{ value: {
    contacts: [{ wa_id: PHONE, profile: { name: 'Probe' } }],
    messages: [{ id: `wamid.probe.${Math.random().toString(36).slice(2)}`, from: PHONE, type: 'text', text: { body: text } }],
  } }] }] });
  return fetch(`${BASE}/api/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'probe-secret').update(raw).digest('hex')}` },
    body: raw,
  });
};
const ask = async (text) => {
  const before = sent.length;
  await post(text);
  const start = Date.now();
  while (Date.now() - start < 50000) {
    const got = sent.slice(before).filter((m) => m.to === PHONE);
    if (got.length > 0) return got.map((m) => m.text).join('\n');
    await sleep(400);
  }
  return '';
};

try {
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await anon.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
  const { data: mem } = await anon.rpc('my_membership');
  const { data: code } = await anon.rpc('create_whatsapp_link_code', { p_store_id: mem[0].store_id });
  await ask(`Link ${code}`);

  const answer = await ask('How much Trophy Bottle is left?');
  console.log(`      ${answer.replace(/\s+/g, ' ').slice(0, 160)}`);
  check('the first provider started the answer, then ran out', llmCalls >= 2, `${llmCalls} calls to it`);
  check('the person still got the answer', /trophy/i.test(answer) && /\d/.test(answer));
  const { data: log } = await admin.from('whatsapp_messages').select('tools').eq('wa_phone', PHONE).eq('direction', 'out').not('tools', 'is', null);
  const t = log?.[log.length - 1]?.tools ?? {};
  check('the lookup made before the switch was not repeated', (t.calls ?? []).length === 1, JSON.stringify((t.calls ?? []).map((c) => c.tool)));
  check('it switched, and the log says why', (t.providers ?? []).includes('gemini') && (t.skipped ?? []).some((s) => /429/.test(s)),
    `${(t.providers ?? []).join(' → ')} | ${(t.skipped ?? []).join(' | ').slice(0, 120)}`);
} catch (e) {
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  meta.close();
  stub.close();
  await admin.from('whatsapp_messages').delete().eq('wa_phone', PHONE);
  await admin.from('whatsapp_links').delete().eq('wa_phone', PHONE);
  console.log('  (probe rows removed)');
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

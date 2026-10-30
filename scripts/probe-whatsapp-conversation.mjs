/**
 * A REAL CONVERSATION WITH THE ASSISTANT — real models, the shop's real figures, Meta stood in for.
 *
 * Start a build with stand-in Meta settings and the real model list (LLM_PROVIDERS from the shell):
 *
 *   WHATSAPP_GRAPH_URL=http://localhost:3199 WHATSAPP_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID=000 \
 *   WHATSAPP_APP_SECRET=probe-secret WHATSAPP_VERIFY_TOKEN=probe-verify npx next start -p 3100
 *
 * The probe listens on 3199 as Meta, posts signed messages from a number that is not real, links it
 * to the sample owner with a real code, asks in plain English, and checks the ANSWER against the
 * database: figures the model invented would not match. It then asks for a receipt and checks the
 * link, and that an unlinked number gets nothing but instructions. Its rows are removed at the end.
 *
 *     node scripts/probe-whatsapp-conversation.mjs [http://localhost:3100]
 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SECRET = 'probe-secret';
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

// Meta, stood in: every text the bot sends lands here.
const sent = [];
const meta = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const j = JSON.parse(body || '{}');
      if (j.text?.body) sent.push({ to: j.to, text: j.text.body });
    } catch {
      // Not ours to judge.
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"messages":[{"id":"stub"}]}');
  });
});
await new Promise((r) => meta.listen(3199, r));

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PHONE = `999${Date.now().toString().slice(-9)}`;
const STRANGER = `998${Date.now().toString().slice(-9)}`;
const post = (from, text) => {
  const raw = JSON.stringify({ entry: [{ changes: [{ value: {
    contacts: [{ wa_id: from, profile: { name: 'Probe' } }],
    messages: [{ id: `wamid.probe.${Math.random().toString(36).slice(2)}`, from, type: 'text', text: { body: text } }],
  } }] }] });
  return fetch(`${BASE}/api/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` },
    body: raw,
  });
};
/** Ask, and wait for the reply to land at the stand-in Meta. */
const ask = async (from, text, timeoutMs = 58000) => {
  const before = sent.length;
  await post(from, text);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const got = sent.slice(before).filter((m) => m.to === from);
    if (got.length > 0) return { text: got.map((m) => m.text).join('\n'), ms: Date.now() - start };
    await sleep(400);
  }
  return { text: '', ms: timeoutMs };
};

try {
  const stranger = await ask(STRANGER, 'How much do I owe?');
  check('an unlinked number gets only how to link', /not linked/i.test(stranger.text) && !/₦/.test(stranger.text), stranger.text.slice(0, 80));

  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await anon.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
  const { data: mem } = await anon.rpc('my_membership');
  const storeId = mem[0].store_id;
  const { data: code } = await anon.rpc('create_whatsapp_link_code', { p_store_id: storeId });
  const linked = await ask(PHONE, `Link ${code}`);
  check('the code links, and says so', /Linked/.test(linked.text), linked.text.slice(0, 80));

  // What the shop's records say, read as the owner.
  const { data: items } = await anon.rpc('search_products', { p_store_id: storeId, p_query: 'trophy bottle', p_limit: 8, p_offset: 0 });
  const { data: debtors } = await anon.rpc('debtors_aged', { p_store_id: storeId });
  const total = (debtors ?? []).reduce((s, r) => s + Number(r.balance), 0);

  const stock = await ask(PHONE, 'How much Trophy Bottle is left?');
  console.log(`      (${stock.ms}ms) ${stock.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  check('it answers about Trophy', /trophy/i.test(stock.text) && /\d/.test(stock.text), `${items?.length} items in the records`);

  const owes = await ask(PHONE, 'Who owes me? Give me the total.');
  console.log(`      (${owes.ms}ms) ${owes.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  const shown = Math.round(total).toLocaleString('en-NG');
  check('the total owed is the database’s, not invented', owes.text.replace(/,/g, '').includes(String(Math.round(total))) || owes.text.includes(shown), `records say ₦${shown}`);

  const follow = await ask(PHONE, 'What are today’s sales?');
  console.log(`      (${follow.ms}ms) ${follow.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  check('today’s sales are answered', /sale|receipt|billed|₦/i.test(follow.text));

  const receipt = await ask(PHONE, 'Print the last receipt for Busayo Store');
  console.log(`      (${receipt.ms}ms) ${receipt.text.replace(/\s+/g, ' ').slice(0, 200)}`);
  check('a receipt comes as a link with the print flag', /\/r\/[^\s]+\?print=1/.test(receipt.text));

  const write = await ask(PHONE, 'Record a sale of 2 crates of Trophy to Busayo Store');
  console.log(`      (${write.ms}ms) ${write.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  check('asked to change something, it says it cannot yet', /coming soon|app|cannot|can.t/i.test(write.text));

  const { data: log } = await admin.from('whatsapp_messages').select('tools').eq('wa_phone', PHONE).eq('direction', 'out').not('tools', 'is', null);
  const providers = [...new Set((log ?? []).flatMap((m) => m.tools?.providers ?? []))];
  check('every answer is logged with what it called', (log ?? []).length >= 4, `models used: ${providers.join(', ')}`);
  const skipped = [...new Set((log ?? []).flatMap((m) => m.tools?.skipped ?? []))];
  if (skipped.length > 0) console.log(`      failed over: ${skipped.join(' | ')}`);
} catch (e) {
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  meta.close();
  await admin.from('whatsapp_messages').delete().in('wa_phone', [PHONE, STRANGER]);
  await admin.from('whatsapp_links').delete().eq('wa_phone', PHONE);
  console.log('  (probe rows removed)');
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

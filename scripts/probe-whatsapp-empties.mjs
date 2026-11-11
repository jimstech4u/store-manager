/**
 * THE AGENT AND A CUSTOMER'S EMPTIES (11 Nov) — the owner's own two messages, replayed.
 *
 *   "Give me New look Empties record from the last 2 receipts we have of them"
 *     → receipt_empties, with quantities, receipt by receipt; never the statement.
 *   "the empties haven't been brought back so I need to revert that and then give me in the products
 *    group instead"
 *     → a proposal to set what came back to nought (propose_receipt_empties_back), answered NO.
 *
 * Meta stood in on :3199 (start the app with serve_agent). Records nothing: the proposal is refused,
 * and the receipts' empties are read before and after to prove it.
 *
 *     node scripts/probe-whatsapp-empties.mjs [http://localhost:3100]
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';


const BASE = process.argv[2] ?? 'http://localhost:3100';
/** A photo of a written list, served as WhatsApp media (optional: `PHOTO=path.jpg`). */
const PHOTO = process.env.PHOTO && existsSync(process.env.PHOTO) ? readFileSync(process.env.PHOTO) : null;
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

// Meta, stood in: everything the app sends is kept here.
const sent = [];
const meta = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // A photo sent in: its media record, then the file itself.
    if (req.method === 'GET' && req.url.endsWith('/media-photo')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ url: 'http://localhost:3199/file/photo.jpg', mime_type: 'image/jpeg' }));
    }
    if (req.method === 'GET' && req.url.endsWith('/file/photo.jpg')) {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(PHOTO ?? Buffer.alloc(0));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith('/messages')) {
      try {
        const m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (m.type === 'text') sent.push({ to: m.to, type: 'text', text: m.text?.body ?? '', at: Date.now() });
        else if (m.type === 'interactive') {
          const i = m.interactive ?? {};
          sent.push({
            to: m.to, type: 'text', at: Date.now(),
            text: i.body?.text ?? '',
            options: (i.action?.buttons ?? []).map((b) => b.reply?.title).concat((i.action?.sections ?? []).flatMap((s) => s.rows.map((r) => r.title))),
          });
        } else if (m.status === 'read') {
          // markRead
        } else sent.push({ to: m.to, type: m.type ?? 'other', at: Date.now() });
      } catch {
        // not JSON
      }
      return res.end(JSON.stringify({ messages: [{ id: `wamid.out.${Math.random().toString(36).slice(2)}` }] }));
    }
    res.end(JSON.stringify({}));
  });
});
await new Promise((r) => meta.listen(3199, r));

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PHONE = `997${Date.now().toString().slice(-9)}`;
const post = (message) => {
  const raw = JSON.stringify({ entry: [{ changes: [{ value: {
    contacts: [{ wa_id: PHONE, profile: { name: 'Probe' } }],
    messages: [{ id: `wamid.probe.${Math.random().toString(36).slice(2)}`, from: PHONE, ...message }],
  } }] }] });
  return fetch(`${BASE}/api/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'probe-secret').update(raw).digest('hex')}` },
    body: raw,
  });
};
/** Send, then wait for the reply that is not the acknowledgement. */
const ask = async (text, timeoutMs = 70_000, message = null) => {
  const before = sent.length;
  const start = Date.now();
  await post(message ?? { type: 'text', text: { body: text } });
  while (Date.now() - start < timeoutMs) {
    const got = sent.slice(before).filter((m) => m.to === PHONE && m.type === 'text');
    const real = got.filter((m) => !/^On it ⏳/.test(m.text));
    if (real.length > 0) {
      await sleep(300);
      const all = sent.slice(before).filter((m) => m.to === PHONE && m.type === 'text');
      return {
        ack: all.find((m) => /^On it ⏳/.test(m.text)) ?? null,
        ackMs: (all.find((m) => /^On it ⏳/.test(m.text))?.at ?? start) - start,
        text: all.filter((m) => !/^On it ⏳/.test(m.text)).map((m) => m.text).join('\n'),
        options: all.flatMap((m) => m.options ?? []),
        ms: Date.now() - start,
      };
    }
    await sleep(300);
  }
  return { ack: null, ackMs: -1, text: '', options: [], ms: timeoutMs };
};
const show = (r) => console.log(`      (${r.ms}ms, ack at ${r.ackMs}ms) ${r.text.replace(/\s+/g, ' ').slice(0, 260)}`);

const NEW_LOOK_RECEIPTS = ['22baa745-f3e1-4d86-837f-16acb8a8f056', 'd1746e61-e417-44e3-8dba-423c1bfbbab1'];
const lastCalls = async () => {
  const { data } = await admin.from('whatsapp_messages').select('tools').eq('wa_phone', PHONE).eq('direction', 'out')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data?.tools ?? {};
};

try {
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await anon.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
  const { data: mem } = await anon.rpc('my_membership');
  const storeId = mem[0].store_id;
  const backNow = async () => {
    const out = [];
    for (const id of NEW_LOOK_RECEIPTS) {
      const { data } = await anon.rpc('sale_empties', { p_sale_id: id });
      out.push(...(data ?? []).map((c) => `${c.product_name}:${Number(c.came_back)}`));
    }
    return out.sort().join(',');
  };
  const before = await backNow();

  const { data: code } = await anon.rpc('create_whatsapp_link_code', { p_store_id: storeId });
  const linked = await ask(`Link ${code}`);
  check('links', /Linked/.test(linked.text));

  console.log('\n— the empties of the last two receipts —');
  const r1 = await ask('Give me New look Empties record from the last 2 receipts we have of them');
  show(r1);
  const t1 = await lastCalls();
  const tools1 = (t1.calls ?? []).map((c) => c.tool);
  check('read with receipt_empties', tools1.includes('receipt_empties'), tools1.join(', '));
  check('not from the statement', !tools1.includes('customer_statement'));
  check('names both receipts', /22BAA745/i.test(r1.text) && /D1746E61/i.test(r1.text));
  check('says quantities', /\b[123]\b.*(crate|out|back)/i.test(r1.text));
  check('inside the minute, not cut short', r1.ms < 60_000 && !t1.late, `${r1.ms}ms`);

  console.log('\n— "they were not brought back" —');
  const r2 = await ask('So sorry, the empties haven’t been brought back so I need to revert that and then give me in the products group instead');
  show(r2);
  const t2 = await lastCalls();
  const tools2 = (t2.calls ?? []).map((c) => c.tool);
  const { data: pending } = await admin.from('whatsapp_pending').select('action, summary').eq('wa_phone', PHONE)
    .is('done_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (pending) console.log(`      proposal: ${pending.summary.replace(/\s+/g, ' ').slice(0, 300)}`);
  check('a proposal to put them back on them, shown first', pending?.action === 'receipt_empties_back', `${pending?.action ?? 'none'} · ${tools2.join(', ')}`);
  check('one proposal for both receipts', /22BAA745/i.test(pending?.summary ?? '') && /D1746E61/i.test(pending?.summary ?? ''));
  check('answered, not cut short', r2.text !== '' && !t2.late, `${r2.ms}ms`);

  if (pending) {
    const r3 = await ask('NO');
    show(r3);
  }
  check('nothing was recorded', (await backNow()) === before);
} catch (e) {
  check('ran', false, String(e).split('\n')[0]);
} finally {
  await admin.from('whatsapp_pending').delete().eq('wa_phone', PHONE);
  await admin.from('whatsapp_links').delete().eq('wa_phone', PHONE);
  meta.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

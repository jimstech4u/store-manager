/**
 * THE AGENT, "IN GROUP" (12 Nov) — the owner's three messages about Arewa this morning, replayed.
 *
 *   "Give me Arewa empties" → receipt_empties, receipt by receipt.
 *   "Just the last receipt for Arewa" → the last one with empties still out.
 *   "Give me this in group" → by maker, with each maker's total, from what receipt_empties already
 *     gives — it took seven lookups and 28 seconds before (receipt numbers failed, and so did the
 *     total for a receipt asked without its customer).
 *
 * What is expected is read from the shop as it is now (Arewa's receipts move as crates come back).
 *
 * Meta stood in on :3199 (start the app with serve_agent). Reads only: nothing is proposed or recorded.
 *
 *     node scripts/probe-whatsapp-groups.mjs [http://localhost:3100]
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
  // The last receipt with something still out, and its totals by maker, as the shop has them now.
  const AREWA = 'c337bd93-1a91-4295-bcca-c2ba030ff3ff';
  const { data: recent } = await anon.rpc('customer_statement', { p_store_customer_id: AREWA, p_limit: 10 });
  let last = null;
  const byMaker = new Map();
  for (const r of recent ?? []) {
    const { data: rows } = await anon.rpc('sale_empties', { p_sale_id: r.sale_id });
    if ((rows ?? []).some((x) => Number(x.still_out) > 0)) {
      last = String(r.sale_id).slice(0, 8).toUpperCase();
      for (const x of rows) {
        if (Number(x.still_out) <= 0) continue;
        const g = x.group_name ?? x.product_name;
        byMaker.set(g, (byMaker.get(g) ?? 0) + Number(x.still_out));
      }
      break;
    }
  }
  console.log(`  expected: #${last}, ${[...byMaker].map(([g, n]) => `${g} ${n}`).join(' · ')}`);

  const { data: code } = await anon.rpc('create_whatsapp_link_code', { p_store_id: storeId });
  const linked = await ask(`Link ${code}`);
  check('links', /Linked/.test(linked.text));

  console.log('\n— Arewa’s empties —');
  const r1 = await ask('Give me Arewa empties');
  show(r1);
  const t1 = await lastCalls();
  check('read with receipt_empties', (t1.calls ?? []).some((c) => c.tool === 'receipt_empties'));
  check('says quantities', /\d+ crates?/i.test(r1.text));

  console.log('\n— just the last receipt —');
  const r2 = await ask('Just the last receipt for Arewa');
  show(r2);
  check(`the last with empties out, #${last}`, new RegExp(last, 'i').test(r2.text));

  console.log('\n— "in group" —');
  const r3 = await ask('Give me this in group');
  show(r3);
  const t3 = await lastCalls();
  const tools3 = (t3.calls ?? []).map((c) => c.tool);
  const wrong = [...byMaker].filter(([g, n]) => {
    const line = (r3.text.match(new RegExp(`[^\\n]*${g}[^\\n]*`)) ?? [''])[0];
    return !new RegExp(`\\b${n}\\b`).test(line);
  });
  check('each maker with its own total', byMaker.size > 0 && wrong.length === 0, wrong.map(([g, n]) => `${g} should be ${n}`).join(', ') || [...byMaker].map(([g, n]) => `${g} ${n}`).join(' · '));
  check('in a few lookups, not seven', tools3.length <= 3, tools3.join(', '));
  check('quickly', r3.ms < 25_000 && !t3.late, `${r3.ms}ms`);
} catch (e) {
  check('ran', false, String(e).split('\n')[0]);
} finally {
  await admin.from('whatsapp_pending').delete().eq('wa_phone', PHONE);
  await admin.from('whatsapp_links').delete().eq('wa_phone', PHONE);
  meta.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

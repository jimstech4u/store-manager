/**
 * THE AGENT TAKES A WHOLE ORDER LIST (11 Nov) — the real lists that failed, replayed.
 *
 * Valuemart's twenty-four lines (7 Nov) got no answer at all; Arewa's twelve (9 Nov) got none, then raw
 * tool calls, and both left empty orders on the till. Each list here is sent as the shop sent it, for a
 * probe customer, and must:
 *   - be acknowledged at once ("On it"),
 *   - be answered inside the minute, in words — never raw tool calls,
 *   - end with an order on the till holding most of its lines, the rest held as questions,
 *   - go through `order_add_list` in one call, not a lookup per line,
 *   - leave no empty order behind.
 * Nothing is sold; every order the probe opens is cancelled at the end and the link removed.
 *
 * The app must run with WHATSAPP_GRAPH_URL=http://localhost:3199 and WHATSAPP_APP_SECRET=probe-secret.
 *
 *     node scripts/probe-whatsapp-orders.mjs [http://localhost:3100]
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

const LISTS = {
  valuemart: `Goldberg 2
Turbo king 1
Castle lite 3
Trophy 2
Flying fish 1
Viju fruits 2
Amstel malt 1
Orijin bottle 1
Budweiser can 2
Zetar 5
Cedaa 3
Dudu yogurt can 2
Ribena pet 1
Fayrouz can 2
Can stout 2
Malta Guinness 2
Maltina can 3
Laqua 20
Nirvana 20
Aquafina 10
Nutrichoco 2
Viju chocolate 2
Heineken can 2
Lacasera 2`,
  arewa: `Goldberg 6
Trophy 7
Lite 4
Turbo 3
Big stout 2
Budweiser 4
Gulder 2
Mr v 10
Pepsi 3
Coke pet 4
Lakasera 3
Malta Guiness can 1`,
};

const opened = new Set();
try {
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await anon.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
  const { data: mem } = await anon.rpc('my_membership');
  const storeId = mem[0].store_id;
  const { data: code } = await anon.rpc('create_whatsapp_link_code', { p_store_id: storeId });
  const linked = await ask(`Link ${code}`);
  check('links', /Linked/.test(linked.text));

  // Probe customers, one per list, so no real customer's order is touched — and two lists for two
  // people must make two orders.
  const { data: found } = await anon.rpc('list_customers', { p_store_id: storeId, p_query: 'AAA', p_limit: 2 });
  const names = (found ?? []).map((c) => c.display_name);
  check('two probe customers to order for', names.length === 2, names.join(', '));
  const drafts = [];

  for (const [k, [name, list]] of Object.entries(LISTS).entries()) {
    const who = names[k];
    const lines = list.split('\n').length;
    console.log(`\n— ${name}: ${lines} lines —`);
    const r = await ask(`${who}'s order\n\n${list}`);
    show(r);
    check(`${name}: acknowledged at once`, r.ack !== null && r.ackMs < 8_000, `${r.ackMs}ms`);
    check(`${name}: answered inside the minute`, r.text !== '' && r.ms < 60_000, `${r.ms}ms`);
    check(`${name}: in words, not tool calls`, r.text !== '' && !/"tool"\s*:|"input"\s*:\s*\{/.test(r.text), r.text.slice(0, 80));

    const { data: msg } = await admin.from('whatsapp_messages').select('tools').eq('wa_phone', PHONE).eq('direction', 'out')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    const calls = msg?.tools?.calls ?? [];
    const bulk = calls.filter((c) => c.tool === 'order_add_list');
    const perLine = calls.filter((c) => c.tool === 'order_set' || c.tool === 'find_items').length;
    // A reply cut short by the clock says where the order stands; it has no trace of its calls.
    const late = Boolean(msg?.tools?.late);
    check(
      `${name}: the list went in as one order_add_list`,
      bulk.length >= 1 || (late && perLine === 0),
      late ? 'answered late, from the saved order' : `order_add_list ×${bulk.length}, find_items/order_set ×${perLine}`,
    );
    check(`${name}: not cut short by the clock`, !late);
    const summary = bulk.at(-1)?.result?.list;
    if (summary) console.log(`      placed ${summary.placed} of ${summary.lines}, held ${summary.held}`);

    const { data: lk } = await admin.from('whatsapp_links').select('working_draft_id, order_questions').eq('wa_phone', PHONE).maybeSingle();
    const draftId = lk?.working_draft_id;
    if (draftId) opened.add(draftId);
    drafts.push(draftId);
    if (k === 1) check('the second customer\'s list is an order of its own', drafts[0] && drafts[1] && drafts[0] !== drafts[1]);
    const { count } = draftId
      ? await admin.from('draft_order_lines').select('id', { count: 'exact', head: true }).eq('draft_order_id', draftId)
      : { count: 0 };
    const held = (lk?.order_questions ?? []).length;
    check(`${name}: every line is on the order or held as a question`, (count ?? 0) + held >= lines - 1, `${count} on it, ${held} held, ${lines} sent`);
    check(`${name}: most lines placed`, (count ?? 0) >= Math.floor(lines / 2), `${count} of ${lines}`);
  }

  // A photo of a written list, captioned with who it is for.
  if (PHOTO) {
    console.log('\n— a photo of a list —');
    const who = names[0];
    const r = await ask('', 70_000, { type: 'image', image: { id: 'media-photo', caption: `Market for ${who}` } });
    show(r);
    check('photo: acknowledged at once', r.ack !== null && r.ackMs < 8_000, `${r.ackMs}ms`);
    check('photo: answered inside the minute, in words', r.text !== '' && r.ms < 60_000 && !/"tool"\s*:/.test(r.text), `${r.ms}ms`);
    const { data: msg } = await admin.from('whatsapp_messages').select('tools').eq('wa_phone', PHONE).eq('direction', 'out')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    const bulk = (msg?.tools?.calls ?? []).filter((c) => c.tool === 'order_add_list');
    const read = bulk.at(-1)?.args?.lines?.length ?? 0;
    check('photo: its lines were read into one order_add_list', read >= 5, `${read} lines read`);
    const { data: lk } = await admin.from('whatsapp_links').select('working_draft_id').eq('wa_phone', PHONE).maybeSingle();
    if (lk?.working_draft_id) opened.add(lk.working_draft_id);
  }

  // A plain question still gets a plain answer, with no "On it" in front of it.
  console.log('\n— a plain question —');
  const plain = await ask('How much is Irekanmi balance');
  show(plain);
  check('a short question is not acknowledged first', plain.ack === null);
  check('and is answered with the figure', /₦[\d,]+/.test(plain.text), plain.text.slice(0, 80));

  // Every order this phone opened, and that none is left empty.
  const { data: mine } = await admin.from('draft_orders').select('id, status').eq('held_by', (await anon.auth.getUser()).data.user.id)
    .gte('created_at', new Date(Date.now() - 15 * 60_000).toISOString());
  for (const d of mine ?? []) {
    const { count } = await admin.from('draft_order_lines').select('id', { count: 'exact', head: true }).eq('draft_order_id', d.id);
    if (d.status === 'open' && opened.has(d.id)) continue;
    if (d.status === 'open' && (count ?? 0) === 0) {
      check('no empty order left on the till', false, d.id);
      opened.add(d.id);
    }
  }
} catch (e) {
  check('ran', false, String(e).split('\n')[0]);
} finally {
  for (const d of opened) await admin.from('draft_orders').update({ status: 'cancelled' }).eq('id', d).eq('status', 'open');
  await admin.from('whatsapp_links').delete().eq('wa_phone', PHONE);
  meta.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

/**
 * TODAY'S TWO ORDERS, REPLAYED (12 Nov) — DCC's list and its answers, and Olaoluwa's one-line order.
 *
 *   DCC: "Desperado - 5pcs" went on as five crates (₦115,500) when the owner meant five bottles, a
 *   quarter crate; the four answers ran out of the minute one order_set at a time and stayed "to check".
 *   Olaoluwa: "For olaoluwa Mr v 30 American cooler 20" was read as two lines, "For olaoluwa" and the
 *   rest; the model then sent the same failing order_set four times.
 *
 * Each is sent for a probe customer and must:
 *   - read "5pcs" as single ones: Desperado and Flying Fish a quarter crate each, never five crates,
 *   - settle the answers in one order_add_list, inside the minute, with nothing left to check,
 *   - learn a name that matched nothing (Gfblg) — forgotten again at the end,
 *   - read "For <customer> Mr v 30 American cooler 20" as Mr V 30 and American cooler 20.
 * Nothing is sold: every order the probe opens is cancelled, the link removed, and what it taught forgotten.
 *
 * The app must run with WHATSAPP_GRAPH_URL=http://localhost:3199 and WHATSAPP_APP_SECRET=probe-secret.
 *
 *     node scripts/probe-whatsapp-dcc.mjs [http://localhost:3100]
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

// Meta, stood in.
const sent = [];
const meta = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith('/messages')) {
      try {
        const m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (m.type === 'text') sent.push({ to: m.to, type: 'text', text: m.text?.body ?? '', at: Date.now() });
        else if (m.type === 'interactive') sent.push({ to: m.to, type: 'text', text: m.interactive?.body?.text ?? '', at: Date.now() });
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
const PHONE = `996${Date.now().toString().slice(-9)}`;
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
const ask = async (text, timeoutMs = 75_000) => {
  const before = sent.length;
  const start = Date.now();
  await post(text);
  while (Date.now() - start < timeoutMs) {
    const real = sent.slice(before).filter((m) => m.to === PHONE && m.type === 'text' && !/^On it ⏳/.test(m.text));
    if (real.length > 0) {
      await sleep(300);
      return { text: sent.slice(before).filter((m) => m.to === PHONE && !/^On it ⏳/.test(m.text)).map((m) => m.text).join('\n'), ms: Date.now() - start };
    }
    await sleep(300);
  }
  return { text: '', ms: timeoutMs };
};
const lastOut = async () =>
  (await admin.from('whatsapp_messages').select('tools').eq('wa_phone', PHONE).eq('direction', 'out').order('created_at', { ascending: false }).limit(1).maybeSingle()).data?.tools ?? {};
const working = async () => (await admin.from('whatsapp_links').select('working_draft_id, order_questions').eq('wa_phone', PHONE).maybeSingle()).data;
const linesOn = async (draftId) => {
  if (!draftId) return [];
  const { data, error } = await admin.from('draft_order_lines').select('product_id, entered_qty, line_total, sale_unit_id').eq('draft_order_id', draftId);
  if (error) console.log('      lines:', error.message);
  const ids = [...new Set((data ?? []).map((l) => l.product_id))];
  const units = [...new Set((data ?? []).map((l) => l.sale_unit_id).filter(Boolean))];
  const names = new Map(((await admin.from('products').select('id, name').in('id', ids)).data ?? []).map((r) => [r.id, r.name]));
  const shapes = new Map(((await admin.from('product_units').select('id, unit_name').in('id', units)).data ?? []).map((r) => [r.id, r.unit_name]));
  return (data ?? []).map((l) => ({ name: names.get(l.product_id) ?? '', qty: Number(l.entered_qty), unit: shapes.get(l.sale_unit_id) ?? '', total: Number(l.line_total) }));
};

const opened = new Set();
const taughtHere = [];
let anon;
try {
  anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await anon.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
  const { data: mem } = await anon.rpc('my_membership');
  const storeId = mem[0].store_id;
  // What the shop already knows these words as: only what the probe teaches is forgotten after.
  for (const w of ['Gfblg', 'Bln', 'Tlstout', 'fayrous']) {
    const { data } = await anon.rpc('product_name_meanings', { p_store_id: storeId, p_phrase: w });
    if ((data ?? []).length === 0) taughtHere.push(w);
  }
  const { data: code } = await anon.rpc('create_whatsapp_link_code', { p_store_id: storeId });
  check('links', /Linked/.test((await ask(`Link ${code}`)).text));
  const { data: found } = await anon.rpc('list_customers', { p_store_id: storeId, p_query: 'AAA', p_limit: 2 });
  const [first, second] = (found ?? []).map((c) => c.display_name);
  check('two probe customers', Boolean(first && second), `${first}, ${second}`);

  // ── DCC's list, as sent ──
  console.log('\n— DCC\'s list —');
  const r1 = await ask(`For ${first}\nTurbo - 1/2\nGfblg - 1/2\n33 - 1/2\nDesperado - 5pcs\nFlyfish - 5pcs\nTlstout - 1/2\nfayrous - 6pcs\nBln - 2pcs`);
  console.log(`      (${r1.ms}ms) ${r1.text.replace(/\s+/g, ' ').slice(0, 400)}`);
  check('answered inside the minute', r1.text !== '' && r1.ms < 60_000, `${r1.ms}ms`);
  let w = await working();
  if (w?.working_draft_id) opened.add(w.working_draft_id);
  let on = await linesOn(w?.working_draft_id);
  console.log('      on it:', on.map((l) => `${l.qty} ${l.unit} ${l.name}`).join('; '));
  const desperado = on.find((l) => /Desperado/i.test(l.name));
  const flying = on.find((l) => /Flying Fish/i.test(l.name));
  check('Desperado 5pcs is a quarter crate, not five crates', desperado?.qty === 0.25, desperado ? `${desperado.qty} ${desperado.unit}` : 'not on it');
  // Its crate is 12: five single ones is no part it sells, so it is asked — never five crates.
  const flyHeld = ((await working())?.order_questions ?? []).some((h) => /Flyfish/i.test(h.written));
  check('Flying Fish 5pcs: a part of its crate, or asked', flying ? flying.qty < 1 : flyHeld, flying ? `${flying.qty} ${flying.unit}` : 'asked');
  check('"Bln" is not put on as whatever the search found', !on.some((l) => /Berry Blast/i.test(l.name)));
  const fay = on.find((l) => /Fayrouz/i.test(l.name));
  console.log('      fayrous 6pcs:', fay ? `${fay.qty} ${fay.unit} ${fay.name}` : 'held');
  check('nothing on it in whole crates that was written in pcs', !on.some((l) => /Desperado|Flying|Fayrouz/i.test(l.name) && l.qty >= 1));
  const held = w?.order_questions ?? [];
  console.log('      held:', held.map((h) => `${h.written} (${h.why})`).join(' | '));

  // ── The answers, numbered as asked ──
  const ANSWER = { gfblg: '0.5 golberg bottle', tlstout: '0.5 trophy stout', fayrous: '1/4 Fayrouz', bln: '2 Mr V' };
  const answers = held.map((h, i) => `${i + 1}. ${ANSWER[h.written.toLowerCase().split(/[\s-]/)[0]] ?? h.written}`);
  if (answers.length > 0) {
    console.log('\n— the answers —');
    const r2 = await ask(answers.join('\n'));
    console.log(`      (${r2.ms}ms) ${r2.text.replace(/\s+/g, ' ').slice(0, 400)}`);
    check('answers settled inside the minute', r2.text !== '' && r2.ms < 60_000, `${r2.ms}ms`);
    const t = await lastOut();
    const calls = (t.calls ?? []).map((c) => c.tool);
    check('in one order_add_list, not order_set one by one', calls.includes('order_add_list') && !calls.includes('order_set'), calls.join(', ') || (t.late ? 'late' : 'none'));
    const learned = (t.calls ?? []).flatMap((c) => c.result?.list?.learned ?? []);
    if (learned.length) console.log('      learned:', learned.join('; '));
    w = await working();
    on = await linesOn(w?.working_draft_id);
    console.log('      on it:', on.map((l) => `${l.qty} ${l.unit} ${l.name}`).join('; '));
    const left = w?.order_questions ?? [];
    check('nothing left to check, or only what is still unclear', left.length < held.length, left.map((h) => `${h.written} (${h.why})`).join(' | ') || 'none');
    // What the reply still asks about is still saved as a question: a line repeated unchanged stays held.
    const stillAsked = held.filter((h) => !ANSWER[h.written.toLowerCase().split(/[\s-]/)[0]]);
    check('a line answered with itself is still held', stillAsked.every((h) => left.some((x) => x.written === h.written)), stillAsked.map((h) => h.written).join(' | ') || 'none to check');
  }

  // ── Olaoluwa's one line ──
  console.log('\n— one line, two items —');
  const r3 = await ask(`For ${second} Mr v 30 American cooler 20`);
  console.log(`      (${r3.ms}ms) ${r3.text.replace(/\s+/g, ' ').slice(0, 300)}`);
  check('answered inside the minute', r3.text !== '' && r3.ms < 60_000, `${r3.ms}ms`);
  w = await working();
  if (w?.working_draft_id) opened.add(w.working_draft_id);
  on = await linesOn(w?.working_draft_id);
  const q = (w?.order_questions ?? []).map((h) => h.written);
  console.log('      on it:', on.map((l) => `${l.qty} ${l.unit} ${l.name}`).join('; '), '| held:', q.join(' | '));
  check('the customer is not read as an item', !q.some((x) => /^for\b/i.test(x)) && !on.some((l) => /^for\b/i.test(l.name)), q.join(' | '));
  check('Mr V 30 is a line of its own', on.some((l) => /Mr\.? V/i.test(l.name) && l.qty === 30) || q.some((x) => /^Mr v 30$/i.test(x)));
  check('American cooler 20 is a line of its own', on.some((l) => /American/i.test(l.name) && l.qty === 20) || q.some((x) => /^American cooler 20$/i.test(x)));
  const t3 = await lastOut();
  const errs = (t3.calls ?? []).filter((c) => c.result?.error);
  check('no call failed twice the same way', new Set(errs.map((c) => c.tool + JSON.stringify(c.args))).size === errs.length);
} catch (e) {
  check('ran', false, String(e).split('\n')[0]);
} finally {
  for (const d of opened) await admin.from('draft_orders').update({ status: 'cancelled' }).eq('id', d).eq('status', 'open');
  await admin.from('whatsapp_links').delete().eq('wa_phone', PHONE);
  if (anon) {
    const { data: mem } = await anon.rpc('my_membership');
    for (const w of taughtHere) await anon.rpc('forget_product_name', { p_store_id: mem[0].store_id, p_phrase: w });
  }
  meta.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

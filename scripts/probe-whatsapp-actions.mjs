/**
 * THE ASSISTANT'S FULL CAPABILITIES — real models, the shop's real figures, Meta stood in, and NOTHING
 * RECORDED: the ledger cannot be taken back, so every action here is proposed and then answered NO.
 * What each proposal WOULD run is written to a file, and `rehearse` replays those exact arguments
 * against the live functions in a transaction that is rolled back.
 *
 * Also: a YES on an action the server refuses (claimed once, the refusal said, nothing done); a YES
 * with nothing open does nothing; files come back as a real PDF and picture; a voice note is heard and
 * answered; a PDF sent in is read. The app must be started with WHATSAPP_GRAPH_URL pointing here (3199).
 *
 *     node scripts/probe-whatsapp-actions.mjs <voice.wav> <out-dir> [http://localhost:3100]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';

const VOICE = process.argv[2];
const OUT = process.argv[3];
const BASE = process.argv[4] ?? 'http://localhost:3100';
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
const files = {};
let lastUpload = null;
let pdfToServe = null;
const meta = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const json = (o) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    const buf = Buffer.concat(chunks);
    if (req.url.endsWith('/media') && req.method === 'POST') {
      // The file part of the multipart body.
      const boundary = `--${String(req.headers['content-type']).split('boundary=')[1]}`;
      const parts = buf.toString('latin1').split(boundary);
      const part = parts.find((p) => p.includes('name="file"')) ?? '';
      const body = part.slice(part.indexOf('\r\n\r\n') + 4, part.lastIndexOf('\r\n'));
      lastUpload = { name: (part.match(/filename="([^"]+)"/) ?? [])[1], bytes: Buffer.from(body, 'latin1') };
      return json({ id: 'uploaded1' });
    }
    if (req.url.endsWith('/messages')) {
      const j = JSON.parse(buf.toString() || '{}');
      if (j.text?.body) sent.push({ to: j.to, type: 'text', text: j.text.body, options: [] });
      else if (j.interactive) {
        const a = j.interactive.action;
        const options = a.buttons ? a.buttons.map((b) => b.reply.title) : a.sections[0].rows.map((r) => r.title);
        sent.push({ to: j.to, type: 'text', text: j.interactive.body.text, options, shape: j.interactive.type });
      }
      else if (j.document) sent.push({ to: j.to, type: 'document', filename: j.document.filename, upload: lastUpload });
      else if (j.image) sent.push({ to: j.to, type: 'image', upload: lastUpload });
      return json({});
    }
    if (req.url === '/voice1') return json({ url: 'http://localhost:3199/file/voice', mime_type: 'audio/wav' });
    if (req.url === '/pdf1') return json({ url: 'http://localhost:3199/file/pdf', mime_type: 'application/pdf' });
    if (req.url === '/file/voice') {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(readFileSync(VOICE));
    }
    if (req.url === '/file/pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(pdfToServe);
    }
    return json({});
  });
});
await new Promise((r) => meta.listen(3199, r));

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PHONE = `996${Date.now().toString().slice(-9)}`;
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
const send = async (message, timeoutMs = 58000) => {
  const before = sent.length;
  await post(message);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const got = sent.slice(before).filter((m) => m.to === PHONE);
    // A file and its one-line note arrive separately: wait for words.
    if (got.some((m) => m.type === 'text')) {
      await sleep(150);
      const all = sent.slice(before).filter((m) => m.to === PHONE);
      const words = all.filter((m) => m.type === 'text');
      return { text: words.map((m) => m.text).join('\n'), options: words.flatMap((m) => m.options), files: all.filter((m) => m.type !== 'text'), ms: Date.now() - start };
    }
    await sleep(300);
  }
  return { text: '', options: [], files: [], ms: timeoutMs };
};
const ask = (text) => send({ type: 'text', text: { body: text } });
const tap = (title) => send({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'o0', title } } });
const show = (r) => console.log(`      (${r.ms}ms) ${r.text.replace(/\s+/g, ' ').slice(0, 170)}${r.options?.length ? ` [${r.options.join(' | ')}]` : ''}`);

const proposals = [];
/** Ask for something; it must come back as a proposal, which is kept and then refused. */
const proposes = async (what, text, mustSay) => {
  const r = await ask(text);
  show(r);
  const ok = /Reply \*YES\*/.test(r.text) && mustSay.test(r.text);
  check(`proposes: ${what}`, ok, ok ? '' : r.text.slice(0, 160));
  if (ok) check('  with YES and NO to tap', r.options.join() === 'YES,NO', r.options.join());
  const { data } = await admin.from('whatsapp_pending').select('action, args').eq('wa_phone', PHONE).is('done_at', null).maybeSingle();
  if (data) proposals.push(data);
  const no = await tap('NO');
  check(`  and NO cancels it`, /Nothing was recorded/.test(no.text), no.text.slice(0, 60));
};

try {
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await anon.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
  const { data: mem } = await anon.rpc('my_membership');
  const storeId = mem[0].store_id;
  const { data: { user } } = await anon.auth.getUser();
  const { data: code } = await anon.rpc('create_whatsapp_link_code', { p_store_id: storeId });
  const linked = await ask(`Link ${code}`);
  check('links', /Linked/.test(linked.text));
  check('the welcome offers things to tap', linked.options.length === 3, linked.options.join(' | '));

  // Real receipts of one customer, read as the shop, to correct and to put together.
  const { data: found } = await anon.rpc('list_customers', { p_store_id: storeId, p_query: 'Busayo Store', p_limit: 1 });
  const buyer = found[0];
  const { data: theirs } = await admin.from('sales').select('id').eq('store_customer_id', buyer.id).eq('status', 'posted').order('created_at', { ascending: false }).limit(2);
  const { data: lastDoc } = await anon.rpc('sale_document', { p_sale_id: theirs[0].id });
  const onIt = lastDoc.lines[0];
  const number = theirs[0].id.slice(0, 8).toUpperCase();

  // The shop is trading while this runs, so only the customer used here can say nothing was recorded.
  const salesOfBuyer = async () => (await admin.from('sales').select('id', { count: 'exact', head: true }).eq('store_customer_id', buyer.id)).count;
  const salesBefore = await salesOfBuyer();
  const trace = async () => {
    const { data } = await admin.from('whatsapp_messages').select('tools').eq('wa_phone', PHONE).eq('direction', 'out').order('created_at', { ascending: false }).limit(1).maybeSingle();
    return JSON.stringify({ providers: data?.tools?.providers, skipped: data?.tools?.skipped, calls: data?.tools?.calls?.map((c) => c.tool) });
  };

  await proposes('a sale', 'I sold 2 crates of Trophy Bottle to Busayo Store, they paid 5000 cash', /Trophy.*\n?[\s\S]*Total/);
  await proposes('a payment', 'Busayo Store paid 10000 by transfer', /10,000/);
  await proposes('a delivery', 'We received 520 packs of Mr. V PET from Random at 1200 each', /Mr\. V[\s\S]*Total/);
  await proposes('an expense', 'I spent 3000 cash on diesel for the generator', /3,000/);
  await proposes('a charge', 'Charge Busayo Store 500 for transport', /500/);
  await proposes('a deposit', 'Busayo Store put down a 2000 deposit for crates', /2,000/);
  await proposes('a count', 'Today’s count of Trophy Bottle: 107 crates on the shelf', /107/);
  await proposes('a new customer', 'Add a new customer called Probe Testing Customer, phone 08000000000', /Probe Testing/);
  await proposes('money back', 'Give Busayo Store 700 back in cash, they overpaid', /700/);
  await proposes('empties back', 'Busayo Store brought back 2 crates of Trophy Bottle empties', /2/);
  await proposes('a receipt correction', `Correct receipt #${number}: make ${onIt.product_name} ${Number(onIt.entered_qty) + 1} ${onIt.unit_name}, because the count was wrong`, /Correct receipt[\s\S]*will say/);
  await proposes('a receipt cancelled', `Cancel receipt #${number}, the customer returned everything`, new RegExp(number));

  const none = await ask('yes');
  show(none);
  check('a YES with nothing open records nothing', !/Recorded/.test(none.text));

  // A YES the server refuses: claimed once, the reason said, nothing done.
  await admin.from('whatsapp_pending').insert({
    wa_phone: PHONE, store_id: storeId, user_id: user.id, action: 'count',
    args: { product_id: '00000000-0000-0000-0000-000000000000', counted: 1 }, summary: 'probe',
  });
  const refused = await ask('YES');
  show(refused);
  check('a YES the server refuses says so', /not recorded/i.test(refused.text));

  const salesAfter = await salesOfBuyer();
  check('and not one sale was recorded', salesAfter === salesBefore, `${salesBefore} → ${salesAfter}`);

  // Files back.
  const pdf = await ask('Send me Busayo Store’s statement for October as a PDF');
  show(pdf);
  const docMsg = pdf.files.find((f) => f.type === 'document');
  check('a statement comes back as a real PDF', docMsg && docMsg.upload?.bytes.slice(0, 5).toString() === '%PDF-', docMsg?.filename);
  if (docMsg) {
    pdfToServe = docMsg.upload.bytes;
    writeFileSync(`${OUT}/bot-statement.pdf`, docMsg.upload.bytes);
  }
  const pic = await ask('Now send who owes me as a picture');
  show(pic);
  const imgMsg = pic.files.find((f) => f.type === 'image');
  check('a report comes back as a picture', imgMsg && imgMsg.upload?.bytes.slice(1, 4).toString() === 'PNG');
  if (imgMsg) writeFileSync(`${OUT}/bot-owes.png`, imgMsg.upload.bytes);

  // A receipt, and two put together, as the shop's own paper.
  const rec = await ask(`Send receipt #${number} as a picture`);
  show(rec);
  const recImg = rec.files.find((f) => f.type === 'image');
  check('a receipt comes back as a picture', recImg && recImg.upload?.bytes.slice(1, 4).toString() === 'PNG', recImg ? '' : await trace());
  if (recImg) writeFileSync(`${OUT}/bot-receipt.png`, recImg.upload.bytes);
  const merged = await ask('Put Busayo Store’s last two receipts together as a PDF');
  show(merged);
  const mergedDoc = merged.files.find((f) => f.type === 'document');
  check('receipts put together come back as a PDF', mergedDoc && mergedDoc.upload?.bytes.slice(0, 5).toString() === '%PDF-', mergedDoc?.filename);
  if (mergedDoc) writeFileSync(`${OUT}/bot-combined.pdf`, mergedDoc.upload.bytes);

  // A misspelling, and a tap in place of typing.
  const fuzzy = await ask('how much tropy bottle is left');
  show(fuzzy);
  check('a misspelt item is still found', /trophy/i.test(fuzzy.text) && /\d/.test(fuzzy.text), /trophy/i.test(fuzzy.text) ? '' : await trace());
  check('an answer offers next steps', fuzzy.options.length > 0 && !/OPTIONS:/i.test(fuzzy.text), fuzzy.options.join(' | '));

  // The questions a shop actually asks, against figures read another way.
  const asks = async (what, text, must) => {
    const r = await ask(text);
    show(r);
    check(what, must(r), must(r) ? '' : await trace());
    return r;
  };
  const { data: bigDebtors } = await anon.rpc('list_customers', { p_store_id: storeId, p_filter: 'owes', p_min_amount: 100000, p_limit: 100 });
  const biggest = [...bigDebtors].sort((a, b) => b.balance - a.balance)[0].display_name;
  await asks('customers above an amount', 'Which customers owe above 100k?', (r) => r.text.includes(biggest.trim()));
  const { data: depositors } = await anon.rpc('list_customers', { p_store_id: storeId, p_filter: 'deposit', p_limit: 100 });
  const topDeposit = [...depositors].sort((a, b) => b.deposit_held - a.deposit_held)[0].display_name;
  await asks('customers holding a deposit', 'Who is holding a deposit with us?', (r) => r.text.includes(topDeposit.trim()));
  await asks('customers who stopped buying', 'Which customers have stopped buying, not bought in 30 days?', (r) => /\d{4}|\d+ customers|last/i.test(r.text));
  const { data: items } = await anon.rpc('search_products', { p_store_id: storeId, p_query: 'Trophy Bottle', p_limit: 1, p_offset: 0 });
  const { data: owing } = await anon.rpc('who_owes_for_product', { p_store_id: storeId, p_product_id: items[0].id });
  await asks('who took an item and still owes', 'Who took Trophy Bottle and still owes for it?', (r) => (owing.length === 0 ? /nobody|no one|none/i.test(r.text) : r.text.includes(owing[0].customer_name.trim())));
  await asks('who bought an item', 'Who bought the most Trophy Bottle this month?', (r) => /₦/.test(r.text));
  await asks('what a customer takes', 'What does Busayo Store usually buy?', (r) => /₦|crate|bottle|pack/i.test(r.text));
  await asks('a reminder ready to send', 'Remind Busayo Store of what they owe', (r) => /wa\.me\//.test(r.text));
  await asks('what sold best', 'What are my best sellers this month by profit?', (r) => /₦/.test(r.text));
  await asks('how the day went', 'How did today go? Cash and transfer', (r) => /₦/.test(r.text));
  await asks('what to order', 'What should I order, what is about to run out?', (r) => /out|days|left/i.test(r.text));
  await asks('what needs attention', 'What needs my attention today?', (r) => r.text.length > 40);
  await asks('what is owed to suppliers', 'How much do I owe my suppliers?', (r) => /₦|nothing|no /i.test(r.text));
  const list = await ask('Send the customers who owe above 100k as a PDF');
  show(list);
  const listDoc = list.files.find((f) => f.type === 'document');
  check('a filtered list comes back as a PDF', listDoc && listDoc.upload?.bytes.slice(0, 5).toString() === '%PDF-', listDoc?.filename ?? await trace());
  const tapped = await tap('Sales today');
  show(tapped);
  check('a tapped option is answered like a typed one', /₦|\d/.test(tapped.text));

  // Hearing and reading.
  const voice = await send({ type: 'audio', audio: { id: 'voice1' } });
  show(voice);
  check('a voice note is heard and answered', /trophy/i.test(voice.text) && /\d/.test(voice.text));
  if (pdfToServe) {
    const read = await send({ type: 'document', document: { id: 'pdf1', caption: 'What is the amount owed at the end on this statement?', filename: 's.pdf' } });
    show(read);
    check('a PDF sent in is read', /\d/.test(read.text) && /₦|N\d/.test(read.text), await trace());
  }
  const noIds = sent.filter((m) => m.type === 'text' && /[0-9a-f]{8}-[0-9a-f]{4}-/.test(m.text));
  check('no internal id was ever shown', noIds.length === 0, noIds[0]?.text.slice(0, 80));
  const leaked = sent.filter((m) => m.type === 'text' && /OPTIONS:/i.test(m.text));
  check('the OPTIONS line never reaches the chat', leaked.length === 0, leaked[0]?.text.slice(-80));
} catch (e) {
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  writeFileSync(`${OUT}/bot-proposals.json`, JSON.stringify(proposals, null, 1));
  meta.close();
  await admin.from('whatsapp_pending').delete().eq('wa_phone', PHONE);
  await admin.from('whatsapp_messages').delete().eq('wa_phone', PHONE);
  await admin.from('whatsapp_links').delete().eq('wa_phone', PHONE);
  console.log('  (probe rows removed)');
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

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
let probeDraft = null;
const probeWords = [];
/** Ask for something; it must come back as a proposal, which is kept and then refused. */
const proposes = async (what, text, mustSay, paperOnly = false) => {
  let r = await ask(text);
  show(r);
  // Counted since the sale (0263): it has to ask before it proposes.
  if (paperOnly && !/Reply \*YES\*/.test(r.text)) {
    check(`  asks whether the goods moved: ${what}`, /paper|moved/i.test(r.text), r.text.slice(0, 140));
    r = await ask('Only the paper was wrong');
    show(r);
    check('  and the proposal says so', /stays as counted/.test(r.text), r.text.slice(0, 200));
  }
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

  {
    // Part paid: the rest is asked about first (the till's rule), then proposed as they say.
    const r = await ask('I sold 2 crates of Trophy Bottle to Busayo Store, they paid 5000 cash');
    show(r);
    check('a part payment asks about the rest first', /remain/i.test(r.text) && !/Reply \*YES\*/.test(r.text), r.text.slice(0, 160));
  }
  await proposes('a sale', 'Put the rest on her account', /Trophy[\s\S]*Total[\s\S]*account/);
  await proposes('a payment', 'Busayo Store paid 10000 by transfer', /10,000/);
  await proposes('a delivery', 'We received 520 packs of Mr. V PET from Random at 1200 each', /Mr\. V[\s\S]*Total/);
  await proposes('an expense', 'I spent 3000 cash on diesel for the generator', /3,000/);
  await proposes('a charge', 'Charge Busayo Store 500 for transport', /500/);
  await proposes('a deposit', 'Busayo Store put down a 2000 deposit for crates', /2,000/);
  await proposes('a count', 'Today’s count of Trophy Bottle: 107 crates on the shelf', /107/);
  await proposes('a new customer', 'Add a new customer called Probe Testing Customer, phone 08000000000', /Probe Testing/);
  await proposes('money back', 'Give Busayo Store 700 back in cash, they overpaid', /700/);
  await proposes('empties back', 'Busayo Store brought back 2 crates of Trophy Bottle empties', /2/);
  await proposes('a receipt correction', `Correct receipt #${number}: make ${onIt.product_name} ${Number(onIt.entered_qty) + 1} ${onIt.unit_name}, because the count was wrong`, /Correct receipt[\s\S]*will say/, true);
  await proposes('a receipt cancelled', `Cancel receipt #${number}, the customer returned everything`, new RegExp(number), true);

  // The gateway: anything the shop can do, found when needed, changes still behind YES (0266).
  await proposes('an item renamed', 'Rename Guinness big stout to Guinness Big Stout 60cl', /Rename an item[\s\S]*Guinness/);
  await proposes('a customer phone changed', "Change Busayo Store's phone number to 08011112222", /phone number[\s\S]*08011112222/);
  await proposes('a supplier added', 'Add a new supplier called Oreoluwa Ventures, phone 08033334444', /Add a supplier[\s\S]*Oreoluwa/);
  // An order built over several messages lives on the till (0267): read back, never remembered.
  {
    const r1 = await ask('Build an order for Busayo Store: 2 crates of Trophy Bottle and 1 crate of Goldberg Bottle');
    show(r1);
    const { data: lk } = await admin.from('whatsapp_links').select('working_draft_id').eq('wa_phone', PHONE).maybeSingle();
    probeDraft = lk?.working_draft_id ?? null;
    check('an order is opened on the till', Boolean(probeDraft) && /Trophy/i.test(r1.text) && /Goldberg/i.test(r1.text), r1.text.slice(0, 160));
    const r2 = await ask('Make the Trophy 3 crates');
    show(r2);
    const { data: lines } = await admin.from('draft_order_lines').select('entered_qty, product_id').eq('draft_order_id', probeDraft ?? '00000000-0000-0000-0000-000000000000');
    check('a change is saved on the order itself', (lines ?? []).some((l) => Number(l.entered_qty) === 3) && (lines ?? []).length === 2, JSON.stringify(lines));
    const r3 = await ask('Show me the order');
    show(r3);
    const { data: d } = await admin.from('draft_orders').select('code').eq('id', probeDraft ?? '00000000-0000-0000-0000-000000000000').maybeSingle();
    check('the order shown is the saved one, with its code', d?.code && r3.text.includes(d.code) && /3 crates/i.test(r3.text), r3.text.slice(0, 160));
  }
  await proposes('the order sold', 'Sell the order, they have not paid, put it on their account', /Sell order[\s\S]*Total/);

  // Two things in one message: the second is asked about after the YES on the first.
  {
    const r1 = await ask(`Busayo Store paid 1000 cash, and also add a new customer called Probe Twostep, phone 0809${String(Date.now()).slice(-7)}`);
    show(r1);
    check('the first of two things is proposed', /Reply \*YES\*/.test(r1.text), r1.text.slice(0, 140));
    // Answered NO here, so nothing is recorded: what is left is only taken up after a YES, which a probe cannot give.
    await ask('no');
    const fake = await ask('Add a new customer called Probe Nophone');
    show(fake);
    check('a phone is never made up', !/Reply \*YES\*/.test(fake.text) && /phone/i.test(fake.text), fake.text.slice(0, 140));
    if (/Reply \*YES\*/.test(fake.text)) await ask('no');

    // What is left after a YES: proven on a change that changes nothing, a group renamed to its own name.
    const { data: group } = await admin.from('product_categories').select('id, name').eq('store_id', storeId).limit(1).maybeSingle();
    if (group) {
      await admin.from('whatsapp_pending').insert({
        wa_phone: PHONE, store_id: storeId, user_id: user.id, action: 'capability', summary: 'probe',
        args: { name: 'rename_product_group', params: { p_category_id: group.id, p_name: group.name },
          _asked: `Rename the ${group.name} group to ${group.name}, and tell me how much Trophy Bottle is left`, _done: [] },
      });
      const before = sent.length;
      await ask('YES');
      // The done reply, then the rest of the message answered on its own.
      for (let i = 0; i < 120 && !sent.slice(before).some((m) => m.type === 'text' && /trophy/i.test(m.text)); i += 1) await sleep(500);
      const after = sent.slice(before).filter((m) => m.type === 'text').map((m) => m.text);
      console.log('      after YES:', after.map((t) => t.replace(/\s+/g, ' ').slice(0, 90)).join(' || '));
      check('after the YES, the rest of the message is done too', after.some((t) => /^Done/.test(t)) && after.some((t) => /trophy/i.test(t) && /\d/.test(t)));
    }
  }

  // The shop's words: taught once, found after; a word that means several is always asked.
  {
    const t = await ask('B/S means Guinness Big Bottle. Remember that.');
    show(t);
    const { data: taught } = await admin.from('product_aliases').select('phrase').eq('store_id', storeId).eq('phrase', 'b s');
    check('a word the shop uses is learned', (taught ?? []).length === 1, t.text.slice(0, 120));
    if ((taught ?? []).length) probeWords.push('b s');
    const f = await ask('How much B/S is left?');
    show(f);
    check('and found next time', /guinness big/i.test(f.text), f.text.slice(0, 140));
    const o = await ask('Order for Busayo Store: Goldberg 2, B/S 1, Coke 1, Dudu');
    show(o);
    const { data: lk } = await admin.from('whatsapp_links').select('working_draft_id, order_questions').eq('wa_phone', PHONE).maybeSingle();
    probeDraft = lk?.working_draft_id ?? probeDraft;
    const { data: placed } = await admin.from('draft_order_lines').select('product_id').eq('draft_order_id', lk?.working_draft_id ?? '00000000-0000-0000-0000-000000000000');
    check('clear lines go on the order', (placed ?? []).length >= 2, `${(placed ?? []).length} placed`);
    check('unclear lines are held, not guessed', (lk?.order_questions ?? []).length >= 1 && /\?/.test(o.text), JSON.stringify(lk?.order_questions ?? []).slice(0, 200));
  }
  {
    const r = await ask('How much did we spend on expenses this month?');
    show(r);
    check('a read nobody hand-wrote a tool for is answered', /₦|nothing|no expenses/i.test(r.text), r.text.slice(0, 120));
  }
  {
    const r = await ask('What is the balance of I R E K A N M I');
    show(r);
    check('a name spelled out letter by letter is found', /irekanmi/i.test(r.text) && !/akanni/i.test(r.text), r.text.slice(0, 120));
  }
  {
    const r = await send({ type: 'contacts', contacts: [{ name: { formatted_name: 'Probe Contact' }, phones: [{ phone: '+234 801 111 2222', wa_id: '2348011112222' }] }] });
    show(r);
    check('a shared contact is read', /Probe Contact|0801|2348011112222|contact|phone number/i.test(r.text) && !/I can read text, photos/.test(r.text), r.text.slice(0, 120));
  }

  // Reconciling, as the count screen does it: what the count found, and what happened to it.
  {
    const { data: off } = await admin.from('stock_periods').select('product_id, variance_qty, products!inner(name, store_id)')
      .eq('products.store_id', storeId).eq('status', 'open').not('counted_at', 'is', null).neq('variance_qty', 0).limit(1);
    const item = off?.[0]?.products?.name;
    check('there is a count with a difference to settle', Boolean(item));
    if (item) {
      const r = await ask(`What is the count difference on ${item}, and what can explain it?`);
      show(r);
      check('the agent says what the count found', /expected|counted|short|over|difference/i.test(r.text), r.text.slice(0, 140));
      const short = Number(off[0].variance_qty) < 0;
      await proposes('a count difference settled',
        `Settle the count of ${item}: the whole difference was ${short ? 'broken or spoiled' : 'a delivery nobody entered'}`,
        /Settle the count[\s\S]*(short|over)/);
    }
  }
  {
    // Only containers they actually hold can be written off; one they do not is refused before any YES.
    const { data: held } = await anon.rpc('customer_empties_owed', { p_store_customer_id: buyer.id });
    const one = (held ?? []).find((h) => Number(h.owed) >= 1 && (h.side ?? 'they_hold') === 'they_hold');
    if (one) {
      await proposes('empties written off', `Busayo Store broke 1 ${one.unit_name} of ${one.product_name}, they paid 1000 for it`, /Write off[\s\S]*not coming back/);
    }
    const none = await ask('Busayo Store broke 500 crates of Trophy Bottle');
    show(none);
    check('it will not write off containers they do not hold', !/Reply \*YES\*/.test(none.text), none.text.slice(0, 140));
    if (/Reply \*YES\*/.test(none.text)) await ask('no');
  }
  // Part payment: what is left is asked about, never assumed; and crates need a customer.
  {
    const r = await ask('Busayo Store bought 2 crates of Trophy Bottle, paid 5000 cash');
    show(r);
    check('asked again, it still asks rather than deciding', /remain|rest|account|another payment|balance/i.test(r.text) && !/Reply \*YES\*/.test(r.text), r.text.slice(0, 180));
    const r2 = await ask('Put the rest on her account');
    show(r2);
    check('and once told, proposes it on the account', /Reply \*YES\*/.test(r2.text) && /account/i.test(r2.text), r2.text.slice(0, 180));
    if (/Reply \*YES\*/.test(r2.text)) await ask('no');
    const r3 = await ask('A walk-in customer bought 1 crate of Trophy Bottle, paid in full by cash. No name.');
    show(r3);
    check('crates going out need a customer', !/Reply \*YES\*/.test(r3.text) && /customer|who/i.test(r3.text), r3.text.slice(0, 180));
    if (/Reply \*YES\*/.test(r3.text)) await ask('no');
  }
  {
    const r = await ask('What is waiting for my approval?');
    show(r);
    check('records waiting for approval are listed', /customer|item|approv|nothing/i.test(r.text), r.text.slice(0, 140));
  }

  // A receipt with an item counted after it: the question has to come first (0263).
  const { data: counts } = await admin.from('stock_periods').select('product_id, counted_at').eq('store_id', storeId).not('counted_at', 'is', null).order('counted_at', { ascending: false }).limit(5);
  let crossed = null;
  for (const c of counts ?? []) {
    const { data } = await admin.from('sale_lines').select('sale_id, sales!inner(store_id, status, occurred_at)')
      .eq('product_id', c.product_id).eq('sales.store_id', storeId).eq('sales.status', 'posted').lt('sales.occurred_at', c.counted_at).limit(1);
    if (data?.length) {
      crossed = data[0].sale_id;
      break;
    }
  }
  check('there is a receipt to ask about', Boolean(crossed));
  if (crossed) await proposes('a counted receipt cancelled', `Cancel receipt #${crossed.slice(0, 8).toUpperCase()}, it was entered by mistake`, /Cancel receipt/, true);

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
  check('the assistant asked about goods before proposing', sent.some((m) => m.type === 'text' && /counted after|paper was wrong|paper/i.test(m.text)));
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
  // The words the probe taught, and only those.
  for (const w of probeWords) await admin.from('product_aliases').delete().eq('phrase', w);
  // The probe's own open order, cancelled as the till cancels one.
  if (probeDraft) await admin.from('draft_orders').update({ status: 'cancelled' }).eq('id', probeDraft).eq('status', 'open');
  await admin.from('whatsapp_pending').delete().eq('wa_phone', PHONE);
  await admin.from('whatsapp_messages').delete().eq('wa_phone', PHONE);
  await admin.from('whatsapp_links').delete().eq('wa_phone', PHONE);
  console.log('  (probe rows removed)');
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

/**
 * THE WHATSAPP WEBHOOK, AS META WILL CALL IT — on a local build started with stand-in settings:
 *
 *   WHATSAPP_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID=000 WHATSAPP_APP_SECRET=probe-secret \
 *   WHATSAPP_VERIFY_TOKEN=probe-verify npx next start -p 3100
 *
 * Checks: Meta's verify handshake; an unsigned or wrongly signed post is refused; a signed message
 * carrying a real link code links that number to the member; the same message delivered twice is
 * handled once; "unlink" unlinks. Replies to Meta fail (the token is fake) — the point is what the
 * shop's records say. The probe's own rows are removed at the end.
 *
 *     node scripts/probe-whatsapp-webhook.mjs [http://localhost:3100]
 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
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
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PHONE = `999${Date.now().toString().slice(-9)}`; // never a real number
const msgId = () => `wamid.probe.${Math.random().toString(36).slice(2)}`;

const post = async (body, sign = true) => {
  const raw = JSON.stringify(body);
  return fetch(`${BASE}/api/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sign ? { 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` } : {}),
    },
    body: raw,
  });
};
const message = (id, text) => ({
  entry: [{ changes: [{ value: {
    contacts: [{ wa_id: PHONE, profile: { name: 'Probe' } }],
    messages: [{ id, from: PHONE, type: 'text', text: { body: text } }],
  } }] }],
});

try {
  // Meta's handshake.
  const ok = await fetch(`${BASE}/api/whatsapp?hub.mode=subscribe&hub.verify_token=probe-verify&hub.challenge=42`);
  check('the verify handshake answers the challenge', ok.status === 200 && (await ok.text()) === '42');
  const no = await fetch(`${BASE}/api/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`);
  check('a wrong verify token is refused', no.status === 403);

  // Unsigned and wrongly signed posts.
  check('an unsigned post is refused', (await post(message(msgId(), 'hi'), false)).status === 403);
  const bad = await fetch(`${BASE}/api/whatsapp`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
    body: JSON.stringify(message(msgId(), 'hi')),
  });
  check('a wrongly signed post is refused', bad.status === 403);

  // A real code, made as the owner (the app's own call).
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const owner = list.users.find((u) => u.email === env.SAMPLE_EMAIL);
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await anon.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
  const { data: mem } = await anon.rpc('my_membership');
  const storeId = mem[0].store_id;
  const { data: code, error: codeErr } = await anon.rpc('create_whatsapp_link_code', { p_store_id: storeId });
  check('the app makes a six-digit code', !codeErr && /^\d{6}$/.test(String(code)), codeErr?.message ?? code);

  const linkId = msgId();
  const r = await post(message(linkId, `Link ${code}`));
  check('a signed message is accepted at once', r.status === 200);
  await sleep(6000);
  const { data: links } = await admin.from('whatsapp_links').select('*').eq('wa_phone', PHONE).is('revoked_at', null);
  check('the code links this number to the owner, in the shop', links?.length === 1 && links[0].user_id === owner.id && links[0].store_id === storeId,
    JSON.stringify(links));
  const { data: usedCode } = await admin.from('whatsapp_link_codes').select('used_at').eq('code', String(code)).maybeSingle();
  check('and the code cannot be used again', Boolean(usedCode?.used_at));

  // Delivered twice: handled once.
  await post(message(linkId, `Link ${code}`));
  await sleep(3000);
  const { data: ins } = await admin.from('whatsapp_messages').select('id').eq('wa_message_id', linkId);
  check('the same message delivered twice is kept once', ins?.length === 1, `${ins?.length}`);

  // Unlink.
  await post(message(msgId(), 'unlink'));
  await sleep(5000);
  const { data: after } = await admin.from('whatsapp_links').select('revoked_at').eq('wa_phone', PHONE);
  check('"unlink" unlinks the number', (after ?? []).every((l) => l.revoked_at), JSON.stringify(after));
} catch (e) {
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  // The probe's own rows go.
  await admin.from('whatsapp_messages').delete().eq('wa_phone', PHONE);
  await admin.from('whatsapp_links').delete().eq('wa_phone', PHONE);
  console.log('  (probe rows removed)');
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

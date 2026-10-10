import { after, NextResponse } from 'next/server';
import { downloadMedia, markRead, sendText, signatureValid, whatsappConfigured } from '@/lib/whatsapp/meta';
import { clientFor, serviceDb } from '@/lib/whatsapp/session';
import { llmConfigured, runAssistant, type Content, type Message } from '@/lib/whatsapp/llm';
import { TOOLS, runTool } from '@/lib/whatsapp/tools';

/**
 * THE SHOP ON WHATSAPP — the webhook Meta calls for every message to the bot's number.
 *
 * GET   Meta's one-time check that this URL is ours (the verify token).
 * POST  a message. Its signature is checked against the app secret before anything is read; Meta is
 *       answered at once (it retries anything slow), and the reply is worked out after, in `after()`.
 *
 * A number not yet linked can only do one thing: send the six-digit code the app showed its owner,
 * which links it to that member in that shop. A linked number is that member — every lookup runs on
 * their own session, so their role and permissions decide what the bot can see and do, exactly as in
 * the app. "unlink" in the chat undoes it, as does Settings → WhatsApp in the app.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ok =
    url.searchParams.get('hub.mode') === 'subscribe' &&
    process.env.WHATSAPP_VERIFY_TOKEN &&
    url.searchParams.get('hub.verify_token') === process.env.WHATSAPP_VERIFY_TOKEN;
  return ok
    ? new NextResponse(url.searchParams.get('hub.challenge') ?? '', { status: 200 })
    : new NextResponse('Forbidden', { status: 403 });
}

interface WaMessage {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  image?: { id: string; caption?: string };
  audio?: { id: string };
  document?: { id: string; caption?: string; filename?: string };
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (!whatsappConfigured() || !signatureValid(raw, request.headers.get('x-hub-signature-256'))) {
    return new NextResponse('Forbidden', { status: 403 });
  }
  let payload: {
    entry?: { changes?: { value?: { messages?: WaMessage[]; contacts?: { wa_id: string; profile?: { name?: string } }[] } }[] }[];
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }

  const work: { msg: WaMessage; name: string | null }[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      for (const msg of v?.messages ?? []) {
        const name = v?.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name ?? null;
        work.push({ msg, name });
      }
    }
  }

  // Answered now; the reply is worked out after.
  after(async () => {
    for (const w of work) {
      try {
        await handle(w.msg, w.name);
      } catch (e) {
        console.error('whatsapp handle failed', e);
        try {
          await sendText(w.msg.from, 'Sorry — something went wrong on our side. Please try again in a moment.');
        } catch {
          // Nothing more to be done for this message.
        }
      }
    }
  });
  return NextResponse.json({ ok: true });
}

async function handle(msg: WaMessage, profileName: string | null) {
  const db = serviceDb();
  const text = (msg.text?.body ?? msg.image?.caption ?? msg.document?.caption ?? '').trim();

  // Once only: Meta retries a webhook it thinks was slow, and a retried message is the same message.
  const { error: dup } = await db.from('whatsapp_messages').insert({
    wa_message_id: msg.id, direction: 'in', wa_phone: msg.from, kind: msg.type, body: text || null,
  });
  if (dup) return;
  await markRead(msg.id);

  const reply = async (body: string, extra: Record<string, unknown> = {}) => {
    await sendText(msg.from, body);
    await db.from('whatsapp_messages').insert({ direction: 'out', wa_phone: msg.from, kind: 'text', body, ...extra });
  };

  const { data: link } = await db
    .from('whatsapp_links')
    .select('id, store_id, user_id')
    .eq('wa_phone', msg.from)
    .is('revoked_at', null)
    .maybeSingle();

  // ── Not linked: the code, or how to get one ────────────────────────────────────────────
  if (!link) {
    const code = text.match(/\b(\d{6})\b/)?.[1];
    if (code) {
      const { data: c } = await db
        .from('whatsapp_link_codes')
        .select('code, store_id, user_id, expires_at, used_at')
        .eq('code', code)
        .is('used_at', null)
        .maybeSingle();
      if (c && new Date(c.expires_at).getTime() > Date.now()) {
        await db.from('whatsapp_link_codes').update({ used_at: new Date().toISOString() }).eq('code', code);
        await db.from('whatsapp_links').insert({ store_id: c.store_id, user_id: c.user_id, wa_phone: msg.from, display: profileName });
        const { data: store } = await db.from('stores').select('name').eq('id', c.store_id).maybeSingle();
        await reply(
          `Linked ✅ This WhatsApp now speaks for you at ${store?.name ?? 'your shop'}, with the same permissions you have in the app.\n\n` +
            'Ask me things like:\n• How much Trophy is left?\n• Sales today\n• Who owes me?\n• Send Mrs Adeola’s statement for this month\n• Print her last receipt\n\n' +
            'Send "unlink" at any time to disconnect this number.',
        );
        return;
      }
      await reply('That code is not valid or has expired. Make a new one in the app: Settings → WhatsApp → Link my WhatsApp.');
      return;
    }
    await reply(
      'Hello 👋 This is the Store Manager assistant. This number is not linked to a shop yet.\n\n' +
        'Open Store Manager → Settings → WhatsApp → "Link my WhatsApp", then send the six-digit code here.',
    );
    return;
  }

  await db.from('whatsapp_messages').update({ store_id: link.store_id, user_id: link.user_id }).eq('wa_message_id', msg.id);

  if (/^\s*(unlink|stop|disconnect)\s*$/i.test(text)) {
    await db.from('whatsapp_links').update({ revoked_at: new Date().toISOString() }).eq('id', link.id);
    await db.from('whatsapp_sessions').delete().eq('user_id', link.user_id);
    await reply('Unlinked. This number no longer speaks for you. Link it again from the app any time.');
    return;
  }

  if (!llmConfigured()) {
    await reply('The assistant is not switched on yet. Please ask the shop owner.');
    return;
  }

  // ── Linked: the assistant, as this member ──────────────────────────────────────────────
  const userDb = await clientFor(link.user_id);
  const { data: membership } = await userDb.rpc('my_membership');
  const mine = ((membership ?? []) as { store_id: string; store_name: string; role_code: string }[]).find(
    (m) => m.store_id === link.store_id,
  );
  if (!mine) {
    await reply('You are no longer a member of this shop, so I cannot help on its behalf.');
    return;
  }

  const content: Exclude<Content, string> = [];
  if (text) content.push({ type: 'text', text });
  if (msg.type === 'image' && msg.image?.id) {
    const media = await downloadMedia(msg.image.id);
    if (media) content.push({ type: 'image_url', image_url: { url: `data:${media.mime};base64,${media.base64}` } });
  }
  if (msg.type === 'audio') {
    await reply('Voice notes are coming soon — please type your question for now.');
    return;
  }
  if (content.length === 0) {
    await reply('I can read text and photos for now. What would you like to know?');
    return;
  }

  // The last few turns, so "and yesterday?" means something.
  const { data: past } = await db
    .from('whatsapp_messages')
    .select('direction, body')
    .eq('wa_phone', msg.from)
    .not('body', 'is', null)
    .neq('wa_message_id', msg.id)
    .order('created_at', { ascending: false })
    .limit(8);
  const history: Message[] = ((past ?? []) as { direction: string; body: string }[])
    .reverse()
    .map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body }));

  const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  const system: Message = {
    role: 'system',
    content:
      `You are the Store Manager assistant for "${mine.store_name}", a shop in Nigeria, chatting on WhatsApp with ` +
      `${profileName ?? 'a member of the shop'} (role: ${mine.role_code}). Today is ${today}. Money is in naira (₦).\n` +
      '- Answer only from the tools; never invent figures, names or prices. If a tool returns an error, say plainly that you cannot see that.\n' +
      '- Be brief and clear, in plain English, formatted for WhatsApp (short lines, *bold* for key figures, no tables).\n' +
      '- Find a customer or item first, then use its id. If several match, ask which one.\n' +
      '- For a receipt to send or print, call receipt_link and give the link; it has a Print button for the shop printer app.\n' +
      '- You can only look things up for now. If asked to record a sale, payment, delivery or change anything, say that this is coming soon and to use the app meanwhile.',
  };

  const { answer, trace, providers } = await runAssistant(
    [system, ...history, { role: 'user', content }],
    TOOLS,
    (name, args) => runTool(userDb, link.store_id, name, args),
  );
  await reply(answer || 'I could not work that out — could you ask another way?', {
    store_id: link.store_id,
    user_id: link.user_id,
    tools: { calls: trace, providers },
  });
}

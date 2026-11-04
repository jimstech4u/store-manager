import { after, NextResponse } from 'next/server';
import { downloadMedia, markRead, sendChoices, sendText, signatureValid, whatsappConfigured } from '@/lib/whatsapp/meta';
import { clientFor, serviceDb } from '@/lib/whatsapp/session';
import { forWhatsApp, llmConfigured, runAssistant, transcribe, type Content, type Message } from '@/lib/whatsapp/llm';
import { TOOLS, paperOf, runTool } from '@/lib/whatsapp/tools';
import { execute, type Ctx } from '@/lib/whatsapp/actions';

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
  /** A contact card shared into the chat. */
  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string; wa_id?: string }[] }[];
  /** A tapped button or a choice from a list. */
  interactive?: {
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * NO ID REACHES THE CHAT. The prompt says so and a model still wrote "Wunmi stores (ID 6560971e-…)".
 * Links carry tokens, not these, so taking every one out loses nothing a person can use.
 */
function withoutIds(text: string): string {
  return text
    .replace(new RegExp(`\\s*\\((?:id|ID|Id)[:\\s]*${UUID.source}\\)`, 'gi'), '')
    .replace(new RegExp(`(?:\\b(?:id|ID)[:\\s]+)?${UUID.source}`, 'gi'), '')
    .replace(/[ \t]{2,}/g, ' ');
}

/** The model's next steps, on a last line of their own: "OPTIONS: Send as PDF | Who owes me?" */
function splitOptions(answer: string): { words: string; options: string[] } {
  // To the end of the message: one model puts each step on its own line, and those reached the chat.
  const m = answer.match(/\n?\s*\*{0,2}OPTIONS:\*{0,2}\s*([\s\S]*)$/i);
  if (!m) return { words: answer, options: [] };
  return {
    words: answer.slice(0, m.index).trim(),
    options: m[1].split(/[|\n]/).map((o) => o.replace(/^\s*[-•]\s*/, '').replace(/[*_]/g, '').trim()).filter(Boolean),
  };
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
        // Kept with the conversation, so a reply that never came can be found afterwards.
        await serviceDb().from('whatsapp_messages').insert({
          direction: 'out', wa_phone: w.msg.from, kind: 'error', body: null,
          tools: { error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) },
        }).then(() => undefined, () => undefined);
        try {
          // Somebody who has just reported a sale needs to know it is not on the books.
          const busy = e instanceof Error && e.message.startsWith('Every assistant is unavailable');
          await sendText(
            w.msg.from,
            busy
              ? 'I am very busy right now, so nothing was recorded. Please send that again in a minute.'
              : 'Sorry — something went wrong on our side. Please try again in a moment.',
          );
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
  const tapped = msg.interactive?.button_reply?.title ??
    (msg.interactive?.list_reply
      ? `${msg.interactive.list_reply.title}${msg.interactive.list_reply.description ?? ''}`
      : undefined);
  // A shared contact is words like any other: "change her number to this" then has something to point at.
  const shared = (msg.contacts ?? [])
    .map((c) => `${c.name?.formatted_name ?? 'A contact'}: ${(c.phones ?? []).map((p) => p.phone ?? p.wa_id).filter(Boolean).join(', ')}`)
    .join('; ');
  let text = (tapped ?? msg.text?.body ?? msg.image?.caption ?? msg.document?.caption ?? (shared ? `(Shared a contact) ${shared}` : '')).trim();

  // Once only: Meta retries a webhook it thinks was slow, and a retried message is the same message.
  const { error: dup } = await db.from('whatsapp_messages').insert({
    wa_message_id: msg.id, direction: 'in', wa_phone: msg.from, kind: msg.type, body: text || null,
  });
  if (dup) return;
  await markRead(msg.id);

  const reply = async (said: string, extra: Record<string, unknown> = {}, options: string[] = []) => {
    const body = withoutIds(said);
    await sendChoices(msg.from, body, options.map(withoutIds));
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
            'Ask me anything, record a sale or a payment, or send me a photo or a voice note.\n\n' +
            'Send "unlink" at any time to disconnect this number.',
          {},
          ['Sales today', 'Who owes me?', 'What is running low?'],
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

  /*
   * A VOICE NOTE IS A TYPED MESSAGE ONCE IT IS WORDS — so everything below, a YES included, works the
   * same for it. What was heard is logged in place of the empty body.
   */
  if (msg.type === 'audio' && msg.audio?.id) {
    const media = await downloadMedia(msg.audio.id);
    const heard = media ? await transcribe(media) : null;
    if (!heard) {
      await reply('I could not make out that voice note. Could you say it again, or type it?');
      return;
    }
    text = heard;
    await db.from('whatsapp_messages').update({ body: heard }).eq('wa_message_id', msg.id);
  }

  const ctx: Ctx = {
    db: userDb, service: db, storeId: link.store_id, userId: link.user_id, phone: msg.from, proposed: null,
  };

  /*
   * YES OR NO, READ HERE AND NOT BY THE MODEL. Claimed in one UPDATE, so a double tap or a retried
   * webhook runs it once. Anything else leaves it open: "actually make it 3 crates" goes to the
   * assistant, whose new proposal replaces this one.
   */
  const { data: open } = await db
    .from('whatsapp_pending')
    .select('id, action, args')
    .eq('wa_phone', msg.from)
    .is('done_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (open) {
    const word = text.toLowerCase().replace(/[.!\s]+$/, '').trim();
    const yes = /^(yes|y|yeah|yep|yes please|ok|okay|confirm|go ahead|do it)$/.test(word);
    const no = /^(no|n|nope|cancel|stop|don'?t)$/.test(word);
    if (yes || no) {
      const { data: claimed } = await db
        .from('whatsapp_pending')
        .update({ done_at: new Date().toISOString(), outcome: no ? 'cancelled' : 'done' })
        .eq('id', open.id)
        .is('done_at', null)
        .select('id');
      if (!claimed || claimed.length === 0) return;
      if (no) {
        await reply('Cancelled. Nothing was recorded.', { store_id: link.store_id, user_id: link.user_id });
        return;
      }
      try {
        const done = await execute(ctx, open.action, open.args as Record<string, unknown>);
        const options = done.receipt ? ['Send as PDF', 'Sales today'] : ['Sales today', 'Who owes me?'];
        // The receipt itself, on the shop's letterhead, as the site shows it.
        if (done.receipt) {
          await runTool(userDb, link.store_id, 'send_file', { kind: 'receipt', sale_id: done.receipt, format: 'picture' }, ctx, mine.store_name)
            .catch(() => undefined);
        }
        await reply(done.text, { store_id: link.store_id, user_id: link.user_id, tools: { executed: open.action, receipt: done.receipt } }, options);
      } catch (e) {
        const why = e instanceof Error ? e.message : 'something went wrong';
        await db.from('whatsapp_pending').update({ outcome: why.slice(0, 300) }).eq('id', open.id);
        await reply(`That was not recorded: ${why}`, { store_id: link.store_id, user_id: link.user_id });
      }
      return;
    }
  }

  const content: Exclude<Content, string> = [];
  if (text) content.push({ type: 'text', text });
  if (msg.type === 'image' && msg.image?.id) {
    const media = await downloadMedia(msg.image.id);
    if (media) content.push({ type: 'image_url', image_url: { url: `data:${media.mime};base64,${media.base64}` } });
  }
  // A PDF or a document goes to the model as it is: an invoice, a price list, a statement to check.
  if (msg.type === 'document' && msg.document?.id) {
    const media = await downloadMedia(msg.document.id);
    if (media) content.push({ type: 'image_url', image_url: { url: `data:${media.mime};base64,${media.base64}` } });
    else await reply('That file is too large for me to read.');
  }
  if (content.length === 0) {
    await reply('I can read text, photos, PDFs and voice notes. What would you like to do?', {}, ['Sales today', 'Who owes me?', 'What is running low?']);
    return;
  }

  // The last few turns, so "and yesterday?" means something.
  /*
   * ONLY THE CONVERSATION ITSELF: rows carrying the shop, which the link code and the welcome do not —
   * a six-digit code left in the history was taken for a receipt number. And the current message is
   * taken out here, not in the query: `.neq` on a column that is NULL for every reply removed the
   * bot's own answers, so the model saw a row of unanswered questions and answered them all again.
   */
  const { data: past } = await db
    .from('whatsapp_messages')
    .select('direction, body, wa_message_id')
    .eq('wa_phone', msg.from)
    .eq('store_id', link.store_id)
    .not('body', 'is', null)
    .order('created_at', { ascending: false })
    .limit(7);
  const told = ((past ?? []) as { direction: string; body: string; wa_message_id: string | null }[])
    // An empty turn (a contact card, a sticker) is refused by some models, and then nobody answers.
    .filter((m) => m.wa_message_id !== msg.id && m.body.trim() !== '')
    .reverse();
  /*
   * WHAT THEY CALLED OFF IS NOT STILL BEING ASKED. Left in, with only "cancelled" after it, the model
   * took the old request for the live one and answered "Busayo paid 10,000" with the sale they had
   * just said no to. The whole exchange goes: the request, the proposal, the NO and the reply to it.
   */
  const live = told.filter((_, i) => {
    const cancelledAt = told.findIndex(
      (m, j) => j >= i && j <= i + 3 && m.direction === 'out' && m.body.startsWith('Cancelled. Nothing was recorded.'),
    );
    return cancelledAt === -1;
  });
  const history: Message[] = live
    /*
     * A proposal in the history is a pattern a model copies: one wrote its own "Reply YES" with no
     * tool behind it, so a YES would have recorded nothing. Only the fact of it stays.
     */
    .map((m) => ({
      role: m.direction === 'in' ? 'user' : 'assistant',
      content: /Reply \*YES\*/.test(m.body) ? '(A proposal was shown to them.)' : m.body.slice(0, 600),
    }));

  const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  const paper = await paperOf(userDb, link.store_id).catch(() => null);
  const system: Message = {
    role: 'system',
    content:
      `You are the Store Manager AI agent for "${mine.store_name}", a shop in Nigeria, chatting on WhatsApp with ` +
      `${profileName ?? 'a member of the shop'} (role: ${mine.role_code}). Today is ${today}. Money is in naira (₦).\n` +
      (paper?.header ? `- The shop as its receipts print it (address, phone): ${paper.header.replace(/\s*\n\s*/g, ' | ')}\n` : '') +
      '- For anything your other tools do not cover, call find_capability with what they want, then use_capability. Never say something cannot be done until you have searched.\n' +
      '- Never choose a customer, item or supplier for them. When it is unclear which, ask, and offer the names as options.\n' +
      '- Answer ONLY the latest message. Earlier messages are context for it, not questions to answer again.\n' +
      '- Answer only from the tools; never invent figures, names or prices. If a tool returns an error, say plainly that you cannot see that.\n' +
      '- Be brief and clear, in plain English, formatted for WhatsApp (short lines, *bold* with single stars for key figures, no tables).\n' +
      '- Find a customer or item first, then use its id. If several match, ask which one.\n' +
      '- For a receipt to send or print, call receipt_link and give the link; it has a Print button for the shop printer app.\n' +
      '- You cannot record or change anything yourself. To do so you MUST call the matching propose_ tool: it shows them the summary and asks for YES itself. Never write a confirmation request in your own words, and never say something was recorded. If the tool returns an error, tell them what it says and ask for what is missing.\n' +
      '- To spare typing, end a reply with a last line starting OPTIONS: then up to five short next steps separated by |, each under 20 characters, written for THIS answer and what this person would most likely do next (a customer\'s name, "Remind them", "Their statement", "Send as PDF" only after a list or report). Never offer what you just did. When several customers or items match, the names go there so they can tap one.\n' +
      '- When searching for an item or customer, pass the name as they wrote it, misspelling and all, with only the name: the search works out what they meant. Never shorten it to one common word like "bottle".\n' +
      '- When they quote a receipt number, call find_receipt first.\n' +
      '- Never show ids, or the words tool or function. Use names, dates and receipt numbers like #1AC5EB6F.\n' +
      '- When they ask for a PDF, picture, file, print or share of a statement, receipt, sales, stock or who owes, use send_file. For a printer link for one receipt, use receipt_link.\n' +
      '- Be the shop\'s assistant: when an answer points at something to do, offer it as an option (a reminder, a PDF, the receipt). Give the headline figure first, then the few names that matter.\n' +
      '- A photo or PDF of an invoice is a delivery: read the supplier, items, quantities and costs from it, find each item, and propose it. Ask only for what you cannot read.',
  };

  const ask = (extra: Message[] = []) =>
    runAssistant(
      [system, ...history, { role: 'user', content }, ...extra],
      TOOLS,
      (name, args) => runTool(userDb, link.store_id, name, args, ctx, mine.store_name),
      () => ctx.proposed !== null,
    );
  const began = Date.now();
  let { answer, trace, providers, skipped } = await ask();
  /*
   * A CONFIRMATION WITH NOTHING BEHIND IT. A model that asks for YES in its own words has proposed
   * nothing, and the person's YES would do nothing while they believed it had. Told once to use the
   * tool; if it still will not, it does not get to say so.
   */
  const imitated = (t: string) => /reply\s+\*?yes\b/i.test(t) || /\brecorded\s*✅/i.test(t);
  if (!ctx.proposed && imitated(answer) && Date.now() - began < 20_000) {
    ({ answer, trace, providers, skipped } = await ask([
      { role: 'system', content: 'You did not call a propose_ tool, so nothing is set up. Call the right propose_ tool now.' },
    ]));
  }
  if (!ctx.proposed && imitated(answer)) answer = 'I could not set that up. Could you say it again with the details?';
  // The same for a file: "it has been sent" with nothing in the chat is a promise nobody can find.
  const delivered = () => trace.some((t) => t.tool === 'send_file' && (t.result as { sent?: boolean } | null)?.sent === true);
  const claimsFile = (t: string) => /\b(has been sent|have been sent|is sent|sent as|in the chat|attached)\b/i.test(t);
  if (!ctx.proposed && claimsFile(answer) && !delivered() && Date.now() - began < 20_000) {
    ({ answer, trace, providers, skipped } = await ask([
      { role: 'system', content: 'No file was sent. Call send_file now; if it returns an error, say what it says.' },
    ]));
  }
  if (!ctx.proposed && claimsFile(answer) && !delivered()) answer = 'I could not send that file just now. Please try again.';
  /*
   * A PROPOSAL IS SENT IN THE SERVER'S WORDS. What they say yes to is exactly what runs, whatever
   * the model made of it.
   */
  const said = splitOptions(answer);
  const words = ctx.proposed
    ? `${forWhatsApp(ctx.proposed)}\n\nReply *YES* to record it, or *NO* to cancel.`
    : said.words || 'I could not work that out — could you ask another way?';
  await reply(
    words,
    { store_id: link.store_id, user_id: link.user_id, tools: { calls: trace, providers, skipped } },
    ctx.proposed ? ['YES', 'NO'] : said.options,
  );
}

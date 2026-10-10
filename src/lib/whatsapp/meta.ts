import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * META'S WHATSAPP CLOUD API — the few calls the bot makes. Server only.
 *
 *   WHATSAPP_TOKEN            a permanent System User token (whatsapp_business_messaging)
 *   WHATSAPP_PHONE_NUMBER_ID  the bot number's id in Meta's dashboard
 *   WHATSAPP_APP_SECRET       the app's secret, which signs every webhook Meta sends
 *   WHATSAPP_VERIFY_TOKEN     any string we choose, typed into Meta's webhook form once
 */
const GRAPH = 'https://graph.facebook.com/v21.0';

export function whatsappConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_APP_SECRET);
}

/**
 * EVERY WEBHOOK IS CHECKED AGAINST THE APP SECRET. Without it anybody who learns the URL could post
 * "messages" as any number — and a number is who the bot acts as.
 */
export function signatureValid(rawBody: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const given = header.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

async function post(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  if (!res.ok) throw new Error(`WhatsApp send failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

/** WhatsApp's own limit is 4,096 characters; a long answer goes as several messages. */
export async function sendText(to: string, text: string): Promise<void> {
  const parts: string[] = [];
  let rest = text.trim() || '…';
  while (rest.length > 3900) {
    const cut = rest.lastIndexOf('\n', 3900) > 1000 ? rest.lastIndexOf('\n', 3900) : 3900;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  parts.push(rest);
  for (const p of parts) await post({ to, type: 'text', text: { body: p, preview_url: true } });
}

/** The read tick and "typing…", while the answer is worked out. */
export async function markRead(messageId: string): Promise<void> {
  try {
    await post({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } });
  } catch {
    // A missing tick is not worth failing a reply over.
  }
}

/** A photo or a voice note the sender attached, as base64 for the model. */
export async function downloadMedia(mediaId: string): Promise<{ mime: string; base64: string } | null> {
  const auth = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: auth });
  if (!meta.ok) return null;
  const info = (await meta.json()) as { url?: string; mime_type?: string };
  if (!info.url) return null;
  const file = await fetch(info.url, { headers: auth });
  if (!file.ok) return null;
  const buf = Buffer.from(await file.arrayBuffer());
  // Large files are not worth a model's time on a phone conversation.
  if (buf.length > 8 * 1024 * 1024) return null;
  return { mime: (info.mime_type ?? 'application/octet-stream').split(';')[0], base64: buf.toString('base64') };
}

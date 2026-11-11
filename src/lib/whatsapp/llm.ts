/**
 * THE ASSISTANT, ON WHICHEVER MODEL IS CHEAPEST THAT WORKS — AND THE NEXT ONE WHEN IT RUNS OUT.
 * Server only.
 *
 * Written against the OpenAI-compatible chat API that nearly every provider speaks, so a model is
 * configuration, not code. "Have it support and switch live on quota reached, and easy to auto switch
 * from a list": the providers are an ordered LIST, tried in turn. A provider that answers "quota
 * reached" or "too many requests" (429), or fails (5xx, timeout), is skipped for the rest of a
 * cooling-off spell and the same message goes straight to the next — the person on WhatsApp just gets
 * their answer.
 *
 *   LLM_PROVIDERS  JSON list, first is preferred (models as tested on 30 Oct 2026; they change, and
 *                  the list is how a retired one stops mattering):
 *     [{"name":"groq","base":"https://api.groq.com/openai/v1","model":"openai/gpt-oss-120b",
 *       "key":"…","vision":false},
 *      {"name":"gemini","base":"https://generativelanguage.googleapis.com/v1beta/openai",
 *       "model":"gemini-3.1-flash-lite","key":"…"},
 *      {"name":"openrouter","base":"https://openrouter.ai/api/v1",
 *       "model":"nvidia/nemotron-3-ultra-550b-a55b:free","key":"…","vision":false}]
 *   or, for one provider, LLM_BASE_URL + LLM_API_KEY + LLM_MODEL.
 *
 * `vision: false` on a provider keeps photos and voice notes away from a model that cannot read them
 * (it gets the words only, and is used only when nothing better is up).
 */
export type Content =
  | string
  | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: Content | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface Provider {
  name: string;
  base: string;
  model: string;
  key: string;
  /** Reads photos and voice notes. Assumed unless set false. */
  vision?: boolean;
}

function providers(): Provider[] {
  const raw = process.env.LLM_PROVIDERS;
  if (raw) {
    try {
      const list = JSON.parse(raw) as Provider[];
      const ok = list.filter((p) => p && p.base && p.model && p.key);
      if (ok.length > 0) return ok;
    } catch {
      // A malformed list falls back to the single provider below rather than taking the bot down.
    }
  }
  if (process.env.LLM_API_KEY) {
    return [{
      name: 'default',
      base: process.env.LLM_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: process.env.LLM_MODEL ?? 'gemini-3.1-flash-lite',
      key: process.env.LLM_API_KEY,
    }];
  }
  return [];
}

export function llmConfigured(): boolean {
  return providers().length > 0;
}

/*
 * RESTING A PROVIDER THAT RAN OUT. Per server instance: a warm instance remembers, a cold one simply
 * tries in order again and moves on at the first refusal — which costs a second, not an answer.
 */
const restingUntil = new Map<string, number>();
const REST_MS = { quota: 60_000, failed: 2 * 60_000 };
/** The longest any provider is rested for, whatever it says. */
const REST_CEILING_MS = 15 * 60_000;

function hasMedia(messages: Message[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type !== 'text'));
}

/** Photos and voice notes taken out, for a provider that only reads words. */
function wordsOnly(messages: Message[]): Message[] {
  return messages.map((m) =>
    Array.isArray(m.content)
      ? {
          ...m,
          content:
            m.content
              .map((c) => (c.type === 'text' ? c.text : '[a photo or document this model cannot read]'))
              .join('\n') || '',
        }
      : m,
  );
}

/*
 * A SWITCH HALFWAY THROUGH AN ANSWER. Tool calls are tied to the model that made them: Gemini refuses
 * another model's ("missing a thought_signature"), and others can object to fields they did not
 * write. So the next provider is handed what has been looked up as plain notes, which every model
 * reads, and carries on from there rather than starting again.
 */
function asNotes(messages: Message[]): Message[] {
  const names = new Map<string, string>();
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) names.set(tc.id, `${tc.function.name}(${tc.function.arguments})`);
  }
  return messages.flatMap((m): Message[] => {
    if (m.role === 'tool') {
      return [{ role: 'user', content: `[Already looked up: ${names.get(m.tool_call_id ?? '') ?? 'a tool'}]\n${String(m.content)}` }];
    }
    if (m.role === 'assistant' && m.tool_calls) {
      return m.content ? [{ role: 'assistant', content: m.content }] : [];
    }
    return [m];
  });
}

async function completeWith(
  p: Provider,
  messages: Message[],
  tools: ToolDef[],
  timeoutMs: number,
): Promise<Message> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${p.base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: p.model,
        messages: p.vision === false ? wordsOnly(messages) : messages,
        ...(tools.length > 0 ? { tools: tools.map((t) => ({ type: 'function', function: t })) } : {}),
        temperature: 0.2,
      }),
    });
    if (res.status === 429 || res.status === 402) {
      const wait = Number(res.headers.get('retry-after')) * 1000;
      throw Object.assign(new Error(`${p.name}: quota or rate limit (${res.status})`), {
        rest: 'quota' as const,
        restMs: wait > 0 ? wait : undefined,
      });
    }
    if (res.status >= 500) {
      throw Object.assign(new Error(`${p.name}: failed (${res.status})`), { rest: 'failed' as const });
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      // Some providers say "quota" with a 400 or 403.
      const rest = /quota|rate.?limit|exhausted|insufficient/i.test(body) ? 'quota' : 'failed';
      throw Object.assign(new Error(`${p.name}: ${res.status} ${body}`), { rest });
    }
    const data = (await res.json()) as { choices?: { message?: Message }[] };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw Object.assign(new Error(`${p.name}: no answer`), { rest: 'failed' as const });
    return msg;
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') {
      throw Object.assign(new Error(`${p.name}: timed out`), { rest: 'failed' as const });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** One answer from the first provider that will give it. */
async function complete(
  messages: Message[],
  tools: ToolDef[],
  skipped: string[],
  /** Who made the tool calls already in `messages`, if anybody. */
  caller: string | null,
  /** When the answer must be finished by, whichever provider gives it. */
  stopAt: number,
): Promise<{ msg: Message; provider: string }> {
  const list = providers();
  if (list.length === 0) throw new Error('No assistant is set up (LLM_PROVIDERS).');
  const media = hasMedia(messages);
  const now = Date.now();
  // Readers of photos first when there is a photo; resting providers last, as a final resort.
  const order = [...list].sort((a, b) => {
    const rest = Number((restingUntil.get(a.name) ?? 0) > now) - Number((restingUntil.get(b.name) ?? 0) > now);
    if (rest !== 0) return rest;
    if (media) return Number(a.vision === false) - Number(b.vision === false);
    return 0;
  });
  const errors: string[] = [];
  /*
   * A FILE ONLY GOES TO A MODEL THAT CAN READ IT. One that cannot is handed the words without the
   * file, and answers as though there had been none: "I can't read the document, what is the
   * customer's name?" Better the apology below than a confident answer about nothing.
   */
  const able = media && order.some((p) => p.vision !== false) ? order.filter((p) => p.vision !== false) : order;
  for (const p of able) {
    /*
     * ONLY THE TIME THAT IS LEFT. Each provider had 20 seconds whatever had already been spent, so
     * three slow ones near the end outran the function's 60: it was killed, and the person heard
     * nothing at all. Stopping here means the caller still has time to say sorry.
     */
    const left = stopAt - Date.now();
    if (left < 1500) {
      errors.push('out of time');
      break;
    }
    try {
      const handedOver = caller !== null && p.name !== caller;
      return {
        msg: await completeWith(p, handedOver ? asNotes(messages) : messages, tools, Math.min(PROVIDER_MS, left)),
        provider: p.name,
      };
    } catch (e) {
      const { rest = 'failed', restMs } = e as { rest?: 'quota' | 'failed'; restMs?: number };
      restingUntil.set(p.name, Date.now() + Math.min(restMs ?? REST_MS[rest], REST_CEILING_MS));
      const said = e instanceof Error ? e.message : String(e);
      errors.push(said);
      // Kept with the message's log, so "why was that slow" has an answer.
      skipped.push(said.slice(0, 160));
    }
  }
  throw new Error(`Every assistant is unavailable just now: ${errors.join(' | ')}`);
}

/** WhatsApp bolds with one star; models write Markdown's two, and links and headings it does not have. */
export function forWhatsApp(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1: $2')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
}

/**
 * A VOICE NOTE, AS WORDS — Groq's hosted Whisper, on the Groq key already in the list, so a voice note
 * then goes down exactly the path a typed message does. Null when there is no Groq in the list.
 */
export async function transcribe(media: { mime: string; base64: string }): Promise<string | null> {
  const groq = providers().find((p) => p.base.includes('groq.com'));
  if (!groq) return null;
  const form = new FormData();
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'en');
  const ext = media.mime.includes('wav') ? 'wav' : media.mime.includes('mp4') ? 'm4a' : media.mime.includes('mpeg') ? 'mp3' : 'ogg';
  form.append('file', new Blob([Buffer.from(media.base64, 'base64')], { type: media.mime }), `voice.${ext}`);
  const res = await fetch(`${groq.base.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${groq.key}` },
    body: form,
  });
  if (!res.ok) return null;
  const text = ((await res.json()) as { text?: string }).text?.trim();
  return text || null;
}

/**
 * TOOL CALLS WRITTEN AS WORDS. A model taking over mid-conversation sometimes writes its calls into
 * the reply — `{"tool": "find_items", "input": {"query": "Goldberg"}}` — instead of making them, and
 * that text reached the shop as the answer (Arewa's order, 9 Nov). Read back out here, by name, and
 * only for tools this run actually offers.
 */
export function writtenCalls(text: string, known: Set<string>): { name: string; args: Record<string, unknown> }[] {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j];
      if (inString) {
        if (c === '\\') j += 1;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const o = JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>;
            const name = String(o.tool ?? o.name ?? o.function ?? '');
            const args = (o.input ?? o.arguments ?? o.args ?? o.parameters ?? {}) as Record<string, unknown> | string;
            if (known.has(name)) {
              out.push({ name, args: typeof args === 'string' ? JSON.parse(args || '{}') : args });
              i = j;
            }
          } catch {
            // Not a call; braces in ordinary words.
          }
          break;
        }
      }
    }
  }
  return out;
}

const MAX_ROUNDS = 8;
/** From here the model is asked to answer with what it has. */
const DEADLINE_MS = 35_000;
/** The serverless function has 60 seconds; everything stops here, leaving time to say so. */
const HARD_STOP_MS = 52_000;
/** A provider that is slow today should cost a moment, not the whole message. */
const PROVIDER_MS = 18_000;

/**
 * Ask, let it call tools, give it the results, until it answers. A question about a shop is a few
 * lookups, and a model going round in circles should stop, not spend: on the last round, or with the
 * clock nearly out, it is asked again WITHOUT tools, so it must answer from what it already has.
 */
export async function runAssistant(
  messages: Message[],
  tools: ToolDef[],
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  /** True once a tool has settled the turn (an action proposed): no more rounds. */
  finished: () => boolean = () => false,
  /**
   * Shared with the caller as the run goes: what has been called and which providers answered, so a
   * run the clock gave up on can still say where its time went — and `stop`, which ends it. A run
   * left going after its reply was sent changed the order while the next message was being handled.
   */
  live: { trace: { tool: string; args: unknown; result: unknown }[]; providers: string[]; skipped: string[]; stop: boolean } = {
    trace: [], providers: [], skipped: [], stop: false,
  },
): Promise<{
  answer: string;
  trace: { tool: string; args: unknown; result: unknown }[];
  providers: string[];
  skipped: string[];
}> {
  const trace = live.trace;
  const used = live.providers;
  const skipped = live.skipped;
  const convo = [...messages];
  const started = Date.now();
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (live.stop) return { answer: '', trace, providers: used, skipped };
    const last = round === MAX_ROUNDS - 1 || Date.now() - started > DEADLINE_MS;
    const caller = [...convo].reverse().some((m) => m.tool_calls?.length) ? used[used.length - 1] ?? null : null;
    const { msg: reply, provider } = await complete(convo, last ? [] : tools, skipped, caller, started + HARD_STOP_MS);
    /*
     * Handed over: the notes replace the tool turns for good, so the rounds after this one read the
     * same conversation whichever provider takes them.
     */
    if (caller !== null && provider !== caller) convo.splice(0, convo.length, ...asNotes(convo));
    used.push(provider);
    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      const text = typeof reply.content === 'string' ? reply.content : '';
      const written = writtenCalls(text, new Set(tools.map((t) => t.name)));
      if (written.length > 0) {
        // On the last round there is no time to run them: nothing of it goes out as an answer.
        if (last) return { answer: '', trace, providers: used, skipped };
        reply.content = '';
        reply.tool_calls = written.map((w, k) => ({
          id: `written_${round}_${k}`,
          type: 'function' as const,
          function: { name: w.name, arguments: JSON.stringify(w.args) },
        }));
      }
    }
    convo.push({ role: 'assistant', content: reply.content ?? '', tool_calls: reply.tool_calls });
    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      const text = typeof reply.content === 'string' ? reply.content : '';
      return { answer: forWhatsApp(text), trace, providers: used, skipped };
    }
    for (const tc of reply.tool_calls) {
      // Given up on: nothing more is done for this message.
      if (live.stop) return { answer: '', trace, providers: used, skipped };
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      let result: unknown;
      try {
        result = await call(tc.function.name, args);
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      trace.push({ tool: tc.function.name, args, result });
      convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 12000) });
    }
    if (finished()) return { answer: '', trace, providers: used, skipped };
  }
  return { answer: 'That took too many steps — can you ask it a simpler way?', trace, providers: used, skipped };
}

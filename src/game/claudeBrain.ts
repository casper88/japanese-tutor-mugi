// 日語家教 Claude brain (client side). The phone never holds the API key: askClaude posts the chat to the dev server's
// /api/chat (server/claudeChat.ts) and reads the Server-Sent Events stream. Her reply is a JSON object (CHAT_REPLY_SCHEMA):
// the stream is read while it arrives (ReplyJsonParser), so the text shows as it is written, and each Japanese segment goes
// to the reply bus (game/replyBus.ts) once it is complete. The done text is the reply as the server fixed it.
import { apiFetch } from './apiFetch';
import type { ChatBrain } from './chatBrain';
import type { ChatLine, Tone } from './chatTypes';
import {
  CHAT_HISTORY_LINES, CHAT_HISTORY_MAX, CHAT_IDLE_KEEP, CHAT_IDLE_RESET_MS, CHAT_MAX_MESSAGE_CHARS,
  userTurn, type ChatContext, type ChatModeId, type ChatRoleId,
} from './claudeProtocol';
import {
  canonicalReplyJson, codePointLength, displayOf, fitReplyJson, isReplyJson, mergeReplyJson, parsePartialJson, readReplyValue, scanJson, toSegments,
  type ReplyFields,
} from './replyJson';
import { emitReply, nextReplyId } from './replyBus';
import { stripTipLabel } from './tipsBook';
import { activeCharacter, aiServicesOf, effectivePersona, loadTutor, serviceReady, TUTOR_DEFAULT_NAME, type AiServices } from './tutor';
import { chatGptReady } from './openaiStatus';
import { localReady } from './localStatus';

/** `personas`: the default personality text per role (from the server, shown in the 人設 settings) */
export type ClaudeStatus = { ok: boolean; model: string; personas?: Record<string, string> };
export type ClaudeSegment = { text: string; lang: 'zh' | 'ja' };
export type ClaudeContext = ChatContext;
export type ClaudeReply = {
  /** the visible reply (each segment, a Japanese one with its Chinese gloss in brackets; the tip is not in it) */
  text: string;
  /** what is voiced: the whole reply in chat mode; in teacher mode only the Japanese (the done event on the bus carries this) */
  spoken: string;
  /** her 小提醒 (teacher mode): Chinese explanation shown in its own bubble, never voiced; undefined when there is none */
  tip?: string;
  /** the Japanese targets written inside the tip (for practice); undefined when there are none */
  tipJa?: string[];
  /** the tip as the server wrote it, with its <ja> tags (for the background rewrite); set only with tipRewrite */
  tipRaw?: string;
  /** the tip has Japanese prose outside <ja>: the server asks for a background rewrite (reviseTip), once */
  tipRewrite?: boolean;
  tone?: Tone;
  segments: ClaudeSegment[];
  /** the reply as it is stored and sent back to Claude: its JSON with an empty tip (replyJson.canonicalReplyJson) */
  sent: string;
};
export type AskClaudeArgs = {
  history: ChatLine[];
  role: ChatRoleId;
  mode: ChatModeId;
  context: ClaudeContext;
  /** the visible reply so far (the segments read so far, with their glosses) */
  onDelta?: (visible: string) => void;
};

export type SSEEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; tipRewrite?: boolean }
  | { type: 'error'; message: string };

/** The last status read: the Claude brain's availability check uses it, so a turn costs no extra request. */
let lastStatus: ClaudeStatus | null = null;

export async function claudeStatus(): Promise<ClaudeStatus> {
  lastStatus = await fetchClaudeStatus();
  return lastStatus;
}

async function fetchClaudeStatus(): Promise<ClaudeStatus> {
  try {
    const r = await apiFetch('/api/chat/status');
    if (!r.ok) return { ok: false, model: '' };
    const j = (await r.json()) as { ok?: unknown; model?: unknown; personas?: unknown };
    const personas = j.personas && typeof j.personas === 'object'
      ? Object.fromEntries(Object.entries(j.personas as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
      : undefined;
    return { ok: j.ok === true, model: typeof j.model === 'string' ? j.model : '', ...(personas ? { personas } : {}) };
  } catch {
    return { ok: false, model: '' };
  }
}

// ---------------------------------------------------------------- SSE

/** Split a buffer of SSE text into complete events; `rest` is the unfinished tail to keep for the next chunk. */
export function takeSSEEvents(buffer: string): { events: SSEEvent[]; rest: string } {
  const events: SSEEvent[] = [];
  let rest = buffer;
  for (let i = rest.indexOf('\n\n'); i >= 0; i = rest.indexOf('\n\n')) {
    const block = rest.slice(0, i);
    rest = rest.slice(i + 2);
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    const ev = data ? parseSSEData(data) : null;
    if (ev) events.push(ev);
  }
  return { events, rest };
}

export function parseSSEData(data: string): SSEEvent | null {
  let j: unknown;
  try { j = JSON.parse(data); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (o.type === 'delta' && typeof o.text === 'string') return { type: 'delta', text: o.text };
  if (o.type === 'done') {
    return { type: 'done', text: typeof o.text === 'string' ? o.text : '', ...(o.tipRewrite === true ? { tipRewrite: true } : {}) };
  }
  if (o.type === 'error') return { type: 'error', message: typeof o.message === 'string' ? o.message : 'Claude 發生錯誤' };
  return null;
}

// ---------------------------------------------------------------- reply stream: her JSON, read while it arrives

/**
 * Streaming reader for her reply (the JSON of CHAT_REPLY_SCHEMA). push() takes the raw text deltas and reads what the JSON
 * says so far (replyJson.parsePartialJson): `visible` grows as the text arrives, and push()/finish() return the Japanese
 * segments that are complete, for the voice. A segment is complete once the next one has started, or once the segments
 * array has closed. finish() ends the stream: whatever has read is then complete, so a cut reply is voiced as far as it goes.
 */
export class ReplyJsonParser {
  /** the raw JSON text as it has arrived */
  raw = '';
  private read: ReplyFields = { segments: [], tip: '' };
  private arrayClosed = false;
  private voiced = 0;

  /** the reply as it reads so far (shown while it is written) */
  get visible(): string {
    return displayOf(this.read.segments);
  }

  /** the fields as they read so far */
  get fields(): ReplyFields {
    return this.read;
  }

  push(chunk: string): ClaudeSegment[] {
    this.raw += chunk;
    const value = parsePartialJson(this.raw);
    if (value !== undefined) {
      this.read = readReplyValue(value);
      this.arrayClosed = scanJson(this.raw).arrayClosed;
    }
    return this.take(false);
  }

  finish(): ClaudeSegment[] {
    return this.take(true);
  }

  private take(end: boolean): ClaudeSegment[] {
    const segs = this.read.segments;
    const complete = end || this.arrayClosed ? segs.length : Math.max(0, segs.length - 1);
    const out: ClaudeSegment[] = [];
    for (let i = this.voiced; i < complete; i++) {
      const s = segs[i];
      if (s.lang && s.text.trim()) out.push({ text: s.text, lang: s.lang });
    }
    this.voiced = Math.max(this.voiced, complete);
    return out;
  }
}

/** A tip with its <ja> tags: the plain text (tags removed, label stripped) and the Japanese targets inside the tags (trimmed, non-empty). */
export function splitTip(tip: string): { text: string; targets: string[] } {
  const t = tip.trim();
  const targets = [...t.matchAll(/<ja>([\s\S]*?)<\/ja>/g)].map((m) => m[1].trim()).filter(Boolean);
  return { text: stripTipLabel(t.replace(/<\/?ja>/g, '').trim()).trim(), targets };
}

/**
 * Her reply from its fields: what is shown, what is voiced (teacher mode: the Japanese only), the tip, and the stored form.
 * tipRewrite: the server asks for the tip to be rewritten (only when there is a tip).
 */
function viewOf(f: ReplyFields, mode: ChatModeId, tipRewrite: boolean): ClaudeReply {
  const segs = toSegments(f);
  const visible = displayOf(segs).trim();
  const { text: tip, targets } = splitTip(f.tip);
  const spoken = mode === 'teacher'
    ? segs.filter((s) => s.lang === 'ja').map((s) => s.text.trim()).filter(Boolean).join('\n')
    : visible;
  const rewrite = !!tip && tipRewrite;
  return {
    text: visible,
    spoken,
    tip: tip || undefined,
    tipJa: targets.length ? targets : undefined,
    tipRaw: rewrite ? f.tip.trim() : undefined,
    tipRewrite: rewrite ? true : undefined,
    tone: f.tone,
    // a Japanese segment with its gloss: the Japanese, then the gloss in brackets as a Chinese part (the old shape)
    segments: segs.flatMap((s): ClaudeSegment[] => (s.lang === 'ja' && s.gloss
      ? [{ lang: 'ja', text: s.text }, { lang: 'zh', text: `（${s.gloss}）` }]
      : [{ lang: s.lang, text: s.text }])),
    sent: canonicalReplyJson({ segments: segs, tip: '', tone: f.tone }),
  };
}

/** The chat line for something she is about to hear. The situation prefix is fixed here, once, and stored on the line (`sent`). */
export function userChatLine(text: string, ctx: ClaudeContext, mode: ChatModeId, t: number): ChatLine {
  return { from: 'me', text, t, sent: userTurn(text, ctx, mode) };
}

/** The stored and sent form of a 開話題 line: its Japanese as one segment with the Chinese as the gloss, and no tip. */
export function topicSent(ja: string, zh: string): string {
  return canonicalReplyJson({ segments: [{ lang: 'ja', text: ja, gloss: zh }], tip: '', tone: 'happy' });
}

/**
 * The persona key of her name and 人設 text: '' for the default (no persona and the default name), else a short stable hash
 * (FNV-1a, 8 hex digits) of the trimmed name and persona. The name joins the hash only when it is not the default, so a chat
 * under the default name keeps the key of a persona-only chat (old saves stay equal). Pure. Stored on the chat lines as `pk`,
 * so a later request can tell that her name or her personality changed.
 */
export function personaKey(persona: string | undefined, name?: string): string {
  const t = (persona ?? '').trim();
  const n = (name ?? '').trim();
  const named = n && n !== TUTOR_DEFAULT_NAME ? n : '';
  if (!t && !named) return '';
  const text = named ? `${named}\n${t}` : t;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Persona change: `lines` already ends with the new line (its `pk` is `key`). When the newest earlier line that has a `pk`
 * was sent under another persona, the request window restarts at the new line (it is flagged `win`), so the old replies are
 * not sent: they are in the old persona's voice and would pull the model back to it, and the cached prefix changes anyway.
 * The chat on screen is not altered (the old lines stay). Lines without `pk` (old saves) never trigger it. Only the last line
 * can change. Returns the same array when nothing changes. Pure function.
 */
export function markPersonaReset(lines: ChatLine[], key: string): ChatLine[] {
  let prev: ChatLine | undefined;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (lines[i].pk !== undefined) { prev = lines[i]; break; }
  }
  if (!prev || prev.pk === key) return lines;
  return lines.map((l, i) => (i === lines.length - 1 ? { ...l, win: true } : l));
}

/** Index where the request window starts: the last line flagged `win` (a window reset), else the first line. */
export function chatWindowStart(lines: ChatLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].win) return i;
  return 0;
}

/**
 * Keeps the request prefix stable: the window only moves when it would grow past CHAT_HISTORY_MAX lines, then it restarts
 * at the newest CHAT_HISTORY_LINES (that line is flagged `win`). Call it with the chat after each push; the window never
 * exceeds CHAT_HISTORY_MAX once the call returns, so a request never carries more than the server accepts.
 */
export function markWindowReset(lines: ChatLine[]): ChatLine[] {
  const start = chatWindowStart(lines);
  if (lines.length - start <= CHAT_HISTORY_MAX) return lines;
  const at = lines.length - CHAT_HISTORY_LINES;
  return lines.map((l, i) => (i === at ? { ...l, win: true } : l));
}

/** A 開話題 line (her pocket topic, `topic: true`). Old saves have no `topic` flag: her line with a `<ja>` sent text and no tip counts too. */
export function isTopicLine(l: ChatLine): boolean {
  if (l.tip) return false;
  if (l.topic === true) return true;
  return l.from === 'her' && typeof l.sent === 'string' && l.sent.startsWith('<ja>');
}

/**
 * Idle reset: after more than CHAT_IDLE_RESET_MS without a real exchange, the next request carries only the newest
 * CHAT_IDLE_KEEP lines (tips not counted; a 開話題 line counts as one of them). The reset is done by flagging the line
 * CHAT_IDLE_KEEP lines back with `win`, so the request window starts there. The idle time is measured from the last real
 * line (a message of yours or her reply), not from a 開話題 line: she may open a topic long after the last talk, and then
 * the player answers. Returns the same array when nothing changes; the chat on screen is never altered. Pure function.
 * Why: a chat idle for an hour is cheap to send in short form, and the next round starts fresh instead of carrying an old
 * context. The window only moves forward (a line already flagged further back stays as it is).
 */
export function markIdleReset(lines: ChatLine[], now: number): ChatLine[] {
  let last: ChatLine | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.tip && !isTopicLine(l)) { last = l; break; }
  }
  if (!last || now - last.t <= CHAT_IDLE_RESET_MS) return lines;
  let count = 0;
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].tip) continue;
    if (++count === CHAT_IDLE_KEEP) { at = i; break; }
  }
  if (at < 0 || at <= chatWindowStart(lines)) return lines;
  return lines.map((l, i) => (i === at ? { ...l, win: true } : l));
}

/** A fixed user turn put in front when the window opens with her line (e.g. a 開話題 she sent before any reply): the API needs a user first, and her opening still goes out. Same text every time, so the cache prefix does not change. The window is at most CHAT_HISTORY_MAX (= CHAT_MAX_MESSAGES − 1) lines, so adding this turn always stays within CHAT_MAX_MESSAGES. */
export const CHAT_LEAD_TURN = '［對話開始，由你先開口］';

/**
 * The text of one request line, within the server's length limit: CHAT_MAX_MESSAGE_CHARS code points (a surrogate pair is one, as the
 * server counts). A reply's JSON loses its oldest segments. A player's line keeps its situation/mode prefix and its own text:
 * the cut takes the text's oldest characters from the front, so its last words (the newest) are always sent. `userPart` is the
 * player's own text, which ends `content` (the prefix goes in front of it).
 */
function requestText(content: string, userPart?: string): string {
  if (codePointLength(content) <= CHAT_MAX_MESSAGE_CHARS) return content;
  if (isReplyJson(content)) return fitReplyJson(content, CHAT_MAX_MESSAGE_CHARS);
  if (userPart !== undefined && userPart !== '' && content.endsWith(userPart)) {
    const prefix = content.slice(0, content.length - userPart.length);
    const room = CHAT_MAX_MESSAGE_CHARS - codePointLength(prefix);
    if (room > 0) return prefix + [...userPart].slice(-room).join('');
  }
  return [...content].slice(0, CHAT_MAX_MESSAGE_CHARS).join('');
}

/**
 * Two of her lines in a row make one assistant message. Two replies in the JSON form merge into one JSON reply (their
 * segments in order, no tip); other lines (old saves) are joined with a newline, as before.
 */
function joinAssistant(a: string, b: string): string {
  return isReplyJson(a) && isReplyJson(b) ? mergeReplyJson(a, b) : `${a}\n${b}`;
}

/**
 * Chat lines → API messages: the request window (see markWindowReset), each line as it was sent, cut to the server's length
 * limit, starting with the user. When the window opens with her line, CHAT_LEAD_TURN is put in front of it (the window is at
 * most CHAT_HISTORY_MAX lines, so this always stays within CHAT_MAX_MESSAGES). Her 小提醒 (tip lines) are display-only and are NOT sent back: when they were, the model
 * imitated its own earlier Japanese tips and wrote every later one in Japanese. Dropping them is deterministic (the same
 * history always gives the same messages), so the cached prefix stays identical from turn to turn.
 */
export function toApiMessages(history: ChatLine[]): { role: 'user' | 'assistant'; content: string }[] {
  // userPart: the player's own text of a user message (kept whole by requestText); undefined for her messages
  const out: { role: 'user' | 'assistant'; content: string; userPart?: string }[] = [];
  for (const l of history.slice(chatWindowStart(history))) {
    if (!l.text.trim()) continue;
    if (l.tip) continue;
    const role = l.from === 'me' ? 'user' : 'assistant';
    const content = l.sent ?? l.text;
    const last = out[out.length - 1];
    // her consecutive lines (a reply, then a 開話題 topic) are one assistant message
    if (role === 'assistant' && last?.role === 'assistant') last.content = joinAssistant(last.content, content);
    else out.push({ role, content, ...(role === 'user' ? { userPart: l.text } : {}) });
  }
  // the API needs a user first: her opening line gets CHAT_LEAD_TURN in front (merging leaves at most one leading assistant)
  if (out.length && out[0].role === 'assistant') out.unshift({ role: 'user', content: CHAT_LEAD_TURN });
  return out.map((m) => ({ role: m.role, content: requestText(m.content, m.userPart) }));
}

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { message?: unknown };
    if (typeof j.message === 'string') return j.message;
  } catch { /* not JSON */ }
  return `Claude 服務錯誤（${res.status}）`;
}

// ---------------------------------------------------------------- the call

/**
 * Ask Claude for her next reply. Streams the visible text to the reply bus and to `onDelta`. Every request ends on the bus
 * with `done` (the whole visible reply) or `error` (HTTP failures, dropped streams, aborts, empty replies alike): the voice
 * loop waits for one of the two. Rejects with an Error whose message is for the player; the caller shows the message.
 */
export async function askClaude(args: AskClaudeArgs, signal?: AbortSignal): Promise<ClaudeReply> {
  const id = nextReplyId();
  emitReply({ type: 'start', id });
  try {
    const reply = await streamClaude(args, id, signal);
    emitReply({ type: 'done', id, text: reply.spoken });
    return reply;
  } catch (e) {
    const message = signal?.aborted ? '已取消' : e instanceof Error ? e.message : '未知錯誤';
    emitReply({ type: 'error', id, message });
    throw e instanceof Error ? e : new Error(message);
  }
}

/** The request and the stream; segments go to the bus as they complete, the end (done / error) is left to askClaude. */
async function streamClaude(args: AskClaudeArgs, id: number, signal?: AbortSignal): Promise<ClaudeReply> {
  // the chat's model and personality (設定 › AI 模型 / 人設): sent only when set, else the server's own
  const cfg = loadTutor();
  // the character on screen (人物): her name and her personality (the default of her id when she has none of her own)
  const me = activeCharacter(cfg);
  const persona = effectivePersona(me);
  let res: Response;
  try {
    res = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: toApiMessages(args.history), role: args.role, mode: args.mode, context: args.context,
        ...(cfg.chatModel ? { model: cfg.chatModel } : {}),
        ...(persona ? { persona } : {}),
        // her name (設定 › 人物): the model is told it, so she answers to it
        name: me.name,
        // the AI services in the player's order (Claude, ChatGPT or both) and the ChatGPT model
        ...aiServicesOf(cfg),
      }),
      signal,
    });
  } catch {
    throw new Error('連不上 Claude');
  }
  if (!res.ok || !res.body) throw new Error(await errorText(res));

  const parser = new ReplyJsonParser();
  const emitSegments = (segs: ClaudeSegment[]) => {
    for (const s of segs) {
      // teacher mode: only her Japanese is voiced; the Chinese in brackets is shown in the bubble, never spoken
      if (args.mode === 'teacher' && s.lang !== 'ja') continue;
      emitReply({ type: 'delta', id, text: s.text, lang: s.lang });
    }
  };
  let errMsg: string | undefined;
  let finalText: string | undefined;
  let finalTipRewrite = false;
  const onEvent = (ev: SSEEvent) => {
    if (ev.type === 'delta') {
      emitSegments(parser.push(ev.text));
      args.onDelta?.(parser.visible);
    } else if (ev.type === 'done') { finalText = ev.text; finalTipRewrite = ev.tipRewrite === true; }
    else if (ev.type === 'error') errMsg ??= ev.message;
  };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const { events, rest } = takeSSEEvents(buf);
      buf = rest;
      for (const ev of events) onEvent(ev);
      if (errMsg) break;
    }
  } catch {
    errMsg ??= signal?.aborted ? '已取消' : '連線中斷';
  }
  if (!errMsg) {
    buf += dec.decode();
    for (const ev of takeSSEEvents(buf + '\n\n').events) onEvent(ev);
  }
  if (errMsg) {
    reader.cancel().catch(() => {});
    throw new Error(errMsg);
  }

  emitSegments(parser.finish());
  // the done text is her reply as the server fixed it (readings filled, a Japanese tip repaired): it is what is shown and
  // stored. Without one (an older server) the streamed fields are used. The voice was already driven by the streamed segments.
  const doneValue = finalText?.trim() ? parsePartialJson(finalText) : undefined;
  const fields = doneValue !== undefined ? readReplyValue(doneValue) : parser.fields;
  const reply = viewOf(fields, args.mode, finalTipRewrite);
  if (!reply.text) throw new Error('Claude 沒有回覆內容');
  args.onDelta?.(reply.text);
  return reply;
}

export const TIP_REVISE_TIMEOUT_MS = 10_000;

/**
 * The background rewrite of one 小提醒 that came back with Japanese prose (POST /api/chat/fix-tip, once per tip). Gives the
 * new tip text (plain, label stripped) and its Japanese targets; null on any failure or timeout, and then the original tip
 * stays. Only ever a console.warn: the player is never shown an error for it.
 */
export async function reviseTip(
  tipRaw: string, timeoutMs = TIP_REVISE_TIMEOUT_MS, model?: string, services?: AiServices,
): Promise<{ text: string; targets: string[] } | null> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn('[tip] rewrite timed out, keeping the original tip');
      ctrl.abort();
      resolve(null);
    }, timeoutMs);
  });
  const call = (async (): Promise<{ text: string; targets: string[] } | null> => {
    const r = await apiFetch('/api/chat/fix-tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tip: tipRaw, ...(model ? { model } : {}), ...(services ?? {}) }),
      signal: ctrl.signal,
    });
    const j = (await r.json().catch(() => null)) as { ok?: unknown; tip?: unknown; message?: unknown } | null;
    if (!r.ok || !j || j.ok !== true || typeof j.tip !== 'string') {
      console.warn('[tip] rewrite not used, keeping the original tip', j?.message ?? r.status);
      return null;
    }
    const { text, targets } = splitTip(j.tip);
    return text ? { text, targets } : null;
  })().catch((e: unknown) => {
    console.warn('[tip] rewrite failed, keeping the original tip', e instanceof Error ? e.message : e);
    return null;
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The chat with one tip line's text replaced. The line is found by its time and its old text; other lines are untouched. */
export function replaceTipLine(chat: ChatLine[], t: number, oldText: string, newText: string): ChatLine[] {
  return chat.map((l) => (l.tip && l.t === t && l.text === oldText ? { ...l, text: newText } : l));
}

/** 「晚上 9 點」 for the situation prefix of the last user message. */
export function timeOfDayText(hour: number, minute = 0): string {
  const period = hour < 5 ? '凌晨' : hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';
  return `${period} ${hour} 點${minute >= 30 ? ' 半' : ''}`;
}

/**
 * The Claude brain: askClaude behind the ChatBrain interface. Available when the PC has a key (the status read at page load).
 * Its reply carries every Claude field, mapped one to one.
 */
export const claudeBrain: ChatBrain = {
  id: 'claude',
  label: 'Claude',
  capabilities: { streaming: true, teacher: true, needsServer: true },
  async available() {
    // usable when one of the chosen services can answer: Claude has its key, ChatGPT is signed in with the plan, or the local
    // model server answers
    const cfg = loadTutor();
    const anthropic = cfg.providers.includes('anthropic') && (lastStatus ?? (await claudeStatus())).ok;
    const openai = cfg.providers.includes('openai') && (await chatGptReady());
    const local = cfg.providers.includes('local') && (await localReady());
    return serviceReady(cfg.providers, { anthropic, openai, local });
  },
  async reply(req) {
    const c = await askClaude({
      history: req.history, role: req.role, mode: req.mode, context: req.situation, onDelta: req.onDelta,
    }, req.signal);
    return {
      text: c.text, tone: c.tone,
      spoken: c.spoken, segments: c.segments, tip: c.tip, tipJa: c.tipJa, tipRaw: c.tipRaw, tipRewrite: c.tipRewrite, sent: c.sent,
    };
  },
};

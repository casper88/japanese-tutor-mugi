// Claude chat endpoint, served by the Vite dev server (vite.config.ts → claudeChatPlugin). The API key is read from
// .env.local on the PC and never leaves it: the phone only talks to /api/chat on the same origin.
//   GET  /api/chat/status → { ok, model, personas } ok = a key is configured; personas: the default 人設 text per role
//   POST /api/chat        → text/event-stream      data: {"type":"delta"|"done"|"error", …}
//                           (delta.text: the reply's JSON text as it streams; done.text: the whole reply JSON, see CHAT_REPLY_SCHEMA)
//   POST /api/chat/judge  → { ok, feedback }        judges a 小提醒 practice line (non-streaming)
//   POST /api/chat/fix-tip → { ok, tip }            rewrites one 小提醒 that came back with Japanese (Haiku, background)
// Every upstream call goes through an LlmProvider (server/llm/provider.ts). Each AI request names its services in the order to
// try them (`providers`, server/aiChain.ts): Claude (the API key), ChatGPT (the signed-in account, server/openai) and 本地模型
// (an OpenAI-compatible server such as Ollama, server/llm/localService.ts). A service that cannot take the request (a failure
// that fallbackWorthy accepts) hands it to the next one.
//   GET  /api/openai/status, POST /api/openai/login and /logout, GET /auth/callback: the ChatGPT sign-in (routes.ts)
//   GET  /api/local/status: whether the local model server answers, and its models (localService.ts)
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadEnv, type Plugin } from 'vite';
import {
  CHAT_MAX_MESSAGES, CHAT_MAX_MESSAGE_CHARS, CHAT_MODES, CHAT_ROLES, CHAT_TONES, CLAUDE_MODEL_DEFAULT, NAME_MAX_CHARS, PERSONA_MAX_CHARS,
  isChatModelId, nameText, personaText, type ChatContext, type ChatModeId, type ChatRoleId,
} from '../src/game/claudeProtocol.ts';
import { LOOKUP_MAX_CHARS, parseLookupText, type LookupAnswer } from '../src/game/lookup.ts';
import { fallbackWorthy, firstServing, parseRouting, routingOf, type Routing, type Service } from './aiChain.ts';
import { createOAuth } from './openai/oauth.ts';
import { createChatGpt, type ChatGptService } from './openai/service.ts';
import { dataDirectory, defaultProtector, openCredentialStore } from './openai/credentials.ts';
import { handleAuthCallback, handleOpenAiApi } from './openai/routes.ts';
import { JUDGE_PROMPT, LOOKUP_SYSTEM, LOOKUP_SYSTEM_PLAIN, TIP_FIX_SYSTEM, TIP_FIX_SYSTEM_PLAIN, defaultPersona, reminderPrompt, systemPrompt } from './prompts.ts';
import { fixReplyJson, isChineseTip, saidOf, tipFromCorrection, wrapJapanese } from './replyFix.ts';
import { fillReadings, loadAnalyzer, stripReadings } from './readings.ts';
import { dailyLimitHit, getUsageStore, type ClaudeUsage, type UsageStore } from './usage.ts';
import { guardApi, guardOptionsFrom } from './apiGuard.ts';
import { handleSettingsApi } from './settingsRoutes.ts';
import { PROJECT_ROOT } from './voicevoxProcess.ts';
import { anthropicProvider, describeAnthropicError } from './llm/anthropicProvider.ts';
import type { LlmChatRequest, LlmProvider, LlmResult, LlmStream } from './llm/provider.ts';
import { handleLocalApi, localModelFor, localService, readLocalConfig, type LocalConfig } from './llm/localService.ts';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';

/** no service can take the request: Claude has no key, ChatGPT is not signed in and no local model answers (or the list has none) */
const NO_SERVICE = { error: 'no_service', message: '尚無可用的 AI 服務：請在電腦上設定 Claude 金鑰、登入 ChatGPT，或啟動本地模型（例如 Ollama）。' };
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CONTEXT_CHARS = 100;
/** the beta server-side fallback is opted into explicitly (see the request below) */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

type ChatMessage = { role: 'user' | 'assistant'; content: string };
/** `model`, `persona` and `name` are optional: absent, the server's own model, the default personality and the default name are used */
export type ChatBody = {
  messages: ChatMessage[]; role: ChatRoleId; mode: ChatModeId; context: ChatContext; model?: string; persona?: string; name?: string;
  /** the services to try, in order (see server/aiChain.ts) */
  routing: Routing;
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The settings of one request: the key and model of Anthropic. */
export type Settings = { key: string; model: string; workspace: string };

/** Key and model from .env.local (or the process environment). Read per request, so a new key needs no restart. */
export function readSettings(root: string, mode: string): Settings {
  const env = loadEnv(mode, root, '');
  const key = (env.ANTHROPIC_API_KEY ?? '').trim();
  // keys that aren't scoped to a workspace must name one on every request (anthropic-workspace-id header)
  const workspace = (env.ANTHROPIC_WORKSPACE_ID ?? '').trim();
  const model = (env.ANTHROPIC_MODEL ?? '').trim() || CLAUDE_MODEL_DEFAULT;
  return { key, model, workspace };
}

// ---------------------------------------------------------------- spending and rate limits

/** the daily Claude spending cap in USD (MUGI_DAILY_USD); 0 means no cap */
export const DEFAULT_DAILY_USD = 2;
/** chat starts allowed per minute, all chat routes together (MUGI_CHAT_PER_MINUTE); 0 means no limit */
export const DEFAULT_CHAT_PER_MINUTE = 20;
/** chat requests running at the same time, all chat routes together */
export const CHAT_MAX_ACTIVE = 2;
export const DAILY_LIMIT_MESSAGE = '今天的 Claude 花費已達上限（MUGI_DAILY_USD）';

export type Limits = { dailyUsd: number; chatPerMinute: number };

/** MUGI_DAILY_USD: a number >= 0. Empty or not a number → the default; 0 → no cap. */
export function parseDailyUsd(v: string | undefined): number {
  const t = (v ?? '').trim();
  if (!t) return DEFAULT_DAILY_USD;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_USD;
}

/** MUGI_CHAT_PER_MINUTE: a whole number >= 0. Empty or invalid → the default; 0 → no limit. */
export function parseChatPerMinute(v: string | undefined): number {
  const t = (v ?? '').trim();
  if (!t) return DEFAULT_CHAT_PER_MINUTE;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_CHAT_PER_MINUTE;
}

/** The limits, read per request like the key (from .env.local or the process environment): no restart needed. */
export function readLimits(root: string, mode: string): Limits {
  const env = loadEnv(mode, root, '');
  return { dailyUsd: parseDailyUsd(env.MUGI_DAILY_USD), chatPerMinute: parseChatPerMinute(env.MUGI_CHAT_PER_MINUTE) };
}

/**
 * What a Claude request is assumed to cost before it runs, in USD: the reservation that counts against the daily cap while the
 * request is in progress (the real cost is recorded when the provider answers). A chat request reserves CHAT_RESERVE_USD; a
 * helper (小提醒, 速查) reserves HELPER_RESERVE_USD.
 */
export const CHAT_RESERVE_USD = 0.02;
export const HELPER_RESERVE_USD = 0.005;
const holds = new Map<symbol, number>();
/** the USD reserved by requests in progress */
export function heldClaudeUsd(): number {
  let sum = 0;
  for (const usd of holds.values()) sum += usd;
  return sum;
}
/** reserves `usd` until the returned function is called (once or more: a second call does nothing) */
function hold(usd: number): () => void {
  const key = Symbol('claude-hold');
  holds.set(key, usd);
  return () => { holds.delete(key); };
}

/** true when today's estimated Claude spending, with the reservations of requests in progress, has reached the cap (MUGI_DAILY_USD) */
export function dailyCapReached(root: string, mode: string): boolean {
  return dailyLimitHit(getUsageStore(root).dailyCostUsd() + heldClaudeUsd(), readLimits(root, mode).dailyUsd);
}

export type ChatSlots = { times: number[]; active: number };
/** the shared state of the chat routes (chat, judge, fix-tip) */
export const chatSlots: ChatSlots = { times: [], active: 0 };
export type SlotResult = 'ok' | 'rate' | 'busy';

/**
 * Takes a chat slot: at most `perMinute` starts in a sliding one-minute window (0 = no limit) and at most CHAT_MAX_ACTIVE
 * running at once. 'ok' takes the slot, which releaseChatSlot gives back when the request is done. Pure given its arguments.
 */
export function takeChatSlot(perMinute: number, now = Date.now(), slots: ChatSlots = chatSlots): SlotResult {
  while (slots.times.length && now - slots.times[0] >= 60_000) slots.times.shift();
  if (perMinute > 0 && slots.times.length >= perMinute) return 'rate';
  if (slots.active >= CHAT_MAX_ACTIVE) return 'busy';
  slots.times.push(now);
  slots.active++;
  return 'ok';
}

/** gives back a slot taken by takeChatSlot */
export function releaseChatSlot(slots: ChatSlots = chatSlots): void {
  if (slots.active > 0) slots.active--;
}

/** the 429 answer for a slot that was not taken */
function slotRefusal(res: ServerResponse, r: SlotResult) {
  return json(res, 429, {
    error: 'rate_limit',
    message: r === 'rate' ? '聊天太頻繁，稍後再試' : '同時進行的請求太多，稍後再試',
  });
}

let cachedClient: { key: string; workspace: string; client: Anthropic } | null = null;
function clientFor(key: string, workspace: string): Anthropic {
  if (!cachedClient || cachedClient.key !== key || cachedClient.workspace !== workspace) {
    const defaultHeaders = workspace ? { 'anthropic-workspace-id': workspace } : undefined;
    // one retry for a dropped connection or a 5xx/429 from Anthropic; a longer chain would hold a chat slot for minutes
    cachedClient = { key, workspace, client: new Anthropic({ apiKey: key, defaultHeaders, maxRetries: 1 }) };
  }
  return cachedClient.client;
}

// ---------------------------------------------------------------- the services of a request

let chatgptCache: ChatGptService | null | undefined;
/**
 * The ChatGPT service of this server (the sign-in in the data folder, see server/openai/credentials.ts), or null when its
 * credentials cannot be read (the reason is logged once; the sign-in cannot be used until the file is fixed).
 */
export function chatGptService(): ChatGptService | null {
  if (chatgptCache === undefined) {
    try {
      const store = openCredentialStore({ directory: dataDirectory(), protector: defaultProtector() });
      chatgptCache = createChatGpt({ store, oauth: createOAuth() });
    } catch (e) {
      console.warn('[chatgpt]', e instanceof Error ? e.message : e);
      chatgptCache = null;
    }
  }
  return chatgptCache;
}

/**
 * The services of a request, in the order of its routing. A Claude service needs the key and the daily cap not reached (the cap
 * is reported as dailyCapped); a ChatGPT service needs the signed-in plan and a model (the one named in openaiModel when it is
 * listed, else the first listed); a local service needs a valid address and a model (LOCAL_LLM_MODEL, else the first chat
 * model the server lists). claudeModel: the Claude model of this request (default: the server's own). `local` and
 * `localFetch` replace the local settings and the network (the tests).
 */
export async function servicesFor(
  routing: Routing,
  opts: {
    root: string; mode: string; claudeModel?: string; chatgpt?: ChatGptService | null; reserveUsd?: number;
    local?: LocalConfig; localFetch?: typeof fetch;
  },
): Promise<{ services: Service[]; dailyCapped: boolean }> {
  const s = readSettings(opts.root, opts.mode);
  const services: Service[] = [];
  let dailyCapped = false;
  for (const id of routing.providers) {
    if (id === 'anthropic') {
      if (!s.key) continue;
      // the check and the reservation are one synchronous step, so two requests at the same moment cannot both pass the cap
      if (dailyCapReached(opts.root, opts.mode)) {
        dailyCapped = true;
        continue;
      }
      const release = hold(opts.reserveUsd ?? CHAT_RESERVE_USD);
      services.push({ id, model: opts.claudeModel ?? s.model, provider: anthropicProvider(clientFor(s.key, s.workspace)), spend: true, hold: release });
      continue;
    }
    if (id === 'local') {
      const cfg = opts.local ?? readLocalConfig(opts.root, opts.mode);
      if (!cfg.url) continue;
      const local = { ...cfg, url: cfg.url };
      const model = await localModelFor(local, opts.localFetch);
      if (!model) continue;
      // a local model costs nothing: no spend and no hold against the daily Claude cap
      services.push({ id, model, provider: localService(local, opts.localFetch), spend: false });
      continue;
    }
    const chatgpt = opts.chatgpt === undefined ? chatGptService() : opts.chatgpt;
    if (!chatgpt || !chatgpt.ready()) continue;
    let list: { slug: string }[];
    try {
      list = await chatgpt.models();
    } catch (e) {
      console.warn('[chatgpt] model list:', e instanceof Error ? e.message : e);
      continue;
    }
    if (!list.length) continue;
    const model = routing.openaiModel && list.some((m) => m.slug === routing.openaiModel) ? routing.openaiModel : list[0].slug;
    services.push({ id, model, provider: chatgpt.provider(), spend: false });
  }
  return { services, dailyCapped };
}

/** the services of a request, or the answer when none is ready: 429 when Claude's daily cap is the reason, else 503 */
async function servicesOrAnswer(
  res: ServerResponse, routing: Routing, opts: { root: string; mode: string; claudeModel?: string; reserveUsd?: number },
): Promise<Service[] | null> {
  const plan = await servicesFor(routing, opts);
  if (plan.services.length) {
    // the reservations last until the response is done (or the player is gone), whichever way the request ends
    res.once('close', () => { for (const s of plan.services) s.hold?.(); });
    return plan.services;
  }
  if (plan.dailyCapped) json(res, 429, { error: 'daily_limit', message: DAILY_LIMIT_MESSAGE });
  else json(res, 503, NO_SERVICE);
  return null;
}

/** a request body read and parsed by `parse`; a bad body is answered (400 or its status) and null is returned */
async function readRequest<T>(req: IncomingMessage, res: ServerResponse, parse: (raw: string) => T): Promise<T | null> {
  try {
    return parse(await readBody(req));
  } catch (e) {
    badRequest(res, e);
    return null;
  }
}

/** the answer when no service could serve the request: the message of the last service tried (its provider's mapping) */
function upstreamFailure(res: ServerResponse, r: { error: unknown; failed: Service }): void {
  const { status, message } = r.failed.provider.describeError(r.error);
  json(res, status, { error: 'upstream', message });
}

/** a body that does not pass its parser: its status (400 for a bad field) and message */
function badRequest(res: ServerResponse, e: unknown): void {
  const status = e instanceof HttpError ? e.status : 400;
  json(res, status, { error: 'bad_request', message: e instanceof Error ? e.message : '請求錯誤' });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, '請求太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const bad = (message: string) => new HttpError(400, message);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);

/**
 * The optional `model` of a body: one of the CHAT_MODEL_CHOICES ids, or undefined when absent (null counts as absent).
 * Anything else is a 400, so a model outside the list never reaches the upstream.
 */
export function parseModel(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isChatModelId(v)) throw bad('不支援的模型');
  return v;
}

/** The `model` of a raw JSON body that another parser has already checked (see parseModel). */
export function bodyModel(raw: string): string | undefined {
  return parseModel((JSON.parse(raw) as Record<string, unknown>).model);
}

/**
 * The optional `persona` of a chat body: the player's personality text, control characters removed, trimmed, 1 to
 * PERSONA_MAX_CHARS characters (longer is a 400). `<` and `>` become the full-width ＜ ＞, so the text cannot close or
 * open a tag in the system prompt. Absent (or null) → undefined: the default personality.
 */
export function parsePersona(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw bad('persona 需為字串');
  const t = personaText(v);
  if (!t) throw bad(`人設需為 1 到 ${PERSONA_MAX_CHARS} 字`);
  if ([...t].length > PERSONA_MAX_CHARS) throw bad(`人設最多 ${PERSONA_MAX_CHARS} 字`);
  return t.replace(/</g, '＜').replace(/>/g, '＞');
}

/**
 * The optional `name` of a chat body: the tutor's name the player gave her (game/tutor.ts), cleaned by nameText. 1 to
 * NAME_MAX_CHARS characters, else a 400. Absent (or null) → undefined: the default name.
 */
export function parseName(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const t = typeof v === 'string' ? nameText(v) : '';
  const n = [...t].length;
  if (!t || n > NAME_MAX_CHARS) throw bad(`名字需為 1～${NAME_MAX_CHARS} 個字`);
  return t;
}

/** Validate the POST body; throws HttpError(400) on anything malformed. */
export function parseChatBody(raw: string): ChatBody {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { throw bad('請求不是合法的 JSON'); }
  if (!j || typeof j !== 'object') throw bad('請求內容錯誤');
  const b = j as Record<string, unknown>;
  if (!Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > CHAT_MAX_MESSAGES) {
    throw bad(`messages 需為 1 到 ${CHAT_MAX_MESSAGES} 則`);
  }
  const messages: ChatMessage[] = b.messages.map((m: unknown) => {
    const mm = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
    if (mm.role !== 'user' && mm.role !== 'assistant') throw bad('message.role 只能是 user 或 assistant');
    if (typeof mm.content !== 'string' || !mm.content.trim()) throw bad('message.content 不可為空');
    if ([...mm.content].length > CHAT_MAX_MESSAGE_CHARS) throw bad(`每則訊息最多 ${CHAT_MAX_MESSAGE_CHARS} 字`);
    return { role: mm.role, content: mm.content };
  });
  // the conversation starts with the user: drop any leading assistant lines
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw bad('最後一則訊息必須是使用者的');
  if (!CHAT_ROLES.includes(b.role as ChatRoleId)) throw bad('role 錯誤');
  if (!CHAT_MODES.includes(b.mode as ChatModeId)) throw bad('mode 錯誤');
  const c = (b.context && typeof b.context === 'object' ? b.context : {}) as Record<string, unknown>;
  const context: ChatContext = { timeOfDay: str(c.timeOfDay, MAX_CONTEXT_CHARS) };
  const model = parseModel(b.model);
  const persona = parsePersona(b.persona);
  const name = parseName(b.name);
  const routing = parseRouting(b);
  return {
    messages, role: b.role as ChatRoleId, mode: b.mode as ChatModeId, context,
    ...(model ? { model } : {}), ...(persona ? { persona } : {}), ...(name ? { name } : {}), routing,
  };
}

/**
 * The upstream messages for a validated body. The history goes through exactly as the client sent it (each turn's text is
 * frozen when sent, see claudeProtocol.userTurn), and only the NEWEST user message gets the volatile reminder appended
 * (reminderPrompt, in a <reminder> tag). The reminder is never stored, so every earlier message is byte-identical from
 * one request to the next. `smallModel` (the local models): the readings are left out of her earlier lines, the reminder is
 * the short one (no example, no readings) and it goes before the player's words, so they are the last thing the model reads.
 *
 * Cache breakpoints: the system block (stable per role and mode) and the last message before the newest user turn, which
 * is the end of the stable history. The newest user turn carries no breakpoint: its bytes (the reminder) are volatile and
 * are re-sent without it next turn, so caching them would never hit again.
 */
export function upstreamMessages(messages: ChatMessage[], opts: { smallModel?: boolean } = {}): BetaMessageStreamParams['messages'] {
  const n = messages.length;
  return messages.map((m, i) => {
    // a model whose readings the server writes is never shown any: her earlier lines go without them
    const content = opts.smallModel && m.role === 'assistant' ? stripReadings(m.content) : m.content;
    const reminder = `<reminder>${reminderPrompt(opts)}</reminder>`;
    const text = i !== n - 1 ? content : opts.smallModel ? `${reminder}\n\n${content}` : `${content}\n\n${reminder}`;
    if (i === n - 2) {
      return { role: m.role, content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] };
    }
    return { role: m.role, content: text };
  });
}

/**
 * Her chat reply (Structured Outputs): the API guarantees this shape. The reply is streamed as its JSON text and read on the
 * client while it arrives (game/claudeBrain.ts ReplyJsonParser). segments: her Japanese in order, each with its Chinese
 * gloss (lang is 'ja' in the teacher mode); tip: a Chinese 小提醒, '' for none; tone: how she says it. The schema is a
 * constant, so the request prefix (system block) stays byte-identical for the prompt cache.
 */
export const CHAT_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['segments', 'tip', 'tone'],
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['lang', 'text', 'gloss'],
        properties: {
          lang: { type: 'string', enum: ['ja', 'zh'] },
          text: { type: 'string' },
          gloss: { type: 'string' },
        },
      },
    },
    tip: { type: 'string' },
    tone: { type: 'string', enum: [...CHAT_TONES] },
  },
} as const;

/**
 * Her reply from a small local model (smallModel): `corrected` first, the player's line written as correct Japanese (his Chinese
 * translated), then her segments and tone, and no tip: the server writes the tip from `corrected` (replyFix.ts
 * tipFromCorrection), since a small model's own explanations were often wrong. `corrected` is dropped from what is shown and
 * stored (the canonical reply has segments, tip and tone only).
 */
export const CHAT_REPLY_SCHEMA_SMALL = {
  type: 'object',
  additionalProperties: false,
  required: ['corrected', 'segments', 'tone'],
  properties: {
    corrected: { type: 'string' },
    segments: CHAT_REPLY_SCHEMA.properties.segments,
    tone: CHAT_REPLY_SCHEMA.properties.tone,
  },
} as const;

/**
 * The upstream request for a validated body: model, the stable system block with its breakpoint, and the messages from
 * upstreamMessages. No top-level cache_control: the automatic marker would sit on the volatile newest turn.
 * `smallModel`: the provider's (see upstreamMessages); a small model also gets CHAT_REPLY_SCHEMA_SMALL and the system prompt
 * that describes its `corrected` field.
 */
export function chatRequest(body: ChatBody, model: string, opts: { smallModel?: boolean } = {}): LlmChatRequest {
  return {
    model,
    max_tokens: 2000,
    // the schema's name for ChatGPT's strict json_schema (the Anthropic provider does not send it)
    schemaName: 'mugi_reply',
    // the reply is a JSON object of CHAT_REPLY_SCHEMA (Structured Outputs); effort low: fast, chatty replies
    output_config: { effort: 'low', format: { type: 'json_schema', schema: opts.smallModel ? CHAT_REPLY_SCHEMA_SMALL : CHAT_REPLY_SCHEMA } },
    betas: [FALLBACK_BETA],
    // retried on another model if a safety classifier declines. If the API ever rejects a request that has both this
    // fallbacks chain and an output format (structured outputs), delete this line and the beta above: the schema is what
    // keeps the reply's shape, the fallback only adds a retry.
    fallbacks: 'default',
    system: [{ type: 'text', text: systemPrompt(body.role, body.persona, body.name, opts), cache_control: { type: 'ephemeral' } }],
    messages: upstreamMessages(body.messages, opts),
  };
}

/** Upstream failure → HTTP status + a message for the player (Anthropic's mapping; see server/llm/anthropicProvider.ts). */
export const describeError = describeAnthropicError;

/**
 * What a chat request that the upstream did not finish is charged, when it reported no usage: the request's text (system
 * prompt and messages) as input, and the reply text that reached the player as output, each at one token per two characters
 * (a conservative estimate; JSON markup is counted too). Only used when the usage is unknown.
 */
export function estimateChatUsage(req: BetaMessageStreamParams, replyChars: number): ClaudeUsage {
  const inputChars = JSON.stringify({ system: req.system, messages: req.messages }).length;
  return { input_tokens: Math.ceil(inputChars / 2), output_tokens: Math.ceil(replyChars / 2) };
}

/**
 * Output tokens reserved for a stream that ended early while thinking was on: thinking tokens are not in the reply text, so
 * the reply length alone would under-count them. chatRequest sets no thinking config today, so this is not applied to chat.
 */
export const INTERRUPTED_THINKING_RESERVE = 256;

/**
 * Records the spend of a chat stream that did not end with a normal reply (every caller passes one, so every spend recorded
 * here is marked estimated). Mid-stream the upstream has reported only the input and an output of about 1 (the output count
 * arrives on message_delta at the end), so the output is the largest of what it reported, the reply text that reached the
 * player at one token per two characters, and, with thinking on, INTERRUPTED_THINKING_RESERVE. With no usage at all, a client
 * that went away is charged the estimate of estimateChatUsage, and a failed upstream is only counted as an error (it is not
 * known to have billed anything). `clientGone`: the player left, so it is not an error.
 */
export function recordStreamSpend(
  store: Pick<UsageStore, 'recordClaude' | 'recordClaudeError'>,
  model: string,
  req: BetaMessageStreamParams,
  stream: { usageSoFar(): ClaudeUsage | undefined },
  replyChars: number,
  opts: { clientGone: boolean },
): void {
  const known = stream.usageSoFar();
  if (known) {
    const thinking = (req as { thinking?: { type?: string } }).thinking;
    const reserve = thinking && thinking.type !== 'disabled' ? INTERRUPTED_THINKING_RESERVE : 0;
    const output = Math.max(known.output_tokens ?? 0, Math.ceil(replyChars / 2), reserve);
    store.recordClaude(model, { ...known, output_tokens: output }, { error: !opts.clientGone, estimated: true });
    return;
  }
  if (opts.clientGone) {
    store.recordClaude(model, estimateChatUsage(req, replyChars), { estimated: true });
    return;
  }
  store.recordClaudeError(model);
}

// ---------------------------------------------------------------- 小提醒 practice: judge what the player said

const JUDGE_MAX_CHARS = 200;
/** the judge is a short one-shot call: 30 s, then it is a failed judgement for the player */
export const JUDGE_TIMEOUT_MS = 30_000;
const JUDGE_FAIL = '判斷失敗，請再試一次';

/** Pull the judge's {ok, feedback} out of its reply (the first {…} in the text). Anything unreadable is a failed judgement. */
export function parseJudge(text: string): { ok: boolean; feedback: string } {
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as unknown;
      if (j && typeof j === 'object') {
        const o = j as Record<string, unknown>;
        if (typeof o.ok === 'boolean') {
          const fb = typeof o.feedback === 'string' ? o.feedback.trim() : '';
          return { ok: o.ok, feedback: fb || (o.ok ? '完全正確！' : '和目標句不一樣') };
        }
      }
    } catch { /* fall through */ }
  }
  return { ok: false, feedback: JUDGE_FAIL };
}

/** Validate the judge body; throws HttpError(400) on anything malformed. */
export function parseJudgeBody(raw: string): { target: string; said: string } {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { throw bad('請求不是合法的 JSON'); }
  if (!j || typeof j !== 'object') throw bad('請求內容錯誤');
  const b = j as Record<string, unknown>;
  const target = str(b.target, JUDGE_MAX_CHARS)?.trim();
  const said = str(b.said, JUDGE_MAX_CHARS)?.trim();
  if (!target) throw bad(`target 需為 1 到 ${JUDGE_MAX_CHARS} 字的字串`);
  if (!said) throw bad(`said 需為 1 到 ${JUDGE_MAX_CHARS} 字的字串`);
  return { target, said };
}

/** the judge's reply shape (Structured Outputs: the reply text is guaranteed to match this) */
export const JUDGE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, feedback: { type: 'string' } },
  required: ['ok', 'feedback'],
  additionalProperties: false,
} as const;

async function handleJudge(req: IncomingMessage, res: ServerResponse, root: string, mode: string) {
  if (req.method !== 'POST') return json(res, 404, { error: 'not_found', message: '沒有這個 API' });
  // the body: the judge fields, the routing, and the Claude model of the phone's 小提醒 (without one, the server's own)
  const parsed = await readRequest(req, res, (raw) => ({ body: parseJudgeBody(raw), routing: routingOf(raw), claudeModel: bodyModel(raw) }));
  if (!parsed) return;
  const { body } = parsed;
  const services = await servicesOrAnswer(res, parsed.routing, { root, mode, claudeModel: parsed.claudeModel, reserveUsd: HELPER_RESERVE_USD });
  if (!services) return;
  const slot = takeChatSlot(readLimits(root, mode).chatPerMinute);
  if (slot !== 'ok') return slotRefusal(res, slot);

  const usage = getUsageStore(root);
  try {
    const r = await firstServing(services, async (svc) => {
      try {
        const msg = await svc.provider.complete({
          model: svc.model,
          // Haiku 5.5 thinks by default: leave room for that, and let structured output guarantee the JSON
          max_tokens: 2000,
          output_config: {
            effort: 'low',
            format: { type: 'json_schema', schema: JUDGE_SCHEMA },
          },
          system: JUDGE_PROMPT,
          messages: [{ role: 'user', content: `目標：${body.target}\n他說：${body.said}` }],
          schemaName: 'mugi_judge',
        }, { timeout: JUDGE_TIMEOUT_MS });
        if (svc.spend) usage.recordClaude(msg.model || svc.model, msg.usage);
        return msg;
      } catch (e) {
        if (svc.spend) usage.recordClaudeError(svc.model);
        throw e;
      }
    });
    if (!r.ok) return upstreamFailure(res, r);
    const verdict = parseJudge(r.value.text);
    if (verdict.feedback === JUDGE_FAIL) console.warn('[judge] unreadable reply', r.value.stopReason, r.value.text.slice(0, 200));
    return json(res, 200, { ...verdict, provider: r.served.id });
  } finally {
    releaseChatSlot();
  }
}

/** The tip rewrite always runs on this model (not the chat's), with no thinking, a small budget and a 10 s limit. */
export const TIP_FIX_MODEL = 'claude-haiku-5-5';
export const TIP_FIX_MAX_TOKENS = 300;
export const TIP_FIX_TIMEOUT_MS = 10_000;
const TIP_FIX_MAX_CHARS = 1000;

/** the tip rewrite's reply shape (Structured Outputs): the tip text goes in `tip`, without <tip> tags */
export const TIP_FIX_SCHEMA = {
  type: 'object',
  properties: { tip: { type: 'string' } },
  required: ['tip'],
  additionalProperties: false,
} as const;

/**
 * The inner text of a tip rewrite reply. JSON {"tip": "..."} is the expected shape (a <tip> wrapper inside it is removed);
 * anything else falls back to the old <tip>…</tip> block, or the whole text.
 */
export function tipFromFixReply(text: string): string {
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === 'object' && typeof (j as Record<string, unknown>).tip === 'string') {
      const tip = (j as { tip: string }).tip;
      const m = /<tip>([\s\S]*?)<\/tip>/.exec(tip);
      return (m ? m[1] : tip).trim();
    }
  } catch { /* not JSON: fall through to the old format */ }
  const m = /<tip>([\s\S]*?)<\/tip>/.exec(text);
  return (m ? m[1] : text).trim();
}

/**
 * Rewrites one 小提醒 that came back with Japanese prose. The inner text (with its <ja> tags) goes in; the rewritten tip
 * comes back with its readings filled, or null when it still does not read as Chinese. A provider whose readings the server
 * writes (smallModel) gets the tip without readings and is asked for none.
 */
export async function rewriteTipWith(
  provider: LlmProvider,
  tip: string,
  onUsage?: (model: string, usage: ClaudeUsage) => void,
  model: string = TIP_FIX_MODEL,
): Promise<string | null> {
  const plain = !!provider.smallModel;
  const msg = await provider.complete({
    model,
    max_tokens: TIP_FIX_MAX_TOKENS,
    thinking: { type: 'disabled' },
    output_config: { format: { type: 'json_schema', schema: TIP_FIX_SCHEMA } },
    system: plain ? TIP_FIX_SYSTEM_PLAIN : TIP_FIX_SYSTEM,
    messages: [{ role: 'user', content: plain ? stripReadings(tip) : tip }],
    schemaName: 'mugi_tip',
  }, { timeout: TIP_FIX_TIMEOUT_MS });
  onUsage?.(msg.model || model, msg.usage as ClaudeUsage);
  const reply = tipFromFixReply(msg.text);
  const inner = plain ? stripReadings(reply) : reply;
  if (!inner) return null;
  const fixed = await fillReadings(wrapJapanese(inner), (w) => console.warn(w));
  return isChineseTip(fixed) ? fixed : null;
}

/** rewriteTipWith on the Anthropic client (kept for callers that hold a client). */
export function rewriteTip(
  client: Anthropic,
  tip: string,
  onUsage?: (model: string, usage: ClaudeUsage) => void,
): Promise<string | null> {
  return rewriteTipWith(anthropicProvider(client), tip, onUsage);
}

/** Validate the fix-tip body; throws HttpError(400) on anything malformed. */
export function parseFixTipBody(raw: string): string {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { throw bad('請求不是合法的 JSON'); }
  if (!j || typeof j !== 'object') throw bad('請求內容錯誤');
  const tip = str((j as Record<string, unknown>).tip, TIP_FIX_MAX_CHARS)?.trim();
  if (!tip) throw bad(`tip 需為 1 到 ${TIP_FIX_MAX_CHARS} 字的字串`);
  return tip;
}

async function handleFixTip(req: IncomingMessage, res: ServerResponse, root: string, mode: string) {
  if (req.method !== 'POST') return json(res, 404, { error: 'not_found', message: '沒有這個 API' });
  const parsed = await readRequest(req, res, (raw) => ({ tip: parseFixTipBody(raw), routing: routingOf(raw), claudeModel: bodyModel(raw) }));
  if (!parsed) return;
  const services = await servicesOrAnswer(res, parsed.routing, { root, mode, claudeModel: parsed.claudeModel ?? TIP_FIX_MODEL, reserveUsd: HELPER_RESERVE_USD });
  if (!services) return;
  const slot = takeChatSlot(readLimits(root, mode).chatPerMinute);
  if (slot !== 'ok') return slotRefusal(res, slot);

  const usage = getUsageStore(root);
  try {
    const r = await firstServing(services, async (svc) => {
      try {
        return await rewriteTipWith(svc.provider, parsed.tip, svc.spend ? (m, u) => usage.recordClaude(m, u) : undefined, svc.model);
      } catch (e) {
        if (svc.spend) usage.recordClaudeError(svc.model);
        throw e;
      }
    });
    if (!r.ok) return upstreamFailure(res, r);
    return r.value === null
      ? json(res, 200, { ok: false, message: '仍是日文，保留原本的小提醒', provider: r.served.id })
      : json(res, 200, { ok: true, tip: r.value, provider: r.served.id });
  } finally {
    releaseChatSlot();
  }
}

/** what the chat stream needs from its response: the player's events, whether the player is gone, and the spend of each attempt */
export type ReplyIo = {
  /** an event for the player (delta, done or error) */
  send(ev: Record<string, unknown>): void;
  /** true once the player has left: nothing more is sent */
  gone(): boolean;
  /** the stream in progress (the player leaving stops it); null when none */
  track(stream: LlmStream | null): void;
  /** a Claude stream that ended early: its spend (recordStreamSpend) */
  spendEnded(svc: Service, upstream: LlmChatRequest, stream: LlmStream, replyChars: number): void;
  /** a Claude reply that completed: its spend */
  spendDone(svc: Service, final: LlmResult): void;
  /** the reply is complete: the done event (or the refusal's error), with the fixed JSON (a local model's readings already removed) */
  finish(svc: Service, final: LlmResult): Promise<void>;
  /** the reply failed for good (no fallback): the error for the player, as the service describes it */
  failed(svc: Service, error: unknown): void;
};

/**
 * The chat reply over the services, in order (the core of handleChat, so the order and the fallback rule are testable).
 * A service that fails with an error fallbackWorthy accepts hands the request to the next one, but only while no text has
 * reached the player: once a delta went out, a failure ends the reply with an error. Returns the service that finished the
 * reply (or ended it with an error), or null when the player left.
 */
export async function streamReply(services: Service[], body: ChatBody, io: ReplyIo): Promise<Service | null> {
  // the player's own words in the newest turn (a small model's correction is compared with them)
  const said = saidOf(body.messages[body.messages.length - 1].content);
  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const last = i === services.length - 1;
    const upstream: LlmChatRequest = chatRequest(body, svc.model, { smallModel: svc.provider.smallModel });
    // the reply text sent so far (for the spend estimate when the stream ends early without usage)
    let replyChars = 0;
    // whether any text reached the player: only a stream that sent nothing may move on to the next service
    let sent = false;
    // set once the reply is complete and its spend recorded: nothing after that may move on or record again
    let recorded = false;
    const stream = svc.provider.streamChat(upstream, (text) => {
      replyChars += text.length;
      sent = true;
      io.send({ type: 'delta', text });
    });
    io.track(stream);
    try {
      const final: LlmResult = await stream.done;
      if (svc.spend) io.spendDone(svc, final);
      recorded = true;
      // a small model's own readings are removed first, so every reading comes from the analyser (fixReplyJson), and its tip is
      // made from its correction of the player's line
      const text = svc.provider.smallModel ? await tipFromCorrection(stripReadings(final.text), said) : final.text;
      await io.finish(svc, { ...final, text });
      return svc;
    } catch (e) {
      // a stream that ended early (the player left, the upstream failed or hit the time limit) still spends what it used
      if (svc.spend && !recorded) io.spendEnded(svc, upstream, stream, replyChars);
      if (io.gone()) return null;
      if (!recorded && !sent && !last && fallbackWorthy(e)) {
        console.warn(`[ai] ${svc.id} could not answer, trying the next service:`, e instanceof Error ? e.message : e);
        continue;
      }
      io.failed(svc, e);
      return svc;
    } finally {
      io.track(null);
    }
  }
  return null;
}

async function handleChat(req: IncomingMessage, res: ServerResponse, root: string, mode: string) {
  const url = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && url.replace(/\/$/, '') === '/status') {
    const s = readSettings(root, mode);
    // personas: the default personality text per role (only that line, never the whole system prompt)
    const personas = Object.fromEntries(CHAT_ROLES.map((r) => [r, defaultPersona(r)]));
    return json(res, 200, { ok: !!s.key, model: s.model, personas });
  }
  if (url.replace(/\/$/, '') === '/judge') return handleJudge(req, res, root, mode);
  if (url.replace(/\/$/, '') === '/fix-tip') return handleFixTip(req, res, root, mode);
  if (req.method !== 'POST' || (url !== '/' && url !== '')) return json(res, 404, { error: 'not_found', message: '沒有這個 API' });

  const body = await readRequest(req, res, parseChatBody);
  if (!body) return;
  // the services in the player's order; the chat's Claude model is the player's (or the server's own)
  const services = await servicesOrAnswer(res, body.routing, { root, mode, claudeModel: body.model, reserveUsd: CHAT_RESERVE_USD });
  if (!services) return;

  const slot = takeChatSlot(readLimits(root, mode).chatPerMinute);
  if (slot !== 'ok') return slotRefusal(res, slot);

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
  };
  let clientGone = false;
  const send = (ev: Record<string, unknown>) => {
    if (clientGone || res.writableEnded) return;
    start();
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  // the stream in progress: the player leaving stops it
  let current: LlmStream | null = null;
  // registered on the response: the request's own 'close' also fires once its body is read, which is not a disconnect
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      current?.abort();
    }
  });

  const usage = getUsageStore(root);
  try {
    await streamReply(services, body, {
      send,
      gone: () => clientGone,
      track: (stream) => { current = stream; },
      spendEnded: (svc, upstream, stream, replyChars) => recordStreamSpend(usage, svc.model, upstream, stream, replyChars, { clientGone }),
      spendDone: (svc, final) => {
        const u = final.usage ?? {};
        usage.recordClaude(final.model || svc.model, u);
        console.log(`[claude] in=${u.input_tokens} cacheRead=${u.cache_read_input_tokens ?? 0} cacheWrite=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`);
      },
      finish: async (svc, final) => {
        if (final.stopReason === 'refusal') {
          send({ type: 'error', message: '（她有點不好意思，別過頭去）這個話題我們換一個好不好？' });
          return;
        }
        // the reply as shown and stored: her JSON with the readings filled and the tip read (server/replyFix.ts). tipRewrite:
        // the tip is to be rewritten in the background (the client calls /api/chat/fix-tip once for it)
        const fixed = clientGone ? { json: final.text, tipRewrite: false } : await fixReplyJson(final.text, { log: (m) => console.warn(m) });
        send({ type: 'done', text: fixed.json, usage: final.usage, tipRewrite: fixed.tipRewrite, provider: svc.id, model: svc.model });
      },
      failed: (svc, e) => {
        if (clientGone) return;
        const { status, message } = svc.provider.describeError(e);
        if (!started) json(res, status, { error: 'upstream', message });
        else send({ type: 'error', message });
      },
    });
  } finally {
    if (started && !res.writableEnded) res.end();
    releaseChatSlot();
  }
}

/** Vite plugin: mounts the chat endpoint on the dev server. */
export function claudeChatPlugin(): Plugin {
  let root = process.cwd();
  let mode = 'development';
  return {
    name: 'mugi-claude-chat',
    apply: 'serve',
    configResolved(cfg) {
      root = cfg.root;
      mode = cfg.mode;
    },
    configureServer(server) {
      // load the reading analyser now, not on the first reply (its dictionary takes about a second)
      loadAnalyzer().catch((e: unknown) => console.warn('[readings]', e instanceof Error ? e.message : e));
      // the ChatGPT sign-in is read now too (its key unlock may take a second on Windows); a failure is logged there
      chatGptService();
      const guard = guardOptionsFrom(server);
      // the ChatGPT sign-in: /api/openai (guarded like the other /api routes; sign-in and sign-out local only) and the OAuth callback (local only, see routes.ts)
      server.middlewares.use('/api/openai', guardApi((req, res) => {
        const chatgpt = chatGptService();
        if (!chatgpt) return json(res, 500, { error: 'server', message: '登入資料無法讀取，請看終端機的說明。' });
        handleOpenAiApi(req, res, chatgpt).then((handled) => {
          if (!handled) json(res, 404, { error: 'not_found', message: '沒有這個 API' });
        }).catch((e: unknown) => {
          console.warn('[openai]', e instanceof Error ? e.message : e);
          if (!res.headersSent) json(res, 500, { error: 'server', message: '伺服器錯誤' });
          else if (!res.writableEnded) res.end();
        });
      }, guard));
      // the settings from the sheet: the keys in .env.local are written from this PC only, the daily budget from a trusted request (settingsRoutes.ts)
      server.middlewares.use('/api/settings', guardApi((req, res) => {
        handleSettingsApi(req, res, {
          envPath: join(PROJECT_ROOT, '.env.local'),
          guard,
          readUsd: () => readLimits(root, mode).dailyUsd,
          spentTodayUsd: () => getUsageStore(root).dailyCostUsd(),
        }).then((handled) => {
          if (!handled) json(res, 404, { error: 'not_found', message: '沒有這個 API' });
        }).catch((e: unknown) => {
          console.warn('[settings]', e instanceof Error ? e.message : e);
          if (!res.headersSent) json(res, 500, { error: 'server', message: '伺服器錯誤' });
          else if (!res.writableEnded) res.end();
        });
      }, guard));
      server.middlewares.use('/auth/callback', (req, res) => {
        const chatgpt = chatGptService();
        if (!chatgpt) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('登入資料無法讀取，請看終端機的說明。');
          return;
        }
        handleAuthCallback(req, res, chatgpt).catch((e: unknown) => {
          console.warn('[openai]', e instanceof Error ? e.message : e);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          if (!res.writableEnded) res.end('登入失敗，請回到首頁重試。');
        });
      });
      // the local model's status: whether its server answers, and the models it lists (localService.ts)
      server.middlewares.use('/api/local', guardApi((req, res) => {
        handleLocalApi(req, res, root, mode).then((handled) => {
          if (!handled) json(res, 404, { error: 'not_found', message: '沒有這個 API' });
        }).catch((e: unknown) => {
          console.warn('[local]', e instanceof Error ? e.message : e);
          if (!res.headersSent) json(res, 500, { error: 'server', message: '伺服器錯誤' });
          else if (!res.writableEnded) res.end();
        });
      }, guard));
      server.middlewares.use('/api/lookup', guardApi((req, res) => {
        handleLookup(req, res, root, mode).catch((e: unknown) => {
          console.warn('[lookup]', e instanceof Error ? e.message : e);
          if (!res.headersSent) json(res, 500, { error: 'server', message: '伺服器錯誤' });
          else if (!res.writableEnded) res.end();
        });
      }, guard));
      server.middlewares.use('/api/chat', guardApi((req, res) => {
        handleChat(req, res, root, mode).catch((e: unknown) => {
          // an unexpected bug must not take the dev server down; report it as a plain error
          console.warn('[claude-chat]', e instanceof Error ? e.message : e);
          if (!res.headersSent) json(res, 500, { error: 'server', message: '伺服器錯誤' });
          else if (!res.writableEnded) res.end();
        });
      }, guard));
    },
  };
}

// ---------------------------------------------------------------- 速查: one Japanese lookup (POST /api/lookup, no persona)

/** the lookup always runs on this model, with no thinking and a small budget (see prompts.ts LOOKUP_SYSTEM) */
export const LOOKUP_MODEL = 'claude-haiku-5-5';
export const LOOKUP_MAX_TOKENS = 700;
export const LOOKUP_TIMEOUT_MS = 20_000;
/** at most this many lookups per minute (one device; the dev server is personal) */
export const LOOKUP_PER_MINUTE = 20;
const lookupTimes: number[] = [];

/** the lookup reply shape (Structured Outputs): the same fields parseLookupText reads; the raw fallback stays for truncation */
export const LOOKUP_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ja: { type: 'string' },
          zh: { type: 'string' },
          level: { type: 'string', enum: ['N5', 'N4', 'N3', 'N2', 'N1', '級外'] },
          note: { type: 'string' },
        },
        required: ['ja', 'zh', 'level', 'note'],
        additionalProperties: false,
      },
    },
    grammar: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          point: { type: 'string' },
          level: { type: 'string', enum: ['N5', 'N4', 'N3', 'N2', 'N1', '級外'] },
          explain: { type: 'string' },
        },
        required: ['point', 'level', 'explain'],
        additionalProperties: false,
      },
    },
    examples: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ja: { type: 'string' }, zh: { type: 'string' } },
        required: ['ja', 'zh'],
        additionalProperties: false,
      },
    },
    message: { type: 'string' },
  },
  required: ['items', 'grammar', 'examples', 'message'],
  additionalProperties: false,
} as const;

/** lookups running at the same time (their own count: separate from the chat slots) */
export const LOOKUP_MAX_ACTIVE = 2;
let lookupActive = 0;

/** takes a running-lookup place; false when LOOKUP_MAX_ACTIVE are already running. releaseLookupConcurrency gives it back. */
export function takeLookupConcurrency(): boolean {
  if (lookupActive >= LOOKUP_MAX_ACTIVE) return false;
  lookupActive++;
  return true;
}

export function releaseLookupConcurrency(): void {
  if (lookupActive > 0) lookupActive--;
}

/** a sliding one-minute window: true when a lookup may run now (and records it) */
export function takeLookupSlot(now = Date.now(), times: number[] = lookupTimes): boolean {
  while (times.length && now - times[0] >= 60_000) times.shift();
  if (times.length >= LOOKUP_PER_MINUTE) return false;
  times.push(now);
  return true;
}

/** Validate the lookup body: a non-empty question of at most LOOKUP_MAX_CHARS characters. */
export function parseLookupBody(raw: string): string {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { throw bad('請求不是合法的 JSON'); }
  if (!j || typeof j !== 'object') throw bad('請求內容錯誤');
  const q = str((j as Record<string, unknown>).q, LOOKUP_MAX_CHARS * 4)?.trim() ?? '';
  if (!q) throw bad('請輸入要查的詞或句子');
  if ([...q].length > LOOKUP_MAX_CHARS) throw bad(`最多 ${LOOKUP_MAX_CHARS} 字`);
  return q;
}

/**
 * One lookup: the model's reply parsed into an answer (null when it is not readable JSON: the raw text goes back instead),
 * and every <ja> field gets the kanji readings it lacks (readings.ts), as the chat replies do. A provider whose readings the
 * server writes (smallModel) is asked for none, and any it writes are removed first.
 */
export async function lookupAnswerWith(
  provider: LlmProvider,
  q: string,
  onUsage?: (model: string, usage: ClaudeUsage) => void,
  model: string = LOOKUP_MODEL,
): Promise<{ answer: LookupAnswer | null; raw: string }> {
  const msg = await provider.complete({
    model,
    max_tokens: LOOKUP_MAX_TOKENS,
    thinking: { type: 'disabled' },
    output_config: { format: { type: 'json_schema', schema: LOOKUP_SCHEMA } },
    system: provider.smallModel ? LOOKUP_SYSTEM_PLAIN : LOOKUP_SYSTEM,
    messages: [{ role: 'user', content: q }],
    schemaName: 'mugi_lookup',
  }, { timeout: LOOKUP_TIMEOUT_MS });
  onUsage?.(msg.model || model, msg.usage as ClaudeUsage);
  const raw = msg.text.trim();
  const answer = parseLookupText(raw);
  if (!answer) return { answer: null, raw };
  const log = (m: string) => console.warn(m);
  const own = (t: string) => (provider.smallModel ? stripReadings(t) : t);
  for (const it of answer.items) it.ja = await fillReadings(own(it.ja), log);
  for (const g of answer.grammar) if (g.point) g.point = await fillReadings(own(g.point), log);
  for (const ex of answer.examples) ex.ja = await fillReadings(own(ex.ja), log);
  return { answer, raw };
}

/** lookupAnswerWith on the Anthropic client (kept for callers that hold a client). */
export function lookupAnswer(
  client: Anthropic,
  q: string,
  onUsage?: (model: string, usage: ClaudeUsage) => void,
): Promise<{ answer: LookupAnswer | null; raw: string }> {
  return lookupAnswerWith(anthropicProvider(client), q, onUsage);
}

async function handleLookup(req: IncomingMessage, res: ServerResponse, root: string, mode: string) {
  if (req.method !== 'POST') return json(res, 404, { error: 'not_found', message: '沒有這個 API' });
  const parsed = await readRequest(req, res, (raw) => ({ q: parseLookupBody(raw), routing: routingOf(raw), claudeModel: bodyModel(raw) }));
  if (!parsed) return;
  const services = await servicesOrAnswer(res, parsed.routing, { root, mode, claudeModel: parsed.claudeModel ?? LOOKUP_MODEL, reserveUsd: HELPER_RESERVE_USD });
  if (!services) return;
  if (!takeLookupConcurrency()) return json(res, 429, { error: 'rate_limit', message: '同時進行的查詢太多，稍後再試' });
  const usage = getUsageStore(root);
  try {
    if (!takeLookupSlot()) return json(res, 429, { error: 'rate_limit', message: '查詢太頻繁，稍後再試' });
    const r = await firstServing(services, async (svc) => {
      try {
        return await lookupAnswerWith(svc.provider, parsed.q, svc.spend ? (m, u) => usage.recordClaude(m, u) : undefined, svc.model);
      } catch (e) {
        if (svc.spend) usage.recordClaudeError(svc.model);
        throw e;
      }
    });
    if (!r.ok) return upstreamFailure(res, r);
    return json(res, 200, { ok: true, answer: r.value.answer, raw: r.value.raw, provider: r.served.id });
  } finally {
    releaseLookupConcurrency();
  }
}

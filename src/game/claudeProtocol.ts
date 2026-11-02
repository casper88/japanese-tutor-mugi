// Shared vocabulary between the Claude chat endpoint (server/claudeChat.ts, prompts in server/prompts.ts) and the client
// (game/claudeBrain.ts). Pure constants only: no imports, so the Node side can use it too.

export const CLAUDE_MODEL_DEFAULT = 'claude-haiku-5-5';

/**
 * The models the player can pick in 設定 › AI 模型 (chat, and the 速查 / 小提醒 helpers). Each id must be priced in
 * server/usage.ts CLAUDE_PRICES. A model id from anywhere else is refused by the server (400).
 */
export const CHAT_MODEL_CHOICES = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', note: '最省、最快（預設）' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: '平衡' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: '最聰明、最貴' },
] as const;
export type ChatModelId = (typeof CHAT_MODEL_CHOICES)[number]['id'];

export function isChatModelId(v: unknown): v is ChatModelId {
  return CHAT_MODEL_CHOICES.some((m) => m.id === v);
}

/** the short name of a model for the settings (「Haiku 5.5」); an id not in the list is shown as it is */
export function chatModelLabel(id: string): string {
  return CHAT_MODEL_CHOICES.find((m) => m.id === id)?.label ?? id;
}

/**
 * The AI services, in the order the server tries them: each AI request carries its own list (`providers`, see
 * server/aiChain.ts). Claude is the API key service; ChatGPT is the signed-in account (server/openai); 本地模型 is an
 * OpenAI-compatible server on the PC, such as Ollama or LM Studio (server/llm/localService.ts).
 */
export const PROVIDER_IDS = ['anthropic', 'openai', 'local'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
/** the names on screen (設定 › AI 服務) */
export const PROVIDER_LABELS: Record<ProviderId, string> = { anthropic: 'Claude', openai: 'ChatGPT', local: '本地模型' };
/** a request without a list (and an old save) uses Claude alone, as before */
export const DEFAULT_PROVIDERS: ProviderId[] = ['anthropic'];
/** the most services a request may list (every id once) */
export const PROVIDERS_MAX = PROVIDER_IDS.length;
/** where the local model server is when LOCAL_LLM_URL is not set: Ollama's OpenAI-compatible address on this PC */
export const LOCAL_LLM_URL_DEFAULT = 'http://127.0.0.1:11434/v1';
/** the longest ChatGPT model id a request may name */
export const OPENAI_MODEL_MAX_CHARS = 100;

/** the routing fields of an AI request: the services in order, and the ChatGPT model ('' or absent = the first one listed) */
export type AiServices = { providers: ProviderId[]; openaiModel?: string };

export function isProviderId(v: unknown): v is ProviderId {
  return PROVIDER_IDS.some((p) => p === v);
}

/** A providers list: 1 to PROVIDERS_MAX known ids, none repeated. Anything else is undefined (the caller decides: 400 or the default). */
export function parseProviderList(v: unknown): ProviderId[] | undefined {
  if (!Array.isArray(v) || v.length < 1 || v.length > PROVIDERS_MAX) return undefined;
  if (!v.every(isProviderId)) return undefined;
  if (new Set(v).size !== v.length) return undefined;
  return [...v];
}

/** the longest 人設 (persona) text, in characters (code points) */
export const PERSONA_MAX_CHARS = 400;

/**
 * The persona text as it is kept: every line break and tab (and the other line/paragraph separators) becomes one space, so the
 * persona stays on its own 「個性：」 line of the system prompt and cannot start a new paragraph there; other control characters
 * are removed; trimmed. '' when nothing is left. Does not cut the length: the caller decides what a too-long text means (the
 * server refuses it, the settings cut it).
 */
export function personaText(raw: string): string {
  return raw
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
}

/** the longest name of the tutor the request accepts, in characters (code points) */
export const NAME_MAX_CHARS = 16;

/**
 * The tutor's name as the request carries it: control characters and line breaks removed (a name is one line), the quote
 * marks 「」『』"' removed (the name is put inside 「…」 in the system prompt, so it cannot close that quote), trimmed, `<` and
 * `>` made full-width (so it cannot open a tag). '' when nothing is left. The length is checked by the caller (the server
 * refuses 1 to NAME_MAX_CHARS characters).
 */
export function nameText(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F\u0085\u2028\u2029「」『』"']/g, '')
    .trim()
    .replace(/</g, '＜')
    .replace(/>/g, '＞');
}

export const CHAT_MAX_MESSAGES = 40;
/** the longest message the server accepts, in code points (a surrogate pair is one character) */
export const CHAT_MAX_MESSAGE_CHARS = 2000;
/**
 * The most the player can type into the chat box, in code points. Below CHAT_MAX_MESSAGE_CHARS by the room the situation/mode
 * prefix (［情境］［模式］, about 30 characters) takes, so the sent message always fits the server's limit.
 */
export const CHAT_INPUT_MAX_CHARS = 1900;

/** the text cut to `max` code points (never inside a surrogate pair); the same text when it is short enough */
export function clipCodePoints(s: string, max: number): string {
  const cps = [...s];
  return cps.length > max ? cps.slice(0, max).join('') : s;
}
/**
 * History window (see claudeBrain.markWindowReset): the request carries the chat lines since the last window reset. The
 * window grows turn by turn (so the prefix stays byte-identical for the prompt cache) and resets to the newest
 * CHAT_HISTORY_LINES once it would exceed CHAT_HISTORY_MAX (the server accepts at most CHAT_MAX_MESSAGES).
 * CHAT_HISTORY_MAX is one less than CHAT_MAX_MESSAGES: the −1 leaves room for CHAT_LEAD_TURN, the fixed user turn put in
 * front when the window opens with her line. So a request never exceeds CHAT_MAX_MESSAGES, and the first message of a
 * window never changes, which keeps the cache prefix stable.
 */
export const CHAT_HISTORY_LINES = 20;
export const CHAT_HISTORY_MAX = CHAT_MAX_MESSAGES - 1;
/**
 * Idle reset (see claudeBrain.markIdleReset): when the last real exchange (not a tip, not a 開話題 line) is older than this,
 * the next request starts at the newest CHAT_IDLE_KEEP lines instead of the whole window. A long pause makes the next
 * round cheaper and starts the topic over; the chat on screen is not changed.
 */
export const CHAT_IDLE_RESET_MS = 60 * 60 * 1000;
/** how many lines (tips not counted, 開話題 lines counted) the request keeps after an idle reset */
export const CHAT_IDLE_KEEP = 5;

/** 'Mugi' (むぎ, the hamster) is the only 日語家教 teacher (server/prompts.ts PERSONA, game/tutorCharacters.ts) */
export const CHAT_ROLES = ['Mugi'] as const;
export type ChatRoleId = (typeof CHAT_ROLES)[number];
/** the Japanese-teacher mode is the only mode */
export const CHAT_MODES = ['teacher'] as const;
export type ChatModeId = (typeof CHAT_MODES)[number];

/** reply tones (chatTypes.ts Tone): how she says it, read from her meta tag */
export const CHAT_TONES = [
  'explain', 'agree', 'nod', 'ask', 'confused', 'refuse', 'think', 'greet', 'bye', 'happy', 'shy', 'angry', 'surprised', 'sad',
] as const;

/** Where the situation is, for the situation prefix of a user turn. */
export type ChatContext = { timeOfDay?: string };

/**
 * The user's message with the time and mode as a bracketed prefix, e.g. ［情境：晚上 9 點］［模式：日語老師］.
 * Built once when the message is sent and stored on its chat line (ChatLine.sent): later requests re-send those exact bytes.
 */
export function userTurn(text: string, ctx: ChatContext, mode: ChatModeId): string {
  const prefix = ctx.timeOfDay ? `［情境：${ctx.timeOfDay}］` : '';
  const modeTag = mode === 'teacher' ? '［模式：日語老師］' : '';
  return `${prefix}${modeTag}${text}`;
}

/** one segment of her reply: lang 'ja' is what she says (voiced), gloss its short Chinese meaning (shown in brackets, not voiced) */
export type ChatSegment = { lang: 'ja' | 'zh'; text: string; gloss: string };
/**
 * Her whole reply as Claude writes it (Structured Outputs, the schema in server/claudeChat.ts CHAT_REPLY_SCHEMA). The server
 * sends it back as the `done` text (canonical form, see game/replyJson.ts); tone is left out only in a cut reply.
 */
export type ChatReplyJson = { segments: ChatSegment[]; tip: string; tone?: (typeof CHAT_TONES)[number] };

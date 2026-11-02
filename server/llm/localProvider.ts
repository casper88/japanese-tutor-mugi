// The local model backend (the third service): an OpenAI-compatible Chat Completions server on this PC or the home network,
// such as Ollama, LM Studio, llama.cpp's llama-server or vLLM (where it is: server/llm/localService.ts). The Anthropic-shaped
// request of claudeChat is converted here: the system text → a system message, messages → text messages (cache marks dropped),
// max_tokens → max_tokens, the JSON schema → response_format json_schema (the local server limits the output to it). A server
// that refuses that format (llama-cpp-python takes only the older json_object with a schema) is asked again in the older one,
// and that is remembered for its address. The stream is on. A local model costs nothing, so nothing is recorded against the daily Claude budget.
// The server writes every kanji reading for a local model (smallModel): small models often get them wrong.
import type { LlmChatRequest, LlmCompleteOptions, LlmCompleteRequest, LlmProvider, LlmResult, LlmStream } from './provider.ts';
import { defaultDescribeError } from './provider.ts';
import { readSSE, systemTextOf, textOf } from './openaiProvider.ts';

/** the whole local reply (stream included) must finish within this long: a model loaded for the first time can take a while */
export const LOCAL_STREAM_TIMEOUT_MS = 180_000;
/**
 * the shortest time limit of a one-shot request (judge, tip rewrite, lookup): a local model is slower than the cloud ones, and a
 * lookup has a prompt of its own that the server cannot reuse (a 4B model on a 4-core CPU took over 30 s)
 */
export const LOCAL_MIN_TIMEOUT_MS = 90_000;
/** the schema name when a request names none (every call site names its own: mugi_reply, mugi_judge, mugi_tip, mugi_lookup) */
const DEFAULT_SCHEMA_NAME = 'mugi_output';
/** the longest piece of the local server's own error text that goes into a message */
const DETAIL_MAX_CHARS = 200;

/**
 * An error from the local server: `status` when it answered with an HTTP error (or sent an error inside the stream, which
 * counts as 500), `timeout` when our own time limit ended the request. The message is shown to the player as it is.
 */
export class LocalLlmError extends Error {
  status?: number;
  timeout?: boolean;
  constructor(message: string, opts: { status?: number; timeout?: boolean } = {}) {
    super(message);
    this.name = 'LocalLlmError';
    this.status = opts.status;
    this.timeout = opts.timeout;
  }
}

/** Sends one POST to the local server (path '/chat/completions'); the provider reads the status and the body */
export type LocalTransport = (path: string, init: { body: string; signal: AbortSignal }) => Promise<Response>;

/**
 * How the JSON schema is sent: 'json_schema' is the OpenAI shape (Ollama, LM Studio, llama-server, vLLM); 'json_object' with a
 * `schema` is the older shape some servers take instead (llama-cpp-python).
 */
export type SchemaStyle = 'json_schema' | 'json_object';
/** the style each server took, by its address: a server that refused json_schema is sent json_object from then on */
const schemaStyles = new Map<string, SchemaStyle>();
/** an error text that says the server did not take the response_format it was sent */
const FORMAT_REFUSED = /response_format|json_schema/i;

/** forgets the styles learned so far (the tests) */
export function clearSchemaStyles(): void {
  schemaStyles.clear();
}

/** the Chat Completions body of an Anthropic-shaped request (exported for the tests) */
export function chatCompletionsBody(req: LlmChatRequest | LlmCompleteRequest, style: SchemaStyle = 'json_schema'): Record<string, unknown> {
  const system = systemTextOf(req);
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...req.messages.map((m) => ({ role: m.role, content: textOf(m.content) })),
  ];
  const format = req.output_config?.format;
  const schemaName = (req as { schemaName?: string }).schemaName || DEFAULT_SCHEMA_NAME;
  return {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    stream: true,
    ...(format
      ? {
        response_format: style === 'json_object'
          ? { type: 'json_object', schema: format.schema }
          : { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: format.schema } },
      }
      : {}),
  };
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * Drops a leading <think>…</think> block from a stream of text pieces: some servers put a reasoning model's thinking into the
 * reply text itself (most send it in a field of its own, which is never read). Text before the reply starts is held back until
 * it is clear whether it opens such a block. `end` sends what is still held back (a short reply that only looked like one).
 */
export function thinkFilter(onText: (text: string) => void): { push(text: string): void; end(): void } {
  let state: 'start' | 'think' | 'pass' = 'start';
  let held = '';
  return {
    push(text: string) {
      if (!text) return;
      if (state === 'pass') {
        onText(text);
        return;
      }
      held += text;
      if (state === 'start') {
        const lead = held.trimStart();
        if (!lead) return;
        if (lead.length < THINK_OPEN.length && THINK_OPEN.startsWith(lead)) return;
        if (!lead.startsWith(THINK_OPEN)) {
          state = 'pass';
          const out = held;
          held = '';
          onText(out);
          return;
        }
        state = 'think';
        held = lead.slice(THINK_OPEN.length);
      }
      const close = held.indexOf(THINK_CLOSE);
      if (close < 0) {
        // keep only what could still be the start of the closing tag
        held = held.slice(-(THINK_CLOSE.length - 1));
        return;
      }
      state = 'pass';
      const rest = held.slice(close + THINK_CLOSE.length).trimStart();
      held = '';
      if (rest) onText(rest);
    },
    end() {
      if (state === 'start' && held) onText(held);
      held = '';
    },
  };
}

type Choice = { delta?: { content?: unknown }; finish_reason?: unknown };

/** the local server's own error text (a JSON body's error.message or error, or the plain text), cut short; '' when none */
export function errorDetail(raw: string): string {
  let detail = raw.trim();
  try {
    const j = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const e = j.error;
    if (typeof e === 'string') detail = e;
    else if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') detail = (e as { message: string }).message;
    else if (typeof j.message === 'string') detail = j.message;
  } catch { /* plain text */ }
  return detail.replace(/\s+/g, ' ').slice(0, DETAIL_MAX_CHARS);
}

/** the message for an HTTP error from the local server, by its status (the server's own text after it, when it gave one) */
export function httpErrorMessage(status: number, detail: string): string {
  const tail = detail ? `：${detail}` : '';
  if (status === 404) return `本地模型服務找不到這個模型或網址（404），請確認模型名稱與網址（Ollama 要先下載模型）${tail}`;
  if (status === 401 || status === 403) return `本地模型服務需要金鑰（${status}），請在電腦的 .env.local 設定 LOCAL_LLM_API_KEY${tail}`;
  if (status === 400 || status === 422) return `本地模型服務不接受這個請求（${status}），它可能不支援 JSON 格式的回覆${tail}`;
  return `本地模型回應錯誤（${status}）${tail}`;
}

/**
 * Reads a Chat Completions stream: each content delta goes to onDelta (a leading <think> block removed); the end is a choice
 * with a finish_reason. An error inside the stream throws a LocalLlmError (status 500); a stream that ends without a
 * finish_reason is a dropped line.
 */
export async function collectChatStream(body: ReadableStream<Uint8Array> | null, onDelta: (text: string) => void): Promise<LlmResult> {
  let text = '';
  let model: string | undefined;
  let finish: string | null = null;
  const filter = thinkFilter((t) => {
    text += t;
    onDelta(t);
  });
  for await (const ev of readSSE(body)) {
    if (ev.error !== undefined) {
      const detail = errorDetail(JSON.stringify({ error: ev.error }));
      throw new LocalLlmError(`本地模型回覆失敗${detail ? `：${detail}` : ''}`, { status: 500 });
    }
    if (typeof ev.model === 'string' && ev.model) model = ev.model;
    const choice = (Array.isArray(ev.choices) ? ev.choices[0] : undefined) as Choice | undefined;
    if (!choice) continue;
    if (typeof choice.delta?.content === 'string') filter.push(choice.delta.content);
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finish = choice.finish_reason;
  }
  filter.end();
  if (!finish) throw new LocalLlmError('本地模型連線中斷，請重試。');
  return { text, model, stopReason: finish };
}

/** Upstream failure → HTTP status and a message for the player. */
export function describeLocalError(e: unknown): { status: number; message: string } {
  if (e instanceof LocalLlmError) {
    if (e.timeout) return { status: 504, message: '本地模型回應逾時，已中止（第一次載入模型可能比較久，請再試一次）' };
    return { status: 502, message: e.message };
  }
  if (e instanceof TypeError) return { status: 502, message: '連不上本地模型，請確認電腦上的 Ollama 或 LM Studio 有在執行' };
  return defaultDescribeError(e);
}

/** a time limit that ends the request ourselves; the caller's abort is not a timeout */
function timeoutError(): LocalLlmError {
  return new LocalLlmError('本地模型回應逾時，已中止', { timeout: true });
}

/** `key`: the server's address, under which the schema style it takes is remembered (none: nothing is remembered) */
export function localProvider(transport: LocalTransport, opts: { key?: string } = {}): LlmProvider {
  /** one POST, and the error it answered with (its status and text), if any */
  async function post(req: LlmChatRequest | LlmCompleteRequest, style: SchemaStyle, signal: AbortSignal) {
    const res = await transport('/chat/completions', { body: JSON.stringify(chatCompletionsBody(req, style)), signal });
    if (res.ok) return { res, error: null };
    return { res, error: { status: res.status, detail: errorDetail(await res.text().catch(() => '')) } };
  }
  /** one request: the transport (in the other schema style once, if the server refused this one), the HTTP status, then the stream read to its end */
  async function run(req: LlmChatRequest | LlmCompleteRequest, onDelta: (text: string) => void, signal: AbortSignal): Promise<LlmResult> {
    const style = (opts.key && schemaStyles.get(opts.key)) || 'json_schema';
    let { res, error } = await post(req, style, signal);
    if (error && req.output_config?.format && style === 'json_schema' && FORMAT_REFUSED.test(error.detail)) {
      ({ res, error } = await post(req, 'json_object', signal));
      if (!error && opts.key) schemaStyles.set(opts.key, 'json_object');
    }
    if (error) throw new LocalLlmError(httpErrorMessage(error.status, error.detail), { status: error.status });
    // an abort ends the body too (a real fetch does this itself; the cancel makes it certain)
    const onAbort = () => { void res.body?.cancel().catch(() => {}); };
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await collectChatStream(res.body, onDelta);
    } catch (e) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      throw e;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
  /** `run` with a time limit of `ms`, and `stop` for the caller's own abort */
  function limited(req: LlmChatRequest | LlmCompleteRequest, onDelta: (text: string) => void, ms: number) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, ms);
    const done = run(req, onDelta, ctrl.signal)
      .catch((e: unknown) => {
        if (timedOut) throw timeoutError();
        throw e;
      })
      .finally(() => clearTimeout(timer));
    return { stop: () => ctrl.abort(), done };
  }
  return {
    id: 'local',
    smallModel: true,
    streamChat(req: LlmChatRequest, onDelta: (text: string) => void): LlmStream {
      const { stop, done } = limited(req, onDelta, LOCAL_STREAM_TIMEOUT_MS);
      return { abort: stop, done, usageSoFar: () => undefined };
    },
    complete(req: LlmCompleteRequest, opts?: LlmCompleteOptions): Promise<LlmResult> {
      return limited(req, () => {}, Math.max(opts?.timeout ?? 0, LOCAL_MIN_TIMEOUT_MS)).done;
    },
    describeError: describeLocalError,
  };
}

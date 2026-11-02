// The ChatGPT backend (the second service): the Responses API at the ChatGPT plan's endpoint, reached with the signed-in
// account's OAuth token (server/openai/service.ts supplies the transport: auth, base URL, HTTP errors). The Anthropic-shaped
// request of claudeChat is converted here: system text → instructions, messages → input (text only, cache marks dropped),
// max_tokens → max_output_tokens, the JSON schema → a strict json_schema text format. store is off and the stream is on.
import type { LlmChatRequest, LlmCompleteOptions, LlmCompleteRequest, LlmProvider, LlmResult, LlmStream } from './provider.ts';
import { defaultDescribeError } from './provider.ts';

/** the whole ChatGPT reply (stream included) must finish within this long, or it is cut off (as the Claude stream) */
export const OPENAI_STREAM_TIMEOUT_MS = 120_000;
/** the schema name when a request names none (every call site names its own: mugi_reply, mugi_judge, mugi_tip, mugi_lookup) */
const DEFAULT_SCHEMA_NAME = 'mugi_output';

/**
 * An error from the ChatGPT side: `status` when there was an HTTP response, `code` the error code OpenAI gave (or the
 * stream's failure code), `timeout` when our own time limit ended the request. Messages never carry a token or a reply.
 */
export class OpenAIError extends Error {
  status?: number;
  code?: string;
  timeout?: boolean;
  constructor(message: string, opts: { status?: number; code?: string; timeout?: boolean } = {}) {
    super(message);
    this.name = 'OpenAIError';
    this.status = opts.status;
    this.code = opts.code;
    this.timeout = opts.timeout;
  }
}

/** Sends one POST to the Responses endpoint (path '/responses'), with the account's token; throws OpenAIError on an HTTP error */
export type OpenAITransport = (path: string, init: { body: string; signal: AbortSignal }) => Promise<Response>;

type Block = { type?: string; text?: unknown };

/** the text of a message content: a string, or the text blocks of an array (cache marks and other blocks are dropped) */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b: Block) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
  return '';
}

/** the system text of an Anthropic-shaped request: a string, or its text blocks joined by a blank line */
export function systemTextOf(req: LlmChatRequest | LlmCompleteRequest): string {
  const system = req.system as unknown;
  return Array.isArray(system) ? system.map((b: Block) => textOf([b])).filter(Boolean).join('\n\n') : textOf(system);
}

/** the Responses body of an Anthropic-shaped request (exported for the tests) */
export function responsesBody(req: LlmChatRequest | LlmCompleteRequest): Record<string, unknown> {
  const instructions = systemTextOf(req);
  const input = req.messages.map((m) => ({ role: m.role, content: textOf(m.content) }));
  const format = req.output_config?.format;
  const schemaName = (req as { schemaName?: string }).schemaName || DEFAULT_SCHEMA_NAME;
  return {
    model: req.model,
    instructions,
    input,
    max_output_tokens: req.max_tokens,
    store: false,
    stream: true,
    ...(format ? { text: { format: { type: 'json_schema', name: schemaName, strict: true, schema: format.schema } } } : {}),
  };
}

/** Server-sent events of a response body: the `data:` JSON of each event (a chunk may cut an event anywhere). */
export async function* readSSE(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Record<string, unknown>> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data) as Record<string, unknown>;
    }
  }
}

/**
 * Reads a Responses stream: each output_text delta goes to onDelta; the end is response.completed. A failed, incomplete or
 * errored response throws an OpenAIError with the code OpenAI gave; a stream that ends without completion is a dropped line.
 */
export async function collectStream(body: ReadableStream<Uint8Array> | null, onDelta: (text: string) => void): Promise<LlmResult> {
  let text = '';
  let completed: { model?: string; status?: string } | null = null;
  for await (const ev of readSSE(body)) {
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      text += ev.delta;
      onDelta(ev.delta);
    } else if (ev.type === 'response.failed' || ev.type === 'response.incomplete' || ev.type === 'error') {
      const r = (ev.response ?? {}) as { error?: { code?: string }; incomplete_details?: { reason?: string } };
      const e = (ev.error ?? {}) as { code?: string };
      const code = r.error?.code || r.incomplete_details?.reason || e.code || (ev.code as string | undefined) || 'response_failed';
      throw new OpenAIError(`ChatGPT 回覆未完成（${code}），請檢查額度或重試。`, { code });
    } else if (ev.type === 'response.completed') {
      completed = (ev.response ?? {}) as { model?: string; status?: string };
    }
  }
  if (!completed) throw new OpenAIError('ChatGPT 連線中斷，請重試。');
  return { text, model: completed.model, stopReason: completed.status ?? null };
}

/** Upstream failure → HTTP status and a message for the player (never a token). */
export function describeOpenAIError(e: unknown): { status: number; message: string } {
  if (e instanceof OpenAIError) {
    if (e.timeout) return { status: 504, message: 'ChatGPT 回應逾時，已中止' };
    if (e.status === 401 || e.status === 403) return { status: 401, message: '請重新登入 ChatGPT' };
    if (e.status === 429 || e.code === 'usage_limit' || e.code === 'rate_limit') return { status: 429, message: 'ChatGPT 額度已用完或太頻繁，請稍後再試' };
    if (typeof e.status === 'number' && e.status >= 500) return { status: 502, message: 'OpenAI 暫時有問題，請稍後再試' };
    if (typeof e.status === 'number') return { status: 502, message: `ChatGPT 回應錯誤（${e.status}）` };
    return { status: 502, message: e.message };
  }
  if (e instanceof TypeError) return { status: 502, message: '連不上 ChatGPT' };
  return defaultDescribeError(e);
}

/** a time limit that ends the request ourselves; the caller's abort is not a timeout */
function timeoutError(): OpenAIError {
  return new OpenAIError('ChatGPT 回應逾時，已中止', { timeout: true });
}

export function openaiProvider(transport: OpenAITransport): LlmProvider {
  /** one request: the transport, then the stream read to its end */
  async function run(req: LlmChatRequest | LlmCompleteRequest, onDelta: (text: string) => void, signal: AbortSignal): Promise<LlmResult> {
    const res = await transport('/responses', { body: JSON.stringify(responsesBody(req)), signal });
    // an abort ends the body too (a real fetch does this itself; the cancel makes it certain)
    const onAbort = () => { void res.body?.cancel().catch(() => {}); };
    // an abort that came before the response (the caller stopped at once) has already fired: cancel now
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await collectStream(res.body, onDelta);
    } catch (e) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      throw e;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
  return {
    id: 'openai',
    streamChat(req: LlmChatRequest, onDelta: (text: string) => void): LlmStream {
      const ctrl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, OPENAI_STREAM_TIMEOUT_MS);
      const done = run(req, onDelta, ctrl.signal)
        .catch((e: unknown) => {
          if (timedOut) throw timeoutError();
          throw e;
        })
        .finally(() => clearTimeout(timer));
      return { abort: () => ctrl.abort(), done, usageSoFar: () => undefined };
    },
    async complete(req: LlmCompleteRequest, opts?: LlmCompleteOptions): Promise<LlmResult> {
      const ctrl = new AbortController();
      let timedOut = false;
      const timer = opts?.timeout ? setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, opts.timeout) : undefined;
      try {
        return await run(req, () => {}, ctrl.signal);
      } catch (e) {
        if (timedOut) throw timeoutError();
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    describeError: describeOpenAIError,
  };
}

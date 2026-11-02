// 本地模型 (the third AI service), offline: the request conversion to Chat Completions, the stream read (deltas, the end, an error
// in the stream, a cut stream, a leading <think> block), HTTP errors and the time limits, the settings (LOCAL_LLM_URL and the
// model list), servicesFor, and the readings the server writes for a local model (the prompt asks for none, her earlier lines
// go without them, and any the model writes are removed). Every network call is a fake fetch.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_REPLY_SCHEMA, LOOKUP_SCHEMA, chatRequest, lookupAnswerWith, parseChatBody, rewriteTipWith, servicesFor, streamReply, type ReplyIo,
} from '../../../server/claudeChat.ts';
import { fallbackWorthy, type Service } from '../../../server/aiChain.ts';
import {
  LOCAL_MIN_TIMEOUT_MS, LOCAL_STREAM_TIMEOUT_MS, LocalLlmError, chatCompletionsBody, clearSchemaStyles, collectChatStream, describeLocalError,
  errorDetail, localProvider, thinkFilter, type LocalTransport,
} from '../../../server/llm/localProvider.ts';
import {
  LOCAL_URL_MESSAGE, clearLocalModelsCache, defaultLocalModel, listLocalModels, localConfigFrom, localStatus, modelIds, parseLocalUrl,
} from '../../../server/llm/localService.ts';
import { LOOKUP_SYSTEM_PLAIN, TIP_FIX_SYSTEM_PLAIN, reminderPrompt, systemPrompt } from '../../../server/prompts.ts';
import { stripReadings } from '../../../server/readings.ts';
import { cleanValue } from '../../../server/envFile.ts';
import { keysStatus, keyUpdatesFrom } from '../../../server/settingsRoutes.ts';
import { LOCAL_LLM_URL_DEFAULT, PROVIDERS_MAX, parseProviderList } from '../claudeProtocol';
import { serviceReady } from '../tutor';
import { localStatusText, readLocalStatus } from '../localStatus';

const sample = parseChatBody(JSON.stringify({
  messages: [
    { role: 'user', content: '今天去學校' },
    { role: 'assistant', content: '{"segments":[{"lang":"ja","text":"学校[がっこう]に行[い]ったの？","gloss":"去學校了嗎？"}],"tone":"happy"}' },
    { role: 'user', content: '是的' },
  ],
  role: 'Mugi', mode: 'teacher', context: {},
}));

/** an SSE body split into arbitrary chunks */
function sseStream(text: string, cuts: number[] = []): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const pieces: Uint8Array[] = [];
  let at = 0;
  for (const c of [...cuts, bytes.length]) {
    if (c > at) pieces.push(bytes.slice(at, c));
    at = c;
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(p);
      controller.close();
    },
  });
}

const events = (list: unknown[], done = true) => list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
const delta = (content: string) => ({ model: 'qwen3:8b', choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const finish = (reason = 'stop') => ({ model: 'qwen3:8b', choices: [{ index: 0, delta: {}, finish_reason: reason }] });

/** a transport that answers with this SSE text (or this response), and records what it was sent */
function transportWith(answer: string | (() => Response)) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const transport: LocalTransport = async (path, init) => {
    sent.push({ path, body: JSON.parse(init.body) as Record<string, unknown> });
    return typeof answer === 'string' ? new Response(sseStream(answer), { status: 200 }) : answer();
  };
  return { transport, sent };
}

describe('request conversion (Anthropic shape → Chat Completions)', () => {
  it('the system text is the first message; the history is plain text; the schema is response_format json_schema', () => {
    const body = chatCompletionsBody(chatRequest(sample, 'qwen3:8b', { serverReadings: true }));
    expect(body.model).toBe('qwen3:8b');
    expect(body.max_tokens).toBe(2000);
    expect(body.stream).toBe(true);
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: 'system', content: systemPrompt('Mugi') });
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'mugi_reply', strict: true, schema: CHAT_REPLY_SCHEMA } });
    const text = JSON.stringify(body);
    expect(text).not.toContain('cache_control');
    expect(text).not.toContain('betas');
    expect(text).not.toContain('fallbacks');
  });

  it('a local model is shown no readings: her earlier lines go without them, and the reminder asks for none', () => {
    const messages = chatCompletionsBody(chatRequest(sample, 'm', { serverReadings: true })).messages as { content: string }[];
    expect(messages[2].content).toBe('{"segments":[{"lang":"ja","text":"学校に行ったの？","gloss":"去學校了嗎？"}],"tone":"happy"}');
    expect(messages[3].content).toBe(`是的\n\n<reminder>${reminderPrompt({ serverReadings: true })}</reminder>`);
    // Claude still gets the readings and the reminder that asks for them
    const claude = chatCompletionsBody(chatRequest(sample, 'claude-haiku-5-5')).messages as { content: string }[];
    expect(claude[2].content).toContain('学校[がっこう]');
    expect(claude[3].content).toBe(`是的\n\n<reminder>${reminderPrompt()}</reminder>`);
  });

  it('a one-shot request without a schema sends no response_format', () => {
    const body = chatCompletionsBody({ model: 'm', max_tokens: 10, system: 'S', messages: [{ role: 'user', content: 'Q' }] });
    expect(body).not.toHaveProperty('response_format');
    expect(body.messages).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'Q' }]);
  });
});

describe('the prompts for a model whose readings the server writes', () => {
  it('the reminder, the lookup and the tip rewrite ask for no readings (no bracketed example left)', () => {
    for (const p of [reminderPrompt({ serverReadings: true }), LOOKUP_SYSTEM_PLAIN, TIP_FIX_SYSTEM_PLAIN]) {
      expect(p).not.toMatch(/[\p{Script=Han}]\[[ぁ-ゖ]+\]/u);
      expect(p).toContain('不要');
      expect(p).toContain('讀音');
    }
    expect(reminderPrompt()).toMatch(/学校\[がっこう\]/);
  });
});

describe('stripReadings', () => {
  it('removes the readings after kanji, in plain text and in a reply JSON, and keeps the JSON brackets', () => {
    expect(stripReadings('学校[がっこう]に行[い]きました')).toBe('学校に行きました');
    expect(stripReadings('<ja>東京[トウキョウ]</ja>')).toBe('<ja>東京</ja>');
    const json = '{"segments":[{"lang":"ja","text":"楽[たの]しい","gloss":"開心"}],"tip":"","tone":"happy"}';
    expect(JSON.parse(stripReadings(json))).toEqual({ segments: [{ lang: 'ja', text: '楽しい', gloss: '開心' }], tip: '', tone: 'happy' });
    // a bracket that holds no kana, or follows no kanji, is not a reading
    expect(stripReadings('漢字[x]、[がっこう]、"a":["b"]')).toBe('漢字[x]、[がっこう]、"a":["b"]');
    // an unclosed reading never reaches the JSON's own brackets
    const cut = '{"segments":[{"text":"学校[","gloss":"x"}],"tip":""}';
    expect(stripReadings(cut)).toBe(cut);
  });
});

describe('the Chat Completions stream', () => {
  it('collects the content deltas (an event may be cut anywhere) and ends on the finish_reason', async () => {
    const text = events([delta('{"seg'), delta('ments":[]}'), finish()]);
    const got: string[] = [];
    const r = await collectChatStream(sseStream(text, [3, 17, 40, 41]), (t) => got.push(t));
    expect(got.join('')).toBe('{"segments":[]}');
    expect(r).toEqual({ text: '{"segments":[]}', model: 'qwen3:8b', stopReason: 'stop' });
  });

  it('a reply cut by the output limit ends with its reason (the reply fix reads it as far as it goes)', async () => {
    const r = await collectChatStream(sseStream(events([delta('{"a'), finish('length')])), () => {});
    expect(r.stopReason).toBe('length');
  });

  it('a stream that ends without a finish_reason is a dropped line', async () => {
    await expect(collectChatStream(sseStream(events([delta('{"a')], false)), () => {})).rejects.toThrow('連線中斷');
  });

  it('an error inside the stream is a LocalLlmError with the server text, and it counts as a server failure', async () => {
    const e = await collectChatStream(sseStream(events([{ error: { message: 'model ran out of memory' } }])), () => {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LocalLlmError);
    expect((e as Error).message).toContain('model ran out of memory');
    expect(fallbackWorthy(e)).toBe(true);
  });

  it('the thinking in a separate field is never read; a leading <think> block in the text is dropped', async () => {
    const thinking = { choices: [{ delta: { reasoning_content: '想一想', reasoning: '想一想' }, finish_reason: null }] };
    const got: string[] = [];
    const r = await collectChatStream(sseStream(events([thinking, delta(' <thi'), delta('nk>嗯…</th'), delta('ink>\n{"x":1}'), finish()])), (t) => got.push(t));
    expect(r.text).toBe('{"x":1}');
    expect(got.join('')).toBe('{"x":1}');
  });
});

describe('thinkFilter', () => {
  it('passes a reply that does not open with <think> at once, and holds back only what could still be the tag', () => {
    const out: string[] = [];
    const f = thinkFilter((t) => out.push(t));
    f.push('<');
    expect(out).toEqual([]);
    f.push('b>hi');
    expect(out).toEqual(['<b>hi']);
    f.push('!');
    expect(out).toEqual(['<b>hi', '!']);
  });

  it('a short reply that only looked like the tag is sent at the end', () => {
    const out: string[] = [];
    const f = thinkFilter((t) => out.push(t));
    f.push('<th');
    f.end();
    expect(out).toEqual(['<th']);
  });
});

describe('localProvider', () => {
  it('streams the chat reply from /chat/completions; it writes the readings itself and costs nothing', async () => {
    const { transport, sent } = transportWith(events([delta('{"tone":'), delta('"happy"}'), finish()]));
    const p = localProvider(transport);
    expect(p.id).toBe('local');
    expect(p.serverReadings).toBe(true);
    const got: string[] = [];
    const s = p.streamChat(chatRequest(sample, 'qwen3:8b', { serverReadings: true }), (t) => got.push(t));
    const r = await s.done;
    expect(r.text).toBe('{"tone":"happy"}');
    expect(got).toEqual(['{"tone":', '"happy"}']);
    expect(s.usageSoFar()).toBeUndefined();
    expect(sent[0].path).toBe('/chat/completions');
  });

  it('an HTTP error is a LocalLlmError with a Chinese message, the status and the server text; 404 moves on to the next service', async () => {
    const { transport } = transportWith(() => new Response(JSON.stringify({ error: { message: 'model "x" not found, try pulling it first' } }), { status: 404 }));
    const e = await localProvider(transport).complete({ model: 'x', max_tokens: 5, system: 's', messages: [{ role: 'user', content: 'q' }] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LocalLlmError);
    expect((e as LocalLlmError).status).toBe(404);
    expect((e as Error).message).toContain('找不到這個模型');
    expect((e as Error).message).toContain('try pulling it first');
    expect(fallbackWorthy(e)).toBe(true);
    expect(describeLocalError(e)).toEqual({ status: 502, message: (e as Error).message });
  });

  it('a server that is not running (fetch fails) moves on, and says to start Ollama or LM Studio', async () => {
    const transport: LocalTransport = async () => { throw new TypeError('fetch failed'); };
    const e = await localProvider(transport).complete({ model: 'm', max_tokens: 5, system: '', messages: [{ role: 'user', content: 'q' }] }).catch((x: unknown) => x);
    expect(fallbackWorthy(e)).toBe(true);
    expect(describeLocalError(e).message).toContain('Ollama');
  });

  it('a one-shot request gets at least LOCAL_MIN_TIMEOUT_MS; the chat stream LOCAL_STREAM_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    try {
      // a server that never answers until the request is aborted
      const transport: LocalTransport = (_p, init) => new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
      const p = localProvider(transport);
      const one = p.complete({ model: 'm', max_tokens: 5, system: '', messages: [{ role: 'user', content: 'q' }] }, { timeout: 10_000 }).catch((x: unknown) => x);
      await vi.advanceTimersByTimeAsync(10_000);
      let settled = false;
      void one.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(LOCAL_MIN_TIMEOUT_MS - 10_000);
      const e = await one;
      expect((e as LocalLlmError).timeout).toBe(true);
      expect(describeLocalError(e).status).toBe(504);
      expect(fallbackWorthy(e)).toBe(true);

      const stream = p.streamChat(chatRequest(sample, 'm'), () => {});
      const late = stream.done.catch((x: unknown) => x);
      await vi.advanceTimersByTimeAsync(LOCAL_STREAM_TIMEOUT_MS);
      expect(((await late) as LocalLlmError).timeout).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the caller’s abort is not a timeout and does not move on', async () => {
    const transport: LocalTransport = (_p, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const s = localProvider(transport).streamChat(chatRequest(sample, 'm'), () => {});
    s.abort();
    const e = await s.done.catch((x: unknown) => x);
    expect((e as Error).name).toBe('AbortError');
    expect(fallbackWorthy(e)).toBe(false);
  });

  it('a server that refuses json_schema (llama-cpp-python) is asked again with json_object and a schema, remembered by its address', async () => {
    clearSchemaStyles();
    // llama-cpp-python's answer to a json_schema response_format (status 500, a pydantic validation message)
    const refusal = JSON.stringify({ error: { message: "1 validation error: {'loc': ('body', 'response_format', 'type'), 'msg': \"Input should be 'text' or 'json_object'\", 'input': 'json_schema'}" } });
    const sent: Record<string, unknown>[] = [];
    const transport: LocalTransport = async (_p, init) => {
      const body = JSON.parse(init.body) as { response_format?: { type?: string } };
      sent.push(body);
      if (body.response_format?.type === 'json_schema') return new Response(refusal, { status: 500 });
      return new Response(sseStream(events([delta('{"ok":true,"feedback":"好"}'), finish()])), { status: 200 });
    };
    const req = { model: 'm', max_tokens: 5, system: 's', messages: [{ role: 'user' as const, content: 'q' }], output_config: { format: { type: 'json_schema' as const, schema: { type: 'object' } } }, schemaName: 'mugi_judge' };
    const r = await localProvider(transport, { key: 'http://h/v1' }).complete(req);
    expect(r.text).toBe('{"ok":true,"feedback":"好"}');
    expect(sent.map((b) => (b.response_format as { type: string }).type)).toEqual(['json_schema', 'json_object']);
    expect(sent[1].response_format).toEqual({ type: 'json_object', schema: { type: 'object' } });
    // the same address is sent json_object at once from then on
    await localProvider(transport, { key: 'http://h/v1' }).complete(req);
    expect(sent.map((b) => (b.response_format as { type: string }).type)).toEqual(['json_schema', 'json_object', 'json_object']);
  });

  it('an error that is not about the response format is not retried', async () => {
    clearSchemaStyles();
    const transport = vi.fn<LocalTransport>(async () => new Response('{"error":"out of memory"}', { status: 500 }));
    const req = { model: 'm', max_tokens: 5, system: 's', messages: [{ role: 'user' as const, content: 'q' }], output_config: { format: { type: 'json_schema' as const, schema: {} } } };
    const e = await localProvider(transport, { key: 'k' }).complete(req).catch((x: unknown) => x);
    expect((e as LocalLlmError).status).toBe(500);
    expect((e as Error).message).toContain('out of memory');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('errorDetail reads the error text of the usual bodies and cuts it short', () => {
    expect(errorDetail('{"error":"boom"}')).toBe('boom');
    expect(errorDetail('{"error":{"message":"bad schema"}}')).toBe('bad schema');
    expect(errorDetail('{"message":"m"}')).toBe('m');
    expect(errorDetail('plain\n text')).toBe('plain text');
    expect(errorDetail('x'.repeat(500))).toHaveLength(200);
  });
});

describe('the local settings', () => {
  it('LOCAL_LLM_URL: empty is Ollama on this PC; an http(s) address loses its trailing slash; anything else is refused', () => {
    expect(parseLocalUrl(undefined)).toBe(LOCAL_LLM_URL_DEFAULT);
    expect(parseLocalUrl('  ')).toBe(LOCAL_LLM_URL_DEFAULT);
    expect(parseLocalUrl('http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234/v1');
    expect(parseLocalUrl('https://gpu-box.local/v1')).toBe('https://gpu-box.local/v1');
    expect(parseLocalUrl('http://[::1]:8080/v1')).toBe('http://[::1]:8080/v1');
    for (const bad of ['ftp://x/v1', 'file:///etc/passwd', 'not a url', 'http://user:pw@host/v1', 'http://h/v1?x=1', 'http://h/v1#f']) {
      expect(parseLocalUrl(bad)).toBeNull();
    }
    expect(localConfigFrom({ LOCAL_LLM_MODEL: ' qwen3:8b ', LOCAL_LLM_API_KEY: 'k' })).toEqual({ url: LOCAL_LLM_URL_DEFAULT, model: 'qwen3:8b', apiKey: 'k' });
  });

  it('the default model is the first listed one that is not an embedding model', () => {
    expect(defaultLocalModel(['nomic-embed-text:latest', 'gemma3:12b', 'qwen3:8b'])).toBe('gemma3:12b');
    expect(defaultLocalModel(['bge-embed'])).toBe('');
    expect(modelIds({ data: [{ id: 'a' }, { id: '' }, { x: 1 }, { id: 'b' }] })).toEqual(['a', 'b']);
    expect(modelIds(null)).toEqual([]);
  });

  it('the model list is asked for with the key and reused for a while', async () => {
    clearLocalModelsCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }), { status: 200 }));
    const cfg = { url: 'http://127.0.0.1:11434/v1', model: '', apiKey: 'secret-key' };
    expect(await listLocalModels(cfg, { fetchImpl, now: 1000 })).toEqual(['qwen3:8b']);
    expect(await listLocalModels(cfg, { fetchImpl, now: 2000 })).toEqual(['qwen3:8b']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
    await listLocalModels(cfg, { fetchImpl, now: 2000, fresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('the status: connected with its model; not running; no model; a model that is not listed; a bad address', async () => {
    const list = (ids: string[]) => vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 }));
    const base = { url: 'http://127.0.0.1:11434/v1', model: '', apiKey: '' };
    expect(await localStatus(base, list(['qwen3:8b', 'gemma3:4b']))).toEqual({ ok: true, url: base.url, model: 'qwen3:8b', models: ['qwen3:8b', 'gemma3:4b'] });
    const down = await localStatus(base, vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(down.ok).toBe(false);
    expect(down.message).toContain('連不上');
    const empty = await localStatus(base, list([]));
    expect(empty).toMatchObject({ ok: false, model: '' });
    expect(empty.message).toContain('還沒有模型');
    expect(await localStatus({ ...base, model: 'qwen3' }, list(['qwen3:latest']))).toEqual({ ok: true, url: base.url, model: 'qwen3', models: ['qwen3:latest'] });
    const other = await localStatus({ ...base, model: 'llama9' }, list(['qwen3:8b']));
    expect(other).toMatchObject({ ok: true, model: 'llama9' });
    expect(other.message).toContain('清單裡沒有');
    expect(await localStatus({ ...base, url: null })).toEqual({ ok: false, url: '', model: '', models: [], message: LOCAL_URL_MESSAGE });
    // the key is never part of a status
    expect(JSON.stringify(await localStatus({ ...base, apiKey: 'secret-key' }, list(['m'])))).not.toContain('secret-key');
  });

  it('the settings sheet may write the address and the model (checked), and shows them in full', () => {
    expect(keyUpdatesFrom({ localUrl: 'http://127.0.0.1:1234/v1', localModel: null })).toEqual({ LOCAL_LLM_URL: 'http://127.0.0.1:1234/v1', LOCAL_LLM_MODEL: null });
    expect(cleanValue('LOCAL_LLM_URL', ' http://192.168.1.20:11434/v1 ')).toBe('http://192.168.1.20:11434/v1');
    expect(cleanValue('LOCAL_LLM_MODEL', 'hf.co/user/Model-GGUF:Q4_K_M')).toBe('hf.co/user/Model-GGUF:Q4_K_M');
    for (const bad of ['http://a b', 'http://h/v1?x', 'http://u:p@h', 'javascript:alert(1)', 'http://h/"x"', 'http://h/#x']) {
      expect(() => cleanValue('LOCAL_LLM_URL', bad)).toThrow(/網址/);
    }
    for (const bad of ['qwen 3', 'a=b', 'x#y', '"q"']) expect(() => cleanValue('LOCAL_LLM_MODEL', bad)).toThrow(/模型名稱/);
    const s = keysStatus('LOCAL_LLM_URL=http://127.0.0.1:1234/v1\nLOCAL_LLM_MODEL=qwen3:8b\n');
    expect(s.localUrl).toEqual({ set: true, value: 'http://127.0.0.1:1234/v1' });
    expect(s.localModel).toEqual({ set: true, value: 'qwen3:8b' });
    expect(keysStatus('').localUrl).toEqual({ set: false });
  });
});

describe('servicesFor with the local model', () => {
  let dir: string;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mugi-tutor-local-'));
    delete process.env.ANTHROPIC_API_KEY;
    clearLocalModelsCache();
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    rmSync(dir, { recursive: true, force: true });
  });
  const ask = (providers: ('anthropic' | 'openai' | 'local')[], local: { url: string | null; model: string; apiKey: string }, localFetch?: typeof fetch) =>
    servicesFor({ providers }, { root: dir, mode: 'development', chatgpt: null, local, localFetch });

  it('the named model is used without asking the server; it costs nothing and holds no budget', async () => {
    const localFetch = vi.fn(async () => { throw new Error('not called'); });
    const r = await ask(['local'], { url: LOCAL_LLM_URL_DEFAULT, model: 'qwen3:8b', apiKey: '' }, localFetch as unknown as typeof fetch);
    expect(r.services.map((s) => [s.id, s.model, s.spend, s.hold])).toEqual([['local', 'qwen3:8b', false, undefined]]);
    expect(r.services[0].provider.serverReadings).toBe(true);
    expect(localFetch).not.toHaveBeenCalled();
  });

  it('without a model name the first chat model the server lists is used; a server that is down is left out', async () => {
    const listing = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'nomic-embed-text' }, { id: 'gemma3:12b' }] }), { status: 200 }));
    const r = await ask(['local'], { url: LOCAL_LLM_URL_DEFAULT, model: '', apiKey: '' }, listing as unknown as typeof fetch);
    expect(r.services[0].model).toBe('gemma3:12b');
    clearLocalModelsCache();
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-used';
    const down = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r2 = await ask(['local', 'anthropic'], { url: LOCAL_LLM_URL_DEFAULT, model: '', apiKey: '' }, down as unknown as typeof fetch);
    warn.mockRestore();
    expect(r2.services.map((s) => s.id)).toEqual(['anthropic']);
  });

  it('a bad address leaves the local model out', async () => {
    expect((await ask(['local'], { url: null, model: 'm', apiKey: '' })).services).toEqual([]);
  });

  it('the local request goes to the address in the settings, with the key', async () => {
    const localFetch = vi.fn(async () => new Response(sseStream(events([delta('{}'), finish()])), { status: 200 }));
    const r = await ask(['local'], { url: 'http://10.0.0.5:8080/v1', model: 'm', apiKey: 'k' }, localFetch as unknown as typeof fetch);
    await r.services[0].provider.complete({ model: 'm', max_tokens: 5, system: '', messages: [{ role: 'user', content: 'q' }] });
    const [url, init] = localFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://10.0.0.5:8080/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });
});

describe('the server writes the readings for a local model', () => {
  const localSvc = (answer: string): { svc: Service; sent: { body: Record<string, unknown> }[] } => {
    const { transport, sent } = transportWith(answer);
    return { svc: { id: 'local', model: 'm', provider: localProvider(transport), spend: false }, sent };
  };

  it('the chat reply reaches finish with the model’s own readings removed', async () => {
    const reply = '{"segments":[{"lang":"ja","text":"学校[がく]に行[い]こう","gloss":"去學校吧"}],"tip":"","tone":"happy"}';
    const { svc } = localSvc(events([delta(reply), finish()]));
    const finished: string[] = [];
    const io: ReplyIo = {
      send: () => {}, gone: () => false, track: () => {}, spendEnded: () => {}, spendDone: () => {},
      finish: async (_s, final) => { finished.push(final.text); }, failed: () => {},
    };
    await streamReply([svc], sample, io);
    expect(finished).toEqual(['{"segments":[{"lang":"ja","text":"学校に行こう","gloss":"去學校吧"}],"tip":"","tone":"happy"}']);
  });

  it('the lookup asks for no readings and removes any the model wrote before the analyser adds them', async () => {
    const answer = { items: [{ ja: '<ja>学校[がく]</ja>', zh: '學校', level: 'N5', note: '' }], grammar: [], examples: [], message: '' };
    const { svc, sent } = localSvc(events([delta(JSON.stringify(answer)), finish()]));
    const r = await lookupAnswerWith(svc.provider, '學校', undefined, 'm');
    const messages = sent[0].body.messages as { content: string }[];
    expect(messages[0].content).toBe(LOOKUP_SYSTEM_PLAIN);
    expect(sent[0].body.response_format).toMatchObject({ json_schema: { schema: LOOKUP_SCHEMA } });
    expect(r.answer?.items[0].ja).not.toContain('[がく]');
  });

  it('the tip rewrite gets the tip without readings and the prompt that asks for none', async () => {
    const { svc, sent } = localSvc(events([delta('{"tip":"要用 <ja>学校[がく]に</ja> 喔"}'), finish()]));
    const r = await rewriteTipWith(svc.provider, '<ja>学校[がっこう]に</ja>行きます', undefined, 'm');
    const messages = sent[0].body.messages as { content: string }[];
    expect(messages[0].content).toBe(TIP_FIX_SYSTEM_PLAIN);
    expect(messages[1].content).toBe('<ja>学校に</ja>行きます');
    expect(r ?? '').not.toContain('[がく]');
  });
});

describe('the client side', () => {
  it('a request may list all three services; the local model counts as ready only when it answers', () => {
    expect(PROVIDERS_MAX).toBe(3);
    expect(parseProviderList(['local', 'anthropic', 'openai'])).toEqual(['local', 'anthropic', 'openai']);
    expect(parseProviderList(['local', 'local'])).toBeUndefined();
    expect(serviceReady(['local'], { anthropic: true, openai: true, local: false })).toBe(false);
    expect(serviceReady(['local'], { local: true })).toBe(true);
    expect(serviceReady(['anthropic', 'local'], { anthropic: false })).toBe(false);
  });

  it('the status is read defensively, and its line says what is wrong', () => {
    expect(readLocalStatus({ ok: true, url: 'u', model: 'm', models: ['m', 3, ''] })).toEqual({ ok: true, url: 'u', model: 'm', models: ['m'] });
    expect(readLocalStatus('nonsense')).toEqual({ ok: false, url: '', model: '', models: [] });
    expect(localStatusText(null)).toBe('讀取中…');
    expect(localStatusText({ ok: true, url: 'u', model: 'qwen3:8b', models: [] })).toBe('已連線（qwen3:8b）');
    expect(localStatusText({ ok: false, url: 'u', model: '', models: [], message: '連不上' })).toBe('連不上');
  });
});

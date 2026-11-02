// The local model service (設定 › AI 服務 › 本地模型): where the OpenAI-compatible server is (LOCAL_LLM_URL; default Ollama's
// address on this PC), which model to use (LOCAL_LLM_MODEL; default the first chat model the server lists) and an optional key
// (LOCAL_LLM_API_KEY, for a server started with one). They are read per request from .env.local, like the Claude key, so a
// change needs no restart.
//   GET /api/local/status → { ok, url, model, models, message? }  whether the server answers, the model in use and the list
// The status never carries the key. The address and the model names are not secret: a phone sees them too.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv } from 'vite';
import { LOCAL_LLM_URL_DEFAULT } from '../../src/game/claudeProtocol.ts';
import { localProvider, type LocalTransport } from './localProvider.ts';
import type { LlmProvider } from './provider.ts';

/** how long the model list may take (the status and the first request without a model name wait for it) */
export const LOCAL_MODELS_TIMEOUT_MS = 2_000;
/** a model list is reused this long, so a chat turn does not ask for it every time */
export const LOCAL_MODELS_CACHE_MS = 15_000;

/** url: null when LOCAL_LLM_URL is set but is not an http(s) address; model: '' = the first chat model the server lists */
export type LocalConfig = { url: string | null; model: string; apiKey: string };

export const LOCAL_URL_MESSAGE = 'LOCAL_LLM_URL 的格式不對，要像 http://127.0.0.1:11434/v1';

/**
 * LOCAL_LLM_URL as it is used: empty → the default (Ollama on this PC); an http or https address with a host, no user name or
 * password, no query and no fragment → the address without its trailing '/'; anything else → null.
 */
export function parseLocalUrl(raw: string | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return LOCAL_LLM_URL_DEFAULT;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

/** the local settings from an environment (the values of .env.local and the process) */
export function localConfigFrom(env: Record<string, string | undefined>): LocalConfig {
  return {
    url: parseLocalUrl(env.LOCAL_LLM_URL),
    model: (env.LOCAL_LLM_MODEL ?? '').trim(),
    apiKey: (env.LOCAL_LLM_API_KEY ?? '').trim(),
  };
}

/** the local settings, read now from .env.local (or the process environment) */
export function readLocalConfig(root: string, mode: string): LocalConfig {
  return localConfigFrom(loadEnv(mode, root, ''));
}

type Fetch = typeof fetch;

/** the headers of a request to the local server: the key only when one is set */
function headersOf(cfg: LocalConfig, json: boolean): Record<string, string> {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
  };
}

/** the transport of the local provider: a POST to the address in the settings */
export function localTransport(cfg: LocalConfig & { url: string }, fetchImpl: Fetch = fetch): LocalTransport {
  return (path, init) => fetchImpl(`${cfg.url}${path}`, { method: 'POST', headers: headersOf(cfg, true), body: init.body, signal: init.signal });
}

/** the provider of the local service, for settings whose address is valid */
export function localService(cfg: LocalConfig & { url: string }, fetchImpl: Fetch = fetch): LlmProvider {
  return localProvider(localTransport(cfg, fetchImpl), { key: cfg.url });
}

/** a model that only makes embeddings (for search), not replies: never picked by default */
const EMBEDDING = /embed/i;

/** the model used when LOCAL_LLM_MODEL is not set: the first listed one that is not an embedding model; '' when none */
export function defaultLocalModel(models: readonly string[]): string {
  return models.find((m) => !EMBEDDING.test(m)) ?? '';
}

/** the ids of a /models answer ({ data: [{ id }] }, the OpenAI shape every compatible server uses) */
export function modelIds(j: unknown): string[] {
  const data = j && typeof j === 'object' ? (j as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  return data.flatMap((m) => {
    const id = m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined;
    return typeof id === 'string' && id ? [id] : [];
  });
}

let modelsCache: { key: string; at: number; models: string[] } | null = null;

/** forgets the cached model list (the tests, and the status, which always asks again) */
export function clearLocalModelsCache(): void {
  modelsCache = null;
}

/**
 * The models the local server lists (GET <url>/models), reused for LOCAL_MODELS_CACHE_MS. Throws when the server does not
 * answer in LOCAL_MODELS_TIMEOUT_MS or answers with an error: the message says which.
 */
export async function listLocalModels(
  cfg: LocalConfig & { url: string }, opts: { fetchImpl?: Fetch; now?: number; fresh?: boolean } = {},
): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const key = `${cfg.url}\n${cfg.apiKey}`;
  if (!opts.fresh && modelsCache && modelsCache.key === key && now - modelsCache.at < LOCAL_MODELS_CACHE_MS) return modelsCache.models;
  const res = await (opts.fetchImpl ?? fetch)(`${cfg.url}/models`, {
    headers: headersOf(cfg, false), signal: AbortSignal.timeout(LOCAL_MODELS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`本地模型服務回應錯誤（${res.status}）`);
  const models = modelIds(await res.json());
  modelsCache = { key, at: now, models };
  return models;
}

/**
 * The model of a request: LOCAL_LLM_MODEL when it is set, else the default of the server's list. '' when the server has none
 * or cannot be asked (the reason is logged): the local service is then left out of that request.
 */
export async function localModelFor(cfg: LocalConfig & { url: string }, fetchImpl?: Fetch): Promise<string> {
  if (cfg.model) return cfg.model;
  try {
    return defaultLocalModel(await listLocalModels(cfg, { fetchImpl }));
  } catch (e) {
    console.warn('[local] model list:', e instanceof Error ? e.message : e);
    return '';
  }
}

export type LocalStatus = {
  /** the server answers and there is a model to use */
  ok: boolean;
  /** the address in use ('' when LOCAL_LLM_URL is not valid) */
  url: string;
  /** the model a request will use ('' when none) */
  model: string;
  /** the models the server lists */
  models: string[];
  /** why it is not ready, or a warning (the model in the settings is not in the list) */
  message?: string;
};

/** the same model name, allowing for Ollama's ':latest' (qwen3 is qwen3:latest) */
function sameModel(a: string, b: string): boolean {
  const base = (m: string) => m.replace(/:latest$/, '');
  return base(a) === base(b);
}

/** the status of the local service now: the model list is always asked for again */
export async function localStatus(cfg: LocalConfig, fetchImpl?: Fetch): Promise<LocalStatus> {
  if (!cfg.url) return { ok: false, url: '', model: cfg.model, models: [], message: LOCAL_URL_MESSAGE };
  const url = cfg.url;
  let models: string[];
  try {
    models = await listLocalModels({ ...cfg, url }, { fetchImpl, fresh: true });
  } catch {
    return {
      ok: false, url, model: cfg.model, models: [],
      message: `連不上本地模型服務（${url}），請確認電腦上的 Ollama 或 LM Studio 有在執行`,
    };
  }
  const model = cfg.model || defaultLocalModel(models);
  if (!model) return { ok: false, url, model: '', models, message: '本地模型服務裡還沒有模型，請先下載一個（例如 ollama pull 模型名稱）' };
  if (cfg.model && models.length && !models.some((m) => sameModel(m, cfg.model))) {
    return { ok: true, url, model, models, message: `清單裡沒有「${cfg.model}」，仍會用這個名稱送出；如果回覆失敗，請確認模型名稱` };
  }
  return { ok: true, url, model, models };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** the /api/local routes (already through the API guard). Returns false when the path is not one of them. */
export async function handleLocalApi(req: IncomingMessage, res: ServerResponse, root: string, mode: string): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
  if (req.method === 'GET' && path === '/status') {
    json(res, 200, await localStatus(readLocalConfig(root, mode)));
    return true;
  }
  return false;
}

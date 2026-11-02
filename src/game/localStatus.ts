import { apiFetch } from './apiFetch';
// 本地模型 on the phone and in the settings: whether the local model server on the PC answers (GET /api/local/status, see
// server/llm/localService.ts), the model in use and the models it lists. The address and the model are set on the PC.

export type LocalStatus = {
  /** the server answers and there is a model to use */
  ok: boolean;
  /** the address in use ('' when the setting is not valid) */
  url: string;
  /** the model a request will use ('' when none) */
  model: string;
  /** the models the server lists */
  models: string[];
  /** why it is not ready, or a warning */
  message?: string;
};

/** the last status read: the Claude brain's availability check uses it, so a reply costs no extra request */
let lastStatus: LocalStatus | null = null;

/** the status as the server sent it (defensive: anything unexpected is a server that does not answer) */
export function readLocalStatus(j: unknown): LocalStatus {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  const models = Array.isArray(o.models) ? (o.models as unknown[]).filter((m): m is string => typeof m === 'string' && !!m) : [];
  return {
    ok: o.ok === true,
    url: typeof o.url === 'string' ? o.url : '',
    model: typeof o.model === 'string' ? o.model : '',
    models,
    ...(typeof o.message === 'string' && o.message ? { message: o.message } : {}),
  };
}

/** the status now; null when the server cannot be asked (the caller keeps what it has) */
export async function fetchLocalStatus(): Promise<LocalStatus | null> {
  try {
    const r = await apiFetch('/api/local/status');
    if (!r.ok) return null;
    lastStatus = readLocalStatus(await r.json());
    return lastStatus;
  } catch {
    return null;
  }
}

/** whether the local model can answer now; the status is read when none was read yet */
export async function localReady(): Promise<boolean> {
  const s = lastStatus ?? (await fetchLocalStatus());
  return !!s && s.ok;
}

/** the status line of the 本地模型 row: 讀取中…, 已連線（model）, or why it is not ready */
export function localStatusText(s: LocalStatus | null): string {
  if (s === null) return '讀取中…';
  if (!s.ok) return s.message ?? '連不上本地模型';
  return `已連線（${s.model}）`;
}

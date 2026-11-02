import { apiFetch } from './apiFetch';
// The settings sheet's calls to the dev server's /api/settings routes (server/settingsRoutes.ts): the keys in .env.local
// (only the last four characters ever come back) and the daily budget (MUGI_DAILY_USD). Every call fails softly: a null or a
// { ok: false, message } the sheet can show, never a throw.

/** what is set for one key: last4 only when the value is longer than 4 characters; a region and the local model settings show their value in full */
export type FieldStatus = { set: boolean; last4?: string; value?: string };
export type KeysStatus = {
  anthropicKey: FieldStatus;
  anthropicWorkspace: FieldStatus;
  googleKey: FieldStatus;
  azureKey: FieldStatus;
  azureRegion: FieldStatus;
  localUrl: FieldStatus;
  localModel: FieldStatus;
};
/** the body names of POST /api/settings/keys */
export type KeyName = keyof KeysStatus;
export type BudgetStatus = { usd: number; spentTodayUsd: number };

const UNSET: FieldStatus = { set: false };

/** a field status from the server's JSON (defensive: anything unexpected is "not set") */
function readField(j: unknown): FieldStatus {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  if (o.set !== true) return UNSET;
  return {
    set: true,
    ...(typeof o.last4 === 'string' ? { last4: o.last4 } : {}),
    ...(typeof o.value === 'string' ? { value: o.value } : {}),
  };
}

/** the keys status as the server sent it */
export function readKeysStatus(j: unknown): KeysStatus {
  const s = (j && typeof j === 'object' && (j as { status?: unknown }).status && typeof (j as { status?: unknown }).status === 'object'
    ? (j as { status: Record<string, unknown> }).status
    : {}) as Record<string, unknown>;
  return {
    anthropicKey: readField(s.anthropicKey),
    anthropicWorkspace: readField(s.anthropicWorkspace),
    googleKey: readField(s.googleKey),
    azureKey: readField(s.azureKey),
    azureRegion: readField(s.azureRegion),
    localUrl: readField(s.localUrl),
    localModel: readField(s.localModel),
  };
}

/** the message of a failed answer from the server (its own message), or the fallback */
async function messageOf(r: Response, fallback: string): Promise<string> {
  try {
    const j = (await r.json()) as { message?: unknown };
    if (typeof j.message === 'string' && j.message) return j.message;
  } catch { /* not JSON */ }
  return fallback;
}

const NO_SERVER = '連不上伺服器，請確認電腦上的 App 有在執行。';

/** the keys status now; null when the server cannot be asked */
export async function fetchKeysStatus(): Promise<KeysStatus | null> {
  try {
    const r = await apiFetch('/api/settings/keys');
    if (!r.ok) return null;
    return readKeysStatus(await r.json());
  } catch {
    return null;
  }
}

/** sets (a string) or clears (null) the given keys; the new status on success, else the message to show */
export async function saveKeys(patch: Partial<Record<KeyName, string | null>>): Promise<{ ok: true; status: KeysStatus } | { ok: false; message: string }> {
  try {
    const r = await apiFetch('/api/settings/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (!r.ok) return { ok: false, message: await messageOf(r, '金鑰無法儲存，請稍後再試。') };
    return { ok: true, status: readKeysStatus(await r.json()) };
  } catch {
    return { ok: false, message: NO_SERVER };
  }
}

/** the budget and today's estimated spending now; null when the server cannot be asked */
export async function fetchBudget(): Promise<BudgetStatus | null> {
  try {
    const r = await apiFetch('/api/settings/budget');
    if (!r.ok) return null;
    const j = (await r.json()) as { usd?: unknown; spentTodayUsd?: unknown };
    if (typeof j.usd !== 'number' || typeof j.spentTodayUsd !== 'number') return null;
    return { usd: j.usd, spentTodayUsd: j.spentTodayUsd };
  } catch {
    return null;
  }
}

/** sets the daily budget (USD, 0 to 100, two decimals at most); the stored budget on success, else the message */
export async function saveBudget(usd: number): Promise<{ ok: true; budget: BudgetStatus } | { ok: false; message: string }> {
  try {
    const r = await apiFetch('/api/settings/budget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usd }) });
    if (!r.ok) return { ok: false, message: await messageOf(r, '預算無法儲存，請稍後再試。') };
    const j = (await r.json()) as { usd?: unknown; spentTodayUsd?: unknown };
    if (typeof j.usd !== 'number' || typeof j.spentTodayUsd !== 'number') return { ok: false, message: '預算無法儲存，請稍後再試。' };
    return { ok: true, budget: { usd: j.usd, spentTodayUsd: j.spentTodayUsd } };
  } catch {
    return { ok: false, message: NO_SERVER };
  }
}

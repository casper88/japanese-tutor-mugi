// The settings routes of the dev server (mounted by claudeChat.ts under /api/settings, behind guardApi):
//   GET  /api/settings/keys    → { status }   what is set: { set, last4? } per key; the region is shown in full
//   POST /api/settings/keys    body { anthropicKey?, anthropicWorkspace?, googleKey?, azureKey?, azureRegion?, localUrl?, localModel? }
//                              (a string sets it, null clears it, absent = unchanged) → { status }. Local only: this PC, not a phone.
//   GET  /api/settings/budget  → { usd, spentTodayUsd }
//   POST /api/settings/budget  body { usd } (0 to 100, at most two decimals) → { usd, spentTodayUsd }. A trusted request (settingsAccess.ts).
//                              0 means no daily cap, and only this PC may set it: a trusted request that is not local (a phone
//                              through Tailscale) gets 403 for 0; it may set 0.01 to 100.
// The GETs never show a full key: a status shows whether each one is set and its last four characters (a region, the local
// model's address and its model name in full: they are not secret).
// No response, error or log carries a key value: a status shows only the last four characters (none when the value is 4
// characters or fewer).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readEnvFile, readEnvValue, updateEnvFile, type AllowedKey } from './envFile.ts';
import { SETTINGS_REFUSED_MESSAGE, trustedForSettings } from './settingsAccess.ts';
import { browserHeadersRefusal, type GuardOptions } from './apiGuard.ts';
import { isLocalRequest } from './openai/routes.ts';

export const KEYS_LOCAL_ONLY_MESSAGE = '金鑰只能在電腦上設定';
export const BUDGET_ZERO_REMOTE_MESSAGE = '每日上限設為 0（不限）只能在電腦上操作';

export type KeyStatus = { set: boolean; last4?: string };
export type RegionStatus = { set: boolean; value?: string };
export type KeysStatus = {
  anthropicKey: KeyStatus;
  anthropicWorkspace: KeyStatus;
  googleKey: KeyStatus;
  azureKey: KeyStatus;
  azureRegion: RegionStatus;
  localUrl: RegionStatus;
  localModel: RegionStatus;
};

/** the body fields of POST /api/settings/keys, and the .env.local name each one sets */
const KEY_FIELDS = {
  anthropicKey: 'ANTHROPIC_API_KEY',
  anthropicWorkspace: 'ANTHROPIC_WORKSPACE_ID',
  googleKey: 'GOOGLE_TTS_API_KEY',
  azureKey: 'AZURE_SPEECH_KEY',
  azureRegion: 'AZURE_SPEECH_REGION',
  localUrl: 'LOCAL_LLM_URL',
  localModel: 'LOCAL_LLM_MODEL',
} as const satisfies Record<string, AllowedKey>;
export type KeyField = keyof typeof KEY_FIELDS;

export const BUDGET_MAX_USD = 100;
const BODY_MAX_BYTES = 8 * 1024;

/** a key's status from the file's text: set when the value is not empty; last4 only when the value is longer than 4 characters */
function keyStatus(content: string, key: AllowedKey): KeyStatus {
  const v = readEnvValue(content, key);
  if (!v) return { set: false };
  return v.length > 4 ? { set: true, last4: v.slice(-4) } : { set: true };
}

/** a setting that is shown in full (it is not secret) */
function plainStatus(content: string, key: AllowedKey): RegionStatus {
  const v = readEnvValue(content, key);
  return v ? { set: true, value: v } : { set: false };
}

/** the status of every key (the region and the local model settings in full, the rest as set + last four) */
export function keysStatus(content: string): KeysStatus {
  const region = readEnvValue(content, 'AZURE_SPEECH_REGION');
  return {
    anthropicKey: keyStatus(content, 'ANTHROPIC_API_KEY'),
    anthropicWorkspace: keyStatus(content, 'ANTHROPIC_WORKSPACE_ID'),
    googleKey: keyStatus(content, 'GOOGLE_TTS_API_KEY'),
    azureKey: keyStatus(content, 'AZURE_SPEECH_KEY'),
    azureRegion: region ? { set: true, value: region } : { set: false },
    localUrl: plainStatus(content, 'LOCAL_LLM_URL'),
    localModel: plainStatus(content, 'LOCAL_LLM_MODEL'),
  };
}

/** the body fields of a keys POST, as .env.local updates. Throws a Chinese message for a field of the wrong type. */
export function keyUpdatesFrom(body: Record<string, unknown>): Partial<Record<AllowedKey, string | null>> {
  const updates: Partial<Record<AllowedKey, string | null>> = {};
  for (const field of Object.keys(KEY_FIELDS) as KeyField[]) {
    if (!(field in body) || body[field] === undefined) continue;
    const v = body[field];
    if (v !== null && typeof v !== 'string') throw new Error('金鑰欄位的格式不對。');
    updates[KEY_FIELDS[field]] = v;
  }
  return updates;
}

/**
 * A budget in USD as the setting is written: a number from 0 to 100 with at most two decimals (BUDGET_MAX_USD). Throws a Chinese
 * message otherwise. The result is the number itself (2, 1.5, 0.25); formatUsd turns it into the file's text.
 */
export function parseBudget(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('請輸入數字。');
  if (v < 0 || v > BUDGET_MAX_USD) throw new Error(`預算要在 0 到 ${BUDGET_MAX_USD} 美元之間。`);
  if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-9) throw new Error('預算最多到小數點後兩位。');
  return Math.round(v * 100) / 100;
}

/** the MUGI_DAILY_USD text: no trailing zeros (2, 1.5, 0.25, 0) */
export const formatUsd = (usd: number): string => String(Number(usd.toFixed(2)));

export type SettingsDeps = {
  /** the .env.local to read and write */
  envPath: string;
  /** the guard options of this server (the allowed names), for the trusted rule */
  guard: GuardOptions;
  /** MUGI_DAILY_USD as the server reads it now (parseDailyUsd: 0 = no cap) */
  readUsd: () => number;
  /** the estimated Claude spending today, USD */
  spentTodayUsd: () => number;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** the request body as a JSON object; throws a Chinese message when it is too big or not an object */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += b.length;
    if (size > BODY_MAX_BYTES) throw new Error('請求太大。');
    chunks.push(b);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new Error('請求內容不是正確的 JSON。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('請求內容格式不對。');
  return parsed as Record<string, unknown>;
}

/** the message of a failed write or validation: our own Chinese text; the value is never part of it */
const failure = (e: unknown): string => (e instanceof Error && /[一-鿿]/.test(e.message) ? e.message : '設定無法儲存。');

/** the settings routes (already through the API guard). Returns false when the path is not one of them. */
export async function handleSettingsApi(req: IncomingMessage, res: ServerResponse, deps: SettingsDeps): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
  // defence in depth: the API guard checked these already; a route that is reached another way is checked again
  const browser = browserHeadersRefusal(req.headers);
  if (browser && !browser.ok) {
    json(res, browser.status, { error: 'forbidden', message: browser.message });
    return true;
  }
  const trusted = trustedForSettings(req, deps.guard);
  const refuse = () => json(res, 403, { error: 'forbidden', message: SETTINGS_REFUSED_MESSAGE });

  if (req.method === 'GET' && path === '/keys') {
    json(res, 200, { status: keysStatus(readEnvFile(deps.envPath)) });
    return true;
  }
  if (req.method === 'POST' && path === '/keys') {
    if (!isLocalRequest(req)) { json(res, 403, { error: 'forbidden', message: KEYS_LOCAL_ONLY_MESSAGE }); return true; }
    if (!trusted) { refuse(); return true; }
    let updates: Partial<Record<AllowedKey, string | null>>;
    try {
      updates = keyUpdatesFrom(await readJsonObject(req));
      updateEnvFile(deps.envPath, updates); // every value is checked before anything is written
    } catch (e) {
      json(res, 400, { error: 'bad_request', message: failure(e) });
      return true;
    }
    json(res, 200, { status: keysStatus(readEnvFile(deps.envPath)) });
    return true;
  }
  if (req.method === 'GET' && path === '/budget') {
    json(res, 200, { usd: deps.readUsd(), spentTodayUsd: deps.spentTodayUsd() });
    return true;
  }
  if (req.method === 'POST' && path === '/budget') {
    if (!trusted) { refuse(); return true; }
    let usd: number;
    try {
      usd = parseBudget((await readJsonObject(req)).usd);
    } catch (e) {
      json(res, 400, { error: 'bad_request', message: failure(e) });
      return true;
    }
    // 0 switches the cap off: only the PC may do that (a phone may set 0.01 to 100)
    if (usd === 0 && !isLocalRequest(req)) { json(res, 403, { error: 'forbidden', message: BUDGET_ZERO_REMOTE_MESSAGE }); return true; }
    try {
      updateEnvFile(deps.envPath, { MUGI_DAILY_USD: formatUsd(usd) });
    } catch (e) {
      json(res, 400, { error: 'bad_request', message: failure(e) });
      return true;
    }
    json(res, 200, { usd, spentTodayUsd: deps.spentTodayUsd() });
    return true;
  }
  return false;
}

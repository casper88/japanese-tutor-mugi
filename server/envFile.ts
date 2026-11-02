// Writes the keys, the local model settings and the daily budget into .env.local, from the settings sheet
// (server/settingsRoutes.ts). Only the names in ENV_KEYS can be written. Every other line of the file (comments, other keys, their order, the line endings) is kept as it
// is; a key that is already there is replaced in place, a missing one is appended, and null removes it. The file is written
// atomically (a temp file in the same folder, then rename) with mode 0600. A value is never logged and never put in an error.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_WORKSPACE_ID', 'GOOGLE_TTS_API_KEY', 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION', 'MUGI_DAILY_USD',
  'LOCAL_LLM_URL', 'LOCAL_LLM_MODEL',
] as const;
export type AllowedKey = (typeof ENV_KEYS)[number];
const ALLOWED = new Set<string>(ENV_KEYS);

/** the value of a key: letters, digits, '.', '_' and '-' only (no spaces, quotes, '=', '#' or control characters) */
export const VALUE_PATTERN = /^[A-Za-z0-9._-]{1,300}$/;
/** an Azure region name, for example eastasia */
export const REGION_PATTERN = /^[a-z0-9]{2,30}$/;
/**
 * the address of the local model server: http or https, a host name, an IPv4 or a bracketed IPv6 address, an optional port and
 * path. No user name, query, fragment, space or quote (server/llm/localService.ts parseLocalUrl checks it again when it is used).
 */
export const LOCAL_URL_PATTERN = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?(?:\/[A-Za-z0-9._~\/-]*)?$/;
/** a local model name, for example qwen3:8b or hf.co/user/model:Q4_K_M */
export const LOCAL_MODEL_PATTERN = /^[A-Za-z0-9._:\/@+-]{1,200}$/;

export const VALUE_MESSAGE = '金鑰只能包含英文字母、數字、「.」「_」「-」，長度 1 到 300 字，不能有空白、引號或「=」「#」。';
export const REGION_MESSAGE = '區域名稱只能是小寫英文字母與數字，例如 eastasia。';
export const LOCAL_URL_MESSAGE = '網址要像 http://127.0.0.1:11434/v1（http 或 https，不能有空白、引號、「?」「#」或帳號密碼）。';
export const LOCAL_MODEL_MESSAGE = '模型名稱只能包含英文字母、數字與「. _ - : / @ +」，長度 1 到 200 字。';
const NAME_MESSAGE = '這個設定不能用這個方式寫入。';
const WRITE_MESSAGE = '無法寫入 .env.local，請確認檔案沒有被其他程式鎖住。';
const LINK_MESSAGE = '.env.local 是捷徑，請改成一般檔案';

/** true when the path itself is a symbolic link (not followed); false when it does not exist */
function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}
const BOM = '﻿';

/** a value as it is written: trimmed and checked; throws a Chinese message that never contains the value */
export function cleanValue(key: AllowedKey, raw: string): string {
  const v = raw.trim();
  if (key === 'AZURE_SPEECH_REGION') {
    if (!REGION_PATTERN.test(v)) throw new Error(REGION_MESSAGE);
    return v;
  }
  if (key === 'LOCAL_LLM_URL') {
    if (v.length > 300 || !LOCAL_URL_PATTERN.test(v)) throw new Error(LOCAL_URL_MESSAGE);
    return v;
  }
  if (key === 'LOCAL_LLM_MODEL') {
    if (!LOCAL_MODEL_PATTERN.test(v)) throw new Error(LOCAL_MODEL_MESSAGE);
    return v;
  }
  if (!VALUE_PATTERN.test(v)) throw new Error(VALUE_MESSAGE);
  return v;
}

type Line = { text: string; eol: string };

/** the lines of a file, each with its own line ending ('' for a last line without one), so every byte survives a rewrite */
function splitLines(content: string): Line[] {
  const out: Line[] = [];
  const re = /\r?\n/g;
  let last = 0;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    out.push({ text: content.slice(last, m.index), eol: m[0] });
    last = m.index + m[0].length;
  }
  if (last < content.length) out.push({ text: content.slice(last), eol: '' });
  return out;
}

/** the text before a key's value on a line that sets it: `KEY=`, `KEY =`, `export KEY=` (spaces allowed around the =) */
const assignPrefix = (key: string): RegExp => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
/** true when a line sets this key (leading spaces and `export` are allowed; comments never match) */
const setsKey = (key: string, line: Line): boolean => assignPrefix(key).test(line.text);
/** a value with one pair of matching surrounding quotes ("…" or '…') without them, as the app's dotenv reading takes it */
const stripQuotes = (v: string): string =>
  v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) ? v.slice(1, -1) : v;

/**
 * The text of the file after the updates (pure). `updates` maps a key to its new value, null to remove it; a key that is absent
 * from `updates` is left alone. Throws for a name that is not allowed or a value that does not pass cleanValue.
 */
export function applyEnvUpdates(content: string, updates: Partial<Record<AllowedKey, string | null>>): string {
  const values = new Map<AllowedKey, string | null>();
  for (const [key, raw] of Object.entries(updates)) {
    if (raw === undefined) continue;
    if (!ALLOWED.has(key)) throw new Error(NAME_MESSAGE);
    values.set(key as AllowedKey, raw === null ? null : cleanValue(key as AllowedKey, raw));
  }

  const bom = content.startsWith(BOM) ? BOM : '';
  const body = bom ? content.slice(1) : content;
  // a new file gets Windows line endings (the working copies of this project use CRLF); an existing one keeps its own
  const eol = body.includes('\r\n') ? '\r\n' : body.includes('\n') ? '\n' : '\r\n';
  let lines = splitLines(body);

  for (const [key, value] of values) {
    if (value === null) {
      lines = lines.filter((l) => !setsKey(key, l));
      continue;
    }
    const present = lines.some((l) => setsKey(key, l));
    if (present) {
      // every line that sets the key gets the new value, so no duplicate can win over it
      lines = lines.map((l) => (setsKey(key, l) ? { text: `${key}=${value}`, eol: l.eol } : l));
    } else {
      const last = lines[lines.length - 1];
      if (last && last.eol === '') last.eol = eol;
      lines.push({ text: `${key}=${value}`, eol });
    }
  }
  return bom + lines.map((l) => l.text + l.eol).join('');
}

/**
 * Applies the updates to the file at `filePath` and writes it back atomically with mode 0600. A missing file is created (from
 * nothing: not from .env.example). Throws a Chinese message on a bad name or value, or when the file cannot be written.
 */
export function updateEnvFile(filePath: string, updates: Partial<Record<AllowedKey, string | null>>): void {
  // a symlink would make the rename replace the link, or write where the link points: refuse it, the owner must use a plain file
  if (isSymlink(filePath)) throw new Error(LINK_MESSAGE);
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const next = applyEnvUpdates(current, updates);
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch { /* the temp file may not exist */ }
    throw new Error(WRITE_MESSAGE);
  }
}

/** the value of a key in a file's text: the last line that sets it (as the app's dotenv reading does), '' when none */
export function readEnvValue(content: string, key: string): string {
  let value = '';
  for (const line of splitLines(content.startsWith(BOM) ? content.slice(1) : content)) {
    if (setsKey(key, line)) value = stripQuotes(line.text.replace(assignPrefix(key), '').trim());
  }
  return value;
}

/** reads the whole file (or '' when it does not exist) */
export function readEnvFile(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

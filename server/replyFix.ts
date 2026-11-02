// Fixes to her chat reply, run on the server before it is sent as `done` (server/claudeChat.ts). The reply is the JSON
// object of CHAT_REPLY_SCHEMA (game/claudeProtocol.ts ChatReplyJson). Pure apart from the readings analyser: no network.
//   1. every segment's Japanese text, and the Japanese runs of the tip, get the kanji readings they lack (readings.ts);
//   2. a tip with Japanese prose outside <ja>: the Japanese runs are wrapped in <ja>…</ja>, so the readings step treats
//      them as Japanese and the tip keeps its Chinese. The tip is then rewritten in the background (tipRewrite; the client
//      calls /api/chat/fix-tip). A Japanese-only tip stays wrapped and is rewritten the same way;
//   3. a cut reply (the output limit) is read as far as it goes (game/replyJson.ts parsePartialJson) and written back in the
//      canonical form, so what is stored and sent back to Claude is always a complete, valid JSON object.
import { canonicalReplyJson, parsePartialJson, readReplyValue, toSegments } from '../src/game/replyJson.ts';
import type { ChatSegment } from '../src/game/claudeProtocol.ts';
import { fillReadings, loadAnalyzer, toHira } from './readings.ts';

const JA = /<ja>([\s\S]*?)<\/ja>/g;
const KANA = /[\u3040-\u30ff\uff66-\uff9d]/;
const HAN = /\p{Script=Han}/gu;
/**
 * A run of Japanese, wrapped in <ja>: kana with the kanji among them. It starts at kana, or at a kanji word of 1 to 4
 * characters that stands at the start of a word (after the start of the text, a space, or an opening quote or bracket)
 * and is followed directly by kana (学校に). It ends at kana, or at the Japanese punctuation that follows kana (行きました、).
 * Chinese stays outside: a Han character with no kana after it is never part of the run (要用に: only に is wrapped), and a
 * longer Chinese phrase (去哪裡要用に) is not taken for a kanji word.
 */
const JA_RUN = /(?:(?<=^|[\s「『（(［\[“"'])[\p{Script=Han}々〆ヶ]{1,4}(?=[\u3040-\u30ff\uff66-\uff9d]))?[\u3040-\u30ff\uff66-\uff9d](?:[\u3040-\u30ff\uff66-\uff9d\p{Script=Han}々〆ヶ]*[\u3040-\u30ff\uff66-\uff9d])?[、。！？…・]*/gu;

export type FixOptions = { log?: (msg: string) => void };

/** the text outside every <ja>…</ja>, after applying fn to each such piece */
function mapOutsideJa(text: string, fn: (s: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(JA)) {
    const at = m.index ?? 0;
    out += fn(text.slice(last, at)) + m[0];
    last = at + m[0].length;
  }
  return out + fn(text.slice(last));
}

/** Japanese outside <ja> is wrapped in <ja>…</ja> (kana runs with their kanji). */
export function wrapJapanese(tip: string): string {
  return mapOutsideJa(tip, (s) => s.replace(JA_RUN, (m) => `<ja>${m}</ja>`));
}

/** The tip has Japanese prose outside <ja> (kana that are not inside a <ja>…</ja>). */
export function hasJapaneseProse(tip: string): boolean {
  let outside = '';
  mapOutsideJa(tip, (s) => { outside += s; return s; });
  return KANA.test(outside);
}

/** A tip is Chinese when no kana is left outside <ja> and at least two Chinese characters are. */
export function isChineseTip(tip: string): boolean {
  let outside = '';
  mapOutsideJa(tip, (s) => { outside += s; return s; });
  return !KANA.test(outside) && (outside.match(HAN)?.length ?? 0) >= 2;
}

/** Chinese characters a Chinese explanation needs before quoted Japanese alone stops counting as "a Japanese tip" */
const CHINESE_PROSE_MIN = 6;

/**
 * The tip needs the background rewrite: it is Japanese prose, not a Chinese explanation that merely quotes Japanese in 「」
 * without <ja> (those are wrapped and shown as they are). After wrapping, a Chinese tip keeps its explanation outside <ja>.
 */
export function needsTipRewrite(tip: string): boolean {
  if (!hasJapaneseProse(tip)) return false;
  let outside = '';
  mapOutsideJa(wrapJapanese(tip), (s) => { outside += s; return s; });
  return KANA.test(outside) || (outside.match(HAN)?.length ?? 0) < CHINESE_PROSE_MIN;
}

export type FixedReply = { json: string; tipRewrite: boolean };

/** One piece of Japanese (a segment's text, or the tip's kana prose) with its kanji readings: readings.ts works on <ja> runs. */
async function withReadings(ja: string, log: (m: string) => void): Promise<string> {
  const out = await fillReadings(`<ja>${ja}</ja>`, log);
  return out.startsWith('<ja>') && out.endsWith('</ja>') ? out.slice(4, -5) : ja;
}

/**
 * Her reply as it is shown and stored: the segments' Japanese gets its readings, the tip is wrapped and read (see above),
 * and the result is the canonical JSON. tipRewrite: the tip has Japanese prose and is to be rewritten in the background.
 * Unreadable text (no JSON at all) comes back as an empty reply, which the client reports as "no reply".
 */
export async function fixReplyJson(raw: string, opts: FixOptions = {}): Promise<FixedReply> {
  const log = opts.log ?? (() => {});
  const value = parsePartialJson(raw);
  let strict = true;
  try { JSON.parse(raw); } catch { strict = false; }
  if (value === undefined) log(`[reply] no readable JSON in the reply (${raw.length} chars), sent empty`);
  else if (!strict) log(`[reply] reply cut or not valid JSON, the readable part is kept (${raw.length} chars)`);
  const fields = readReplyValue(value);
  const segments: ChatSegment[] = [];
  for (const s of toSegments(fields)) {
    const text = s.lang === 'ja' ? await withReadings(s.text, log) : s.text;
    segments.push({ lang: s.lang, text, gloss: s.gloss });
  }
  // the rewrite check reads the tip as the model wrote it (before wrapping)
  const written = fields.tip.trim();
  const tipRewrite = needsTipRewrite(written);
  const wrapped = wrapJapanese(written);
  if (wrapped !== written) log(`[tip] Japanese in the tip wrapped in <ja>: ${written.slice(0, 60)}`);
  const tip = wrapped ? await fillReadings(wrapped, log) : '';
  return { json: canonicalReplyJson({ segments, tip, tone: fields.tone }), tipRewrite };
}

/** the player's own words in his turn: the ［情境］［模式］ marks in front (claudeProtocol.userTurn) removed */
export function saidOf(turn: string): string {
  return turn.replace(/^(?:［[^］]*］)+/, '').trim();
}

/** punctuation and spaces, which never make a sentence wrong */
const NOT_WORDS = /[\s、。，,．.！!？?「」『』（）()…〜~・]/g;

/**
 * A line as it is compared: punctuation and spaces removed, then every word as its kana (so 寒かった and さむかった are the same
 * line). Without the analyser, the text without punctuation.
 */
export async function sayingOf(text: string): Promise<string> {
  const bare = text.replace(NOT_WORDS, '');
  try {
    const tk = await loadAnalyzer();
    return tk.tokenize(bare).map((t) => toHira(t.reading && t.reading !== '*' ? t.reading : t.surface_form)).join('');
  } catch {
    return bare;
  }
}

/** the length of the longest run of characters that `a` and `b` share in order (not necessarily side by side) */
function commonLength(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = [0];
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[y.length];
}

/**
 * How much a correction adds to the line it corrects, as a share of the line (compared as kana, see sayingOf). A real
 * correction changes an ending or a particle; a small model that answers in `corrected` instead adds a phrase of its own.
 * Measured on Qwen3 4B: real corrections added at most 0.29 (おいしいでした → おいしかったです); rewrites that were not
 * corrections added 0.44 and 0.50.
 */
export function addedShare(said: string, corrected: string): number {
  const n = [...said].length;
  return n ? ([...corrected].length - commonLength(said, corrected)) / n : 1;
}

/** above this added share, a correction is taken for a rewrite of the model's own and gives no tip */
export const CORRECTION_MAX_ADDED = 0.4;

/**
 * The tip of a small model's reply (smallModel), made from its `corrected`: the player's line written as correct Japanese (his
 * Chinese translated). The model writes no tip of its own: its explanations were wrong about half the time, while its corrected
 * line was right (Qwen3 8B: 8 of 8). So the tip shows the corrected line only:
 * - his Chinese → 「這句話的日文可以說 <ja>…</ja>」;
 * - his Japanese, when the correction says it differently (compared by the kana of its words, so a kanji written as kana is no
 *   change) and adds no more than a correction would (addedShare) → 「這句可以說成 <ja>…</ja>」;
 * - anything else (no correction, the same sentence, a rewrite of the model's own) → no tip.
 * A tip the model wrote anyway (a server that does not hold to the schema) is replaced. A reply that is not complete JSON is left
 * as it is. `said`: the player's words (saidOf).
 */
export async function tipFromCorrection(raw: string, said: string): Promise<string> {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return raw; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return raw;
  const o = j as Record<string, unknown>;
  return JSON.stringify({ ...o, tip: await correctionTip(typeof o.corrected === 'string' ? o.corrected : '', said) });
}

/** the tip of tipFromCorrection: the corrected line, or '' when it teaches nothing */
async function correctionTip(raw: string, said: string): Promise<string> {
  const corrected = raw.replace(/<\/?ja>/g, '').trim();
  if (!said || !KANA.test(corrected)) return '';
  // the Japanese keeps its own end mark (。！？); the tip adds 。 only after one that has none
  const line = `<ja>${corrected}</ja>${/[。！？!?]$/.test(corrected) ? '' : '。'}`;
  if (!KANA.test(said)) return `這句話的日文可以說 ${line}`;
  const before = await sayingOf(said);
  const after = await sayingOf(corrected);
  if (before === after || addedShare(before, after) > CORRECTION_MAX_ADDED) return '';
  return `這句可以說成 ${line}`;
}

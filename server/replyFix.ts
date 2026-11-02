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

/**
 * A small model's reply (smallModel) starts with `corrected`: the player's line written as correct Japanese (his Chinese
 * translated). Writing that is easier for a small model than spotting a mistake while it chats, and it shows what the model
 * found even when it then leaves the tip empty. So when the tip is empty, it is written from `corrected`: his Chinese →
 * 「這句話的日文可以說 <ja>…</ja>。」; his Japanese, when the correction says it differently (compared by the kana of its words,
 * so a kanji written as kana is no change) → 「這句可以說成 <ja>…</ja>。」. A tip the model wrote, no correction, the same
 * sentence, or a reply that is not complete JSON leaves the reply as it is. `said`: the player's words (saidOf).
 */
export async function tipFromCorrection(raw: string, said: string): Promise<string> {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return raw; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return raw;
  const o = j as Record<string, unknown>;
  const corrected = typeof o.corrected === 'string' ? o.corrected.replace(/<\/?ja>/g, '').trim() : '';
  const tip = typeof o.tip === 'string' ? o.tip.trim() : '';
  if (tip || !said || !KANA.test(corrected)) return raw;
  // the Japanese keeps its own end mark (。！？); the tip adds 。 only after one that has none
  const line = `<ja>${corrected}</ja>${/[。！？!?]$/.test(corrected) ? '' : '。'}`;
  if (!KANA.test(said)) return JSON.stringify({ ...o, tip: `這句話的日文可以說 ${line}` });
  if ((await sayingOf(said)) === (await sayingOf(corrected))) return raw;
  return JSON.stringify({ ...o, tip: `這句可以說成 ${line}` });
}

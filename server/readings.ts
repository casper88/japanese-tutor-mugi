// 漢字の読み仮名 filler (server side only). The teacher is told to write `学校[がっこう]` for every kanji word inside <ja>,
// but the model sometimes leaves a reading out. This fills the missing ones in with a local morphological analyser
// (kuromoji + its bundled IPA dictionary, Node only: it is never part of the phone bundle). Existing readings are never
// touched. A word whose analysed reading does not line up with its kana is left as it is: no reading beats a wrong one.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

type KuroToken = { surface_form: string; reading?: string };
type KuroTokenizer = { tokenize(s: string): KuroToken[] };
type KuroModule = { builder(o: { dicPath: string }): { build(cb: (err: Error | null, tk: KuroTokenizer) => void): void } };

const req = createRequire(import.meta.url);
const DIC = join(dirname(req.resolve('kuromoji/package.json')), 'dict');

let analyzer: Promise<KuroTokenizer> | null = null;
/** The tokenizer, built once (the dictionary takes about a second to load). Rejects if the dictionary is missing. */
export function loadAnalyzer(): Promise<KuroTokenizer> {
  analyzer ??= new Promise<KuroTokenizer>((resolve, reject) => {
    (req('kuromoji') as KuroModule).builder({ dicPath: DIC }).build((err, tk) => (err ? reject(err) : resolve(tk)));
  });
  return analyzer;
}

const KANJI = /[\p{Script=Han}々〆ヶ]/u;
const JA = /<ja>([\s\S]*?)<\/ja>/g;
/** an existing annotation: kanji run + [reading]. Kept verbatim. */
const RUBY = /([\p{Script=Han}々〆ヶ]+)\[([^[\]]*)\]/gu;

/** katakana → hiragana (the readings are katakana from the dictionary, the written kana may be either) */
export const toHira = (s: string): string => s.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

type Seg = { kanji: boolean; text: string };
/** a word split into alternating kanji runs and kana runs */
export function segments(s: string): Seg[] {
  const out: Seg[] = [];
  for (const ch of s) {
    const kanji = KANJI.test(ch);
    const last = out[out.length - 1];
    if (last && last.kanji === kanji) last.text += ch;
    else out.push({ kanji, text: ch });
  }
  return out;
}

/**
 * The reading of each kanji run in a word, in order, so that the kana runs of the word match the reading exactly.
 * `reading` is the hiragana reading of the whole word. Null when they do not line up (then nothing is annotated).
 * Example: 行き / いき → ['い'] (行[い]き); 食べ物 / たべもの → ['た', 'もの'].
 */
export function alignReading(word: string, reading: string): string[] | null {
  return align(segments(word), 0, toHira(reading), 0, []);
}

function align(segs: Seg[], i: number, reading: string, pos: number, acc: string[]): string[] | null {
  if (i === segs.length) return pos === reading.length ? acc : null;
  const seg = segs[i];
  if (!seg.kanji) {
    const k = toHira(seg.text);
    return reading.startsWith(k, pos) ? align(segs, i + 1, reading, pos + k.length, acc) : null;
  }
  const next = segs[i + 1];
  if (!next) {
    const r = reading.slice(pos);
    return r ? [...acc, r] : null;
  }
  // the kanji run ends where the next kana run starts in the reading; try each place it occurs
  const k = toHira(next.text);
  for (let idx = reading.indexOf(k, pos + 1); idx >= 0; idx = reading.indexOf(k, idx + 1)) {
    const res = align(segs, i + 1, reading, idx, [...acc, reading.slice(pos, idx)]);
    if (res) return res;
  }
  return null;
}

/**
 * Words the analyser splits into tokens whose separate readings are wrong (the compound has its own reading), with the
 * reading of the whole word in katakana. Tried before the token readings.
 */
const COMPOUND_READINGS: Record<string, string> = { 一人: 'ヒトリ', 二人: 'フタリ' };

/** the tokens, with the COMPOUND_READINGS words joined back into one token */
function tokensOf(s: string, tk: KuroTokenizer): KuroToken[] {
  const out: KuroToken[] = [];
  for (const t of tk.tokenize(s)) {
    const last = out[out.length - 1];
    const joined = last ? last.surface_form + t.surface_form : '';
    if (last && COMPOUND_READINGS[joined]) out[out.length - 1] = { surface_form: joined, reading: COMPOUND_READINGS[joined] };
    else out.push(t);
  }
  return out;
}

/** Plain text (no existing annotations): every token with kanji gets its readings. */
function annotatePlain(s: string, tk: KuroTokenizer): string {
  if (!s) return s;
  let out = '';
  let pos = 0;
  for (const t of tokensOf(s, tk)) {
    const surf = t.surface_form;
    if (!surf) continue;
    const at = s.indexOf(surf, pos);
    if (at < 0) break; // the analyser did not give back the text as it was: keep the rest as it is
    out += s.slice(pos, at);
    pos = at + surf.length;
    if (!KANJI.test(surf) || !t.reading || t.reading === '*') {
      out += surf;
      continue;
    }
    const segs = segments(surf);
    const readings = align(segs, 0, toHira(t.reading), 0, []);
    if (!readings) {
      out += surf;
      continue;
    }
    let j = 0;
    for (const seg of segs) out += seg.kanji ? `${seg.text}[${readings[j++]}]` : seg.text;
  }
  return out + s.slice(pos);
}

/** The inside of one <ja>: existing readings stay, the text between them is analysed. */
export function annotateJa(inner: string, tk: KuroTokenizer): string {
  let out = '';
  let last = 0;
  for (const m of inner.matchAll(RUBY)) {
    const at = m.index ?? 0;
    out += annotatePlain(inner.slice(last, at), tk) + m[0];
    last = at + m[0].length;
  }
  return out + annotatePlain(inner.slice(last), tk);
}

let warned = false;
/**
 * Every <ja>…</ja> in `text` gets the readings it lacks. Text outside <ja> is not touched. If the analyser is not
 * available the text comes back unchanged (logged once): the chat still works, the readings just stay out.
 */
export async function fillReadings(text: string, log: (m: string) => void = console.warn): Promise<string> {
  if (!text.includes('<ja>')) return text;
  let tk: KuroTokenizer;
  try {
    tk = await loadAnalyzer();
  } catch (e) {
    if (!warned) log(`[readings] analyser unavailable, readings not added: ${e instanceof Error ? e.message : e}`);
    warned = true;
    return text;
  }
  return text.replace(JA, (_m, inner: string) => `<ja>${annotateJa(inner, tk)}</ja>`);
}

/**
 * A reading a model wrote after a kanji run, as in 学校[がっこう]: the brackets hold kana only, so the brackets of a JSON text
 * (an array) are never taken for one.
 */
const MODEL_RUBY = /([\p{Script=Han}々〆ヶ]+)\[[ぁ-ゖァ-ヺー・]{1,30}\]/gu;

/**
 * The text with every reading a model wrote removed (学校[がっこう]に → 学校に). Used for the local models (smallModel, see
 * server/llm/provider.ts): their readings are not trusted, and fillReadings then writes them all from the analyser. Works on
 * plain text and on the JSON text of a reply alike.
 */
export function stripReadings(text: string): string {
  return text.replace(MODEL_RUBY, '$1');
}

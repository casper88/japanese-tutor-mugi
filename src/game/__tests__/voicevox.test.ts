import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TtsCache as DiskCache, looksLikeAudio, looksLikeWav, ttsCacheFileName } from '../../../server/ttsCache.ts';
import {
  TtsError, TTS_VOICES, answerTts, audioExtOf, audioTypeOf, cacheKey, createVoicevoxStatus, engineConfigured, isVoicevoxStyle,
  parseTtsBody, ttsStatus, voicevoxSynthesize, voicevoxUrl, voicevoxVoices, type TtsBody, type TtsConfig,
} from '../../../server/tts.ts';
import { UsageStore, billedChars, crossesThreshold, freeOf, ttsBucket } from '../../../server/usage.ts';
import { ENGINE_CHOICES, migrateTtsSettings } from '../tts';
import { cloudDefaultVoice } from '../cloudTts';

// ---- fakes -------------------------------------------------------------------------------------------------

const SPEAKERS = [
  { name: '春日部つむぎ', speaker_uuid: 'a', styles: [{ name: 'ノーマル', id: 8 }, { name: 'あまあま', id: 14 }] },
  { name: '四国めたん', speaker_uuid: 'b', styles: [{ name: 'ノーマル', id: 2 }] },
  { name: '壊れた話者', styles: 'nope' },
];
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(40)]);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

type Call = { url: string; method: string; body?: string };
/** a fetch that records each call and answers from `route`; a route that returns undefined makes the engine "refuse" the connection */
function fakeEngine(route: (url: URL, init: RequestInit) => Response | undefined | Promise<Response | undefined>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined });
    const r = await route(new URL(url), init);
    if (!r) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return r;
  }) as unknown as typeof fetch;
  return { f, calls };
}

/** an engine that is up: /version, /speakers, /audio_query, /synthesis */
function upEngine(extra: { query?: Record<string, unknown> } = {}) {
  const query = { accent_phrases: [], speedScale: 1.3, pitchScale: 0.12, intonationScale: 1, volumeScale: 1, prePhonemeLength: 0.1, postPhonemeLength: 0.1, outputSamplingRate: 24000, outputStereo: false, kana: 'コンニチワ', ...extra.query };
  return fakeEngine((u) => {
    if (u.pathname === '/version') return json('0.25.2');
    if (u.pathname === '/speakers') return json(SPEAKERS);
    if (u.pathname === '/audio_query') return json(query);
    if (u.pathname === '/synthesis') return new Response(WAV, { headers: { 'Content-Type': 'audio/wav' } });
    return new Response('nope', { status: 404 });
  });
}

const BASE = 'http://127.0.0.1:50021';

/** the caches the running test opened (TtsCache below) */
const opened: DiskCache[] = [];
/**
 * The real cache, remembered when it is made. A cache writes its files in the background (fetchOnce and answerTts return before
 * the file is on disk), so afterEach waits for every cache's writes before it removes the folder: a file that lands while the
 * folder is being removed makes the removal fail (ENOTEMPTY).
 */
class TtsCache extends DiskCache {
  constructor(...args: ConstructorParameters<typeof DiskCache>) {
    super(...args);
    opened.push(this);
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mugi-tutor-voicevox-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.settle()));
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const NONE: TtsConfig = { azureKey: '', azureRegion: '', googleKey: '' };

// ---- voice list and status ---------------------------------------------------------------------------------

describe('VOICEVOX speakers as voices', () => {
  it('lists every style as "<character>・<style>" with the style id as a string', () => {
    const v = voicevoxVoices(SPEAKERS);
    expect(v).toEqual([
      { id: '8', label: '春日部つむぎ・ノーマル', lang: 'ja-JP', character: '春日部つむぎ' },
      { id: '14', label: '春日部つむぎ・あまあま', lang: 'ja-JP', character: '春日部つむぎ' },
      { id: '2', label: '四国めたん・ノーマル', lang: 'ja-JP', character: '四国めたん' },
    ]);
  });

  it('skips malformed entries and tolerates a non-list answer', () => {
    expect(voicevoxVoices('oops')).toEqual([]);
    expect(voicevoxVoices([{ name: 'x', styles: [{ id: 'no', name: 'a' }] }])).toEqual([]);
  });

  it('accepts only short numeric style ids as voice ids', () => {
    expect(isVoicevoxStyle('8')).toBe(true);
    expect(isVoicevoxStyle('14')).toBe(true);
    expect(isVoicevoxStyle('8; rm')).toBe(false);
    expect(isVoicevoxStyle('1234567')).toBe(false);
    expect(isVoicevoxStyle('')).toBe(false);
  });
});

describe('VOICEVOX status probe', () => {
  const clock = () => { let t = 1_000_000; return { now: () => t, tick: (ms: number) => { t += ms; } }; };

  it('is up when /version and /speakers answer, with its voices', async () => {
    const e = upEngine();
    const c = clock();
    const st = createVoicevoxStatus({ base: () => BASE, fetch: e.f, now: c.now });
    const info = await st.info();
    expect(info.up).toBe(true);
    expect(info.voices.map((v) => v.id)).toEqual(['8', '14', '2']);
  });

  it('is down when the engine refuses the connection, or answers an error', async () => {
    const c = clock();
    const refused = createVoicevoxStatus({ base: () => BASE, fetch: fakeEngine(() => undefined).f, now: c.now });
    expect(await refused.info()).toEqual({ up: false, voices: [] });
    const bad = createVoicevoxStatus({ base: () => BASE, fetch: fakeEngine(() => new Response('x', { status: 500 })).f, now: c.now });
    expect(await bad.info()).toEqual({ up: false, voices: [] });
  });

  it('keeps the answer for about 10 seconds, then probes again', async () => {
    const e = upEngine();
    const c = clock();
    const st = createVoicevoxStatus({ base: () => BASE, fetch: e.f, now: c.now, ttlMs: 10_000 });
    await st.info();
    await st.info();
    expect(e.calls.filter((x) => x.url.endsWith('/version'))).toHaveLength(1);
    c.tick(9_000);
    await st.info();
    expect(e.calls.filter((x) => x.url.endsWith('/version'))).toHaveLength(1);
    c.tick(2_000);
    await st.info();
    expect(e.calls.filter((x) => x.url.endsWith('/version'))).toHaveLength(2);
  });

  it('shares one probe between concurrent status calls', async () => {
    const e = upEngine();
    const st = createVoicevoxStatus({ base: () => BASE, fetch: e.f, now: () => 0 });
    await Promise.all([st.info(), st.info(), st.info()]);
    expect(e.calls.filter((x) => x.url.endsWith('/version'))).toHaveLength(1);
  });

  it('ttsStatus reports voicevox true only when up, with the ja list; never a key', async () => {
    const up = await createVoicevoxStatus({ base: () => BASE, fetch: upEngine().f, now: () => 0 }).info();
    const s = ttsStatus({ azureKey: 'AZ-SECRET', azureRegion: 'eastasia', googleKey: 'G-SECRET' }, up);
    expect(s.voicevox).toBe(true);
    expect(s.voices.voicevox.ja.map((v) => v.id)).toEqual(['8', '14', '2']);
    expect(s.voices.voicevox.zh).toEqual([]);
    expect(s.voices.azure).toEqual(TTS_VOICES.azure);
    expect(JSON.stringify(s)).not.toContain('SECRET');

    const down = ttsStatus(NONE);
    expect(down.voicevox).toBe(false);
    expect(down.voices.voicevox.ja).toEqual([]);
  });

  it('the address comes from VOICEVOX_URL, else the local default', () => {
    expect(voicevoxUrl({})).toBe('http://127.0.0.1:50021');
    expect(voicevoxUrl({ VOICEVOX_URL: ' http://127.0.0.1:60000/ ' })).toBe('http://127.0.0.1:60000');
  });
});

// ---- synthesis -----------------------------------------------------------------------------------------------

describe('VOICEVOX synthesis (two steps at neutral settings)', () => {
  it('posts audio_query with the text and style, then synthesis with the query at speed 1 and pitch 0', async () => {
    const e = upEngine();
    const wav = await voicevoxSynthesize(BASE, '8', 'こんにちは', e.f);
    expect(wav.equals(WAV)).toBe(true);

    const [q, s] = e.calls;
    expect(q.method).toBe('POST');
    const qu = new URL(q.url);
    expect(qu.pathname).toBe('/audio_query');
    expect(qu.searchParams.get('speaker')).toBe('8');
    expect(qu.searchParams.get('text')).toBe('こんにちは');

    const su = new URL(s.url);
    expect(su.pathname).toBe('/synthesis');
    expect(su.searchParams.get('speaker')).toBe('8');
    expect(s.method).toBe('POST');
    const sent = JSON.parse(s.body ?? '{}');
    expect(sent.speedScale).toBe(1);
    expect(sent.pitchScale).toBe(0);
    expect(sent.kana).toBe('コンニチワ'); // the rest of the query is passed as the engine made it
  });

  it('a refused connection is "down": 503 voicevox_down', async () => {
    const e = fakeEngine(() => undefined);
    const err = await voicevoxSynthesize(BASE, '8', 'こんにちは', e.f).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(TtsError);
    expect((err as TtsError).status).toBe(503);
    expect((err as TtsError).code).toBe('voicevox_down');
  });

  it('an engine error (for example an unknown style) is an upstream error, 502', async () => {
    const e = fakeEngine((u) => (u.pathname === '/audio_query' ? new Response('no style', { status: 422 }) : undefined));
    const err = await voicevoxSynthesize(BASE, '999', 'hi', e.f).catch((x: unknown) => x);
    expect((err as TtsError).status).toBe(502);
    expect((err as TtsError).code).toBe('upstream');
  });
});

describe('VOICEVOX through answerTts: cache, WAV file kind, usage, fallback', () => {
  const VV: TtsBody = { engine: 'voicevox', voice: '8', text: 'こんにちは、今日は晴れですね。', rate: 1, pitch: 1 };
  const usageFile = () => join(dir, '.usage', 'usage.json');
  const at = new Date(2026, 9, 20, 12);
  const store = () => new UsageStore({ file: usageFile(), now: () => at, debounceMs: 60_000 });
  const cacheDir = () => join(dir, '.tts-cache');

  it('synthesizes, stores the WAV on disk under a .wav name, and a repeat is a cache hit', async () => {
    const e = upEngine();
    const cache = new TtsCache({ dir: cacheDir() });
    const usage = store();
    const synth = (use: TtsBody) => voicevoxSynthesize(BASE, use.voice, use.text, e.f);

    const first = await answerTts(VV, { cache, usage, synth, azureConfigured: false });
    expect(first.kind).toBe('audio');
    if (first.kind !== 'audio') return;
    expect(first.hit).toBe(false);
    expect(first.buf.equals(WAV)).toBe(true);
    expect(audioExtOf('voicevox')).toBe('wav');
    expect(audioTypeOf('voicevox')).toBe('audio/wav');

    await cache.settle();
    const names = readdirSync(cacheDir());
    expect(names).toEqual([ttsCacheFileName(cacheKey(VV), 'wav')]);
    expect(names[0].endsWith('.wav')).toBe(true);

    const again = await answerTts(VV, { cache: new TtsCache({ dir: cacheDir() }), usage, synth: vi.fn(synth), azureConfigured: false });
    expect(again.kind === 'audio' && again.hit).toBe(true);
    expect(e.calls.filter((c) => c.url.includes('/synthesis'))).toHaveLength(1);
  });

  it('a WAV file is found only under the wav name (an mp3 lookup of the same key misses)', async () => {
    const cache = new TtsCache({ dir: cacheDir() });
    await cache.store(cacheKey(VV), WAV, 'wav');
    await cache.settle();
    expect(await new TtsCache({ dir: cacheDir() }).lookup(cacheKey(VV), 'wav')).toEqual(WAV);
    expect(await new TtsCache({ dir: cacheDir() }).lookup(cacheKey(VV), 'mp3')).toBeUndefined();
  });

  it('the WAV check recognizes RIFF/WAVE only', () => {
    expect(looksLikeWav(WAV)).toBe(true);
    expect(looksLikeWav(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00'))).toBe(false);
    expect(looksLikeAudio(WAV, 'wav')).toBe(true);
    expect(looksLikeAudio(WAV, 'mp3')).toBe(false);
    expect(ttsCacheFileName('k', 'wav')).toMatch(/\.wav$/);
    expect(ttsCacheFileName('k')).toMatch(/\.mp3$/);
  });

  it('counts requests and characters under voicevox, with no allowance and no fallback', async () => {
    const e = upEngine();
    const cache = new TtsCache({ dir: cacheDir() });
    const usage = store();
    const synth = (use: TtsBody) => voicevoxSynthesize(BASE, use.voice, use.text, e.f);
    await answerTts(VV, { cache, usage, synth, azureConfigured: false });
    await answerTts(VV, { cache, usage, synth, azureConfigured: false }); // a hit: counted as a cache hit only

    const t = usage.snapshot().months['2026-10'].tts.voicevox?.voicevox;
    expect(t).toEqual({ requests: 1, failures: 0, chars: [...VV.text].length, cacheHits: 1, fallbacks: 0 });
    expect(usage.snapshot().months['2026-10'].tts.google).toEqual({});
    expect(freeOf('voicevox', 'voicevox')).toBeUndefined();
    expect(crossesThreshold(10 ** 9, 10 ** 9, freeOf('voicevox', 'voicevox'))).toBe(false);
    expect(billedChars(VV.text, 'voicevox', 'voicevox')).toBe([...VV.text].length);
    expect(ttsBucket('voicevox', '8')).toEqual({ engine: 'voicevox', tier: 'voicevox' });
  });

  it('when the engine is down, the request fails with voicevox_down and the failure is counted', async () => {
    const cache = new TtsCache({ dir: cacheDir() });
    const usage = store();
    const e = fakeEngine(() => undefined);
    const synth = (use: TtsBody) => voicevoxSynthesize(BASE, use.voice, use.text, e.f);
    const err = await answerTts(VV, { cache, usage, synth, azureConfigured: false }).catch((x: unknown) => x);
    expect((err as TtsError).code).toBe('voicevox_down');
    expect((err as TtsError).status).toBe(503);
    expect(usage.snapshot().months['2026-10'].tts.voicevox?.voicevox).toMatchObject({ requests: 1, failures: 1, chars: 0 });
  });

  it('a request for an unknown style is refused by validation (400), never sent to the engine', () => {
    expect(() => parseTtsBody(JSON.stringify({ engine: 'voicevox', voice: 'cmn-TW-Wavenet-A', text: 'hi', rate: 1, pitch: 1 }))).toThrow(TtsError);
    expect(parseTtsBody(JSON.stringify({ engine: 'voicevox', voice: '8', text: 'hi', rate: 1, pitch: 1 })).voice).toBe('8');
  });

  it('an engine with no key config is still "configured" (VOICEVOX needs no key)', () => {
    expect(engineConfigured(NONE, 'voicevox')).toBe(true);
  });
});

describe('usage store: months saved before VOICEVOX', () => {
  it('reads an old month without a voicevox bucket and adds it on first use', () => {
    const file = join(dir, 'old.json');
    const at = new Date(2026, 9, 20, 12);
    // written by an older build: no voicevox key in the month
    writeFileSync(file, JSON.stringify({ version: 1, months: { '2026-10': { tts: { google: {}, azure: {} }, claude: {} } } }));
    const s = new UsageStore({ file, now: () => at, debounceMs: 60_000 });
    expect(s.snapshot().months['2026-10'].tts).toEqual({ google: {}, azure: {} });
    s.recordTts({ engine: 'voicevox', tier: 'voicevox' }, { ok: true, chars: 5 });
    expect(s.snapshot().months['2026-10'].tts.voicevox?.voicevox.chars).toBe(5);
    expect(s.ttsUsed('voicevox', 'voicevox')).toBe(5);
  });
});

// skipped unless a VOICEVOX engine answers on the default address (this PC only)
const engineUp = await fetch(`${BASE}/version`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok, () => false);

describe('the optional integration test against the real local engine', () => {
  it.skipIf(!engineUp)('synthesizes a Japanese line at style 8 into a RIFF/WAVE file', async () => {
    const wav = await voicevoxSynthesize(BASE, '8', 'こんにちは', fetch);
    expect(looksLikeWav(wav)).toBe(true);
    expect(wav.length).toBeGreaterThan(1000);
  }, 60_000);
});

// ---- client settings ----------------------------------------------------------------------------------------

describe('VOICEVOX as a Japanese engine (client settings)', () => {
  it('defaults to 四国めたん・ノーマル (style 2) when no status is loaded', () => {
    expect(cloudDefaultVoice('voicevox', 'ja')).toBe('2');
  });

  it('is offered for Japanese only', () => {
    expect(ENGINE_CHOICES.ja.map((c) => c.engine)).toContain('voicevox');
    expect(ENGINE_CHOICES.ja.find((c) => c.engine === 'voicevox')?.label).toBe('VOICEVOX');
    expect(ENGINE_CHOICES.zh.map((c) => c.engine)).not.toContain('voicevox');
  });

  it('a saved Japanese VOICEVOX setting survives migration', () => {
    const s = migrateTtsSettings({ on: true, zh: { engine: 'browser', rate: 1.05, pitch: 1, voices: {} }, ja: { engine: 'voicevox', rate: 1.1, pitch: 1, voices: { voicevox: '14' } } });
    expect(s.ja.engine).toBe('voicevox');
    expect(s.ja.voices.voicevox).toBe('14');
    expect(s.ja.rate).toBe(1.1);
  });

  it('a Chinese line saved with VOICEVOX falls back to the device voice', () => {
    const s = migrateTtsSettings({ zh: { engine: 'voicevox', rate: 1, pitch: 1, voices: {} }, ja: { engine: 'browser', rate: 1, pitch: 1, voices: {} } });
    expect(s.zh.engine).toBe('browser');
  });

  it('settings saved before VOICEVOX (v1 shape, or v2 without it) stay valid', () => {
    const v1 = migrateTtsSettings({ engine: 'azure', rate: 1.05, pitch: 1, azureJa: 'ja-JP-AoiNeural' });
    expect(v1.zh.engine).toBe('azure');
    expect(v1.ja.engine).toBe('azure');
    expect(v1.ja.voices.azure).toBe('ja-JP-AoiNeural');
    const v2 = migrateTtsSettings({ on: false, zh: { engine: 'google', rate: 1, pitch: 1, voices: {} }, ja: { engine: 'azure', rate: 1, pitch: 1, voices: {} } });
    expect(v2.on).toBe(false);
    expect(v2.ja.engine).toBe('azure');
    expect(migrateTtsSettings(null).ja.engine).toBe('browser');
  });

  it('an unknown engine name still falls back to the device voice', () => {
    expect(migrateTtsSettings({ ja: { engine: 'festival', rate: 1, pitch: 1, voices: {} } }).ja.engine).toBe('browser');
  });
});

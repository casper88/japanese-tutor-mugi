import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TtsCache as DiskCache, looksLikeMp3, ttsCacheFileName } from '../../../server/ttsCache.ts';
import { answerTts, cacheKey, sameOriginRequest, type TtsBody } from '../../../server/tts.ts';
import { UsageStore, usageRoute } from '../../../server/usage.ts';
import { ttsCacheLine } from '../usageView';

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
let cdir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mugi-tutor-ttscache-'));
  cdir = join(dir, '.tts-cache');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.settle()));
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** a fake mp3: an ID3 tag, then filler up to `size` bytes */
const blob = (size: number, fill = 0x61) => {
  const b = Buffer.alloc(size, fill);
  b[0] = 0x49; b[1] = 0x44; b[2] = 0x33;
  return b;
};
const K = 'azure|zh-TW-HsiaoChenNeural|1|1|你好世界';
const K2 = 'azure|zh-TW-HsiaoChenNeural|1|1|再見';
const K3 = 'azure|zh-TW-HsiaoChenNeural|1|1|謝謝';

describe('key hashing and file names', () => {
  it('names a file by the sha256 (hex) of the key, with .mp3, and never shows the text', () => {
    const name = ttsCacheFileName(K);
    expect(name).toBe(`${createHash('sha256').update(K, 'utf8').digest('hex')}.mp3`);
    expect(name).toMatch(/^[0-9a-f]{64}\.mp3$/);
    expect(name).not.toContain('你好');
    expect(ttsCacheFileName(K)).toBe(name);
    expect(ttsCacheFileName(K2)).not.toBe(name);
  });

  it('the cache key separates every field of the request (rate and pitch and engine too)', () => {
    const base: TtsBody = { engine: 'azure', voice: 'zh-TW-HsiaoChenNeural', text: 'a', rate: 1, pitch: 1 };
    const keys = new Set([
      cacheKey(base),
      cacheKey({ ...base, rate: 1.1 }),
      cacheKey({ ...base, pitch: 1.1 }),
      cacheKey({ ...base, voice: 'zh-TW-HsiaoYuNeural' }),
      cacheKey({ ...base, engine: 'google', voice: 'cmn-TW-Wavenet-A' }),
      cacheKey({ ...base, text: 'b' }),
    ]);
    expect(keys.size).toBe(6);
    expect(cacheKey(base)).toBe('azure|zh-TW-HsiaoChenNeural|1|1|a');
  });

  it('recognizes an mp3 payload (ID3 tag or frame sync) and nothing else', () => {
    expect(looksLikeMp3(blob(40))).toBe(true);
    expect(looksLikeMp3(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00]))).toBe(true);
    expect(looksLikeMp3(Buffer.from('not audio at all'))).toBe(false);
    expect(looksLikeMp3(Buffer.alloc(0))).toBe(false);
    expect(looksLikeMp3(Buffer.from('ID'))).toBe(false);
  });
});

describe('TtsCache: memory, disk and restart', () => {
  it('a disk hit after a restart (a new cache instance) returns the stored bytes without synthesizing', async () => {
    const c1 = new TtsCache({ dir: cdir });
    const first = await c1.fetchOnce(K, async () => blob(120));
    expect(first.hit).toBe(false);
    await c1.settle();

    const c2 = new TtsCache({ dir: cdir });
    const synth = vi.fn(async () => blob(120, 0x62));
    const again = await c2.fetchOnce(K, synth);
    expect(again.hit).toBe(true);
    expect(synth).not.toHaveBeenCalled();
    expect(again.buf.equals(first.buf)).toBe(true);
    expect(c2.stats()).toEqual({ files: 1, bytes: 120 });
  });

  it('a disk hit is promoted to memory: it still answers after the file is gone', async () => {
    const c1 = new TtsCache({ dir: cdir });
    await c1.fetchOnce(K, async () => blob(60));
    await c1.settle();
    const c2 = new TtsCache({ dir: cdir });
    expect(await c2.lookup(K)).toBeDefined();
    rmSync(join(cdir, ttsCacheFileName(K)));
    expect((await c2.lookup(K))?.length).toBe(60);
  });

  it('writes the file atomically: the final name holds the whole reply, and no temp file is left', async () => {
    const c = new TtsCache({ dir: cdir });
    await c.fetchOnce(K, async () => blob(333));
    await c.settle();
    expect(readdirSync(cdir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(readFileSync(join(cdir, ttsCacheFileName(K))).length).toBe(333);
  });

  it('a failed write is logged and never breaks the reply', async () => {
    // the cache directory cannot be created under a plain file: every write fails
    writeFileSync(join(dir, 'plain'), 'x');
    const c = new TtsCache({ dir: join(dir, 'plain', 'sub') });
    const r = await c.fetchOnce(K, async () => blob(50));
    expect(r.hit).toBe(false);
    expect(r.buf.length).toBe(50);
    await expect(c.settle()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it('removes leftover temp files of an interrupted write at startup', () => {
    new TtsCache({ dir: cdir }); // creates the directory
    writeFileSync(join(cdir, `${ttsCacheFileName(K)}.123.1.abcd.tmp`), 'partial');
    new TtsCache({ dir: cdir });
    expect(readdirSync(cdir)).toEqual([]);
  });
});

describe('TtsCache: size cap and eviction', () => {
  it('evicts the least recently used file when over the cap, and a hit saves a file from eviction', async () => {
    let t = 1000;
    const c = new TtsCache({ dir: cdir, maxBytes: 100, now: () => t, sweepDebounceMs: 60_000 });
    await c.fetchOnce(K, async () => blob(40)); // mtime 1000
    await c.settle();
    t = 2000;
    await c.fetchOnce(K2, async () => blob(40)); // mtime 2000
    await c.settle();
    t = 3000;
    expect(await c.lookup(K)).toBeDefined(); // K is used again: mtime 3000
    t = 4000;
    await c.fetchOnce(K3, async () => blob(40)); // 120 bytes: over the 100 cap
    await c.settle();
    expect(existsSync(join(cdir, ttsCacheFileName(K2)))).toBe(false);
    expect(existsSync(join(cdir, ttsCacheFileName(K)))).toBe(true);
    expect(existsSync(join(cdir, ttsCacheFileName(K3)))).toBe(true);
    expect(c.stats()).toEqual({ files: 2, bytes: 80 });
  });

  it('trims a directory left over the cap once at startup, oldest first', async () => {
    let t = 1000;
    const big = new TtsCache({ dir: cdir, now: () => t, sweepDebounceMs: 60_000 });
    for (const [k, when] of [[K, 1000], [K2, 2000], [K3, 3000]] as const) {
      t = when;
      await big.fetchOnce(k, async () => blob(40));
      await big.settle();
    }
    const small = new TtsCache({ dir: cdir, maxBytes: 100 });
    await small.settle();
    expect(readdirSync(cdir).filter((n) => n.endsWith('.mp3')).sort()).toEqual(
      [ttsCacheFileName(K2), ttsCacheFileName(K3)].sort(),
    );
    expect(small.stats()).toEqual({ files: 2, bytes: 80 });
  });

  it('a sweep under the cap removes nothing', async () => {
    const c = new TtsCache({ dir: cdir, maxBytes: 1000, sweepDebounceMs: 10 });
    await c.fetchOnce(K, async () => blob(40));
    await c.settle();
    expect(await c.sweep()).toBe(0);
    expect(c.stats().files).toBe(1);
  });

  it('clear empties the directory and the memory copies', async () => {
    const c = new TtsCache({ dir: cdir });
    await c.fetchOnce(K, async () => blob(40));
    await c.fetchOnce(K2, async () => blob(40));
    await c.settle();
    expect(await c.clear()).toEqual({ files: 2, bytes: 80 });
    expect(c.stats()).toEqual({ files: 0, bytes: 0 });
    expect(await c.lookup(K)).toBeUndefined();
    expect(readdirSync(cdir).filter((n) => n.endsWith('.mp3'))).toEqual([]);
  });
});

describe('TtsCache: concurrent requests and damaged files', () => {
  it('two concurrent requests for the same key share one synthesis; the second waits and is a hit', async () => {
    const c = new TtsCache({ dir: cdir });
    let release!: (b: Buffer) => void;
    const gate = new Promise<Buffer>((r) => { release = r; });
    const synth = vi.fn(() => gate);
    const p1 = c.fetchOnce(K, synth);
    const p2 = c.fetchOnce(K, synth);
    release(blob(40));
    const [a, b] = await Promise.all([p1, p2]);
    expect(synth).toHaveBeenCalledTimes(1);
    expect([a.hit, b.hit]).toEqual([false, true]);
    expect(b.buf.equals(a.buf)).toBe(true);
  });

  it('a failed synthesis is not stored: the next request synthesizes again', async () => {
    const c = new TtsCache({ dir: cdir });
    await expect(c.fetchOnce(K, async () => { throw new Error('upstream'); })).rejects.toThrow('upstream');
    const r = await c.fetchOnce(K, async () => blob(40));
    expect(r.hit).toBe(false);
  });

  it('a corrupt or partial file is ignored, removed and re-synthesized', async () => {
    const c0 = new TtsCache({ dir: cdir });
    await c0.fetchOnce(K, async () => blob(40));
    await c0.settle();
    // a file that is not an mp3 (garbage) and one that is empty (a partial write that was never renamed)
    writeFileSync(join(cdir, ttsCacheFileName(K)), Buffer.from('not audio at all'));
    writeFileSync(join(cdir, ttsCacheFileName(K2)), Buffer.alloc(0));
    const c = new TtsCache({ dir: cdir });
    const synth = vi.fn(async () => blob(40, 0x63));
    const r1 = await c.fetchOnce(K, synth);
    const r2 = await c.fetchOnce(K2, synth);
    await c.settle();
    expect(synth).toHaveBeenCalledTimes(2);
    expect([r1.hit, r2.hit]).toEqual([false, false]);
    expect(readFileSync(join(cdir, ttsCacheFileName(K))).equals(blob(40, 0x63))).toBe(true);
    expect(c.stats()).toEqual({ files: 2, bytes: 80 });
  });
});

// ---- answerTts: the billing rule with the disk cache in front of the provider

const AZ: TtsBody = { engine: 'azure', voice: 'zh-TW-HsiaoChenNeural', text: '你好世界', rate: 1, pitch: 1 };
const GO: TtsBody = { engine: 'google', voice: 'ja-JP-Neural2-B', text: 'はい', rate: 1, pitch: 1 };
const usageAt = (file: string) => new UsageStore({ file, now: () => new Date(2026, 9, 20, 12), debounceMs: 60_000 });
const month = (u: UsageStore) => u.snapshot().months['2026-10'].tts;

describe('answerTts: billing with the disk cache', () => {
  it('a disk hit after a restart bills nothing and counts as a cache hit', async () => {
    const usage = usageAt(join(dir, 'usage.json'));
    const c1 = new TtsCache({ dir: cdir });
    const first = await answerTts(AZ, { cache: c1, usage, synth: async () => blob(90), azureConfigured: true });
    expect(first).toMatchObject({ kind: 'audio', hit: false });
    await c1.settle();
    expect(month(usage).azure.neural).toMatchObject({ requests: 1, chars: 4, cacheHits: 0 });

    const c2 = new TtsCache({ dir: cdir }); // the server restarted
    const synth = vi.fn(async () => blob(90));
    const second = await answerTts(AZ, { cache: c2, usage, synth, azureConfigured: true });
    expect(second).toMatchObject({ kind: 'audio', hit: true, fellBack: false });
    expect(synth).not.toHaveBeenCalled();
    expect(month(usage).azure.neural).toMatchObject({ requests: 1, chars: 4, cacheHits: 1 });
  });

  it('a cached reply is served from disk even when its tier is past 90% (nothing is billed, no fallback)', async () => {
    const usage = usageAt(join(dir, 'usage.json'));
    usage.recordTts({ engine: 'google', tier: 'neural2' }, { ok: true, chars: 999_000 });
    const c1 = new TtsCache({ dir: cdir });
    await c1.fetchOnce(cacheKey(GO), async () => blob(70));
    await c1.settle();
    const c2 = new TtsCache({ dir: cdir });
    const got = await answerTts(GO, { cache: c2, usage, synth: vi.fn(async () => blob(70)), azureConfigured: false });
    expect(got).toMatchObject({ kind: 'audio', hit: true, fellBack: false, requestedTier: 'neural2' });
    expect(month(usage).google.neural2.chars).toBe(999_000);
  });

  it('an uncached request past 90% falls back to the next Google tier and is cached under that key', async () => {
    const usage = usageAt(join(dir, 'usage.json'));
    usage.recordTts({ engine: 'google', tier: 'neural2' }, { ok: true, chars: 950_000 });
    const c = new TtsCache({ dir: cdir });
    const synth = vi.fn(async () => blob(70));
    const got = await answerTts(GO, { cache: c, usage, synth, azureConfigured: false });
    expect(got).toMatchObject({ kind: 'audio', hit: false, fellBack: true, requestedTier: 'neural2' });
    if (got.kind !== 'audio') throw new Error('expected audio');
    expect(got.use.voice).toBe('ja-JP-Wavenet-B');
    expect(synth).toHaveBeenCalledWith(expect.objectContaining({ voice: 'ja-JP-Wavenet-B' }));
    await c.settle();
    expect(existsSync(join(cdir, ttsCacheFileName(cacheKey(got.use))))).toBe(true);
  });

  it('two concurrent identical requests reach the provider once and bill once', async () => {
    const usage = usageAt(join(dir, 'usage.json'));
    const c = new TtsCache({ dir: cdir });
    let release!: (b: Buffer) => void;
    const gate = new Promise<Buffer>((r) => { release = r; });
    const synth = vi.fn(() => gate);
    const deps = { cache: c, usage, synth, azureConfigured: true };
    const p1 = answerTts(AZ, deps);
    const p2 = answerTts(AZ, deps);
    release(blob(90));
    const [a, b] = await Promise.all([p1, p2]);
    expect(synth).toHaveBeenCalledTimes(1);
    expect([a, b].map((x) => x.kind === 'audio' && x.hit)).toEqual([false, true]);
    expect(month(usage).azure.neural).toMatchObject({ requests: 1, chars: 4, cacheHits: 1 });
  });

  it('a failed provider call is billed as a failure and leaves nothing in the cache', async () => {
    const usage = usageAt(join(dir, 'usage.json'));
    const c = new TtsCache({ dir: cdir });
    await expect(answerTts(AZ, { cache: c, usage, synth: async () => { throw new Error('502'); }, azureConfigured: true })).rejects.toThrow('502');
    expect(month(usage).azure.neural).toMatchObject({ requests: 1, failures: 1, chars: 0 });
    expect(c.stats().files).toBe(0);
  });
});

describe('route helpers', () => {
  it('the clear route is refused for another origin, and allowed for this server or with no Origin header', () => {
    expect(sameOriginRequest({ socket: { remoteAddress: '127.0.0.1' }, origin: 'http://localhost:3004', host: 'localhost:3004' })).toBe(true);
    // a name other than localhost is served only when server.allowedHosts lists it (a leading dot covers subdomains)
    expect(sameOriginRequest({ socket: { remoteAddress: '127.0.0.1' }, origin: 'https://my-pc.example.test:8447', host: 'my-pc.example.test:8447' })).toBe(false);
    expect(sameOriginRequest({ socket: { remoteAddress: '127.0.0.1' }, origin: 'https://my-pc.example.test:8447', host: 'my-pc.example.test:8447' }, { allowedHosts: ['.example.test'] })).toBe(true);
    expect(sameOriginRequest({ socket: { remoteAddress: '127.0.0.1' }, origin: 'https://evil.example', host: 'localhost:3004' })).toBe(false);
    expect(sameOriginRequest({ socket: { remoteAddress: '127.0.0.1' }, origin: 'http://localhost:3004', host: 'localhost:3004', 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(sameOriginRequest({ socket: { remoteAddress: '127.0.0.1' }, origin: 'not a url', host: 'localhost:3004' })).toBe(false);
    expect(sameOriginRequest({ socket: { remoteAddress: '127.0.0.1' }, host: 'localhost:3004' })).toBe(true);
    // a LAN connection (its own address, Host 127.0.0.1) is refused here too: the cache clear and VOICEVOX are this PC's
    expect(sameOriginRequest({ socket: { remoteAddress: '192.168.1.50' }, host: 'localhost:3004' })).toBe(false);
    expect(sameOriginRequest({ host: 'localhost:3004' })).toBe(false);
  });

  it('GET /api/usage adds ttsCache { files, bytes } when a speech cache is given, and not otherwise', () => {
    const usage = usageAt(join(dir, 'usage.json'));
    const f = { r: { status: 0, body: '' }, writeHead(s: number) { this.r.status = s; return this; }, end(b: string) { this.r.body = b; } };
    usageRoute(usage, { method: 'GET', url: '/' }, f as never, { stats: () => ({ files: 3, bytes: 2048 }) });
    expect(JSON.parse(f.r.body).ttsCache).toEqual({ files: 3, bytes: 2048 });
    usageRoute(usage, { method: 'GET', url: '/' }, f as never);
    expect(JSON.parse(f.r.body)).not.toHaveProperty('ttsCache');
  });

  it('the panel line shows the sentence count and the size in MB', () => {
    expect(ttsCacheLine({ files: 12, bytes: 3.5 * 1024 * 1024 })).toBe('語音快取：12 句・3.5 MB（重複的句子不再計費）');
    expect(ttsCacheLine({ files: 0, bytes: 0 })).toBe('語音快取：0 句・0.0 MB（重複的句子不再計費）');
  });
});

// SPDX-License-Identifier: GPL-3.0-or-later
import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { renderSkin } from './renderer.mjs';
import sharp from 'sharp';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_BYTES = 2 * 1024 * 1024;
const SOURCES = ['https://skins.ddnet.org/skin/community/', 'https://ddstats.tw/skins/'];
const TTL = 6 * 60 * 60 * 1000;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
class Cache {
  constructor(maxItems, maxBytes) { this.map = new Map(); this.bytes = 0; this.maxItems = maxItems; this.maxBytes = maxBytes; }
  remove(key) { const v = this.map.get(key); if (v) this.bytes -= v.size; this.map.delete(key); }
  get(key) {
    const v = this.map.get(key); if (!v) return;
    if (v.exp < Date.now()) { this.remove(key); return; }
    this.map.delete(key); this.map.set(key, v); return v.value;
  }
  set(key, value, size) {
    this.remove(key); if (size > this.maxBytes) return;
    while (this.map.size >= this.maxItems || this.bytes + size > this.maxBytes) this.remove(this.map.keys().next().value);
    this.map.set(key, { value, size, exp: Date.now() + TTL }); this.bytes += size;
  }
}
export function parseOptions(url) {
  const allowed = new Set(['name', 'custom', 'body', 'feet', 'v']);
  for (const k of url.searchParams.keys())
    if (!allowed.has(k) || url.searchParams.getAll(k).length !== 1) throw new HttpError(400, 'Invalid parameters');
  const name = url.searchParams.get('name') ?? 'default';
  if (!name || Buffer.byteLength(name) > 64 || /[\x00-\x1f\x7f/\\]/u.test(name) || name === '.' || name === '..')
    throw new HttpError(400, 'Invalid skin name');
  const custom = url.searchParams.get('custom') ?? '0';
  if (!['0', '1'].includes(custom)) throw new HttpError(400, 'custom must be 0 or 1');
  const number = key => {
    const val = url.searchParams.get(key);
    if (val === null) { if (custom === '1') throw new HttpError(400, `${key} is required`); return 0; }
    if (!/^\d{1,8}$/.test(val) || Number(val) > 16777215) throw new HttpError(400, 'Invalid color');
    return Number(val);
  };
  const body = number('body'), feet = number('feet');
  return { name, custom: custom === '1', body: custom === '1' ? body : 0, feet: custom === '1' ? feet : 0 };
}

export async function fetchSkin(name) {
  let unavailable = false;
  for (const root of SOURCES) {
    try {
      const response = await fetch(root + encodeURIComponent(name) + '.png', {
        signal: AbortSignal.timeout(4500), redirect: 'error',
        headers: { Accept: 'image/png', 'User-Agent': 'RIVALS-Skin-Service/1.0' },
      });
      if (response.status === 404) { await response.body?.cancel(); continue; }
      if (!response.ok) { await response.body?.cancel(); unavailable = true; continue; }
      if (Number(response.headers.get('content-length')) > MAX_BYTES) {
        await response.body?.cancel(); throw new Error('Skin too large');
      }
      let size = 0; const parts = [];
      for await (const part of response.body) {
        size += part.length; if (size > MAX_BYTES) throw new Error('Skin too large'); parts.push(part);
      }
      const data = Buffer.concat(parts);
      if (data.length < 24 || !data.subarray(0, 8).equals(PNG)) throw new Error('Not PNG');
      return data;
    } catch { unavailable = true; }
  }
  throw new HttpError(unavailable ? 502 : 404, unavailable ? 'Skin database unavailable' : 'Skin not found');
}

export function createSkinServer({ loadSkin = fetchSkin } = {}) {
  const images = new Cache(128, 24 * 1024 * 1024);
  const sources = new Cache(48, 12 * 1024 * 1024);
  // Ready-made tee PNGs are served byte-for-byte. No atlas rendering or recoloring here.
  // Storage is bounded RAM, not a promise of durable hosting.
  const tees = new Cache(96, 24 * 1024 * 1024);
  let activeUploads = 0;
  let uploadTokens = 12;
  let tokenTime = Date.now();
  function allowUpload() {
    const now = Date.now();
    uploadTokens = Math.min(12, uploadTokens + Math.max(0, now - tokenTime) / 5000);
    tokenTime = now;
    if (uploadTokens < 1) return false;
    uploadTokens -= 1; return true;
  }
  async function receiveTee(req) {
    if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'image/png')
      throw new HttpError(415, 'Only image/png is accepted');
    const length = req.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > 512 * 1024))
      throw new HttpError(413, 'PNG exceeds 512 KiB');
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 512 * 1024) throw new HttpError(413, 'PNG exceeds 512 KiB');
      chunks.push(chunk);
    }
    const png = Buffer.concat(chunks);
    if (png.length < 45 || !png.subarray(0, 8).equals(PNG)) throw new HttpError(400, 'Invalid PNG');
    try {
      const meta = await sharp(png, { limitInputPixels: 512 * 512, failOn: 'error' }).metadata();
      if (meta.format !== 'png' || meta.width !== 512 || meta.height !== 512 || !meta.hasAlpha || (meta.pages ?? 1) > 1)
        throw new Error('Expected one 512x512 RGBA image');
      // Decode to verify integrity, but do NOT re-encode/resize/recolor the supplied PNG.
      await sharp(png, { limitInputPixels: 512 * 512, failOn: 'error' }).raw().toBuffer();
    } catch { throw new HttpError(400, 'Expected a valid single-frame 512x512 PNG with alpha'); }
    return png;
  }
  const pending = new Map(); const loading = new Map();
  const getSource = async name => {
    const hit = sources.get(name); if (hit) return hit;
    if (loading.has(name)) return loading.get(name);
    const task = loadSkin(name).then(data => { sources.set(name, data, data.length); return data; });
    loading.set(name, task);
    try { return await task; } finally { loading.delete(name); }
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!req.url || req.url.length > 1024) throw new HttpError(414, 'URL too long');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/tee') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new HttpError(405, 'Use POST image/png'); }
        if (url.search) throw new HttpError(400, 'No upload query parameters');
        if (activeUploads >= 2 || !allowUpload()) { res.setHeader('Retry-After', '5'); throw new HttpError(429, 'Upload limit reached; retry later'); }
        activeUploads++;
        try {
          const png = await receiveTee(req);
          const hash = createHash('sha256').update(png).digest('hex');
          tees.set(hash, png, png.length);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ ok: true, image: '/tee/' + hash + '.png', sha256: hash, expires_in: 21600, storage: 'memory' }));
        } finally { activeUploads--; }
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); throw new HttpError(405, 'Use GET or HEAD'); }
      if (url.pathname.startsWith('/tee/')) {
        const match = /^\/tee\/([a-f0-9]{64})\.png$/.exec(url.pathname);
        if (!match) throw new HttpError(404, 'Not found');
        const png = tees.get(match[1]);
        if (!png) throw new HttpError(404, 'PNG expired; client must upload it again');
        const etag = '"' + match[1] + '"';
        res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
        res.setHeader('Content-Type', 'image/png'); res.setHeader('Content-Length', png.length);
        res.end(req.method === 'HEAD' ? undefined : png); return;
      }
      if (['/', '/health', '/healthz'].includes(url.pathname)) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, service: 'RIVALS skin service', version: 2, upload_api: 1, storage: 'memory', example: '/skin.png?name=default', privacy: 'Client may upload a 512x512 tee-only PNG. No screenshots, nicknames or server addresses are required.' })); return;
      }
      if (url.pathname !== '/skin.png') throw new HttpError(404, 'Not found');
      const opts = parseOptions(url); const key = JSON.stringify(opts);
      let image = images.get(key);
      if (!image) {
        if (!pending.has(key)) {
          if (pending.size >= 3) { res.setHeader('Retry-After', '3'); throw new HttpError(503, 'Renderer busy'); }
          const task = (async () => {
            const data = await renderSkin(await getSource(opts.name), opts);
            const result = { data, etag: '"' + createHash('sha256').update(data).digest('hex') + '"' };
            images.set(key, result, data.length); return result;
          })();
          pending.set(key, task); task.finally(() => pending.delete(key)).catch(() => {});
        }
        image = await pending.get(key);
      }
      res.setHeader('ETag', image.etag);
      res.setHeader('Cache-Control', 'public, max-age=21600, s-maxage=21600');
      if (req.headers['if-none-match'] === image.etag) { res.writeHead(304); res.end(); return; }
      res.setHeader('Content-Type', 'image/png'); res.setHeader('Content-Length', image.data.length);
      res.end(req.method === 'HEAD' ? undefined : image.data);
    } catch (err) {
      if (res.destroyed) return;
      res.statusCode = err.status ?? 502;
      if (req.method === 'POST') res.setHeader('Connection', 'close');
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: err.status ? err.message : 'Unable to render this skin' }));
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.maxConnections = 128;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 10000);
  const server = createSkinServer();
  server.listen(port, '0.0.0.0', () => console.log(`RIVALS skin service listening on port ${port}`));
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
}

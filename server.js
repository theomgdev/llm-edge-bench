/**
 * server.js — statik dosya sunucusu + LLM proxy. Sıfır bağımlılık.
 *
 * Proxy iki iş yapar:
 *  1) CORS duvarını kaldırır (tarayıcıdan api.openai.com'a doğrudan POST çoğu
 *     sağlayıcıda engellidir).
 *  2) API anahtarını isteğe göre sunucuda tutar (--key ile verilirse tarayıcı
 *     anahtarı hiç görmez).
 *
 * Kullanım:
 *   node server.js [--port 8787] [--base-url URL] [--key SECRET] [--open]
 *   Anahtar ortamdan da okunur: OPENAI_API_KEY / LLM_API_KEY
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'web');

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || process.env.PORT || 8787);
const HOST = args.host || '127.0.0.1';
const SERVER_KEY = args.key || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
const SERVER_BASE = args['base-url'] || process.env.LLM_BASE_URL || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/llm' && req.method === 'POST') return await handleProxy(req, res);
    if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, {
      hasServerKey: !!SERVER_KEY,
      serverBaseUrl: SERVER_BASE || null,
      version: '0.1.0',
    });
    if (url.pathname === '/api/examples' && req.method === 'GET') return await listExamples(res);
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'bilinmeyen endpoint' });
    return await serveStatic(url.pathname, res);
  } catch (err) {
    console.error('[hata]', err);
    if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
  }
});

async function handleProxy(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req, 8 * 1024 * 1024));
  } catch (err) {
    return json(res, 400, { error: `gövde çözülemedi: ${err.message}` });
  }

  const baseUrl = String(body.baseUrl || SERVER_BASE || '').replace(/\/+$/, '');
  if (!baseUrl) return json(res, 400, { error: 'baseUrl gerekli' });
  if (!/^https?:\/\//i.test(baseUrl)) return json(res, 400, { error: 'baseUrl http(s) olmalı' });

  const subPath = String(body.path || '/chat/completions');
  if (!subPath.startsWith('/')) return json(res, 400, { error: 'path / ile başlamalı' });

  const target = baseUrl + subPath;
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  for (const [k, v] of Object.entries(body.headers || {})) {
    if (typeof v === 'string' && /^[\w-]+$/.test(k)) headers[k.toLowerCase()] = v;
  }
  // tarayıcının gönderdiği anahtar yoksa sunucudakini kullan
  const key = body.apiKey || SERVER_KEY;
  if (key) headers.authorization = `Bearer ${key}`;

  const method = (body.method || (body.payload ? 'POST' : 'GET')).toUpperCase();
  const ctrl = new AbortController();
  const timeoutMs = Number(body.timeoutMs) || 180000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  req.on('close', () => ctrl.abort());

  const started = Date.now();
  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body.payload ?? {}),
      signal: ctrl.signal,
    });
    const text = await upstream.text();
    clearTimeout(timer);
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'x-proxy-latency-ms': String(Date.now() - started),
      'cache-control': 'no-store',
    });
    res.end(text);
  } catch (err) {
    clearTimeout(timer);
    const aborted = err.name === 'AbortError';
    if (!res.headersSent) {
      json(res, aborted ? 504 : 502, {
        error: aborted ? `yukarı akış zaman aşımı (${timeoutMs}ms)` : `yukarı akışa ulaşılamadı: ${err.message}`,
        target: baseUrl,
      });
    }
  }
}

async function listExamples(res) {
  const dir = path.join(__dirname, 'examples');
  try {
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      try {
        const flow = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
        out.push({ file: f, id: flow.id, name: flow.name, description: flow.description, nodeCount: Object.keys(flow.nodes || {}).length, flow });
      } catch { /* bozuk örnek listeyi düşürmez */ }
    }
    return json(res, 200, { examples: out });
  } catch {
    return json(res, 200, { examples: [] });
  }
}

async function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // core/ klasörü web kökünün dışında; tarayıcıya oradan servis edelim
  let filePath;
  if (rel.startsWith('/core/')) filePath = path.join(__dirname, rel);
  else filePath = path.join(ROOT, rel);

  const resolved = path.resolve(filePath);
  const allowed = [path.resolve(ROOT), path.resolve(path.join(__dirname, 'core'))];
  if (!allowed.some((a) => resolved === a || resolved.startsWith(a + path.sep))) {
    return json(res, 403, { error: 'yasak yol' });
  }
  try {
    const stat = await fsp.stat(resolved);
    if (stat.isDirectory()) return json(res, 404, { error: 'bulunamadı' });
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(resolved).pipe(res);
  } catch {
    json(res, 404, { error: `bulunamadı: ${rel}` });
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('gövde çok büyük')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  LLM Edge Bench  →  ${url}`);
  console.log(`  proxy: POST ${url}/api/llm`);
  if (SERVER_KEY) console.log('  API anahtarı sunucuda tutuluyor (tarayıcıya gitmez)');
  if (SERVER_BASE) console.log(`  varsayılan baseUrl: ${SERVER_BASE}`);
  console.log('');
  if (args.open) {
    // Kabuk yok: URL argüman dizisi olarak geçer, dolayısıyla --host/--port
    // içindeki shell metakarakterleri yorumlanamaz.
    import('node:child_process').then(({ spawn }) => {
      const [cmd, argv] = process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(cmd, argv, { detached: true, stdio: 'ignore' }).unref();
    });
  }
});

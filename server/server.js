'use strict';
// خادم Bta3 Anime المحلي: يقدّم الواجهة، ويدير التحميل والضغط في الخلفية على اللابتوب.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ff = require('./lib/ffmpeg');
const U = require('./lib/util');
const { Manager, Fail } = require('./lib/jobs');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const CATALOG_DIR = process.env.BTA3_CATALOG_DIR || path.join(ROOT, 'data');
const PREFERRED_PORT = Number(process.env.BTA3_PORT) || 8787;
const NO_OPEN = process.argv.includes('--no-open') || process.env.BTA3_NO_OPEN === '1';
const APP_ID = 'bta3-anime-web';

function pickStateDir() {
  const candidates = [process.env.BTA3_STATE_DIR, path.join(ROOT, 'state'), path.join(os.homedir(), '.bta3-anime')].filter(Boolean);
  for (const d of candidates) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (_) { /* next */ }
  }
  throw new Error('لا يوجد مجلد قابل للكتابة لحفظ حالة البرنامج');
}

// ---------- الكتالوج ----------
function loadCatalog() {
  const videosRaw = U.readJson(path.join(CATALOG_DIR, 'videos.json'), []);
  const playlists = U.readJson(path.join(CATALOG_DIR, 'playlists.json'), []);
  const map = new Map();
  for (const v of videosRaw) {
    if (!v || !v.id || v.isShow === false) continue;
    map.set(v.id, {
      id: v.id,
      title: String(v.title || '').trim(),
      image: v.image || '',
      video: v.video || '',
      video2: v.video2 || '',
      description: v.description || '',
      playList: v.playList || '',
      views: Number(v.views) || 0,
      date: v.date || '',
      type: v.type || 'all',
      download: v.download || '',
    });
  }
  return { map, playlists };
}

const catalog = loadCatalog();
const stateDir = pickStateDir();
const manager = new Manager({ dataDir: stateDir, catalog: catalog.map });

function publicCatalog() {
  return {
    videos: Array.from(catalog.map.values()).map((v) => ({
      id: v.id, title: v.title, image: v.image, video: v.video, video2: v.video2,
      description: v.description, playList: v.playList, views: v.views, date: v.date, type: v.type,
      hasDownload: /^https?:\/\//i.test(v.download),
    })),
    playlists: catalog.playlists,
  };
}

function systemSnapshot() {
  const s = ff.status;
  return {
    platform: process.platform,
    ffmpeg: {
      state: s.state, percent: s.percent, version: s.version, error: s.error,
      hw: s.hw, encoders: { libx264: s.encoders.libx264, libx265: s.encoders.libx265 },
    },
    settings: manager.settings,
    freeBytes: Number.isFinite(U.freeBytes(manager.saveDir)) ? U.freeBytes(manager.saveDir) : null,
  };
}

// ---------- أدوات HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 65536)) { reject(new Fail('الطلب كبير جدًا', false)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(new Fail('JSON غير صالح', false)); }
    });
    req.on('error', reject);
  });
}

let listenPort = PREFERRED_PORT;
function allowedHost(h) {
  if (!h) return false;
  return [`localhost:${listenPort}`, `127.0.0.1:${listenPort}`, `[::1]:${listenPort}`].includes(h.toLowerCase());
}

// حماية: الخادم يكتب ملفات ويشغّل ffmpeg، فلا نقبل طلبات من مواقع أخرى (CSRF / DNS rebinding)
function guard(req, res) {
  if (!allowedHost(req.headers.host)) { sendJson(res, 403, { error: 'host not allowed' }); return false; }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.headers['x-bta3'] !== '1') { sendJson(res, 403, { error: 'missing header' }); return false; }
    const origin = req.headers.origin;
    if (origin) {
      let oh = '';
      try { oh = new URL(origin).host; } catch (_) { oh = ''; }
      if (!allowedHost(oh)) { sendJson(res, 403, { error: 'origin not allowed' }); return false; }
    }
  }
  return true;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC, rel);
  if (!U.isInside(PUBLIC, file)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size };
    headers['Cache-Control'] = ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function serveMedia(req, res, name, asDownload) {
  const p = manager.libraryPath(name);
  if (!p || !U.exists(p)) { res.writeHead(404); return res.end('not found'); }
  const st = fs.statSync(p);
  const ext = path.extname(p).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (asDownload) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`;
  let start = 0;
  let end = st.size - 1;
  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); } else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
  } else {
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
  }
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(p, { start, end });
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

// ---------- SSE ----------
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.write(payload); } catch (_) { clients.delete(c); } }
}
manager.on('change', () => broadcast('jobs', manager.listJobs()));
manager.on('toast', (t) => broadcast('toast', t));
setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch (_) { clients.delete(c); } } }, 20000);
setInterval(() => { if (ff.status.state === 'downloading') broadcast('system', systemSnapshot()); }, 1000);

// ---------- فتح المتصفح / المجلد ----------
function openExternal(target, reveal) {
  try {
    if (process.platform === 'win32') {
      if (reveal) spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      else spawn('cmd', ['/c', 'start', '""', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', reveal ? ['-R', target] : [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [reveal ? path.dirname(target) : target], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch (_) { return false; }
}

// ---------- المسارات ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/ping') return sendJson(res, 200, { app: APP_ID, ok: true });
  if (p === '/api/catalog' && m === 'GET') return sendJson(res, 200, publicCatalog());
  if (p === '/api/system' && m === 'GET') return sendJson(res, 200, systemSnapshot());
  if (p === '/api/system/ffmpeg-setup' && m === 'POST') { ff.setup().then(() => broadcast('system', systemSnapshot())); return sendJson(res, 200, { started: true }); }

  if (p === '/api/settings' && m === 'GET') return sendJson(res, 200, manager.settings);
  if (p === '/api/settings' && m === 'POST') {
    const body = await readBody(req);
    try { manager.updateSettings(body); } catch (e) { throw new Fail('تعذّر حفظ الإعدادات: ' + (e.code === 'EACCES' ? 'لا يوجد إذن بالكتابة في هذا المجلد' : e.message), false); }
    broadcast('system', systemSnapshot());
    return sendJson(res, 200, manager.settings);
  }

  if (p === '/api/options' && m === 'GET') {
    const videoId = url.searchParams.get('videoId');
    const file = url.searchParams.get('file');
    const data = videoId ? await manager.optionsForVideo(videoId) : await manager.optionsForFile(file);
    return sendJson(res, 200, {
      ffmpeg: ff.status.state,
      sizeBytes: data.sizeBytes,
      probeError: data.probeError,
      built: data.built,
      hw: ff.status.hw,
      hevcAvailable: ff.status.encoders.libx265 || !!ff.status.hw.hevc,
      defaults: { codec: manager.settings.defaultCodec, speed: manager.settings.defaultSpeed, keepOriginal: manager.settings.keepOriginal },
      saveDir: manager.saveDir,
    });
  }

  if (p === '/api/jobs' && m === 'GET') return sendJson(res, 200, manager.listJobs());
  if (p === '/api/jobs' && m === 'POST') {
    const b = await readBody(req);
    return sendJson(res, 200, manager.addDownload(String(b.videoId || ''), b));
  }
  if (p === '/api/jobs/compress-file' && m === 'POST') {
    const b = await readBody(req);
    return sendJson(res, 200, manager.addCompressFile(String(b.file || ''), b));
  }
  if (p === '/api/jobs/clear-finished' && m === 'POST') { manager.clearFinished(); return sendJson(res, 200, { ok: true }); }
  const jm = /^\/api\/jobs\/([a-z0-9]+)\/(pause|resume|cancel|retry|remove)$/.exec(p);
  if (jm && m === 'POST') {
    const [, id, action] = jm;
    let r;
    if (action === 'pause') r = await manager.pause(id);
    else if (action === 'resume') r = await manager.resume(id);
    else if (action === 'cancel') r = await manager.cancel(id);
    else if (action === 'retry') r = manager.retry(id);
    else r = manager.remove(id);
    return sendJson(res, 200, r || { ok: true });
  }

  if (p === '/api/library' && m === 'GET') return sendJson(res, 200, { dir: manager.saveDir, files: manager.listLibrary() });
  if (p === '/api/library' && m === 'DELETE') { manager.deleteLibrary(String(url.searchParams.get('name') || '')); return sendJson(res, 200, { ok: true }); }
  if (p === '/api/open-folder' && m === 'POST') {
    const b = await readBody(req);
    let target = manager.saveDir;
    let reveal = false;
    if (b.name) { const f = manager.libraryPath(String(b.name)); if (f && U.exists(f)) { target = f; reveal = true; } }
    fs.mkdirSync(manager.saveDir, { recursive: true });
    return sendJson(res, 200, { ok: openExternal(target, reveal) });
  }

  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    res.write(`event: jobs\ndata: ${JSON.stringify(manager.listJobs())}\n\n`);
    res.write(`event: system\ndata: ${JSON.stringify(systemSnapshot())}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!guard(req, res)) return;
    if (url.pathname.startsWith('/api/')) {
      try { await handleApi(req, res, url); } catch (e) {
        if (res.headersSent) return res.end();
        const msg = e && e.message ? e.message : 'خطأ غير متوقع';
        sendJson(res, e instanceof Fail ? 400 : 500, { error: msg });
      }
      return;
    }
    if (url.pathname.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
      let name = '';
      try { name = decodeURIComponent(url.pathname.slice(7)); } catch (_) { name = ''; }
      return serveMedia(req, res, name, url.searchParams.get('download') === '1');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url.pathname);
  } catch (e) {
    try { res.writeHead(500); res.end('error'); } catch (_) { /* ignore */ }
  }
});

// ---------- التشغيل ----------
function openBrowser(url) {
  if (NO_OPEN) return;
  openExternal(url, false);
}

function pingExisting(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b).app === APP_ID); } catch (_) { resolve(false); } });
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
}

function tryListen(port, left) {
  return new Promise((resolve, reject) => {
    const onErr = async (e) => {
      server.removeListener('listening', onOk);
      if (e.code === 'EADDRINUSE') {
        if (await pingExisting(port)) return resolve({ existing: true, port });
        if (left > 0) return resolve(tryListen(port + 1, left - 1));
      }
      reject(e);
    };
    const onOk = () => { server.removeListener('error', onErr); resolve({ existing: false, port }); };
    server.once('error', onErr);
    server.once('listening', onOk);
    listenPort = port;
    server.listen(port, '127.0.0.1');
  });
}

function shutdown() {
  try { manager.saveNow(); } catch (_) { /* ignore */ }
  for (const rt of manager.rt.values()) {
    if (rt.child) { try { rt.child.kill('SIGCONT'); } catch (_) { /* ignore */ } try { rt.child.kill('SIGKILL'); } catch (_) { /* ignore */ } }
  }
}
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('exit', shutdown);
process.on('uncaughtException', (e) => { console.error('[خطأ غير متوقع]', e && e.stack ? e.stack : e); });
process.on('unhandledRejection', (e) => { console.error('[وعد مرفوض]', e && e.stack ? e.stack : e); });

(async () => {
  const r = await tryListen(PREFERRED_PORT, 20);
  const url = `http://localhost:${r.port}/`;
  if (r.existing) {
    console.log(`البرنامج يعمل بالفعل على ${url} — سأفتح الصفحة فقط.`);
    openBrowser(url);
    setTimeout(() => process.exit(0), 500);
    return;
  }
  console.log('====================================================');
  console.log('  Bta3 Anime — نسخة الويب تعمل الآن');
  console.log('  افتح الرابط:  ' + url);
  console.log('  مجلد الحفظ:   ' + manager.saveDir);
  console.log('  لا تغلق هذه النافذة أثناء التحميل أو الضغط.');
  console.log('====================================================');
  manager.boot();
  openBrowser(url);
  ff.setup().then((ok) => {
    console.log(ok ? `أداة الضغط جاهزة (ffmpeg ${ff.status.version})` : `أداة الضغط غير جاهزة: ${ff.status.error}`);
    broadcast('system', systemSnapshot());
  });
})().catch((e) => { console.error('تعذّر تشغيل الخادم:', e.message); process.exit(1); });

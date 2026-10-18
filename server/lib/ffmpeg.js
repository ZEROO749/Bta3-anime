'use strict';
// تحديد مكان ffmpeg (أو تنزيله تلقائيًا مرة واحدة) + قراءة معلومات الفيديو + كشف المشفّرات.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const { exists, rmQuiet } = require('./util');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN_DIR = path.join(ROOT, 'bin');
const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const status = {
  state: 'checking', // checking | ready | downloading | missing | error
  percent: 0,
  path: null,
  version: null,
  error: null,
  encoders: { libx264: false, libx265: false, aac: false },
  hw: { h264: null, hevc: null }, // اسم المشفّر العتادي الذي نجح اختباره
  filters: { zscale: false, tonemap: false },
};

function assetName() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32') return 'ffmpeg-win32-x64.gz';
  if (p === 'darwin') return a === 'arm64' ? 'ffmpeg-darwin-arm64.gz' : 'ffmpeg-darwin-x64.gz';
  if (p === 'linux') return a === 'arm64' ? 'ffmpeg-linux-arm64.gz' : 'ffmpeg-linux-x64.gz';
  return null;
}

function runQuick(bin, args, timeoutMs) {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutMs || 15000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || ''), status: r.status };
  } catch (e) {
    return { ok: false, out: String(e && e.message), status: -1 };
  }
}

// يتحقق أن الملف يعمل ويدعم x264 + aac على الأقل.
function inspect(bin) {
  const v = runQuick(bin, ['-hide_banner', '-version'], 10000);
  if (!v.ok) return null;
  const e = runQuick(bin, ['-hide_banner', '-encoders'], 15000);
  if (!e.ok) return null;
  const f = runQuick(bin, ['-hide_banner', '-filters'], 15000);
  const encoders = {
    libx264: /\blibx264\b/.test(e.out),
    libx265: /\blibx265\b/.test(e.out),
    aac: /\baac\b/.test(e.out),
    names: e.out,
  };
  if (!encoders.libx264 || !encoders.aac) return null;
  const m = /ffmpeg version (\S+)/.exec(v.out);
  return {
    version: m ? m[1] : 'unknown',
    encoders,
    filters: { zscale: /\bzscale\b/.test(f.out), tonemap: /\btonemap\b/.test(f.out) },
  };
}

function candidates() {
  const list = [];
  if (process.env.FFMPEG_PATH) list.push(process.env.FFMPEG_PATH);
  list.push(path.join(BIN_DIR, EXE));
  list.push('ffmpeg'); // من PATH
  return list;
}

// اختبار تشفير عتادي حقيقي (إطار واحد) حتى لا نعتمد على وجود الاسم فقط.
function hwArgsFor(name, codec) {
  const base = ['-c:v', name];
  if (name.endsWith('_nvenc')) return base.concat(['-preset', 'p4', '-rc', 'vbr', '-b:v', '1000k']);
  if (name.endsWith('_qsv')) return base.concat(['-b:v', '1000k']);
  if (name.endsWith('_amf')) return base.concat(['-quality', 'balanced', '-b:v', '1000k']);
  if (name.endsWith('_videotoolbox')) return base.concat(['-b:v', '1000k']);
  return base;
}

function detectHardware(bin, namesText) {
  const order = process.platform === 'darwin'
    ? ['videotoolbox']
    : process.platform === 'win32' ? ['nvenc', 'qsv', 'amf'] : ['nvenc', 'qsv'];
  const res = { h264: null, hevc: null };
  for (const codec of ['h264', 'hevc']) {
    for (const kind of order) {
      const name = `${codec}_${kind}`;
      if (!new RegExp('\\b' + name + '\\b').test(namesText)) continue;
      const args = ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=0.5']
        .concat(hwArgsFor(name, codec), ['-pix_fmt', 'yuv420p', '-f', 'null', '-']);
      const r = runQuick(bin, args, 20000);
      if (r.ok) { res[codec] = name; break; }
    }
  }
  return res;
}

function activate(bin, info) {
  status.state = 'ready';
  status.path = bin;
  status.version = info.version;
  status.error = null;
  status.percent = 100;
  status.encoders = { libx264: info.encoders.libx264, libx265: info.encoders.libx265, aac: info.encoders.aac };
  status.filters = info.filters;
  status.hw = detectHardware(bin, info.encoders.names);
}

function locate() {
  for (const c of candidates()) {
    if (c !== 'ffmpeg' && !exists(c)) continue;
    const info = inspect(c);
    if (info) { activate(c, info); return true; }
  }
  return false;
}

// ---------- تنزيل ffmpeg ثابت من GitHub (مرة واحدة) ----------
function httpsGetFollow(url, onResponse, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: '*/*' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpsGetFollow(next, onResponse, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      onResponse(res, resolve, reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

let setupPromise = null;
function setup() {
  if (status.state === 'ready') return Promise.resolve(true);
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    try {
      if (locate()) return true;
      const asset = assetName();
      const url = process.env.BTA3_FFMPEG_URL || (asset && `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/${asset}`);
      if (!url) throw new Error('نظام التشغيل غير مدعوم لتنزيل أداة الضغط تلقائيًا');
      status.state = 'downloading';
      status.percent = 0;
      status.error = null;
      fs.mkdirSync(BIN_DIR, { recursive: true });
      const target = path.join(BIN_DIR, EXE);
      const tmp = target + '.download';
      rmQuiet(tmp);
      await httpsGetFollow(url, (res, resolve, reject) => {
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        const out = fs.createWriteStream(tmp);
        const gunzip = url.endsWith('.gz') ? zlib.createGunzip() : null;
        res.on('data', (c) => {
          got += c.length;
          if (total) status.percent = Math.min(99, Math.round((got / total) * 100));
        });
        res.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        if (gunzip) { gunzip.on('error', reject); res.pipe(gunzip).pipe(out); } else { res.pipe(out); }
      });
      fs.renameSync(tmp, target);
      if (!IS_WIN) fs.chmodSync(target, 0o755);
      const info = inspect(target);
      if (!info) throw new Error('الملف الذي تم تنزيله لا يعمل على هذا الجهاز');
      activate(target, info);
      return true;
    } catch (e) {
      status.state = 'error';
      status.error = String((e && e.message) || e);
      return false;
    } finally {
      setupPromise = null;
    }
  })();
  return setupPromise;
}

// ---------- قراءة معلومات الفيديو من خرج ffmpeg -i ----------
function parseProbe(text) {
  const info = { duration: 0, bitrateKbps: 0, video: null, audio: null, hdr: false };
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) info.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const br = /Duration:[^\n]*bitrate:\s*(\d+)\s*kb\/s/.exec(text);
  if (br) info.bitrateKbps = Number(br[1]);

  const lines = text.split(/\r?\n/);
  let rotation = 0;
  for (const line of lines) {
    const rot = /rotation of (-?[\d.]+) degrees/.exec(line);
    if (rot) rotation = Math.abs(Math.round(Number(rot[1]))) % 360;
  }
  for (const line of lines) {
    if (!info.video && /Stream #\d+:\d+.*: Video:/.test(line) && !/attached pic/.test(line)) {
      const codec = /Video:\s*([A-Za-z0-9_]+)/.exec(line);
      const size = /[,\s](\d{2,5})x(\d{2,5})[\s,\[]/.exec(line + ' ');
      const fps = /([\d.]+)\s*fps/.exec(line) || /([\d.]+)\s*tbr/.exec(line);
      const vbr = /(\d+)\s*kb\/s/.exec(line);
      let w = size ? Number(size[1]) : 0;
      let h = size ? Number(size[2]) : 0;
      if (rotation === 90 || rotation === 270) { const t = w; w = h; h = t; }
      info.video = {
        codec: codec ? codec[1] : 'unknown',
        width: w,
        height: h,
        fps: fps ? Number(fps[1]) : 30,
        bitrateKbps: vbr ? Number(vbr[1]) : 0,
        tenBit: /10le|10be|p010|yuv420p12/.test(line),
      };
      if (/smpte2084|arib-std-b67/.test(line)) info.hdr = true;
    } else if (!info.audio && /Stream #\d+:\d+.*: Audio:/.test(line)) {
      const codec = /Audio:\s*([A-Za-z0-9_]+)/.exec(line);
      const hz = /(\d+)\s*Hz/.exec(line);
      const ch = /Hz,\s*([^,]+),/.exec(line);
      const abr = /(\d+)\s*kb\/s/.exec(line);
      let channels = 2;
      if (ch) {
        const c = ch[1].trim();
        if (/^mono/.test(c)) channels = 1;
        else if (/^stereo/.test(c)) channels = 2;
        else { const m = /^(\d+)(?:\.(\d))?/.exec(c); if (m) channels = Number(m[1]) + Number(m[2] || 0); }
      }
      info.audio = {
        codec: codec ? codec[1] : 'unknown',
        hz: hz ? Number(hz[1]) : 44100,
        channels,
        bitrateKbps: abr ? Number(abr[1]) : 0,
      };
    }
  }
  return info;
}

// source: مسار ملف أو رابط http(s)
function probe(source, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    if (!status.path) return reject(new Error('أداة ffmpeg غير جاهزة بعد'));
    const args = ['-hide_banner', '-nostdin'];
    if (/^https?:/i.test(source)) args.push('-user_agent', UA);
    args.push('-i', source);
    const child = spawn(status.path, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } }, opts.timeoutMs || 40000);
    child.stderr.on('data', (c) => { if (err.length < 400000) err += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      const info = parseProbe(err);
      if (!info.video || !info.duration) return reject(new Error('تعذّرت قراءة معلومات الفيديو'));
      resolve(info);
    });
  });
}

module.exports = { status, setup, locate, probe, parseProbe, UA, ROOT, IS_WIN };

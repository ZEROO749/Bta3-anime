'use strict';
// مدير المهام: تحميل (استئناف Range) ← ضغط (ffmpeg) ← حفظ نهائي.
// يعمل في الخلفية داخل خادم اللابتوب، فلا يتوقف عند إغلاق صفحة الويب، ويستأنف تلقائيًا بعد إعادة التشغيل.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const ff = require('./ffmpeg');
const presets = require('./presets');
const cmp = require('./compress');
const power = require('./power');
const U = require('./util');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v']);
const MAX_RETRY_NO_PROGRESS = 12;

class Canceled extends Error { constructor() { super('canceled'); this.code = 'CANCELED'; } }
class Fail extends Error { constructor(m, retry) { super(m); this.code = 'FAIL'; this.retry = !!retry; } }

function httpMessage(code) {
  if (code === 404 || code === 410) return `الرابط لا يعمل — الملف غير موجود (${code})`;
  if (code === 401 || code === 403) return `الوصول إلى الرابط مرفوض (${code})`;
  if (code >= 500) return `الخادم لا يستجيب حاليًا (${code})`;
  return `الرابط لا يعمل (خطأ ${code})`;
}

function friendlyNetError(e) {
  const c = e && e.code;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'تعذّر الوصول إلى الخادم (لا يوجد إنترنت أو الرابط لا يعمل)';
  if (c === 'ECONNREFUSED' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'تعذّر الاتصال بالخادم';
  if (c === 'ETIMEDOUT' || (e && /timeout|stalled/i.test(e.message))) return 'انتهت مهلة الاتصال بالخادم';
  if (c === 'ECONNRESET' || c === 'EPIPE') return 'انقطع الاتصال أثناء التنزيل';
  if (c === 'ENOSPC') return 'مساحة التخزين ممتلئة';
  if (c === 'EACCES' || c === 'EPERM') return 'لا يوجد إذن بالكتابة في المجلد';
  if (c && String(c).startsWith('CERT')) return 'خطأ في الاتصال الآمن بالخادم';
  return (e && e.message) || 'خطأ غير معروف';
}

// طلب GET مع تتبّع التحويلات (Dropbox يحوّل إلى رابط موقّع).
function getFollow(url, headers, rt, hops) {
  hops = hops || 0;
  return new Promise((resolve, reject) => {
    if (hops > 8) return reject(new Fail('الرابط لا يعمل (تحويلات كثيرة)', false));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Fail('رابط التنزيل غير صالح', false)); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers: Object.assign({ 'User-Agent': ff.UA, Accept: '*/*', 'Accept-Encoding': 'identity' }, headers || {}) }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(getFollow(new URL(res.headers.location, u).toString(), headers, rt, hops + 1));
      }
      res.finalUrl = u.toString();
      resolve(res);
    });
    if (rt) rt.req = req;
    req.setTimeout(25000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

class Semaphore {
  constructor(n) { this.n = n; this.used = 0; this.q = []; }
  setLimit(n) { this.n = Math.max(1, n); this._pump(); }
  acquire() { return new Promise((r) => { this.q.push(r); this._pump(); }); }
  release() { this.used = Math.max(0, this.used - 1); this._pump(); }
  _pump() { while (this.used < this.n && this.q.length) { this.used++; this.q.shift()(); } }
}

class Manager extends EventEmitter {
  constructor(opts) {
    super();
    this.dataDir = opts.dataDir;
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.catalog = opts.catalog; // Map id -> video
    this.rt = new Map();
    this.optionCache = new Map();
    this.dlSem = new Semaphore(2);
    this.cpSem = new Semaphore(1);
    this._saveT = null;
    this._emitT = null;
    this._lastEmit = 0;

    const st = U.readJson(this.stateFile, {});
    this.settings = Object.assign({
      saveDir: path.join(os.homedir(), 'Downloads', 'Bta3 Anime'),
      maxDownloads: 2,
      keepAwake: true,
      defaultCodec: 'h264',
      defaultSpeed: 'balanced',
      keepOriginal: false,
    }, st.settings || {});
    this.jobs = Array.isArray(st.jobs) ? st.jobs : [];
    this.dlSem.setLimit(this.settings.maxDownloads);
  }

  // ---------- مسارات ----------
  get saveDir() { return this.settings.saveDir; }
  get cacheDir() { return path.join(this.saveDir, '.bta3-cache'); }
  ensureDirs() {
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  // ---------- تشغيل/استئناف بعد إعادة التشغيل ----------
  boot() {
    try { this.ensureDirs(); } catch (_) { /* ignore */ }
    for (const j of this.jobs) {
      if (j.status === 'running' || j.status === 'queued') {
        j.status = 'queued';
        j.message = 'استُؤنف تلقائيًا بعد إعادة تشغيل البرنامج';
      }
    }
    this.cleanOrphans();
    for (const j of this.jobs) if (j.status === 'queued') this.start(j);
    this.syncPower();
    this.save();
  }

  cleanOrphans() {
    try {
      const keep = new Set();
      for (const j of this.jobs) if (['queued', 'running', 'paused', 'failed'].includes(j.status)) keep.add(j.id);
      for (const f of fs.readdirSync(this.cacheDir)) {
        const id = f.split('.')[0];
        if (!keep.has(id)) U.rmQuiet(path.join(this.cacheDir, f));
      }
    } catch (_) { /* ignore */ }
  }

  // ---------- الحالة والإشعار ----------
  publicJob(j) {
    return {
      id: j.id, kind: j.kind, videoId: j.videoId, title: j.title, thumb: j.thumb,
      status: j.status, phase: j.phase, message: j.message, error: j.error,
      plan: j.plan, dl: j.dl, cp: j.cp, origBytes: j.origBytes,
      outputName: j.outputName, outputBytes: j.outputBytes,
      createdAt: j.createdAt, updatedAt: j.updatedAt,
    };
  }
  listJobs() { return this.jobs.slice().reverse().map((j) => this.publicJob(j)); }

  touch(job, immediate) {
    job.updatedAt = Date.now();
    const now = Date.now();
    const fire = () => { this._lastEmit = Date.now(); this._emitT = null; this.emit('change'); };
    if (immediate || now - this._lastEmit > 400) { clearTimeout(this._emitT); fire(); }
    else if (!this._emitT) this._emitT = setTimeout(fire, 400);
  }

  save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.saveNow(), 800);
  }
  saveNow() {
    try {
      const keepTerminal = this.jobs.filter((j) => ['done', 'failed', 'canceled'].includes(j.status)).slice(-40);
      const active = this.jobs.filter((j) => !['done', 'failed', 'canceled'].includes(j.status));
      this.jobs = keepTerminal.concat(active).sort((a, b) => a.createdAt - b.createdAt);
      U.writeJsonAtomic(this.stateFile, { settings: this.settings, jobs: this.jobs });
    } catch (_) { /* ignore */ }
  }

  syncPower() {
    const busy = this.jobs.some((j) => j.status === 'running' || j.status === 'queued');
    if (busy && this.settings.keepAwake) power.on(); else power.off();
  }

  setStatus(job, status, extra) {
    job.status = status;
    if (extra) Object.assign(job, extra);
    this.touch(job, true);
    this.save();
    this.syncPower();
  }

  // ---------- إعدادات ----------
  updateSettings(patch) {
    const s = this.settings;
    if (typeof patch.saveDir === 'string' && patch.saveDir.trim()) {
      const p = path.resolve(patch.saveDir.trim());
      fs.mkdirSync(p, { recursive: true });
      fs.accessSync(p, fs.constants.W_OK);
      s.saveDir = p;
      this.ensureDirs();
    }
    if (Number.isInteger(patch.maxDownloads)) { s.maxDownloads = Math.min(6, Math.max(1, patch.maxDownloads)); this.dlSem.setLimit(s.maxDownloads); }
    if (typeof patch.keepAwake === 'boolean') s.keepAwake = patch.keepAwake;
    if (patch.defaultCodec === 'h264' || patch.defaultCodec === 'hevc') s.defaultCodec = patch.defaultCodec;
    if (['fast', 'balanced', 'best'].includes(patch.defaultSpeed)) s.defaultSpeed = patch.defaultSpeed;
    if (typeof patch.keepOriginal === 'boolean') s.keepOriginal = patch.keepOriginal;
    this.saveNow();
    this.syncPower();
    this.emit('change');
    return s;
  }

  // ---------- خيارات الضغط والحجم المتوقع ----------
  async resolveRemote(url) {
    const res = await getFollow(url, { Range: 'bytes=0-0' }, null);
    try {
      if (res.statusCode >= 400 && res.statusCode !== 416) throw new Fail(httpMessage(res.statusCode), false);
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      if (/text\/html|application\/json|xml/.test(ct)) throw new Fail('الرابط لا يشير إلى ملف فيديو', false);
      let size = 0;
      const cr = /\/(\d+)\s*$/.exec(String(res.headers['content-range'] || ''));
      if (cr) size = Number(cr[1]);
      else if (res.statusCode === 200) size = Number(res.headers['content-length']) || 0;
      return { finalUrl: res.finalUrl, size };
    } finally { res.destroy(); }
  }

  async optionsForVideo(videoId) {
    const key = 'v:' + videoId;
    const c = this.optionCache.get(key);
    if (c && Date.now() - c.t < 20 * 60 * 1000) return c.v;
    const video = this.catalog.get(videoId);
    if (!video || !/^https?:\/\//i.test(video.download || '')) throw new Fail('لا يوجد رابط تنزيل لهذا الفيديو', false);
    const { finalUrl, size } = await this.resolveRemote(video.download);
    let out = { sizeBytes: size, built: null, probeError: null };
    if (ff.status.state === 'ready') {
      try {
        const probe = await ff.probe(finalUrl, { timeoutMs: 45000 });
        out.built = presets.buildOptions(probe, size);
      } catch (e) { out.probeError = e.message; }
    }
    this.optionCache.set(key, { t: Date.now(), v: out });
    return out;
  }

  libraryPath(name) {
    if (typeof name !== 'string' || name.includes('/') || name.includes('\\') || name.startsWith('.')) return null;
    const p = path.join(this.saveDir, name);
    if (!U.isInside(this.saveDir, p)) return null;
    if (!VIDEO_EXT.has(path.extname(p).toLowerCase())) return null;
    return p;
  }

  async optionsForFile(name) {
    const p = this.libraryPath(name);
    if (!p || !U.exists(p)) throw new Fail('الملف غير موجود', false);
    const st = fs.statSync(p);
    const key = `f:${name}:${st.mtimeMs}:${st.size}`;
    const c = this.optionCache.get(key);
    if (c) return c.v;
    if (ff.status.state !== 'ready') throw new Fail('أداة الضغط غير جاهزة بعد', false);
    const probe = await ff.probe(p, { timeoutMs: 30000 });
    const out = { sizeBytes: st.size, built: presets.buildOptions(probe, st.size), probeError: null };
    this.optionCache.set(key, { t: Date.now(), v: out });
    return out;
  }

  listLibrary() {
    const out = [];
    try {
      for (const f of fs.readdirSync(this.saveDir)) {
        if (f.startsWith('.')) continue;
        if (!VIDEO_EXT.has(path.extname(f).toLowerCase())) continue;
        const st = fs.statSync(path.join(this.saveDir, f));
        if (!st.isFile()) continue;
        out.push({ name: f, size: st.size, mtime: st.mtimeMs });
      }
    } catch (_) { /* المجلد غير موجود بعد */ }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  deleteLibrary(name) {
    const p = this.libraryPath(name);
    if (!p || !U.exists(p)) throw new Fail('الملف غير موجود', false);
    // لا نحذف ملفًا قيد الضغط حاليًا
    for (const j of this.jobs) if (j.paths && j.paths.src === p && ['queued', 'running', 'paused'].includes(j.status)) throw new Fail('الملف قيد المعالجة الآن', false);
    fs.unlinkSync(p);
    this.emit('change');
  }

  // ---------- إنشاء المهام ----------
  newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  normalizePlan(req) {
    const plan = { mode: 'save', speed: this.settings.defaultSpeed, keepOriginal: !!this.settings.keepOriginal, opt: null };
    if (req && req.mode === 'compress') {
      plan.mode = 'compress';
      plan.opt = { height: Number(req.height), fps: Number(req.fps), codec: req.codec === 'hevc' ? 'hevc' : 'h264' };
      if (!plan.opt.height || !plan.opt.fps) throw new Fail('خيار الضغط غير صالح', false);
    }
    if (req && ['fast', 'balanced', 'best'].includes(req.speed)) plan.speed = req.speed;
    if (req && typeof req.keepOriginal === 'boolean') plan.keepOriginal = req.keepOriginal;
    if (req && typeof req.replaceOriginal === 'boolean') plan.replaceOriginal = req.replaceOriginal;
    return plan;
  }

  addDownload(videoId, req) {
    const video = this.catalog.get(videoId);
    if (!video) throw new Fail('الفيديو غير موجود', false);
    if (!/^https?:\/\//i.test(video.download || '')) throw new Fail('لا يوجد رابط تنزيل لهذا الفيديو', false);
    const dup = this.jobs.find((j) => j.videoId === videoId && ['queued', 'running', 'paused'].includes(j.status));
    if (dup) return this.publicJob(dup);
    const plan = this.normalizePlan(req);
    this.ensureDirs();
    const id = this.newId();
    const job = {
      id, kind: 'download', videoId, title: video.title, thumb: video.image || '',
      source: { url: video.download },
      plan, status: 'queued', phase: 'download', message: '', error: '',
      dl: { received: 0, total: -1, speed: 0, etaMs: -1 },
      cp: { percent: 0, etaMs: -1, speed: 0, pass: 1, passes: 1, label: '' },
      origBytes: 0, outputName: '', outputBytes: 0,
      paths: { part: path.join(this.cacheDir, id + '.part'), src: path.join(this.cacheDir, id + '.src.mp4') },
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.jobs.push(job);
    this.touch(job, true);
    this.save();
    this.start(job);
    this.syncPower();
    return this.publicJob(job);
  }

  addCompressFile(name, req) {
    const p = this.libraryPath(name);
    if (!p || !U.exists(p)) throw new Fail('الملف غير موجود', false);
    const plan = this.normalizePlan(Object.assign({}, req, { mode: 'compress' }));
    const dup = this.jobs.find((j) => j.paths && j.paths.src === p && ['queued', 'running', 'paused'].includes(j.status));
    if (dup) return this.publicJob(dup);
    this.ensureDirs();
    const id = this.newId();
    const base = path.basename(name, path.extname(name));
    const job = {
      id, kind: 'compress-file', videoId: null, title: base, thumb: '',
      source: { file: name }, plan, status: 'queued', phase: 'compress', message: '', error: '',
      dl: { received: 0, total: -1, speed: 0, etaMs: -1 },
      cp: { percent: 0, etaMs: -1, speed: 0, pass: 1, passes: 1, label: '' },
      origBytes: fs.statSync(p).size, outputName: '', outputBytes: 0,
      paths: { src: p },
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.jobs.push(job);
    this.touch(job, true);
    this.save();
    this.start(job);
    this.syncPower();
    return this.publicJob(job);
  }

  // ---------- عناصر التحكم ----------
  find(id) { return this.jobs.find((j) => j.id === id); }

  makeRt(job) {
    const rt = {
      paused: job.status === 'paused',
      canceled: false,
      child: null,
      req: null,
      res: null,
      running: false,
      pauseAbort: false,
      waiters: [],
      waitIfPaused() {
        if (!rt.paused || rt.canceled) return Promise.resolve();
        return new Promise((r) => rt.waiters.push(r));
      },
      wake() { const w = rt.waiters.splice(0); w.forEach((f) => f()); },
    };
    this.rt.set(job.id, rt);
    return rt;
  }

  start(job) {
    let rt = this.rt.get(job.id);
    if (rt && rt.running) return;
    if (!rt) rt = this.makeRt(job);
    rt.running = true;
    this.runJob(job, rt).catch((e) => {
      // حماية أخيرة: لا نترك المهمة معلّقة أبدًا
      if (job.status !== 'canceled') this.fail(job, (e && e.message) || 'خطأ غير متوقع');
    }).finally(() => { rt.running = false; });
  }

  async pause(id) {
    const job = this.find(id);
    if (!job) throw new Fail('المهمة غير موجودة', false);
    if (!['queued', 'running'].includes(job.status)) return this.publicJob(job);
    let rt = this.rt.get(id);
    if (!rt) rt = this.makeRt(job);
    rt.paused = true;
    job.message = 'متوقف مؤقتًا';
    this.setStatus(job, 'paused');
    if (job.phase === 'download') {
      rt.pauseAbort = true;
      try { if (rt.res) rt.res.destroy(); else if (rt.req) rt.req.destroy(); } catch (_) { /* ignore */ }
    } else if (job.phase === 'compress' && rt.child) {
      const ok = await cmp.suspendChild(rt.child);
      if (!ok) {
        rt.paused = false;
        job.message = 'تعذّر تعليق الضغط على هذا النظام';
        this.setStatus(job, 'running');
        throw new Fail('تعذّر إيقاف الضغط مؤقتًا على هذا النظام', false);
      }
    }
    return this.publicJob(job);
  }

  async resume(id) {
    const job = this.find(id);
    if (!job) throw new Fail('المهمة غير موجودة', false);
    if (job.status !== 'paused') return this.publicJob(job);
    let rt = this.rt.get(id);
    if (!rt) rt = this.makeRt(job);
    rt.paused = false;
    rt.pauseAbort = false;
    job.message = '';
    this.setStatus(job, rt.running ? 'running' : 'queued');
    if (job.phase === 'compress' && rt.child) await cmp.resumeChild(rt.child);
    rt.wake();
    if (!rt.running) this.start(job);
    return this.publicJob(job);
  }

  async cancel(id) {
    const job = this.find(id);
    if (!job) throw new Fail('المهمة غير موجودة', false);
    if (['done', 'failed', 'canceled'].includes(job.status)) { this.remove(id); return; }
    const rt = this.rt.get(id);
    if (rt) {
      rt.canceled = true;
      try { if (rt.res) rt.res.destroy(); else if (rt.req) rt.req.destroy(); } catch (_) { /* ignore */ }
      if (rt.child) {
        try { if (rt.paused) await cmp.resumeChild(rt.child); } catch (_) { /* ignore */ }
        try { rt.child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }
      rt.wake();
    }
    this.cleanupJobFiles(job, { keepSrcForFileJob: true });
    this.setStatus(job, 'canceled', { message: 'أُلغيت المهمة' });
  }

  retry(id) {
    const job = this.find(id);
    if (!job) throw new Fail('المهمة غير موجودة', false);
    if (job.status !== 'failed' && job.status !== 'canceled') return this.publicJob(job);
    this.rt.delete(id);
    job.error = '';
    job.message = '';
    job.dl = { received: 0, total: -1, speed: 0, etaMs: -1 };
    job.cp = { percent: 0, etaMs: -1, speed: 0, pass: 1, passes: 1, label: '' };
    job.phase = job.kind === 'download' ? 'download' : 'compress';
    this.setStatus(job, 'queued');
    this.start(job);
    return this.publicJob(job);
  }

  remove(id) {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i < 0) return;
    const job = this.jobs[i];
    if (['queued', 'running', 'paused'].includes(job.status)) throw new Fail('ألغِ المهمة أولًا', false);
    this.jobs.splice(i, 1);
    this.rt.delete(id);
    this.save();
    this.emit('change');
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => ['queued', 'running', 'paused'].includes(j.status));
    this.save();
    this.emit('change');
  }

  cleanupJobFiles(job, opts) {
    if (!job.paths) return;
    const dir = this.cacheDir;
    try {
      for (const f of fs.readdirSync(dir)) if (f.startsWith(job.id + '.')) U.rmQuiet(path.join(dir, f));
    } catch (_) { /* ignore */ }
  }

  fail(job, message) {
    job.error = message;
    this.setStatus(job, 'failed', { message: '' });
    this.emit('toast', { type: 'error', title: job.title, text: message, jobId: job.id });
  }

  // ---------- التنفيذ ----------
  async runJob(job, rt) {
    try {
      if (job.kind === 'download') {
        job.phase = 'download';
        await this.phaseDownload(job, rt);
      }
      if (job.plan.mode === 'compress') {
        job.phase = 'compress';
        await this.phaseCompress(job, rt);
      }
      await this.phaseFinish(job, rt);
      this.touch(job, true);
    } catch (e) {
      if (e && e.code === 'CANCELED') return; // الحالة ضُبطت داخل cancel()
      if (rt.canceled) return;
      const m = e instanceof Fail || (e && e.code === 'COMPRESS') ? e.message : friendlyNetError(e);
      this.fail(job, m);
    }
  }

  // تنفيذ دالة داخل خانة (تحميل/ضغط) مع احترام الإيقاف المؤقت والإلغاء
  async withSlot(sem, job, rt, fn) {
    for (;;) {
      if (rt.canceled) throw new Canceled();
      await rt.waitIfPaused();
      if (rt.canceled) throw new Canceled();
      if (sem.used >= sem.n && job.status !== 'paused') this.setStatus(job, 'queued', { message: 'في قائمة الانتظار…' });
      await sem.acquire();
      if (rt.canceled) { sem.release(); throw new Canceled(); }
      if (rt.paused) { sem.release(); continue; }
      try {
        if (job.status === 'queued') this.setStatus(job, 'running', { message: '' });
        const r = await fn();
        if (r === 'paused') continue;
        return r;
      } finally { sem.release(); }
    }
  }

  // ----- التحميل -----
  async phaseDownload(job, rt) {
    if (U.exists(job.paths.src) && fs.statSync(job.paths.src).size > 0) { // اكتمل سابقًا
      job.origBytes = fs.statSync(job.paths.src).size;
      return;
    }
    let failures = 0;
    let lastReceived = -1;
    for (;;) {
      const r = await this.withSlot(this.dlSem, job, rt, async () => {
        try {
          return await this.downloadOnce(job, rt);
        } catch (e) {
          if (rt.canceled) throw new Canceled();
          if (rt.pauseAbort && rt.paused) return 'paused';
          throw e;
        }
      }).catch((e) => {
        if (e && e.code === 'CANCELED') throw e;
        return e; // أخطاء قابلة لإعادة المحاولة تُعالج أدناه
      });
      if (r === 'done') return;
      if (r instanceof Error) {
        if (r instanceof Fail && !r.retry) {
          if (!r.keepPart) U.rmQuiet(job.paths.part);
          throw r;
        }
        const received = job.dl.received;
        if (received > lastReceived) { failures = 0; lastReceived = received; }
        failures++;
        if (failures > MAX_RETRY_NO_PROGRESS) throw new Fail((r instanceof Fail ? r.message : friendlyNetError(r)) + ' — اضغط «إعادة المحاولة» لاحقًا', false);
        const wait = Math.min(30000, 1500 * Math.pow(2, Math.min(failures, 5)));
        const why = r instanceof Fail ? r.message : friendlyNetError(r);
        job.message = `${why} — إعادة المحاولة (${failures}/${MAX_RETRY_NO_PROGRESS})…`;
        job.dl.speed = 0;
        this.touch(job, true);
        await this.sleepInterruptible(wait, rt);
        if (rt.canceled) throw new Canceled();
      }
    }
  }

  async sleepInterruptible(ms, rt) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (rt.canceled || rt.paused) return;
      await U.sleep(250);
    }
  }

  async downloadOnce(job, rt) {
    this.ensureDirs();
    const part = job.paths.part;
    let offset = 0;
    try { offset = fs.statSync(part).size; } catch (_) { offset = 0; }
    rt.pauseAbort = false;
    const res = await getFollow(job.source.url, offset > 0 ? { Range: `bytes=${offset}-` } : {}, rt);
    rt.res = res;
    try {
      if (rt.canceled) { res.destroy(); throw new Canceled(); }
      if (rt.paused) { res.destroy(); return 'paused'; }
      const code = res.statusCode;
      if (code === 416) {
        const cr = /\/(\d+)\s*$/.exec(String(res.headers['content-range'] || ''));
        res.resume();
        if (offset > 0 && cr && Number(cr[1]) === offset) { return this.completeDownload(job, offset, offset); }
        U.rmQuiet(part);
        throw new Fail('إعادة التنزيل من البداية', true);
      }
      if (code >= 400) { res.resume(); throw new Fail(httpMessage(code), code >= 500 || code === 429); }
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      if (/text\/html|application\/json|xml/.test(ct)) { res.resume(); throw new Fail('الرابط لا يشير إلى ملف فيديو (الرابط ميت أو الصفحة غير صالحة)', false); }

      let append = false;
      let total = -1;
      if (offset > 0 && code === 206) {
        append = true;
        const cr = /\/(\d+)\s*$/.exec(String(res.headers['content-range'] || ''));
        if (cr) total = Number(cr[1]);
        else if (res.headers['content-length']) total = offset + Number(res.headers['content-length']);
      } else {
        offset = 0; // الخادم تجاهل Range ← نبدأ من الصفر
        total = res.headers['content-length'] ? Number(res.headers['content-length']) : -1;
      }
      job.dl.total = total;
      job.dl.received = offset;
      job.message = '';
      this.touch(job, true);

      const state = await this.pump(res, part, append, job, rt);
      if (state === 'paused') return 'paused';
      const size = fs.statSync(part).size;
      if (size <= 0) throw new Fail('الملف فارغ — الرابط لا يعمل', false);
      if (total > 0 && size < total) throw new Fail('انقطع الاتصال قبل اكتمال الملف', true); // انقطاع مبكر ← استئناف
      return this.completeDownload(job, size, total);
    } finally {
      rt.res = null;
    }
  }

  completeDownload(job, size, total) {
    const src = job.paths.src;
    U.rmQuiet(src);
    fs.renameSync(job.paths.part, src);
    job.origBytes = size;
    job.dl.received = size;
    job.dl.total = size;
    job.dl.speed = 0;
    job.dl.etaMs = 0;
    this.touch(job, true);
    return 'done';
  }

  pump(res, part, append, job, rt) {
    return new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
      let settled = false;
      const samples = [];
      let lastSample = 0;
      const settle = (fn, v) => { if (settled) return; settled = true; fn(v); };
      const finishWrite = (cb) => { try { ws.end(cb); } catch (_) { cb(); } };

      res.setTimeout(30000, () => res.destroy(Object.assign(new Error('stalled'), { code: 'ETIMEDOUT' })));
      res.on('data', (c) => {
        job.dl.received += c.length;
        const now = Date.now();
        if (now - lastSample > 500) {
          lastSample = now;
          samples.push({ t: now, b: job.dl.received });
          while (samples.length > 2 && now - samples[0].t > 5000) samples.shift();
          const a = samples[0];
          const dt = (now - a.t) / 1000;
          if (dt > 0.4) {
            job.dl.speed = (job.dl.received - a.b) / dt;
            job.dl.etaMs = job.dl.total > 0 && job.dl.speed > 1 ? Math.round(((job.dl.total - job.dl.received) / job.dl.speed) * 1000) : -1;
          }
          this.touch(job, false);
        }
      });
      ws.on('error', (e) => { try { res.destroy(); } catch (_) { /* ignore */ } settle(reject, e); });
      res.on('error', (e) => {
        finishWrite(() => {
          if (rt.canceled) return settle(reject, new Canceled());
          if (rt.pauseAbort || rt.paused) return settle(resolve, 'paused');
          settle(reject, e);
        });
      });
      res.on('close', () => {
        if (res.complete) return; // انتهى بشكل سليم، تتولاه 'end'
        finishWrite(() => {
          if (rt.canceled) return settle(reject, new Canceled());
          if (rt.pauseAbort || rt.paused) return settle(resolve, 'paused');
          settle(reject, Object.assign(new Error('انقطع الاتصال أثناء التنزيل'), { code: 'ECONNRESET' }));
        });
      });
      res.on('end', () => finishWrite(() => settle(resolve, 'done')));
      res.pipe(ws, { end: false });
    });
  }

  // ----- الضغط -----
  async phaseCompress(job, rt) {
    const input = job.paths.src;
    if (ff.status.state !== 'ready') {
      // لا نفشل التحميل: نحفظ الأصل ونخبر المستخدم
      job.plan.mode = 'save';
      job.message = 'أداة الضغط غير جاهزة — سيُحفظ الفيديو الأصلي';
      job.compressSkipped = 'أداة الضغط غير جاهزة بعد، فحُفظ الأصل';
      return;
    }
    job.cp = { percent: 0, etaMs: -1, speed: 0, pass: 1, passes: 1, label: 'قراءة الفيديو…' };
    job.message = '';
    this.touch(job, true);
    let probe;
    try { probe = await ff.probe(input, { timeoutMs: 45000 }); } catch (e) {
      job.plan.mode = 'save';
      job.compressSkipped = 'تعذّرت قراءة الفيديو للضغط، فحُفظ الأصل';
      return;
    }
    const size = fs.statSync(input).size;
    const built = presets.buildOptions(probe, size);
    const opt = presets.resolveOption(built, job.plan.opt);
    if (!opt) throw new Fail('خيار الضغط المطلوب غير متاح لهذا الفيديو', false);
    const needed = opt.estBytes * 1.2 + 300 * 1048576;
    if (U.freeBytes(this.saveDir) < needed) throw new Fail('مساحة التخزين غير كافية للضغط (' + U.fmtBytes(needed) + ' مطلوبة تقريبًا)', false);

    const output = path.join(this.cacheDir, job.id + '.cmp.mp4');
    const ctl = {
      stallMs: 180000,
      setChild: (c) => { rt.child = c; if (c && rt.paused) cmp.suspendChild(c); },
      isPaused: () => rt.paused,
      isCanceled: () => rt.canceled,
      label: (l) => { job.cp.label = l; this.touch(job, false); },
      progress: (p) => { Object.assign(job.cp, p); this.touch(job, false); },
    };
    const result = await this.withSlot(this.cpSem, job, rt, async () => {
      job.phase = 'compress';
      this.touch(job, true);
      return cmp.compress({ input, output, probe, built, opt, speed: job.plan.speed, ctl });
    }).catch((e) => {
      if (e && e.code === 'CANCELED') throw e;
      // فشل الضغط لا يعني فشل المهمة: نحفظ الأصل
      job.compressSkipped = 'تعذّر الضغط فحُفظ الأصل: ' + (e && e.message ? String(e.message).slice(0, 180) : '');
      return null;
    });
    if (!result) { job.plan.mode = 'save'; return; }
    if (result.bytes >= size * 0.98) {
      U.rmQuiet(output);
      job.plan.mode = 'save';
      job.compressSkipped = 'لا يمكن تصغير هذا الفيديو أكثر دون خسارة جودة ملحوظة، فحُفظ كما هو';
      return;
    }
    job.cp.percent = 100;
    job.cp.etaMs = 0;
    job.paths.out = output;
    job.outputBytes = result.bytes;
    job.cp.label = result.label;
    this.touch(job, true);
  }

  // ----- الحفظ النهائي -----
  moveFile(from, to) {
    try { fs.renameSync(from, to); } catch (e) {
      if (e.code === 'EXDEV') { fs.copyFileSync(from, to); fs.unlinkSync(from); } else throw e;
    }
  }

  async phaseFinish(job, rt) {
    job.phase = 'finish';
    this.touch(job, true);
    const dir = this.saveDir;
    fs.mkdirSync(dir, { recursive: true });
    const base = U.safeName(job.title, 'video');
    let finalPath;
    if (job.kind === 'download') {
      if (job.plan.mode === 'compress' && job.paths.out) {
        finalPath = U.uniquePath(dir, base, '.mp4');
        this.moveFile(job.paths.out, finalPath);
        if (job.plan.keepOriginal) this.moveFile(job.paths.src, U.uniquePath(dir, base + ' (الأصل)', '.mp4'));
        else U.rmQuiet(job.paths.src);
      } else {
        finalPath = U.uniquePath(dir, base, '.mp4');
        this.moveFile(job.paths.src, finalPath);
      }
    } else { // ضغط ملف موجود في المكتبة
      if (job.paths.out) {
        const srcName = path.basename(job.paths.src, path.extname(job.paths.src));
        if (job.plan.replaceOriginal) {
          finalPath = U.uniquePath(dir, srcName, '.mp4');
          const old = job.paths.src;
          this.moveFile(job.paths.out, finalPath);
          U.rmQuiet(old);
        } else {
          finalPath = U.uniquePath(dir, srcName + ' (مضغوط)', '.mp4');
          this.moveFile(job.paths.out, finalPath);
        }
      } else {
        finalPath = job.paths.src; // لم يتغير شيء
      }
    }
    job.outputName = path.basename(finalPath);
    try { job.outputBytes = fs.statSync(finalPath).size; } catch (_) { /* ignore */ }
    job.phase = 'done';
    const saved = job.origBytes && job.outputBytes && job.paths.out !== undefined && job.plan.mode === 'compress'
      ? ` (${U.fmtBytes(job.origBytes)} ← ${U.fmtBytes(job.outputBytes)})` : '';
    job.message = (job.compressSkipped ? job.compressSkipped : 'تم الحفظ') + saved;
    this.cleanupJobFiles(job);
    this.setStatus(job, 'done');
    this.emit('toast', { type: job.compressSkipped ? 'warn' : 'ok', title: job.title, text: job.message, jobId: job.id });
  }
}

module.exports = { Manager, Fail, VIDEO_EXT, httpMessage };

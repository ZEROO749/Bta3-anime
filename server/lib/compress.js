'use strict';
// محرك الضغط: ffmpeg مع قياس تقدّم حقيقي، إيقاف مؤقت/استئناف حقيقي (تعليق العملية)،
// مراقب تعليق، محاولات بديلة تلقائية، والتحقق من الناتج قبل اعتماده.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ff = require('./ffmpeg');
const { crfFor } = require('./presets');
const { rmQuiet } = require('./util');

class CanceledError extends Error { constructor() { super('canceled'); this.code = 'CANCELED'; } }
class CompressError extends Error { constructor(m) { super(m); this.code = 'COMPRESS'; } }

// ---------- تعليق/استئناف العملية على كل الأنظمة ----------
function psSuspendResume(pid, fn) {
  return new Promise((resolve) => {
    const script = `$s='[DllImport("ntdll.dll")] public static extern int ${fn}(IntPtr h);'; ` +
      `$t=Add-Type -MemberDefinition $s -Name N${fn} -Namespace W -PassThru; ` +
      `$p=[System.Diagnostics.Process]::GetProcessById(${pid}); [void]$t::${fn}($p.Handle)`;
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
  });
}

async function suspendChild(child) {
  if (!child || child.exitCode !== null) return false;
  if (process.platform === 'win32') return psSuspendResume(child.pid, 'NtSuspendProcess');
  try { return child.kill('SIGSTOP'); } catch (_) { return false; }
}
async function resumeChild(child) {
  if (!child || child.exitCode !== null) return false;
  if (process.platform === 'win32') return psSuspendResume(child.pid, 'NtResumeProcess');
  try { return child.kill('SIGCONT'); } catch (_) { return false; }
}

// ---------- بناء أوامر ffmpeg ----------
function vfChain(opt, probe) {
  const f = [];
  if (probe.hdr && ff.status.filters.zscale && ff.status.filters.tonemap) {
    f.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  }
  if (opt.fpsChange) f.push(`fps=${opt.fps}`);
  if (opt.scale) f.push(`scale=-2:${opt.height}:flags=lanczos`);
  f.push('format=yuv420p');
  return f.join(',');
}

function softwareVideoArgs(plan, opt, pass, passlog) {
  const T = opt.videoKbps;
  const R = Math.round(T * 1.4);
  const B = Math.round(T * 2.8);
  const crf = crfFor(plan.codec, opt.height);
  const preset = plan.preset;
  const a = [];
  if (plan.codec === 'h264') {
    a.push('-c:v', 'libx264', '-preset', preset, '-profile:v', 'high');
    if (plan.tune) a.push('-tune', 'animation');
    if (plan.twoPass) {
      a.push('-b:v', T + 'k', '-pass', String(pass), '-passlogfile', passlog);
    } else {
      a.push('-crf', String(crf), '-maxrate', R + 'k', '-bufsize', B + 'k');
    }
  } else {
    a.push('-c:v', 'libx265', '-preset', preset, '-tag:v', 'hvc1');
    if (plan.tune) a.push('-tune', 'animation');
    let xp = 'log-level=error';
    if (plan.twoPass) {
      xp += `:pass=${pass}:stats=${passlog.replace(/\\/g, '/').replace(/:/g, '\\:')}`;
      a.push('-b:v', T + 'k');
    } else {
      xp += `:vbv-maxrate=${R}:vbv-bufsize=${B}`;
      a.push('-crf', String(crf));
    }
    a.push('-x265-params', xp);
  }
  return a;
}

function hardwareVideoArgs(plan, opt) {
  const T = opt.videoKbps;
  const R = Math.round(T * 1.5);
  const name = plan.hwName;
  const a = ['-c:v', name];
  if (name.endsWith('_nvenc')) a.push('-preset', 'p5', '-rc', 'vbr', '-b:v', T + 'k', '-maxrate', R + 'k', '-bufsize', R * 2 + 'k', '-spatial-aq', '1');
  else if (name.endsWith('_qsv')) a.push('-b:v', T + 'k', '-maxrate', R + 'k', '-look_ahead', '0');
  else if (name.endsWith('_amf')) a.push('-quality', 'quality', '-rc', 'vbr_peak', '-b:v', T + 'k', '-maxrate', R + 'k');
  else if (name.endsWith('_videotoolbox')) a.push('-b:v', T + 'k');
  else a.push('-b:v', T + 'k');
  if (plan.codec === 'hevc') a.push('-tag:v', 'hvc1');
  return a;
}

function audioArgs(built, probe) {
  if (!probe.audio) return ['-an'];
  if (built.audioCopy) return ['-c:a', 'copy'];
  return ['-c:a', 'aac', '-b:a', built.audioKbps + 'k', '-ac', String(Math.min(2, Math.max(1, probe.audio.channels)))];
}

function buildArgs(input, output, probe, built, opt, plan, pass, passlog) {
  const a = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-i', input,
    '-map', '0:v:0', '-vf', vfChain(opt, probe)];
  if (plan.hwName) a.push(...hardwareVideoArgs(plan, opt)); else a.push(...softwareVideoArgs(plan, opt, pass, passlog));
  a.push('-pix_fmt', 'yuv420p');
  if (plan.twoPass && pass === 1) {
    a.push('-an', '-f', 'null', '-');
  } else {
    a.push('-map', '0:a?', ...audioArgs(built, probe), '-sn', '-dn', '-map_metadata', '0', '-map_chapters', '0',
      '-movflags', '+faststart', '-max_muxing_queue_size', '4096', output);
  }
  return a;
}

// قائمة محاولات: الطلب الأصلي ثم بدائل أكثر أمانًا.
function makeAttempts(optSpeed, codec) {
  const attempts = [];
  const hwName = ff.status.hw && ff.status.hw[codec];
  if (optSpeed === 'fast') {
    if (hwName) attempts.push({ codec, hwName, label: 'تشفير بكرت الشاشة' });
    attempts.push({ codec, preset: 'veryfast', tune: true, twoPass: false, label: 'تشفير سريع' });
  } else if (optSpeed === 'best') {
    attempts.push({ codec, preset: 'slow', tune: true, twoPass: true, label: 'أعلى جودة (مرورين)' });
    attempts.push({ codec, preset: 'medium', tune: true, twoPass: false, label: 'جودة متوازنة' });
  } else {
    attempts.push({ codec, preset: 'medium', tune: true, twoPass: false, label: 'جودة متوازنة' });
  }
  // بدائل أخيرة مضمونة
  if (codec === 'hevc' && ff.status.encoders.libx264) attempts.push({ codec: 'h264', preset: 'veryfast', tune: false, twoPass: false, label: 'H.264 احتياطي' });
  attempts.push({ codec: 'h264', preset: 'ultrafast', tune: false, twoPass: false, label: 'وضع الأمان' });
  // إزالة x265 إن لم يكن متوفرًا
  return attempts.filter((p) => p.codec !== 'hevc' || ff.status.encoders.libx265 || p.hwName);
}

// ---------- تشغيل ffmpeg واحد ----------
function runFfmpeg(args, ctl, durationSec, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(ff.status.path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    ctl.setChild(child);
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { /* ignore */ }
    let stderrTail = '';
    let buf = '';
    let lastOut = 0;
    let lastSpeed = 0;
    let lastProgressAt = Date.now();
    let stalled = false;

    child.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString('utf8')).slice(-4000); });
    child.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq);
        const v = line.slice(eq + 1);
        if (k === 'out_time_us' || k === 'out_time_ms') {
          const n = Number(v);
          if (isFinite(n) && n >= 0) lastOut = n / 1e6;
        } else if (k === 'speed') {
          const s = parseFloat(v);
          if (isFinite(s) && s > 0) lastSpeed = lastSpeed ? lastSpeed * 0.7 + s * 0.3 : s;
        } else if (k === 'progress') {
          lastProgressAt = Date.now();
          onProgress(Math.min(lastOut, durationSec), lastSpeed);
        }
      }
    });

    const watchdog = setInterval(() => {
      if (ctl.isPaused()) { lastProgressAt = Date.now(); return; }
      if (Date.now() - lastProgressAt > ctl.stallMs) {
        stalled = true;
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }
    }, 4000);

    child.on('error', (e) => { clearInterval(watchdog); ctl.setChild(null); reject(new CompressError('تعذّر تشغيل ffmpeg: ' + e.message)); });
    child.on('close', (code, signal) => {
      clearInterval(watchdog);
      ctl.setChild(null);
      if (ctl.isCanceled()) return reject(new CanceledError());
      if (stalled) return reject(new CompressError('توقف الضغط عن التقدم (تعليق)'));
      if (code !== 0) return reject(new CompressError('ffmpeg فشل (' + (code === null ? signal : code) + '): ' + stderrTail.split('\n').filter(Boolean).slice(-3).join(' | ')));
      resolve();
    });
  });
}

// يتحقق أن الملف الناتج سليم ومدته مطابقة.
async function validate(output, srcDuration) {
  let st;
  try { st = fs.statSync(output); } catch (_) { throw new CompressError('الملف الناتج غير موجود'); }
  if (!st.size) throw new CompressError('الملف الناتج فارغ');
  let info;
  try { info = await ff.probe(output, { timeoutMs: 30000 }); } catch (_) { throw new CompressError('الملف الناتج غير قابل للقراءة'); }
  const tol = Math.max(2, srcDuration * 0.02);
  if (Math.abs(info.duration - srcDuration) > tol) throw new CompressError(`مدة الناتج لا تطابق الأصل (${info.duration.toFixed(1)}s مقابل ${srcDuration.toFixed(1)}s)`);
  return st.size;
}

/**
 * ctl: { setChild, isPaused, isCanceled, progress({percent,etaMs,speed,pass,passes,label}), stallMs }
 */
async function compress({ input, output, probe, built, opt, speed, ctl }) {
  if (ff.status.state !== 'ready') throw new CompressError('أداة الضغط غير جاهزة');
  const attempts = makeAttempts(speed, opt.codec);
  const notes = [];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const plan = attempts[i];
    const passes = plan.twoPass ? 2 : 1;
    const passlog = output + '.passlog';
    ctl.label(plan.label);
    try {
      for (let pass = 1; pass <= passes; pass++) {
        const args = buildArgs(input, output, probe, built, opt, plan, pass, passlog);
        const weight = passes === 2 ? (pass === 1 ? 0.4 : 0.6) : 1;
        const base = passes === 2 ? (pass === 1 ? 0 : 0.4) : 0;
        await runFfmpeg(args, ctl, probe.duration, (outSec, spd) => {
          const frac = base + weight * (probe.duration > 0 ? outSec / probe.duration : 0);
          const done = (pass - 1) * probe.duration + outSec; // ثواني فيديو تمت معالجتها عبر كل المرورات
          const remaining = Math.max(0, passes * probe.duration - done);
          const etaMs = spd > 0.01 && outSec > 0.5 ? Math.round((remaining / spd) * 1000) : -1;
          ctl.progress({ percent: Math.max(0, Math.min(99, Math.round(frac * 100))), etaMs, speed: spd, pass, passes, label: plan.label });
        });
      }
      const bytes = await validate(output, probe.duration);
      cleanupPassLogs(passlog);
      return { bytes, attempt: i + 1, label: plan.label, notes };
    } catch (e) {
      cleanupPassLogs(passlog);
      rmQuiet(output);
      if (e instanceof CanceledError || (e && e.code === 'CANCELED')) throw e;
      lastErr = e;
      notes.push(`${plan.label}: ${e.message}`);
      if (ctl.isCanceled()) throw new CanceledError();
    }
  }
  throw new CompressError('فشلت كل محاولات الضغط. ' + (lastErr ? lastErr.message : ''));
}

function cleanupPassLogs(base) {
  try {
    const dir = path.dirname(base);
    const name = path.basename(base);
    for (const f of fs.readdirSync(dir)) if (f.startsWith(name)) rmQuiet(path.join(dir, f));
  } catch (_) { /* ignore */ }
}

module.exports = { compress, suspendChild, resumeChild, CanceledError, CompressError, buildArgs, makeAttempts };

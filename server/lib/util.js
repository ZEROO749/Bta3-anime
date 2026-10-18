'use strict';
// أدوات مساعدة صغيرة بدون أي مكتبات خارجية.
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtBytes(n) {
  if (!isFinite(n) || n < 0) return '—';
  const mb = n / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

// اسم ملف آمن على ويندوز/ماك/لينكس (يحافظ على العربية والإيموجي المسموح).
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function safeName(title, fallback) {
  let s = String(title == null ? '' : title)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // الإيموجي مسموح لكن بعض الأنظمة تتعثر معه؛ نحذف رموز التنويع فقط ونبقي الباقي.
  s = s.replace(/[︎️⃣]/g, '');
  s = s.replace(/[. ]+$/g, '');
  if (s.length > 90) s = s.slice(0, 90).trim();
  if (!s || RESERVED.test(s)) s = fallback || 'video';
  return s;
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}

// يعيد مسارًا غير مستخدم: name.ext ثم name (1).ext ...
function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  let i = 1;
  while (exists(p)) {
    p = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  return p;
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return dflt; }
}

// هل target داخل base (حماية من ../ )
function isInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function freeBytes(dir) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(dir);
      return Number(s.bavail) * Number(s.bsize);
    }
  } catch (_) { /* ignore */ }
  return Infinity;
}

function rmQuiet(p) {
  try { fs.rmSync(p, { force: true, recursive: true }); } catch (_) { /* ignore */ }
}

module.exports = { sleep, fmtBytes, safeName, uniquePath, writeJsonAtomic, readJson, isInside, freeBytes, rmQuiet, exists };

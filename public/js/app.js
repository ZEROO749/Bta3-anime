'use strict';
// واجهة Bta3 Anime (نسخة الحاسوب). تتصل بالخادم المحلي: الكتالوج، المهام (SSE)، الإعدادات، المكتبة.

const state = {
  videos: [], playlists: [], byId: new Map(), plById: new Map(),
  jobs: [], system: null, library: null,
  view: null, // { name, onJobs, onSystem, cleanup }
  online: false,
};
const ACTIVE = ['queued', 'running', 'paused'];
const isActive = (j) => ACTIVE.includes(j.status);

// ---------- الاتصال بالخادم ----------
async function api(path, opts) {
  const o = opts || {};
  const init = { method: o.method || 'GET', headers: { 'X-Bta3': '1' } };
  if (o.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
  let res;
  try { res = await fetch(path, init); } catch (_) { throw new Error('تعذّر الاتصال بالبرنامج — تأكد أنه ما زال يعمل على اللابتوب'); }
  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }
  if (!res.ok) throw new Error((data && data.error) || `خطأ ${res.status}`);
  return data;
}
const post = (path, body) => api(path, { method: 'POST', body: body || {} });

function connectEvents() {
  const es = new EventSource('/api/events');
  const conn = $('#conn');
  const setConn = (s, t) => { state.online = s === 'ok'; conn.dataset.state = s; conn.title = t; };
  es.addEventListener('open', () => setConn('ok', 'متصل بالبرنامج'));
  es.addEventListener('error', () => setConn('off', 'انقطع الاتصال بالبرنامج — يُعاد الاتصال تلقائيًا'));
  es.addEventListener('jobs', (e) => { state.jobs = JSON.parse(e.data); onJobsChanged(); });
  es.addEventListener('system', (e) => { state.system = JSON.parse(e.data); if (state.view && state.view.onSystem) state.view.onSystem(); systemHooks.forEach((f) => f()); });
  es.addEventListener('toast', (e) => {
    const t = JSON.parse(e.data);
    toast(t.text, { type: t.type, title: t.title });
  });
}
const systemHooks = new Set();

// ---------- بيانات مساعدة ----------
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}
function byDateDesc(a, b) { return String(b.date).localeCompare(String(a.date)); }
function plTitle(id) { const p = state.plById.get(id); return p ? p.title : ''; }
function activeJobFor(videoId) { return state.jobs.find((j) => j.videoId === videoId && isActive(j)); }
function doneJobFor(videoId) { return state.jobs.find((j) => j.videoId === videoId && j.status === 'done' && j.outputName); }
function resLabel(h) {
  if (h >= 2000) return '4K';
  if (h >= 1400) return '2K';
  if (h >= 1000) return 'Full HD';
  if (h >= 700) return 'HD';
  if (h >= 450) return 'SD';
  return 'منخفضة';
}

// ---------- مكوّنات مشتركة ----------
function videoCard(v) {
  const job = activeJobFor(v.id);
  const done = !job && doneJobFor(v.id);
  const img = h('img', { src: v.image || '', alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => { e.target.style.visibility = 'hidden'; } });
  return h('a.vcard', { href: `#/video/${encodeURIComponent(v.id)}`, 'aria-label': v.title },
    h('div.vthumb', img,
      h('div.vbadges',
        v.hasDownload ? h('span.vb.dl', icon('download', 13), 'يُحفظ') : null,
        job ? h('span.vb.busy', job.status === 'paused' ? 'متوقف' : 'جارٍ…') : null,
        done ? h('span.vb.ok', icon('check', 13), 'محفوظ') : null)),
    h('div.vinfo', h('h3', { dir: 'auto' }, v.title),
      h('p.vmeta', icon('eye', 14), fmtNum(v.views))));
}
function emptyState(title, text, action) {
  return h('div.empty', icon('film', 40), h('h3', title), text ? h('p', text) : null, action || null);
}
function sectionHead(title, linkText, href) {
  return h('div.sec-head', h('h2', { dir: 'auto' }, title), linkText ? h('a.sec-link', { href }, linkText) : null);
}
function confirmDialog(title, text, okLabel, danger) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({ title, cls: 'small', onClose: () => { if (!done) resolve(false); } });
    m.body.appendChild(h('p.confirm-text', text));
    m.foot.append(
      btn('إلغاء', { cls: 'ghost', onclick: () => m.close() }),
      btn(okLabel || 'تأكيد', { cls: danger ? 'danger' : 'primary', onclick: () => { done = true; resolve(true); m.close(); } }));
  });
}

// ---------- المسارات ----------
function setActiveNav(name) {
  $$('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === name));
}
function mount(name, node, hooks) {
  if (state.view && state.view.cleanup) { try { state.view.cleanup(); } catch (_) { /* ignore */ } }
  state.view = Object.assign({ name }, hooks || {});
  const root = $('#view');
  clear(root);
  root.appendChild(node);
  setActiveNav(name === 'video' || name === 'playlist' ? 'home' : name);
  renderDock();
}
function route() {
  const hash = (location.hash || '#/').replace(/^#/, '');
  const parts = hash.split('/').filter((x) => x !== '');
  const [a, b] = parts;
  window.scrollTo(0, 0);
  try {
    if (!a) viewHome();
    else if (a === 'search') viewSearch(b ? decodeURIComponent(b) : '');
    else if (a === 'playlist' && b) viewPlaylist(decodeURIComponent(b));
    else if (a === 'video' && b) viewVideo(decodeURIComponent(b));
    else if (a === 'downloads') viewDownloads();
    else if (a === 'settings') viewSettings();
    else viewHome();
  } catch (e) {
    mount('home', emptyState('حدث خطأ في عرض الصفحة', e.message));
  }
  const f = $('#view'); try { f.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
}

// ================= الرئيسية =================
function viewHome() {
  const page = h('div.page');
  const vids = state.videos.slice().sort(byDateDesc);
  const hero = vids.find((v) => v.image && v.hasDownload) || vids.find((v) => v.image) || vids[0];
  if (hero) {
    page.appendChild(h('section.hero', { style: { '--hero': `url("${String(hero.image).replace(/"/g, '%22')}")` } },
      h('div.hero-bg'),
      h('div.hero-in',
        h('span.hero-tag', 'جديد'),
        h('h1', { dir: 'auto' }, hero.title),
        h('p', { dir: 'auto' }, (hero.description || '').split('\n').filter(Boolean).slice(0, 2).join(' — ').slice(0, 220)),
        h('div.hero-act',
          h('a.btn.primary', { href: `#/video/${encodeURIComponent(hero.id)}` }, icon('play', 18), h('span', 'شاهد الآن')),
          hero.hasDownload ? btn('حفظ على الحاسوب', { cls: 'glass', icon: 'save', onclick: () => openSaveDialog({ videoId: hero.id }) }) : null))));
  }

  const lists = state.playlists.map((p) => ({ p, items: vids.filter((v) => v.playList === p.id) })).filter((x) => x.items.length);
  if (lists.length) {
    page.appendChild(h('div.chips', { role: 'list' }, lists.map(({ p, items }) =>
      h('a.chip', { href: `#/playlist/${encodeURIComponent(p.id)}`, role: 'listitem', dir: 'auto' }, p.title, h('small', String(items.length))))));
  }
  const latest = vids.slice(0, 12);
  page.appendChild(h('section.row', sectionHead('الأحدث', 'عرض الكل', '#/search/'), h('div.rail', latest.map(videoCard))));
  const popular = vids.slice().sort((a, b) => b.views - a.views).slice(0, 12);
  page.appendChild(h('section.row', sectionHead('الأكثر مشاهدة'), h('div.rail', popular.map(videoCard))));
  for (const { p, items } of lists) {
    page.appendChild(h('section.row', sectionHead(p.title, `عرض الكل (${items.length})`, `#/playlist/${encodeURIComponent(p.id)}`),
      h('div.rail', items.slice(0, 12).map(videoCard))));
  }
  if (!vids.length) page.appendChild(emptyState('لا توجد فيديوهات', 'ملف الكتالوج فارغ.'));
  mount('home', page, { onJobs: () => refreshBadges(page) });
}
function refreshBadges() { /* البطاقات تُحدَّث عند إعادة الرسم؛ الشارات الحية في شريط الأسفل */ }

// ================= البحث =================
function viewSearch(q0) {
  let q = q0 || '';
  let pl = '';
  let sort = 'new';
  const input = h('input.big-input', { type: 'search', placeholder: 'اكتب اسم الأنمي أو الحلقة…', value: q, 'data-autofocus': '', 'aria-label': 'بحث' });
  const plSel = h('select', { 'aria-label': 'القائمة' }, h('option', { value: '' }, 'كل القوائم'),
    state.playlists.map((p) => h('option', { value: p.id }, p.title)));
  const sortSel = segmented([{ value: 'new', label: 'الأحدث' }, { value: 'views', label: 'الأكثر مشاهدة' }], sort, (v) => { sort = v; render(); }, 'ترتيب');
  const grid = h('div.grid');
  const count = h('p.count');
  const page = h('div.page', h('h1.page-title', 'البحث'),
    h('div.searchbar', input, plSel, sortSel), count, grid);
  function render() {
    const nq = norm(q).trim();
    let list = state.videos.filter((v) => (!pl || v.playList === pl) && (!nq || norm(v.title).includes(nq) || norm(v.description).includes(nq)));
    list = list.slice().sort(sort === 'views' ? (a, b) => b.views - a.views : byDateDesc);
    count.textContent = nq || pl ? `${fmtNum(list.length)} نتيجة` : `${fmtNum(list.length)} فيديو`;
    clear(grid);
    if (!list.length) grid.appendChild(emptyState('لا توجد نتائج', 'جرّب كلمة أخرى أو اختر «كل القوائم».'));
    else list.forEach((v) => grid.appendChild(videoCard(v)));
  }
  input.addEventListener('input', debounce(() => { q = input.value; render(); }, 120));
  plSel.addEventListener('change', () => { pl = plSel.value; render(); });
  render();
  mount('search', page);
  const ti = $('#topSearchInput'); if (ti) ti.value = '';
}

// ================= قائمة تشغيل =================
function viewPlaylist(id) {
  const p = state.plById.get(id);
  const items = state.videos.filter((v) => v.playList === id).sort(byDateDesc);
  const page = h('div.page',
    h('a.back', { href: '#/' }, '→ الرئيسية'),
    h('h1.page-title', { dir: 'auto' }, p ? p.title : 'قائمة غير موجودة'),
    h('p.count', `${fmtNum(items.length)} فيديو`),
    items.length ? h('div.grid', items.map(videoCard)) : emptyState('القائمة فارغة'));
  mount('playlist', page);
}

// ================= صفحة الفيديو =================
function viewVideo(id) {
  const v = state.byId.get(id);
  if (!v) { mount('video', emptyState('الفيديو غير موجود', 'ربما حُذف من الكتالوج.', h('a.btn.primary', { href: '#/' }, 'العودة للرئيسية'))); return; }

  const sources = [];
  if (v.video) sources.push({ key: 'dm', label: 'المشغّل الأساسي', url: `https://www.dailymotion.com/embed/video/${encodeURIComponent(v.video)}` });
  if (/^https?:\/\//i.test(v.video2 || '')) sources.push({ key: 'alt', label: 'مشغّل بديل', url: v.video2 });
  const stage = h('div.stage');
  const tabs = h('div.src-tabs', { role: 'tablist' });
  let current = null;
  let localName = null;

  function showSource(s) {
    current = s.key;
    clear(stage);
    if (s.key === 'local') {
      const vid = h('video', { controls: true, preload: 'metadata', playsinline: true, poster: v.image || null, src: `/media/${encodeURIComponent(s.name)}` });
      stage.appendChild(vid);
    } else {
      stage.appendChild(h('iframe', { src: s.url, allowfullscreen: true, allow: 'autoplay; fullscreen; picture-in-picture', referrerpolicy: 'no-referrer-when-downgrade', title: v.title }));
    }
    renderTabs();
  }
  function allSources() {
    const arr = sources.slice();
    if (localName) arr.unshift({ key: 'local', label: 'الملف المحفوظ على جهازك', name: localName });
    return arr;
  }
  function renderTabs() {
    clear(tabs);
    const arr = allSources();
    if (arr.length < 2) return;
    arr.forEach((s) => tabs.appendChild(h('button.tab' + (s.key === current ? '.on' : ''), { type: 'button', role: 'tab', 'aria-selected': s.key === current ? 'true' : 'false', onclick: () => showSource(s) }, s.label)));
  }

  const actions = h('div.v-actions');
  function renderActions() {
    clear(actions);
    const job = activeJobFor(v.id);
    if (job) {
      const wrap = h('div.v-job');
      const list = new JobList(wrap, { compact: false });
      list.sync([job]);
      actions.appendChild(wrap);
      return;
    }
    if (v.hasDownload) {
      actions.appendChild(btn('حفظ على الحاسوب', { cls: 'primary lg', icon: 'save', onclick: () => openSaveDialog({ videoId: v.id }) }));
    } else {
      actions.appendChild(h('p.note', icon('info', 16), 'هذا الفيديو للمشاهدة فقط — لا يوجد ملف للحفظ.'));
    }
    const dj = doneJobFor(v.id);
    if (dj) actions.appendChild(btn('تشغيل النسخة المحفوظة', { cls: 'ghost', icon: 'play', onclick: () => { localName = dj.outputName; showSource({ key: 'local', name: localName }); } }));
  }

  const related = state.videos.filter((x) => x.id !== v.id && x.playList === v.playList).sort(byDateDesc);
  const more = related.length >= 6 ? related : related.concat(state.videos.filter((x) => x.id !== v.id && x.playList !== v.playList).sort((a, b) => b.views - a.views)).slice(0, 12);

  const page = h('div.page.vpage',
    h('div.v-main',
      h('a.back', { href: v.playList ? `#/playlist/${encodeURIComponent(v.playList)}` : '#/' }, '→ رجوع'),
      h('div.player', stage),
      tabs,
      h('h1.v-title', { dir: 'auto' }, v.title),
      h('div.v-meta',
        h('span', icon('eye', 15), `${fmtNum(v.views)} مشاهدة`),
        v.date ? h('span', icon('clock', 15), fmtDate(v.date)) : null,
        v.playList ? h('a.pill', { href: `#/playlist/${encodeURIComponent(v.playList)}`, dir: 'auto' }, plTitle(v.playList)) : null),
      actions,
      v.description ? h('div.v-desc', { dir: 'auto' }, v.description) : null),
    h('aside.v-side', h('h2', 'قد يعجبك'), h('div.side-list', more.map(sideItem))));

  // المصدر الافتراضي: النسخة المحفوظة إن وُجدت، وإلا المشغّل الأساسي
  mount('video', page, {
    onJobs: () => {
      const prevDone = localName;
      const dj = doneJobFor(v.id);
      if (dj && dj.outputName !== prevDone) { localName = dj.outputName; renderTabs(); }
      renderActions();
    },
  });
  const dj0 = doneJobFor(v.id);
  if (dj0) { localName = dj0.outputName; }
  renderActions();
  if (sources.length) showSource(sources[0]); else if (localName) showSource({ key: 'local', name: localName });
  else stage.appendChild(emptyState('لا يوجد مصدر تشغيل لهذا الفيديو'));
  api('/api/library').then((lib) => {
    state.library = lib;
    if (localName && !lib.files.some((f) => f.name === localName)) { localName = null; if (current === 'local') showSource(sources[0]); else renderTabs(); }
    else renderTabs();
  }).catch(() => renderTabs());
}
function sideItem(v) {
  return h('a.side-item', { href: `#/video/${encodeURIComponent(v.id)}` },
    h('img', { src: v.image || '', alt: '', loading: 'lazy', onerror: (e) => { e.target.style.visibility = 'hidden'; } }),
    h('div', h('h4', { dir: 'auto' }, v.title), h('small', icon('eye', 12), fmtNum(v.views))));
}

// ================= المهام (بطاقات حية) =================
const PHASE_LABEL = { download: 'تحميل', compress: 'ضغط', finish: 'حفظ', done: 'اكتمل' };

function stepsFor(job) {
  if (job.kind === 'compress-file') return ['ضغط', 'حفظ'];
  if (job.plan && job.plan.mode === 'compress') return ['تحميل', 'ضغط', 'حفظ'];
  return ['تحميل', 'حفظ'];
}
function stepIndex(job, steps) {
  if (job.status === 'done') return steps.length;
  if (job.phase === 'finish') return steps.length - 1;
  if (job.phase === 'compress') return steps.indexOf('ضغط');
  return 0;
}
function jobProgress(job) {
  // يعيد {pct (أو -1 لغير محدد), text}
  if (job.status === 'done') return { pct: 100, text: job.message || 'اكتمل الحفظ' };
  if (job.status === 'failed') return { pct: -2, text: job.error || 'فشلت المهمة' };
  if (job.status === 'canceled') return { pct: -2, text: 'أُلغيت المهمة' };
  const paused = job.status === 'paused';
  const queuedMsg = job.status === 'queued' ? (job.message || 'في قائمة الانتظار…') : '';
  if (job.phase === 'download') {
    const d = job.dl || {};
    const pct = d.total > 0 ? clamp((d.received / d.total) * 100, 0, 100) : -1;
    const parts = [];
    if (d.total > 0) parts.push(`${fmtBytes(d.received)} / ${fmtBytes(d.total)}`); else if (d.received > 0) parts.push(fmtBytes(d.received));
    if (!paused && d.speed > 1) parts.push(fmtSpeed(d.speed));
    if (!paused && d.etaMs >= 0 && d.speed > 1) parts.push(`متبقي ${fmtEta(d.etaMs)}`);
    const text = paused ? `متوقف مؤقتًا${parts.length ? ' • ' + parts[0] : ''}` : (queuedMsg || job.message || parts.join(' • ') || 'جارٍ الاتصال…');
    return { pct: queuedMsg && !d.received ? -1 : pct, text };
  }
  if (job.phase === 'compress') {
    const c = job.cp || {};
    const pct = c.percent > 0 ? clamp(c.percent, 0, 100) : (c.label ? 0 : -1);
    const parts = [];
    if (c.label) parts.push(c.label);
    if (c.passes > 1) parts.push(`المرحلة ${c.pass}/${c.passes}`);
    if (c.percent > 0) parts.push(`${Math.floor(c.percent)}%`);
    if (!paused && c.speed > 0) parts.push(`×${c.speed.toFixed(2)}`);
    if (!paused && c.etaMs >= 0) parts.push(`متبقي ${fmtEta(c.etaMs)}`);
    return { pct, text: paused ? `متوقف مؤقتًا${c.percent > 0 ? ' • ' + Math.floor(c.percent) + '%' : ''}` : (queuedMsg || job.message || parts.join(' • ') || 'جارٍ التحضير…') };
  }
  return { pct: -1, text: job.message || 'جارٍ الحفظ النهائي…' };
}

async function jobAction(job, action) {
  try { await post(`/api/jobs/${job.id}/${action}`); } catch (e) { toast(e.message, { type: 'error' }); }
}
function jobButtons(job, compact) {
  const b = (label, ic, cls, fn) => btn(compact ? '' : label, { cls: 'sm ' + cls + (compact ? ' icon-only' : ''), icon: ic, title: label, aria: label, onclick: fn });
  const out = [];
  if (job.status === 'queued' || job.status === 'running') {
    out.push(b('إيقاف مؤقت', 'pause', 'ghost', () => jobAction(job, 'pause')));
    out.push(b('إلغاء', 'x', 'ghost danger-text', () => jobAction(job, 'cancel')));
  } else if (job.status === 'paused') {
    out.push(b('استئناف', 'play', 'primary', () => jobAction(job, 'resume')));
    out.push(b('إلغاء', 'x', 'ghost danger-text', () => jobAction(job, 'cancel')));
  } else if (job.status === 'failed' || job.status === 'canceled') {
    out.push(b('إعادة المحاولة', 'retry', 'primary', () => jobAction(job, 'retry')));
    out.push(b('إزالة', 'trash', 'ghost', () => jobAction(job, 'remove')));
  } else if (job.status === 'done') {
    if (job.outputName) out.push(b('تشغيل', 'play', 'primary', () => openPlayer(job.outputName)));
    out.push(b('إزالة من القائمة', 'x', 'ghost', () => jobAction(job, 'remove')));
  }
  return out;
}

class JobList {
  constructor(container, opts) { this.root = container; this.compact = !!(opts && opts.compact); this.els = new Map(); this.limit = (opts && opts.limit) || 0; }
  sync(jobs) {
    const list = this.limit ? jobs.slice(0, this.limit) : jobs;
    const seen = new Set();
    let prev = null;
    for (const j of list) {
      seen.add(j.id);
      let el = this.els.get(j.id);
      if (!el) { el = this.create(j); this.els.set(j.id, el); }
      this.update(el, j);
      const want = prev ? prev.nextSibling : this.root.firstChild;
      if (want !== el) this.root.insertBefore(el, want);
      prev = el;
    }
    for (const [id, el] of this.els) if (!seen.has(id)) { el.remove(); this.els.delete(id); }
  }
  create(j) {
    const r = {};
    r.thumb = h('div.job-thumb', j.thumb ? h('img', { src: j.thumb, alt: '', onerror: (e) => { e.target.remove(); } }) : icon('film', 22));
    r.title = h('a.job-title', { dir: 'auto' });
    r.phase = h('span.job-phase');
    r.steps = h('ol.steps');
    r.bar = h('div.bar', h('i'));
    r.info = h('div.job-info');
    r.act = h('div.job-act');
    const el = h('article.job' + (this.compact ? '.compact' : ''), { dataset: { id: j.id } },
      r.thumb, h('div.job-main', h('div.job-top', r.title, r.phase), this.compact ? null : r.steps, r.bar, r.info), r.act);
    el._r = r;
    return el;
  }
  update(el, j) {
    const r = el._r;
    el.dataset.status = j.status;
    el.dataset.phase = j.phase || '';
    r.title.textContent = j.title || '—';
    if (j.videoId) r.title.setAttribute('href', `#/video/${encodeURIComponent(j.videoId)}`); else r.title.removeAttribute('href');
    const steps = stepsFor(j);
    const si = stepIndex(j, steps);
    const sig = steps.join('|') + ':' + si;
    if (r.steps._sig !== sig) {
      r.steps._sig = sig;
      clear(r.steps);
      steps.forEach((s, i) => r.steps.appendChild(h('li' + (i < si ? '.done' : i === si ? '.now' : ''), h('span.dot'), s)));
    }
    r.phase.textContent = j.status === 'done' ? 'اكتمل' : j.status === 'failed' ? 'فشل' : j.status === 'canceled' ? 'ملغاة' : j.status === 'paused' ? 'متوقف مؤقتًا' : (PHASE_LABEL[j.phase] || '');
    const p = jobProgress(j);
    r.bar.classList.toggle('indet', p.pct === -1);
    r.bar.classList.toggle('err', p.pct === -2);
    r.bar.firstChild.style.width = p.pct >= 0 ? p.pct.toFixed(1) + '%' : (p.pct === -2 ? '100%' : '');
    r.info.textContent = p.text;
    r.info.classList.toggle('err', j.status === 'failed');
    const asig = j.status;
    if (r.act._sig !== asig) {
      r.act._sig = asig;
      clear(r.act);
      jobButtons(j, this.compact).forEach((b) => r.act.appendChild(b));
    }
  }
}

// ---------- الشريط العائم للمهام النشطة ----------
let dockList = null;
let dockCollapsed = false;
function renderDock() {
  const dock = $('#dock');
  const active = state.jobs.filter(isActive);
  const onDownloads = state.view && state.view.name === 'downloads';
  if (!active.length || onDownloads) { dock.hidden = true; return; }
  dock.hidden = false;
  if (!dockList) {
    const body = h('div.dock-body');
    dockList = new JobList(body, { compact: true, limit: 3 });
    dock._body = body;
    dock._head = h('button.dock-head', { type: 'button', onclick: () => { dockCollapsed = !dockCollapsed; dock.classList.toggle('min', dockCollapsed); } });
    dock._more = h('a.dock-more', { href: '#/downloads' }, 'عرض كل التنزيلات');
    dock.append(dock._head, body, dock._more);
  }
  const running = active.filter((j) => j.status !== 'paused').length;
  dock._head.textContent = '';
  dock._head.append(icon('download', 16), h('b', `${active.length} مهمة`), h('small', running ? 'قيد التنفيذ' : 'متوقفة'));
  dock.classList.toggle('min', dockCollapsed);
  dockList.sync(active);
  dock._more.hidden = active.length <= 3;
}

function onJobsChanged() {
  const n = state.jobs.filter(isActive).length;
  const b = $('#navBadge');
  b.hidden = n === 0;
  b.textContent = String(n);
  document.title = n ? `(${n}) Bta3 Anime — بتاع أنمي` : 'Bta3 Anime — بتاع أنمي';
  renderDock();
  if (state.view && state.view.onJobs) state.view.onJobs();
}

// ================= التنزيلات والمكتبة =================
function openPlayer(name) {
  const m = openModal({ title: name, cls: 'player-dlg', noFoot: true, onClose: () => { try { vid.pause(); vid.removeAttribute('src'); vid.load(); } catch (_) { /* ignore */ } } });
  const vid = h('video', { controls: true, autoplay: true, playsinline: true, src: `/media/${encodeURIComponent(name)}` });
  vid.addEventListener('error', () => { clear(m.body); m.body.appendChild(emptyState('تعذّر تشغيل الملف في المتصفح', 'يمكنك فتحه من المجلد بمشغّل الفيديو المفضّل لديك.')); });
  m.body.appendChild(vid);
}

function viewDownloads() {
  const jobsWrap = h('div.jobs');
  const jobList = new JobList(jobsWrap, { compact: false });
  const jobsEmpty = h('div.empty.small', icon('download', 28), h('p', 'لا توجد مهام حاليًا. اختر فيديو واضغط «حفظ على الحاسوب».'));
  const libWrap = h('div.lib');
  const libHead = h('p.count');
  const free = h('span.pill');
  const clearBtn = btn('مسح المنتهية', { cls: 'ghost sm', icon: 'trash', onclick: async () => { try { await post('/api/jobs/clear-finished'); } catch (e) { toast(e.message, { type: 'error' }); } } });
  const openBtn = btn('فتح مجلد الحفظ', { cls: 'ghost sm', icon: 'folder', onclick: async () => { try { await post('/api/open-folder'); } catch (e) { toast(e.message, { type: 'error' }); } } });

  const page = h('div.page',
    h('div.page-head', h('h1.page-title', 'التنزيلات'), h('div.page-tools', free, openBtn, clearBtn)),
    jobsWrap, jobsEmpty,
    h('h2.sub-title', 'المحفوظ على جهازك'), libHead, libWrap);

  function renderFree() {
    const fb = state.system && state.system.freeBytes;
    free.textContent = fb != null ? `المساحة الحرة: ${fmtBytes(fb)}` : '';
    free.hidden = fb == null;
  }
  async function loadLibrary() {
    try {
      const lib = await api('/api/library');
      state.library = lib;
      libHead.textContent = lib.files.length ? `${lib.files.length} ملف • ${lib.dir}` : lib.dir;
      clear(libWrap);
      if (!lib.files.length) libWrap.appendChild(emptyState('لا توجد ملفات محفوظة بعد', 'ستظهر هنا الفيديوهات التي تحفظها.'));
      lib.files.forEach((f) => libWrap.appendChild(libRow(f, loadLibrary)));
    } catch (e) { clear(libWrap); libWrap.appendChild(emptyState('تعذّر قراءة المكتبة', e.message)); }
  }
  let lastDone = state.jobs.filter((j) => j.status === 'done').length;
  const refresh = () => {
    jobList.sync(state.jobs);
    jobsEmpty.hidden = state.jobs.length > 0;
    const d = state.jobs.filter((j) => j.status === 'done').length;
    if (d !== lastDone) { lastDone = d; loadLibrary(); }
  };
  mount('downloads', page, { onJobs: refresh, onSystem: renderFree });
  refresh(); renderFree(); loadLibrary();
}

function libRow(f, reload) {
  const dl = h('a.btn.sm.ghost.icon-only', { href: `/media/${encodeURIComponent(f.name)}?download=1`, title: 'تنزيل عبر المتصفح', 'aria-label': 'تنزيل عبر المتصفح', download: f.name }, icon('download', 17));
  return h('div.lib-row',
    h('div.lib-ico', icon('film', 22)),
    h('div.lib-main', h('b', { dir: 'auto' }, f.name), h('small', `${fmtBytes(f.size)} • ${fmtDate(new Date(f.mtime).toISOString())}`)),
    h('div.lib-act',
      btn('تشغيل', { cls: 'primary sm', icon: 'play', onclick: () => openPlayer(f.name) }),
      btn('ضغط', { cls: 'ghost sm', icon: 'compress', onclick: () => openSaveDialog({ file: f.name }) }),
      btn('', { cls: 'ghost sm icon-only', icon: 'folder', title: 'إظهار في المجلد', aria: 'إظهار في المجلد', onclick: () => post('/api/open-folder', { name: f.name }).catch((e) => toast(e.message, { type: 'error' })) }),
      dl,
      btn('', { cls: 'ghost sm icon-only danger-text', icon: 'trash', title: 'حذف', aria: 'حذف', onclick: async () => {
        if (!(await confirmDialog('حذف الملف؟', `سيُحذف «${f.name}» من جهازك نهائيًا.`, 'حذف', true))) return;
        try { await api('/api/library?name=' + encodeURIComponent(f.name), { method: 'DELETE' }); toast('تم الحذف', { type: 'ok' }); reload(); } catch (e) { toast(e.message, { type: 'error' }); }
      } })));
}

// ================= الإعدادات =================
function ffmpegPanel() {
  const box = h('div.card.ff');
  const retry = btn('إعادة تجهيز أداة الضغط', { cls: 'primary sm', icon: 'retry', onclick: async () => { try { await post('/api/system/ffmpeg-setup'); } catch (e) { toast(e.message, { type: 'error' }); } } });
  function render() {
    const s = state.system && state.system.ffmpeg;
    clear(box);
    box.appendChild(h('h3', icon('chip', 18), 'أداة الضغط (ffmpeg)'));
    if (!s) { box.appendChild(spinner('جارٍ الفحص…')); return; }
    const st = { checking: 'جارٍ الفحص…', downloading: `جارٍ تنزيل الأداة (${Math.round(s.percent || 0)}%)`, ready: 'جاهزة', missing: 'غير موجودة', error: 'تعذّر تجهيزها' }[s.state] || s.state;
    box.appendChild(h('p.ff-state.' + s.state, st + (s.version ? ` — الإصدار ${s.version}` : '')));
    if (s.state === 'downloading') box.appendChild(h('div.bar', h('i', { style: { width: (s.percent || 0) + '%' } })));
    if (s.state === 'ready') {
      const enc = [];
      if (s.encoders.libx264) enc.push('H.264');
      if (s.encoders.libx265) enc.push('H.265');
      if (s.hw && s.hw.h264) enc.push('تسريع عتادي H.264');
      if (s.hw && s.hw.hevc) enc.push('تسريع عتادي H.265');
      box.appendChild(h('p.muted', 'المشفّرات المتاحة: ' + (enc.join(' • ') || '—')));
    } else {
      if (s.error) box.appendChild(h('p.err', s.error));
      if (s.state !== 'downloading' && s.state !== 'checking') box.appendChild(retry);
    }
  }
  render();
  box.refresh = render;
  return box;
}

function viewSettings() {
  const st = (state.system && state.system.settings) || {};
  const dir = h('input.field', { type: 'text', value: st.saveDir || '', spellcheck: 'false', dir: 'ltr', 'aria-label': 'مجلد الحفظ' });
  const saveDirBtn = btn('حفظ المسار', { cls: 'primary sm', icon: 'save', onclick: () => update({ saveDir: dir.value.trim() }, 'تم تغيير مجلد الحفظ') });
  async function update(patch, okMsg) {
    try {
      await post('/api/settings', patch);
      if (okMsg) toast(okMsg, { type: 'ok' });
    } catch (e) { toast(e.message, { type: 'error' }); }
  }
  const maxSel = h('select', { 'aria-label': 'عدد التنزيلات المتزامنة', onchange: () => update({ maxDownloads: Number(maxSel.value) }) },
    [1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n), selected: n === st.maxDownloads }, String(n))));
  const awake = h('input', { type: 'checkbox', checked: st.keepAwake !== false, onchange: () => update({ keepAwake: awake.checked }) });
  const keep = h('input', { type: 'checkbox', checked: !!st.keepOriginal, onchange: () => update({ keepOriginal: keep.checked }) });
  const codecSeg = segmented([
    { value: 'h264', label: 'H.264', sub: 'يعمل على كل جهاز' },
    { value: 'hevc', label: 'H.265', sub: 'أصغر حجمًا' },
  ], st.defaultCodec || 'h264', (v) => update({ defaultCodec: v }), 'الترميز الافتراضي');
  const speedSeg = segmented([
    { value: 'fast', label: 'سريع', sub: 'أسرع، حجم أكبر قليلًا' },
    { value: 'balanced', label: 'متوازن', sub: 'موصى به' },
    { value: 'best', label: 'أفضل ضغط', sub: 'أبطأ، أصغر حجمًا' },
  ], st.defaultSpeed || 'balanced', (v) => update({ defaultSpeed: v }), 'سرعة الضغط');
  const ff = ffmpegPanel();

  const row = (label, hint, control) => h('div.set-row', h('div', h('b', label), hint ? h('small', hint) : null), control);
  const page = h('div.page.narrow',
    h('h1.page-title', 'الإعدادات'),
    h('div.card',
      h('h3', icon('folder', 18), 'مكان الحفظ'),
      h('p.muted', 'تُحفظ الفيديوهات في هذا المجلد على جهازك. اكتب المسار الكامل.'),
      h('div.field-row', dir, saveDirBtn)),
    h('div.card',
      h('h3', icon('bolt', 18), 'التنزيل'),
      row('عدد التنزيلات في الوقت نفسه', 'قيمة أعلى = أسرع لكن تستهلك إنترنت أكثر', maxSel),
      row('منع السكون أثناء العمل', 'يبقي اللابتوب مستيقظًا حتى تنتهي المهام', h('label.switch', awake, h('span.knob')))),
    h('div.card',
      h('h3', icon('compress', 18), 'الضغط'),
      row('الترميز الافتراضي', null, codecSeg),
      row('سرعة الضغط', 'الأبطأ يعطي حجمًا أصغر بنفس الجودة', speedSeg),
      row('الاحتفاظ بالنسخة الأصلية', 'بعد الضغط تُحفظ نسخة الفيديو الأصلية بجانب المضغوطة', h('label.switch', keep, h('span.knob')))),
    ff);
  mount('settings', page, { onSystem: () => ff.refresh() });
}

// ================= نافذة الحفظ والضغط =================
function openSaveDialog(target) {
  const isFile = !!target.file;
  const video = isFile ? null : state.byId.get(target.videoId);
  if (!isFile && !video) { toast('الفيديو غير موجود', { type: 'error' }); return; }
  const title = isFile ? target.file : video.title;
  const sys = state.system || {};
  const defaults0 = (sys.settings) || {};

  let data = null; let loading = true; let loadErr = '';
  let codec = defaults0.defaultCodec === 'hevc' ? 'hevc' : 'h264';
  let speed = defaults0.defaultSpeed || 'balanced';
  let keepOriginal = !!defaults0.keepOriginal;
  let replaceOriginal = false;
  let choice = isFile ? null : { kind: 'orig' };

  const subtitle = h('p.dlg-sub', isFile ? 'اختر جودة الضغط الجديدة' : 'اختر الجودة قبل الحفظ');
  const head = h('div.dlg-head',
    h('div.dlg-thumb', (video && video.image) ? h('img', { src: video.image, alt: '', onerror: (e) => e.target.remove() }) : icon('film', 26)),
    h('div.dlg-ttl', h('h2.modal-title', { id: 'saveTitle', dir: 'auto' }, title), subtitle));
  const m = openModal({ head: null, title, cls: 'save-dlg', onClose: () => systemHooks.delete(onSys) });
  // استبدال رأس النافذة بالرأس المخصص
  const mh = $('.modal-head', m.el);
  clear(mh); mh.append(head, h('button.modal-x', { 'aria-label': 'إغلاق', onclick: () => m.close() }, icon('x', 18)));
  m.el.setAttribute('aria-labelledby', 'saveTitle');

  const banner = h('div.banner', { hidden: true });
  const origWrap = h('div');
  const cmpWrap = h('div.cmp');
  const advWrap = h('details.adv');
  const summary = h('div.sum');
  const startBtn = btn('', { cls: 'primary lg', onclick: () => start() });
  const cancelBtn = btn('إلغاء', { cls: 'ghost lg', onclick: () => m.close() });
  m.body.append(banner, origWrap, cmpWrap, advWrap);
  m.foot.append(summary, h('div.foot-btns', cancelBtn, startBtn));

  const ffState = () => (state.system && state.system.ffmpeg && state.system.ffmpeg.state) || 'checking';
  const hevcOk = () => !!(data && data.hevcAvailable);

  function fillBanner() {
    const s = state.system && state.system.ffmpeg;
    banner.hidden = true; clear(banner);
    if (!s || s.state === 'ready') return;
    banner.hidden = false;
    banner.className = 'banner ' + (s.state === 'error' || s.state === 'missing' ? 'warn' : 'info');
    if (s.state === 'downloading') banner.append(spinner(`جارٍ تجهيز أداة الضغط (${Math.round(s.percent || 0)}%) — يتم ذلك مرة واحدة فقط`));
    else if (s.state === 'checking') banner.append(spinner('جارٍ فحص أداة الضغط…'));
    else banner.append(icon('alert', 18), h('span', 'أداة الضغط غير جاهزة' + (s.error ? ': ' + s.error : '') + ' — يمكنك حفظ الفيديو بجودته الأصلية الآن.'),
      btn('إعادة المحاولة', { cls: 'sm ghost', onclick: () => post('/api/system/ffmpeg-setup').catch((e) => toast(e.message, { type: 'error' })) }));
  }

  function radioCard(opts) {
    const sel = opts.selected;
    const card = h('button.opt' + (sel ? '.on' : '') + (opts.disabled ? '.dis' : '') + (opts.cls ? '.' + opts.cls : ''), {
      type: 'button', role: 'radio', 'aria-checked': sel ? 'true' : 'false', disabled: opts.disabled, onclick: opts.onclick,
    },
      h('span.radio'),
      h('div.opt-l', h('b', opts.title), opts.sub ? h('small', opts.sub) : null, opts.tags && opts.tags.length ? h('div.tags', opts.tags) : null),
      h('div.opt-r', h('b.size', opts.size), opts.note ? h('small' + (opts.noteCls ? '.' + opts.noteCls : ''), opts.note) : null));
    return card;
  }

  function renderOrig() {
    clear(origWrap);
    const o = data && data.built && data.built.original;
    let sub; let size;
    if (o) {
      sub = parts(`${o.width}×${o.height}`, `${o.fpsLabel} إطار/ث`, String(o.codec || '').toUpperCase(), fmtDuration(o.duration));
      size = o.sizeBytes ? fmtBytes(o.sizeBytes) : '—';
    } else if (data && data.sizeBytes) { sub = loading ? '' : 'بدون ضغط'; size = fmtBytes(data.sizeBytes); }
    else { sub = loading ? 'جارٍ قراءة معلومات الفيديو…' : 'بدون ضغط'; size = loading ? '…' : '—'; }
    origWrap.appendChild(h('div.grp-label', isFile ? 'الملف الحالي' : 'الجودة الأصلية'));
    origWrap.appendChild(radioCard({
      selected: !isFile && choice && choice.kind === 'orig', disabled: isFile,
      title: isFile ? 'الملف الحالي' : 'حفظ كما هو (بدون ضغط)', sub, size, note: isFile ? '' : 'أعلى جودة',
      onclick: () => { choice = { kind: 'orig' }; refresh(); },
    }));
  }

  function recommended(list) {
    const ok = list.filter((o) => !o.noGain);
    return ok.find((o) => o.savingPct >= 40) || ok[0] || null;
  }
  const same = (a, b) => a && b && a.height === b.height && Math.abs(a.fps - b.fps) < 0.01 && a.codec === b.codec;

  function renderCmp() {
    clear(cmpWrap);
    cmpWrap.appendChild(h('div.grp-label', 'ضغط الفيديو لتوفير المساحة'));
    if (loading) {
      cmpWrap.appendChild(h('div.skels', [0, 1, 2, 3].map(() => h('div.skel'))));
      cmpWrap.appendChild(h('p.hint', icon('info', 15), 'يقرأ البرنامج دقة الفيديو وعدد إطاراته من الإنترنت ليحسب الأحجام بدقة — قد يستغرق ذلك لحظات.'));
      return;
    }
    if (loadErr) { cmpWrap.appendChild(h('div.banner.warn', icon('alert', 18), h('span', loadErr), btn('إعادة المحاولة', { cls: 'sm ghost', onclick: () => load() }))); return; }
    const built = data && data.built;
    if (!built) {
      const why = data && data.probeError ? `تعذّر قراءة معلومات الفيديو (${data.probeError}).` : (ffState() === 'ready' ? 'لا تتوفر خيارات ضغط لهذا الفيديو.' : 'أداة الضغط لم تجهز بعد.');
      cmpWrap.appendChild(h('div.banner.warn', icon('alert', 18), h('span', why + (isFile ? '' : ' يمكنك حفظه كما هو.')), btn('تحديث', { cls: 'sm ghost', onclick: () => load() })));
      return;
    }
    cmpWrap.appendChild(h('div.codec-row',
      segmented([
        { value: 'h264', label: 'H.264', sub: 'متوافق مع كل الأجهزة' },
        { value: 'hevc', label: 'H.265', sub: hevcOk() ? 'أصغر بحوالي ٣٥٪' : 'غير متاح على هذا الجهاز', disabled: !hevcOk() },
      ], codec, (v) => { codec = v; if (choice && choice.kind === 'cmp') choice = { kind: 'cmp', opt: null }; autoPick(); refresh(); }, 'الترميز')));
    const list = built.options.filter((o) => o.codec === codec);
    if (!list.length) { cmpWrap.appendChild(h('p.hint', 'لا توجد خيارات لهذا الترميز.')); return; }
    const rec = recommended(list);
    if (list.every((o) => o.noGain)) cmpWrap.appendChild(h('div.banner.info', icon('info', 18), h('span', 'هذا الفيديو مضغوط بالفعل بدرجة عالية — الضغط الإضافي لن يوفّر مساحة تُذكر.')));
    const box = h('div.opts', { role: 'radiogroup', 'aria-label': 'خيارات الضغط' });
    for (const o of list) {
      const tags = [];
      if (rec && same(o, rec)) tags.push(h('span.tag.rec', 'موصى به'));
      if (o.scale) tags.push(h('span.tag', 'تصغير الدقة'));
      if (o.fpsChange) tags.push(h('span.tag', 'خفض الإطارات'));
      if (o.capped) tags.push(h('span.tag', 'بمعدل المصدر'));
      box.appendChild(radioCard({
        selected: choice && choice.kind === 'cmp' && same(choice.opt, o),
        disabled: o.noGain,
        title: `${o.height}p`, sub: parts(resLabel(o.height), `${o.fpsLabel} إطار/ث`), tags,
        size: `≈ ${fmtBytes(o.estBytes)}`,
        note: o.noGain ? 'لا يوفّر مساحة' : (o.savingPct > 0 ? `توفير ${o.savingPct}٪` : ''),
        noteCls: o.noGain ? 'dim' : 'save',
        onclick: () => { choice = { kind: 'cmp', opt: o }; refresh(); },
      }));
    }
    cmpWrap.appendChild(box);
    cmpWrap.appendChild(h('p.hint', icon('info', 15), 'الأحجام المعروضة تقديرية (±١٥٪) وتعتمد على نوع المشهد؛ يتم الضغط بالكامل على جهازك دون رفع أي شيء.'));
  }

  function autoPick() {
    const built = data && data.built;
    if (!built) return;
    const list = built.options.filter((o) => o.codec === codec);
    if (choice && choice.kind === 'cmp' && choice.opt) {
      const keep = list.find((o) => same(o, choice.opt));
      if (keep) { choice = { kind: 'cmp', opt: keep }; return; }
      // نفس الدقة والإطارات بالترميز الآخر
      const alt = list.find((o) => o.height === choice.opt.height && Math.abs(o.fps - choice.opt.fps) < 0.01);
      if (alt && !alt.noGain) { choice = { kind: 'cmp', opt: alt }; return; }
    }
    if (isFile) { const r = recommended(list); choice = r ? { kind: 'cmp', opt: r } : null; }
    else if (choice && choice.kind === 'cmp') { const r = recommended(list); choice = r ? { kind: 'cmp', opt: r } : { kind: 'orig' }; }
  }

  function renderAdv() {
    const open = advWrap.open;
    clear(advWrap);
    advWrap.open = open;
    advWrap.appendChild(h('summary', icon('gear', 16), 'خيارات متقدمة'));
    const inner = h('div.adv-in');
    inner.appendChild(h('div.adv-row', h('div', h('b', 'سرعة الضغط'), h('small', 'الأبطأ يعطي حجمًا أصغر بنفس الجودة')),
      segmented([{ value: 'fast', label: 'سريع' }, { value: 'balanced', label: 'متوازن' }, { value: 'best', label: 'أفضل ضغط' }], speed, (v) => { speed = v; }, 'سرعة الضغط')));
    if (isFile) {
      inner.appendChild(h('label.adv-row.chk', h('div', h('b', 'استبدال الملف الأصلي'), h('small', 'يُحذف الملف الحالي بعد نجاح الضغط')),
        h('label.switch', h('input', { type: 'checkbox', checked: replaceOriginal, onchange: (e) => { replaceOriginal = e.target.checked; } }), h('span.knob'))));
    } else {
      inner.appendChild(h('label.adv-row.chk', h('div', h('b', 'الاحتفاظ بالنسخة الأصلية أيضًا'), h('small', 'عند الضغط تُحفظ النسخة الأصلية بجانب المضغوطة')),
        h('label.switch', h('input', { type: 'checkbox', checked: keepOriginal, onchange: (e) => { keepOriginal = e.target.checked; } }), h('span.knob'))));
    }
    advWrap.appendChild(inner);
  }

  function renderSummary() {
    const dir = (data && data.saveDir) || (sys.settings && sys.settings.saveDir) || '';
    let line;
    if (choice && choice.kind === 'cmp') {
      const o = choice.opt;
      line = h('div', h('b', `≈ ${fmtBytes(o.estBytes)}`), h('span', ` بعد الضغط (${o.height}p • ${o.fpsLabel} إطار)`));
    } else if (choice && choice.kind === 'orig') {
      const sz = (data && data.built && data.built.original.sizeBytes) || (data && data.sizeBytes) || 0;
      line = h('div', h('b', sz ? fmtBytes(sz) : 'الحجم الأصلي'), h('span', ' — بدون ضغط'));
    } else line = h('div', h('span', 'اختر جودة للمتابعة'));
    clear(summary);
    summary.append(line, dir ? h('small', icon('folder', 13), h('span', 'يُحفظ في:'), h('span.path', { dir: 'ltr', title: dir }, dir)) : null);
    clear(startBtn);
    const label = choice && choice.kind === 'cmp' ? (isFile ? 'ابدأ الضغط' : 'ضغط وحفظ') : 'حفظ';
    startBtn.append(icon(choice && choice.kind === 'cmp' ? 'compress' : 'save', 18), h('span', label));
    startBtn.disabled = !choice;
  }

  function refresh() { fillBanner(); renderOrig(); renderCmp(); renderAdv(); renderSummary(); }

  let starting = false;
  async function start() {
    if (!choice || starting) return;
    starting = true; startBtn.disabled = true;
    try {
      const o = choice.kind === 'cmp' ? choice.opt : null;
      const common = o ? { mode: 'compress', height: o.height, fps: o.fps, codec: o.codec } : { mode: 'save' };
      if (isFile) await post('/api/jobs/compress-file', Object.assign({ file: target.file, speed, replaceOriginal }, common));
      else await post('/api/jobs', Object.assign({ videoId: video.id, speed, keepOriginal }, common));
      toast(o ? 'بدأ التحميل ثم الضغط — يمكنك متابعته من الشريط السفلي' : 'بدأ التحميل — يمكنك متابعته من الشريط السفلي', { type: 'ok' });
      m.close();
    } catch (e) { toast(e.message, { type: 'error' }); starting = false; startBtn.disabled = false; }
  }

  async function load() {
    loading = true; loadErr = ''; refresh();
    try {
      const q = isFile ? 'file=' + encodeURIComponent(target.file) : 'videoId=' + encodeURIComponent(video.id);
      data = await api('/api/options?' + q);
      if (m.closed) return;
      if (data.defaults) {
        if (data.defaults.codec) codec = data.defaults.codec === 'hevc' && data.hevcAvailable ? 'hevc' : 'h264';
        if (data.defaults.speed) speed = data.defaults.speed;
        if (typeof data.defaults.keepOriginal === 'boolean') keepOriginal = data.defaults.keepOriginal;
      }
      if (codec === 'hevc' && !data.hevcAvailable) codec = 'h264';
      if (isFile && !data.built) choice = null;
      autoPick();
    } catch (e) { if (m.closed) return; loadErr = e.message; if (isFile) choice = null; }
    loading = false;
    refresh();
  }
  const onSys = () => { if (m.closed) return; fillBanner(); if (!loading && !(data && data.built) && ffState() === 'ready') load(); };
  systemHooks.add(onSys);
  refresh();
  load();
}

// ================= تشغيل التطبيق =================
async function boot() {
  const view = $('#view');
  view.appendChild(h('div.page', spinner('جارٍ التحميل…')));
  try {
    const [cat, sys] = await Promise.all([api('/api/catalog'), api('/api/system')]);
    state.videos = cat.videos; state.playlists = cat.playlists; state.system = sys;
    state.byId = new Map(cat.videos.map((v) => [v.id, v]));
    state.plById = new Map(cat.playlists.map((p) => [p.id, p]));
  } catch (e) {
    clear(view);
    view.appendChild(h('div.page', emptyState('تعذّر الاتصال بالبرنامج', 'تأكد أن نافذة البرنامج (الخادم) ما زالت مفتوحة على اللابتوب ثم أعد تحميل الصفحة.',
      h('button.btn.primary', { onclick: () => location.reload() }, 'إعادة التحميل'))));
    return;
  }
  $('#topSearch').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#topSearchInput').value.trim();
    location.hash = '#/search/' + encodeURIComponent(q);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) { e.preventDefault(); $('#topSearchInput').focus(); }
  });
  window.addEventListener('hashchange', route);
  connectEvents();
  route();
}
boot();

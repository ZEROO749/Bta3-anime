'use strict';
// Bta3 Anime — نسخة ثابتة بالكامل (بدون سيرفر). تعمل على GitHub Pages والمتصفح مباشرة.

const LS = {
  fav: 'bta3.favorites',
  hist: 'bta3.history',
  theme: 'bta3.theme',
  settings: 'bta3.settings',
};

const state = {
  videos: [], playlists: [], byId: new Map(), plById: new Map(),
  favorites: [], history: {},
  settings: { theme: 'dark' },
  view: null,
};

const isFav = (id) => state.favorites.includes(id);
const histFor = (id) => state.history[id] || null;

// ---------- تخزين محلي ----------
function loadLS(key, dflt) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return dflt;
    return JSON.parse(raw);
  } catch (_) { return dflt; }
}
function saveLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* quota */ }
}

function loadUserData() {
  state.favorites = loadLS(LS.fav, []).filter((id) => typeof id === 'string');
  state.history = loadLS(LS.hist, {}) || {};
  state.settings = Object.assign({ theme: 'dark' }, loadLS(LS.settings, {}));
  applyTheme(state.settings.theme || 'dark');
}
function persistFavorites() { saveLS(LS.fav, state.favorites); }
function persistHistory() { saveLS(LS.hist, state.history); }
function persistSettings() { saveLS(LS.settings, state.settings); }

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'light' ? '#f4f0ec' : '#0b0607';
}

function toggleFavorite(videoId) {
  const id = String(videoId || '');
  if (!id || !state.byId.has(id)) return false;
  const i = state.favorites.indexOf(id);
  let added = false;
  if (i >= 0) state.favorites.splice(i, 1);
  else {
    state.favorites.unshift(id);
    added = true;
    if (state.favorites.length > 200) state.favorites.length = 200;
  }
  persistFavorites();
  toast(added ? 'أُضيف إلى المفضلة' : 'أُزيل من المفضلة', { type: 'ok' });
  if (state.view && state.view.onUserdata) state.view.onUserdata();
  return added;
}

function saveProgress(videoId, progress, duration) {
  if (!videoId) return;
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  const d = Math.max(0, Number(duration) || 0);
  const prev = state.history[videoId] || {};
  state.history[videoId] = {
    progress: p,
    duration: d || prev.duration || 0,
    updatedAt: Date.now(),
    watched: p >= 0.92 || !!prev.watched,
  };
  const keys = Object.keys(state.history).sort((a, b) => (state.history[b].updatedAt || 0) - (state.history[a].updatedAt || 0));
  if (keys.length > 150) {
    for (const k of keys.slice(150)) delete state.history[k];
  }
  persistHistory();
}

function markWatched(videoId, watched) {
  const prev = state.history[videoId] || { progress: 0, duration: 0 };
  state.history[videoId] = Object.assign({}, prev, {
    watched: !!watched,
    progress: watched ? 1 : prev.progress,
    updatedAt: Date.now(),
  });
  persistHistory();
  if (state.view && state.view.onUserdata) state.view.onUserdata();
}

function clearHistory() {
  state.history = {};
  persistHistory();
}

// ---------- مساعدة ----------
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}
function byDateDesc(a, b) { return String(b.date || '').localeCompare(String(a.date || '')); }
function plTitle(id) { const p = state.plById.get(id); return p ? p.title : ''; }

// ---------- مكوّنات ----------
function videoCard(v, opts) {
  const o = opts || {};
  const hist = histFor(v.id);
  const fav = isFav(v.id);
  const img = h('img', {
    src: v.image || '', alt: '', loading: 'lazy', decoding: 'async',
    onerror: (e) => { e.target.style.visibility = 'hidden'; },
  });
  const prog = hist && hist.progress > 0.02 && hist.progress < 0.95
    ? h('div.vprog', h('div.vprog-bar', { style: { width: (hist.progress * 100).toFixed(1) + '%' } }))
    : null;
  const card = h('a.vcard', { href: `#/video/${encodeURIComponent(v.id)}`, 'aria-label': v.title },
    h('div.vthumb', img,
      h('div.vbadges',
        fav ? h('span.vb.fav', icon('heartFill', 12)) : null,
        v.hasDownload ? h('span.vb.dl', icon('download', 13), 'رابط') : null,
        hist && hist.watched ? h('span.vb.watched', icon('checkCircle', 12), 'شُوهد') : null),
      prog),
    h('div.vinfo',
      h('h3', { dir: 'auto' }, v.title),
      h('p.vmeta', icon('eye', 14), fmtNum(v.views),
        hist && hist.progress > 0.02 && hist.progress < 0.95
          ? h('span.vprog-label', Math.round(hist.progress * 100) + '%')
          : null)));
  if (o.showFavBtn) {
    card.appendChild(h('button.vcard-fav', {
      type: 'button',
      title: fav ? 'إزالة من المفضلة' : 'أضف للمفضلة',
      'aria-label': fav ? 'إزالة من المفضلة' : 'أضف للمفضلة',
      class: fav ? 'on' : '',
      onclick: (e) => {
        e.preventDefault(); e.stopPropagation();
        toggleFavorite(v.id);
        // تحديث الزر محليًا
        const on = isFav(v.id);
        e.currentTarget.classList.toggle('on', on);
        clear(e.currentTarget);
        e.currentTarget.appendChild(on ? icon('heartFill', 16) : icon('heart', 16));
      },
    }, fav ? icon('heartFill', 16) : icon('heart', 16)));
  }
  return card;
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

// ---------- توجيه ----------
function setActiveNav(name) {
  $$('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === name));
}
function mount(name, node, hooks) {
  if (state.view && state.view.cleanup) { try { state.view.cleanup(); } catch (_) { /* ignore */ } }
  state.view = Object.assign({ name }, hooks || {});
  const root = $('#view');
  clear(root);
  root.appendChild(node);
  const nav = (name === 'video' || name === 'playlist') ? 'home' : name;
  setActiveNav(nav);
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
    else if (a === 'favorites') viewFavorites();
    else if (a === 'settings') viewSettings();
    else viewHome();
  } catch (e) {
    mount('home', emptyState('حدث خطأ في عرض الصفحة', e.message));
  }
  const f = $('#view');
  try { f.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
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
        h('span.hero-tag', 'مميز'),
        h('h1', { dir: 'auto' }, hero.title),
        h('p', { dir: 'auto' }, (hero.description || '').split('\n').filter(Boolean).slice(0, 2).join(' — ').slice(0, 220)),
        h('div.hero-act',
          h('a.btn.primary', { href: `#/video/${encodeURIComponent(hero.id)}` }, icon('play', 18), h('span', 'شاهد الآن')),
          hero.hasDownload
            ? h('a.btn.glass', { href: hero.download, target: '_blank', rel: 'noopener' }, icon('download', 18), h('span', 'تحميل'))
            : null,
          btn(isFav(hero.id) ? 'في المفضلة' : 'أضف للمفضلة', {
            cls: 'glass',
            icon: isFav(hero.id) ? 'heartFill' : 'heart',
            onclick: () => { toggleFavorite(hero.id); route(); },
          })))));
  }

  const cont = Object.keys(state.history)
    .map((id) => ({ v: state.byId.get(id), h: state.history[id] }))
    .filter((x) => x.v && x.h && x.h.progress > 0.03 && x.h.progress < 0.95)
    .sort((a, b) => (b.h.updatedAt || 0) - (a.h.updatedAt || 0))
    .slice(0, 12);
  if (cont.length) {
    page.appendChild(h('section.row', sectionHead('متابعة المشاهدة', 'عرض الكل', '#/favorites'),
      h('div.rail', cont.map(({ v }) => videoCard(v)))));
  }

  const favs = state.favorites.map((id) => state.byId.get(id)).filter(Boolean).slice(0, 12);
  if (favs.length) {
    page.appendChild(h('section.row', sectionHead('المفضلة', `عرض الكل (${state.favorites.length})`, '#/favorites'),
      h('div.rail', favs.map((v) => videoCard(v)))));
  }

  const lists = state.playlists
    .map((p) => ({ p, items: vids.filter((v) => v.playList === p.id) }))
    .filter((x) => x.items.length);
  if (lists.length) {
    page.appendChild(h('div.chips', { role: 'list' }, lists.map(({ p, items }) =>
      h('a.chip', { href: `#/playlist/${encodeURIComponent(p.id)}`, role: 'listitem', dir: 'auto' }, p.title, h('small', String(items.length))))));
  }

  page.appendChild(h('section.row', sectionHead('الأحدث', 'عرض الكل', '#/search/'),
    h('div.rail', vids.slice(0, 12).map((v) => videoCard(v)))));
  const popular = vids.slice().sort((a, b) => b.views - a.views).slice(0, 12);
  page.appendChild(h('section.row', sectionHead('الأكثر مشاهدة'),
    h('div.rail', popular.map((v) => videoCard(v)))));
  for (const { p, items } of lists) {
    page.appendChild(h('section.row',
      sectionHead(p.title, `عرض الكل (${items.length})`, `#/playlist/${encodeURIComponent(p.id)}`),
      h('div.rail', items.slice(0, 12).map((v) => videoCard(v)))));
  }
  if (!vids.length) page.appendChild(emptyState('لا توجد فيديوهات', 'ملف الكتالوج فارغ.'));
  mount('home', page, { onUserdata: () => route() });
}

// ================= البحث =================
function viewSearch(q0) {
  let q = q0 || '';
  let pl = '';
  let sort = 'new';
  const input = h('input.big-input', {
    type: 'search', placeholder: 'اكتب اسم الأنمي أو الحلقة…', value: q,
    'data-autofocus': '', 'aria-label': 'بحث',
  });
  const plSel = h('select', { 'aria-label': 'القائمة' },
    h('option', { value: '' }, 'كل القوائم'),
    state.playlists.map((p) => h('option', { value: p.id }, p.title)));
  const sortSel = segmented(
    [{ value: 'new', label: 'الأحدث' }, { value: 'views', label: 'الأكثر مشاهدة' }],
    sort, (v) => { sort = v; render(); }, 'ترتيب');
  const grid = h('div.grid');
  const count = h('p.count');
  const page = h('div.page', h('h1.page-title', 'البحث'),
    h('div.searchbar', input, plSel, sortSel), count, grid);

  function render() {
    const nq = norm(q).trim();
    let list = state.videos.filter((v) =>
      (!pl || v.playList === pl) &&
      (!nq || norm(v.title).includes(nq) || norm(v.description).includes(nq)));
    list = list.slice().sort(sort === 'views' ? (a, b) => b.views - a.views : byDateDesc);
    count.textContent = nq || pl ? `${fmtNum(list.length)} نتيجة` : `${fmtNum(list.length)} فيديو`;
    clear(grid);
    if (!list.length) grid.appendChild(emptyState('لا توجد نتائج', 'جرّب كلمة أخرى أو اختر «كل القوائم».'));
    else list.forEach((v) => grid.appendChild(videoCard(v, { showFavBtn: true })));
  }
  input.addEventListener('input', debounce(() => { q = input.value; render(); }, 120));
  plSel.addEventListener('change', () => { pl = plSel.value; render(); });
  render();
  mount('search', page, { onUserdata: () => render() });
  const ti = $('#topSearchInput'); if (ti) ti.value = '';
}

// ================= المفضلة =================
function viewFavorites() {
  const page = h('div.page');
  page.appendChild(h('div.page-head',
    h('h1.page-title', 'المفضلة ومتابعة المشاهدة'),
    h('div.page-tools',
      btn('مسح سجل المشاهدة', {
        cls: 'ghost sm', icon: 'trash',
        onclick: async () => {
          if (!(await confirmDialog('مسح سجل المشاهدة؟', 'سيتم حذف تقدّم كل الحلقات. المفضلة لن تُمس.', 'مسح', true))) return;
          clearHistory();
          toast('تم مسح السجل', { type: 'ok' });
          route();
        },
      }))));

  const cont = Object.keys(state.history)
    .map((id) => ({ v: state.byId.get(id), h: state.history[id] }))
    .filter((x) => x.v && x.h && x.h.progress > 0.03 && x.h.progress < 0.95)
    .sort((a, b) => (b.h.updatedAt || 0) - (a.h.updatedAt || 0));
  if (cont.length) {
    page.appendChild(h('section.row', sectionHead('متابعة المشاهدة'),
      h('div.grid', cont.map(({ v }) => videoCard(v, { showFavBtn: true })))));
  }

  const favs = state.favorites.map((id) => state.byId.get(id)).filter(Boolean);
  page.appendChild(h('section.row',
    sectionHead(`المفضلة (${favs.length})`),
    favs.length
      ? h('div.grid', favs.map((v) => videoCard(v, { showFavBtn: true })))
      : emptyState('لا توجد مفضلات بعد', 'اضغط على أيقونة القلب في صفحة أي حلقة لإضافتها.')));

  const watched = Object.keys(state.history)
    .map((id) => ({ v: state.byId.get(id), h: state.history[id] }))
    .filter((x) => x.v && x.h && x.h.watched)
    .sort((a, b) => (b.h.updatedAt || 0) - (a.h.updatedAt || 0))
    .slice(0, 24);
  if (watched.length) {
    page.appendChild(h('section.row', sectionHead('شوهدت مؤخرًا'),
      h('div.grid', watched.map(({ v }) => videoCard(v, { showFavBtn: true })))));
  }
  mount('favorites', page, { onUserdata: () => route() });
}

// ================= قائمة =================
function viewPlaylist(id) {
  const p = state.plById.get(id);
  const items = state.videos.filter((v) => v.playList === id).sort(byDateDesc);
  const page = h('div.page',
    h('a.back', { href: '#/' }, '→ الرئيسية'),
    h('h1.page-title', { dir: 'auto' }, p ? p.title : 'قائمة غير موجودة'),
    h('p.count', `${fmtNum(items.length)} فيديو`),
    items.length
      ? h('div.grid', items.map((v) => videoCard(v, { showFavBtn: true })))
      : emptyState('القائمة فارغة'));
  mount('playlist', page, { onUserdata: () => route() });
}

// ================= صفحة الفيديو =================
function viewVideo(id) {
  const v = state.byId.get(id);
  if (!v) {
    mount('video', emptyState('الفيديو غير موجود', 'ربما حُذف من الكتالوج.',
      h('a.btn.primary', { href: '#/' }, 'العودة للرئيسية')));
    return;
  }

  const sources = [];
  if (v.video) {
    sources.push({
      key: 'dm',
      label: 'المشغّل الأساسي',
      url: `https://www.dailymotion.com/embed/video/${encodeURIComponent(v.video)}`,
    });
  }
  if (/^https?:\/\//i.test(v.video2 || '')) {
    sources.push({ key: 'alt', label: 'مشغّل بديل', url: v.video2 });
  }

  const stage = h('div.stage');
  const tabs = h('div.src-tabs', { role: 'tablist' });
  let current = null;

  function showSource(s) {
    current = s.key;
    clear(stage);
    stage.appendChild(h('iframe', {
      src: s.url,
      allowfullscreen: true,
      allow: 'autoplay; fullscreen; picture-in-picture',
      referrerpolicy: 'no-referrer-when-downgrade',
      title: v.title,
    }));
    // بداية مشاهدة خفيفة للمتابعة
    const hist = histFor(v.id);
    if (!hist || (hist.progress || 0) < 0.05) saveProgress(v.id, 0.08, 0);
    renderTabs();
  }

  function renderTabs() {
    clear(tabs);
    if (sources.length < 2) return;
    sources.forEach((s) => {
      tabs.appendChild(h('button.tab' + (s.key === current ? '.on' : ''), {
        type: 'button', role: 'tab',
        'aria-selected': s.key === current ? 'true' : 'false',
        onclick: () => showSource(s),
      }, s.label));
    });
  }

  const actions = h('div.v-actions');
  function renderActions() {
    clear(actions);
    const row = h('div.v-act-row');
    if (v.hasDownload && v.download) {
      row.appendChild(h('a.btn.primary.lg', {
        href: v.download, target: '_blank', rel: 'noopener',
      }, icon('download', 18), h('span', 'تحميل الفيديو')));
    } else {
      row.appendChild(h('p.note', icon('info', 16), 'هذا الفيديو للمشاهدة فقط.'));
    }
    row.appendChild(btn(isFav(v.id) ? 'في المفضلة' : 'أضف للمفضلة', {
      cls: isFav(v.id) ? 'fav-on lg' : 'ghost lg',
      icon: isFav(v.id) ? 'heartFill' : 'heart',
      onclick: () => { toggleFavorite(v.id); renderActions(); },
    }));
    const hist = histFor(v.id);
    if (!hist || !hist.watched) {
      row.appendChild(btn('تعليم كـ «شُوهد»', {
        cls: 'ghost',
        icon: 'checkCircle',
        onclick: () => {
          markWatched(v.id, true);
          toast('تم التحديد كمشاهد', { type: 'ok' });
          renderActions();
        },
      }));
    } else {
      row.appendChild(btn('إلغاء «شُوهد»', {
        cls: 'ghost',
        onclick: () => {
          markWatched(v.id, false);
          renderActions();
        },
      }));
    }
    actions.appendChild(row);
  }

  const related = state.videos.filter((x) => x.id !== v.id && x.playList === v.playList).sort(byDateDesc);
  const more = related.length >= 6
    ? related
    : related.concat(
      state.videos.filter((x) => x.id !== v.id && x.playList !== v.playList)
        .sort((a, b) => b.views - a.views)).slice(0, 12);

  function sideItem(x) {
    return h('a.side-item', { href: `#/video/${encodeURIComponent(x.id)}` },
      h('img', { src: x.image || '', alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }),
      h('div', h('h4', { dir: 'auto' }, x.title), h('small', icon('eye', 12), fmtNum(x.views))));
  }

  const page = h('div.page.vpage',
    h('div.v-main',
      h('a.back', { href: v.playList ? `#/playlist/${encodeURIComponent(v.playList)}` : '#/' }, '→ رجوع'),
      h('div.player', stage),
      tabs,
      h('h1.v-title', { dir: 'auto' }, v.title),
      h('div.v-meta',
        h('span', icon('eye', 15), `${fmtNum(v.views)} مشاهدة`),
        v.date ? h('span', icon('clock', 15), fmtDate(v.date)) : null,
        v.playList ? h('a.pill', { href: `#/playlist/${encodeURIComponent(v.playList)}`, dir: 'auto' }, plTitle(v.playList)) : null,
        isFav(v.id) ? h('span.pill.fav-pill', icon('heartFill', 13), 'مفضلة') : null),
      actions,
      v.description ? h('div.v-desc', { dir: 'auto' }, v.description) : null),
    h('aside.v-side', h('h2', 'قد يعجبك'), h('div.side-list', more.map(sideItem))));

  mount('video', page, { onUserdata: () => renderActions() });
  if (sources.length) showSource(sources[0]);
  else stage.appendChild(emptyState('لا يوجد مشغّل', 'لا يتوفر رابط تشغيل لهذا الفيديو.'));
  renderActions();
}

// ================= الإعدادات =================
function viewSettings() {
  const st = state.settings;
  const themeSeg = segmented([
    { value: 'dark', label: 'داكن', sub: 'افتراضي' },
    { value: 'light', label: 'فاتح', sub: 'مريح نهارًا' },
  ], st.theme || 'dark', (v) => {
    state.settings.theme = v;
    applyTheme(v);
    persistSettings();
    toast('تم تغيير المظهر', { type: 'ok' });
  }, 'المظهر');

  const row = (label, hint, control) =>
    h('div.set-row', h('div', h('b', label), hint ? h('small', hint) : null), control);

  const page = h('div.page.narrow',
    h('h1.page-title', 'الإعدادات'),
    h('div.card',
      h('h3', icon(st.theme === 'light' ? 'sun' : 'moon', 18), 'المظهر'),
      row('المظهر', 'داكن أو فاتح — يُحفظ على هذا الجهاز', themeSeg)),
    h('div.card',
      h('h3', icon('trash', 18), 'البيانات المحلية'),
      h('p.muted', 'المفضلة وسجل المشاهدة يُحفظان في متصفحك فقط.'),
      h('div.field-row',
        btn('مسح المفضلة', {
          cls: 'ghost',
          onclick: async () => {
            if (!(await confirmDialog('مسح المفضلة؟', 'سيتم حذف كل العناصر من المفضلة.', 'مسح', true))) return;
            state.favorites = [];
            persistFavorites();
            toast('تم مسح المفضلة', { type: 'ok' });
          },
        }),
        btn('مسح سجل المشاهدة', {
          cls: 'ghost',
          onclick: async () => {
            if (!(await confirmDialog('مسح السجل؟', 'سيتم حذف تقدّم كل الحلقات.', 'مسح', true))) return;
            clearHistory();
            toast('تم مسح السجل', { type: 'ok' });
          },
        }))),
    h('div.card.about',
      h('h3', 'حول Bta3 Anime'),
      h('p.muted', 'نسخة ويب ثابتة — تعمل بدون سيرفر، جاهزة لـ GitHub Pages.'),
      h('p.muted', 'التصفح والمشاهدة والمفضلة ومتابعة المشاهدة تعمل بالكامل في المتصفح.'),
      h('p.muted', 'التحميل يفتح الرابط المباشر للفيديو عند توفره.')));

  mount('settings', page);
}

// ================= التشغيل =================
async function boot() {
  const view = $('#view');
  view.appendChild(h('div.page', spinner('جارٍ التحميل…')));
  loadUserData();

  try {
    // مسارات نسبية تعمل على GitHub Pages (حتى مع اسم المستودع)
    const base = document.querySelector('base')?.href || '';
    const [videosRaw, playlists] = await Promise.all([
      fetch('data/videos.json').then((r) => { if (!r.ok) throw new Error('videos'); return r.json(); }),
      fetch('data/playlists.json').then((r) => { if (!r.ok) throw new Error('playlists'); return r.json(); }),
    ]);

    const videos = [];
    for (const v of videosRaw) {
      if (!v || !v.id || v.isShow === false) continue;
      videos.push({
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
        hasDownload: /^https?:\/\//i.test(v.download || ''),
      });
    }
    state.videos = videos;
    state.playlists = Array.isArray(playlists) ? playlists : [];
    state.byId = new Map(videos.map((v) => [v.id, v]));
    state.plById = new Map(state.playlists.map((p) => [p.id, p]));
  } catch (e) {
    clear(view);
    view.appendChild(h('div.page', emptyState(
      'تعذّر تحميل الكتالوج',
      'تأكد أن ملفات data/videos.json و data/playlists.json موجودة بجانب الموقع.',
      h('button.btn.primary', { onclick: () => location.reload() }, 'إعادة التحميل'))));
    return;
  }

  $('#topSearch').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#topSearchInput').value.trim();
    location.hash = '#/search/' + encodeURIComponent(q);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) {
      e.preventDefault();
      $('#topSearchInput').focus();
    }
    if ((e.key === 'f' || e.key === 'F') && state.view && state.view.name === 'video' &&
      !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) {
      const m = location.hash.match(/#\/video\/(.+)/);
      if (m) { e.preventDefault(); toggleFavorite(decodeURIComponent(m[1])); }
    }
  });
  window.addEventListener('hashchange', route);
  route();
}

boot();

'use strict';
// أدوات الواجهة المشتركة: بناء العناصر، الأيقونات، التنسيق، الإشعارات، النوافذ.

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

// h('div.card#id', {onclick}, 'نص', child, ...)  — كل النصوص تُدرج كنص آمن (لا innerHTML).
function h(spec, attrs, ...kids) {
  const m = /^([a-z0-9]+)((?:[.#][\w-]+)*)$/i.exec(spec);
  const node = document.createElement(m ? m[1] : 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') node.classList.add(part.slice(1)); else node.id = part.slice(1);
    }
  }
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'class') v.split(' ').filter(Boolean).forEach((c) => node.classList.add(c));
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') { if (v) node[k] = true; }
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  } else if (attrs != null) kids.unshift(attrs);
  appendKids(node, kids);
  return node;
}
function appendKids(node, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) appendKids(node, k);
    else if (k instanceof Node) node.appendChild(k);
    else node.appendChild(document.createTextNode(String(k)));
  }
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

// ---------- أيقونات (SVG ثابتة وموثوقة) ----------
const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  download: '<path d="M12 4v10m0 0-4-4m4 4 4-4M5 19h14"/>',
  save: '<path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6"/>',
  compress: '<path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  retry: '<path d="M4 12a8 8 0 1 0 3-6.2M4 4v5h5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 2.5 20h19zM12 10v5M12 17.5v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bolt: '<path d="M13 3 5 13h6l-1 8 8-10h-6z"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  heart: '<path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6C19 16.5 12 21 12 21z"/>',
  heartFill: '<path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6C19 16.5 12 21 12 21z" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/><path d="M12 7v5l3 2"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
};
function icon(name, size) {
  const s = size || 18;
  const wrap = document.createElement('span');
  wrap.className = 'ico';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return wrap;
}

// ---------- تنسيق ----------
function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const mb = n / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  if (mb >= 100) return Math.round(mb) + ' MB';
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  return Math.max(0, Math.round(n / 1024)) + ' KB';
}
function fmtSpeed(bps) { return bps > 1 ? fmtBytes(bps) + '/ث' : ''; }
function fmtEta(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'جارٍ الحساب…';
  const s = Math.round(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0) return `${hh} س ${mm} د`;
  if (mm > 0) return `${mm} د ${ss} ث`;
  return `${ss} ث`;
}
function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const s = Math.round(sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}
function fmtDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('ar-EG-u-nu-latn', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch (_) { return ''; }
}
function fmtNum(n) {
  try { return Number(n).toLocaleString('en-US'); } catch (_) { return String(n); }
}
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------- إشعارات ----------
function toast(text, opts) {
  const o = opts || {};
  const root = $('#toasts');
  if (!root) return;
  const kind = o.type || 'info';
  const t = h('div.toast.' + kind, { role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'ok' ? 'check' : kind === 'error' || kind === 'warn' ? 'alert' : 'info', 18),
    h('div.toast-body', o.title ? h('b', o.title) : null, h('span', text)),
    h('button.toast-x', { 'aria-label': 'إغلاق', onclick: () => close() }, icon('x', 14)));
  let closed = false;
  function close() {
    if (closed) return; closed = true;
    t.classList.add('out');
    setTimeout(() => t.remove(), 220);
  }
  root.appendChild(t);
  while (root.children.length > 4) root.firstChild.remove();
  setTimeout(close, o.ms || (kind === 'error' ? 9000 : 5200));
}

// ---------- نوافذ ----------
const modalStack = [];
function openModal(opts) {
  const o = opts || {};
  const root = $('#modalRoot');
  const prevFocus = document.activeElement;
  const body = h('div.modal-body');
  const foot = h('div.modal-foot');
  const titleEl = h('h2.modal-title', { id: 'mt' + Date.now() }, o.title || '');
  const closeBtn = h('button.modal-x', { 'aria-label': 'إغلاق', onclick: () => api.close() }, icon('x', 18));
  const card = h('div.modal.' + (o.cls || ''), { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleEl.id },
    h('div.modal-head', o.head || titleEl, closeBtn), body, o.noFoot ? null : foot);
  const wrap = h('div.overlay', { onmousedown: (e) => { if (e.target === wrap && !o.sticky) api.close(); } }, card);
  const api = {
    el: card, body, foot, titleEl, closed: false,
    close() {
      if (api.closed) return;
      api.closed = true;
      const i = modalStack.indexOf(api);
      if (i >= 0) modalStack.splice(i, 1);
      wrap.classList.add('out');
      document.body.classList.toggle('noscroll', modalStack.length > 0);
      setTimeout(() => wrap.remove(), 180);
      if (o.onClose) { try { o.onClose(); } catch (_) { /* ignore */ } }
      try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (_) { /* ignore */ }
    },
  };
  modalStack.push(api);
  root.appendChild(wrap);
  document.body.classList.add('noscroll');
  setTimeout(() => { const f = card.querySelector('[data-autofocus]') || closeBtn; try { f.focus(); } catch (_) { /* ignore */ } }, 30);
  return api;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalStack.length) { modalStack[modalStack.length - 1].close(); }
});

// ---------- مكوّنات صغيرة ----------
function spinner(text) { return h('div.spin-line', h('span.spinner'), text ? h('span', text) : null); }
function parts(...items) { return h('span.parts', items.filter((x) => x != null && x !== '').map((x) => h('span', { dir: 'auto' }, x))); }
function badge(text, cls) { return h('span.badge' + (cls ? '.' + cls : ''), text); }
function btn(label, o) {
  const x = o || {};
  const b = h('button.btn' + (x.cls ? '.' + x.cls.split(' ').join('.') : ''), {
    type: x.type || 'button', onclick: x.onclick, disabled: x.disabled, title: x.title, 'aria-label': x.aria,
  }, x.icon ? icon(x.icon, x.iconSize || 18) : null, label ? h('span', label) : null);
  return b;
}
function segmented(items, value, onchange, label) {
  const root = h('div.seg', { role: 'radiogroup', 'aria-label': label || '' });
  const render = (val) => {
    clear(root);
    for (const it of items) {
      root.appendChild(h('button.seg-b' + (it.value === val ? '.on' : ''), {
        type: 'button', role: 'radio', 'aria-checked': it.value === val ? 'true' : 'false', disabled: it.disabled, title: it.title || null,
        onclick: () => { if (it.disabled) return; render(it.value); onchange(it.value); },
      }, it.label, it.sub ? h('small', it.sub) : null));
    }
  };
  render(value);
  root.set = render;
  return root;
}

/* Drafts and Ideas: a sidebar on the left. On a computer it stays out of sight until the pointer
   rests on the left edge (it leaves when the pointer does); the sidebar button in the spine (or
   ⌘O) keeps it open, beside the page when there is room. On a phone it is a drawer: a swipe from
   near the left edge pulls it out under the finger, a swipe left (or a tap beside it) puts it
   away, and its actions sit at the bottom, in thumb reach.

   Drafts are a tree: a project opens to its parts. Drag a row to reorder or to move it into or
   out of a project (a row's ⋯ → Move to… does the same without dragging). Group, sort and filter
   by status, month and tag. Every property on a row is a chip that changes it, and a new draft
   opens a small sheet of properties (nothing in it is required; a tap outside closes it). */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { el, icon, toast, money, relTime, menu, closeMenu, present, dismiss } = TDW.UI;
  const { Store } = TDW;
  const P = () => TDW.Project;
  const app = () => TDW.App;
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

  const VIEW_KEY = 'tdw.draftsView2';
  const PIN_KEY = 'tdw.draftsPinned';
  const PIN_MIN = 1360;      // narrower than this, an open sidebar lies over the page instead of beside it
  const STATUS = ['idea', 'drafting', 'editing', 'done'];
  const S_LABEL = { idea: 'Idea', drafting: 'Drafting', editing: 'Editing', done: 'Done' };
  const GROUPS = [['tree', 'Projects'], ['status', 'Status'], ['date', 'Month'], ['tag', 'Tag'], ['none', 'No groups']];
  const SORTS = [['edited', 'Edited'], ['created', 'Created'], ['date', 'Date'], ['title', 'Title'], ['spend', 'Spend'], ['order', 'Your order']];

  TDW.icons.filter = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M4.5 8h7M6.5 12h3"/></svg>';
  TDW.icons.gear = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/></svg>';

  let side = null, scrim = null, listEl = null, findEl = null, findWrap = null, chipsEl = null, pinBtn = null, tabBtns = null, searchBtn = null, viewBtn = null, importEl = null;
  let state = null;          // null | 'peek' (leaves with the pointer) | 'held' (over the page until dismissed) | 'pinned' (beside the page)
  let tab = 'drafts';
  let query = '';
  let ideaTag = null, showArchived = false, searching = false;
  let view = null;
  let enterTimer = 0, leaveTimer = 0;
  let slide = null, dx = null; // the sidebar's spring, and where it is now (0 = fully in)
  let drag = null;           // a row being dragged
  let lastShown = null;      // the draft whose projects were last opened for it

  /* ---------- The view: how the list is grouped, sorted and filtered ---------- */
  function loadView() {
    let v = {};
    try { v = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') || {}; } catch (_) { v = {}; }
    const arr = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string') : []);
    return {
      group: GROUPS.some(([k]) => k === v.group) ? v.group : 'tree',
      sort: SORTS.some(([k]) => k === v.sort) ? v.sort : 'edited',
      dir: v.dir === 'asc' ? 'asc' : 'desc',
      status: arr(v.status).filter((s) => STATUS.includes(s)),
      tags: arr(v.tags),
      open: arr(v.open),
      folded: arr(v.folded)
    };
  }
  function saveView() { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch (_) { /* private mode */ } }
  const filtering = () => !!query || view.status.length > 0 || view.tags.length > 0;
  const isOpenRow = (id) => view.open.includes(id);
  function setOpenRow(id, on) {
    const i = view.open.indexOf(id);
    if (on && i < 0) view.open.push(id);
    if (!on && i >= 0) view.open.splice(i, 1);
    saveView();
  }

  const allTags = () => {
    const seen = new Map();
    for (const d of Store.allItems()) if (!d.deletedAt) for (const t of d.tags) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  };
  const rootOf = (d) => { const a = Store.ancestors(d.id); return a.length ? a[a.length - 1] : null; };
  const wordsCache = new Map();
  const wordsOf = (d) => {
    const k = d.id + ':' + d.textAt + ':' + d.updatedAt;
    if (!wordsCache.has(k)) { if (wordsCache.size > 2000) wordsCache.clear(); wordsCache.set(k, P().wordsOf(d)); }
    return wordsCache.get(k);
  };
  const shortDate = (iso) => {
    const t = Date.parse(iso + 'T12:00:00');
    if (isNaN(t)) return iso;
    const dt = new Date(t);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: dt.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  };

  /* ---------- Changing properties ---------- */
  function setFields(d, patch) {
    if (d.kind === 'idea') { Store.update(d.id, patch); render(); return; }
    app().setFields(d, patch);
    render();
  }

  function statusMenu(anchor, d) {
    menu(anchor, [{ type: 'head', label: 'Status' }].concat(STATUS.map((s) => ({ label: S_LABEL[s], value: s, checked: d.status === s }))), (it) => { setFields(d, { status: it.value }); });
  }

  function dateMenu(anchor, d) {
    const cal = TDW.UI.calendar({ value: d.date, onPick: (iso) => { setFields(d, { date: iso || Store.today() }); closeMenu(); } });
    menu(anchor, [], () => false, cal);
    cal.focusDay();
  }

  // Tags: tick the ones it has, or type a new one.
  function tagMenu(anchor, item, after) {
    const chosen = new Set(item.tags);
    const save = () => { setFields(item, { tags: [...chosen] }); if (after) after(); };
    const input = el('input', { type: 'text', class: 'menu-input', placeholder: 'New tag', 'aria-label': 'New tag', autocomplete: 'off', enterkeyhint: 'done' });
    const form = el('form', { class: 'menu-form tag-form' }, input);
    form.noValidate = true;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim().replace(/^#/, '');
      if (!v) { closeMenu(); return; }
      chosen.add(v);
      save();
      closeMenu();
      tagMenu(anchor, item, after);
    });
    const items = [{ type: 'head', label: 'Tags' }].concat(allTags().map((t) => ({ label: t, value: t, checked: item.tags.some((x) => x.toLowerCase() === t.toLowerCase()) })));
    menu(anchor, items, (it, btn) => {
      const has = [...chosen].find((x) => x.toLowerCase() === it.value.toLowerCase());
      if (has) chosen.delete(has); else chosen.add(it.value);
      btn.setAttribute('aria-checked', String(!has));
      save();
      return true;
    }, form);
    if (!allTags().length || TDW.UI.device.touch === false) input.focus({ preventScroll: true });
  }

  function chips(d) {
    const st = el('button', { type: 'button', class: 'chip t-status s-' + d.status, 'aria-label': 'Status: ' + S_LABEL[d.status] + '. Change' },
      el('span', { class: 'chip-dot' }), el('span', { class: 'chip-text', text: S_LABEL[d.status] }));
    st.addEventListener('click', (e) => { e.stopPropagation(); statusMenu(st, d); });
    const dt = el('button', { type: 'button', class: 'chip t-date', 'aria-label': 'Date: ' + shortDate(d.date) + '. Change' }, el('span', { class: 'chip-text', text: shortDate(d.date) }));
    dt.addEventListener('click', (e) => { e.stopPropagation(); dateMenu(dt, d); });
    const tg = d.tags.length
      ? d.tags.map((t) => el('button', { type: 'button', class: 'chip t-tag', 'aria-label': 'Tag ' + t + '. Change tags' }, el('span', { class: 'chip-text', text: t })))
      : [el('button', { type: 'button', class: 'chip t-tag is-empty', 'aria-label': 'Add a tag' }, el('span', { class: 'chip-text', text: 'Tag' }))];
    for (const b of tg) b.addEventListener('click', (e) => { e.stopPropagation(); tagMenu(b, d); });
    return [st, dt].concat(tg);
  }

  /* ---------- Rows ---------- */
  function rowMenu(anchor, d) {
    const kids = Store.children(d.id).length;
    menu(anchor, [
      { label: 'Properties', value: 'props', icon: 'sliders' },
      { label: 'New part', value: 'part', icon: 'plus' },
      { label: 'Move to…', value: 'move', icon: 'turn' },
      kids ? { label: 'Read as one', value: 'read', icon: 'book' } : null,
      { type: 'sep' },
      { label: kids ? 'Delete with its parts' : 'Delete', value: 'delete', icon: 'trash', danger: true }
    ], (it) => {
      if (it.value === 'props') setTimeout(() => openProps(d, { anchor }));
      else if (it.value === 'part') { closeIfOver(); setOpenRow(d.id, true); P().newPart(d.id); }
      else if (it.value === 'move') setTimeout(() => moveTo(d, anchor));
      else if (it.value === 'read') { closeIfOver(); P().read(d.id); }
      else if (it.value === 'delete') deleteDraft(d.id);
    }, null, null, { align: 'end' });
  }

  function rowOf(d, o) {
    const cur = app().state.draft;
    const is = cur && d.id === cur.id;
    const kids = o.kids || 0;
    const open = kids && isOpenRow(d.id);
    const crumb = o.flat ? Store.ancestors(d.id).reverse().map((a) => P().nameOf(a)).join(' › ') : '';
    const title = P().nameOf(d);
    const btn = el('button', { type: 'button', class: 'dr-open', dataset: { key: 'open:' + d.id }, 'aria-current': is ? 'true' : null, 'aria-expanded': kids && !o.flat ? String(!!open) : null },
      crumb ? el('span', { class: 'dr-crumb', text: crumb + ' › ' }) : null, el('span', { class: 'dr-title', text: title }));
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (!suppressClick()) openDraft(d.id); });
    btn.addEventListener('keydown', (e) => {
      if (!kids || o.flat) return;
      if (e.key === 'ArrowRight' && !open) { e.preventDefault(); setOpenRow(d.id, true); render(); }
      if (e.key === 'ArrowLeft' && open) { e.preventDefault(); setOpenRow(d.id, false); render(); }
    });
    const twisty = kids && !o.flat
      ? el('button', { type: 'button', class: 'dr-twisty' + (open ? ' is-open' : ''), tabindex: '-1', 'aria-label': (open ? 'Hide' : 'Show') + ' the parts of “' + title + '”', onclick: (e) => { e.stopPropagation(); setOpenRow(d.id, !open); render(); } }, icon('chevRight'))
      : el('span', { class: 'dr-twisty is-leaf', 'aria-hidden': 'true' });
    const more = el('button', { type: 'button', class: 'dr-more', 'aria-label': 'More for “' + title + '”', 'aria-haspopup': 'menu' }, icon('more'));
    more.addEventListener('click', (e) => { e.stopPropagation(); rowMenu(more, d); });
    const li = el('li', { class: 'dr-row' + (is ? ' is-current' : '') + (kids ? ' has-parts' : ''), dataset: { id: d.id }, style: '--depth:' + (o.depth || 0) },
      el('div', { class: 'dr-line' }, twisty, btn, kids && o.flat ? el('span', { class: 'dr-sub', text: String(kids) }) : null, more),
      el('div', { class: 'dr-props' }, chips(d)));
    li.addEventListener('click', () => { if (!suppressClick()) openDraft(d.id); });
    if (o.draggable) li.addEventListener('pointerdown', (e) => armDrag(e, li, d));
    return li;
  }

  /* ---------- Drawing ---------- */
  function renderDrafts(out) {
    const cur = app().state.draft;
    // The open draft's projects open for it, once, so it shows in the tree.
    if (cur && lastShown !== cur.id) {
      lastShown = cur.id;
      for (const a of Store.ancestors(cur.id)) if (!isOpenRow(a.id)) view.open.push(a.id);
    }
    if (view.group === 'tree' && !filtering()) {
      const kids = (id) => {
        const list = Store.children(id);
        return id == null && view.sort !== 'order' ? list.sort(P().compareBy(view, { words: wordsOf })) : list;
      };
      const rows = P().tree(kids, new Set(view.open));
      for (const r of rows) out.push(rowOf(r.d, { depth: r.depth, kids: r.kids, draggable: true }));
      if (drag) drag.rows = rows;
      lastRows = rows;
      return rows.length;
    }
    const list = Store.listDrafts().filter((d) => P().passes(d, view, query));
    const h = { rootOf, words: wordsOf };
    for (const g of P().groups(list, Object.assign({}, view, { group: view.group === 'tree' ? 'none' : view.group }), h)) {
      const folded = view.folded.includes(view.group + '/' + g.key);
      if (g.label) {
        const b = el('button', { type: 'button', class: 'dr-group' + (folded ? ' is-folded' : ''), 'aria-expanded': String(!folded), dataset: { key: 'group:' + g.key } },
          g.key in S_LABEL ? el('span', { class: 'chip-dot s-' + g.key }) : null, el('span', { text: g.label }), icon('chevDown'));
        b.addEventListener('click', () => {
          const k = view.group + '/' + g.key;
          const i = view.folded.indexOf(k);
          if (i < 0) view.folded.push(k); else view.folded.splice(i, 1);
          saveView();
          render();
        });
        out.push(el('li', { class: 'dr-group-row' }, b));
      }
      if (!folded) for (const d of g.rows) out.push(rowOf(d, { flat: true, kids: Store.children(d.id).length }));
    }
    return list.length;
  }
  let lastRows = [];

  function drawChips() {
    const out = [];
    const chip = (label, cls, onclick, aria) => el('button', { type: 'button', class: 'chip is-filter ' + cls, 'aria-label': aria, onclick }, el('span', { class: 'chip-text', text: label }), icon('close'));
    if (tab === 'drafts') {
      for (const s of view.status) out.push(chip(S_LABEL[s], 't-status s-' + s, () => { view.status = view.status.filter((x) => x !== s); saveView(); render(); }, 'Stop showing only ' + S_LABEL[s]));
      for (const t of view.tags) out.push(chip(t, 't-tag', () => { view.tags = view.tags.filter((x) => x !== t); saveView(); render(); }, 'Stop showing only ' + t));
    } else if (ideaTag) out.push(chip(ideaTag, 't-tag', () => { ideaTag = null; render(); }, 'Show every idea'));
    chipsEl.replaceChildren(...out);
    chipsEl.hidden = !out.length;
  }

  function render() {
    if (!listEl) return;
    const focusKey = document.activeElement && listEl.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const top = listEl.scrollTop;
    for (const [k, b] of Object.entries(tabBtns)) { b.setAttribute('aria-selected', String(k === tab)); b.tabIndex = k === tab ? 0 : -1; }
    side.dataset.tab = tab;
    findEl.placeholder = tab === 'ideas' ? 'Find an idea' : 'Find a draft';
    findEl.setAttribute('aria-label', findEl.placeholder);
    viewBtn.hidden = tab !== 'drafts';
    viewBtn.classList.toggle('is-on', view.status.length + view.tags.length > 0 || view.group !== 'tree');
    drawChips();
    const out = [];
    if (tab === 'ideas') {
      out.push(...TDW.Ideas.rows(query, ideaTag, showArchived, (t) => { ideaTag = t; render(); }, () => { showArchived = !showArchived; render(); }));
    } else {
      const n = renderDrafts(out);
      if (!n) {
        out.push(el('li', { class: 'dr-empty' }, filtering() ? 'No draft matches. ' : 'No drafts yet. ',
          filtering() ? el('button', { type: 'button', class: 'link', text: 'Show all', onclick: clearFilters })
            : el('button', { type: 'button', class: 'link', text: 'Start one', onclick: () => newDraft() })));
      }
    }
    listEl.replaceChildren(...out);
    listEl.scrollTop = top;
    if (focusKey) { const again = listEl.querySelector('[data-key="' + CSS.escape(focusKey) + '"]'); if (again) again.focus({ preventScroll: true }); }
    renderImport();
  }

  function clearFilters() {
    query = ''; findEl.value = '';
    view.status = []; view.tags = [];
    saveView();
    render();
  }

  /* ---------- The view menu: group, sort, filter ---------- */
  function viewMenu(anchor) {
    const items = [{ type: 'head', label: 'Group' }].concat(GROUPS.map(([k, label]) => ({ label, value: 'g:' + k, checked: view.group === k })));
    const note = (k) => (view.sort === k ? (view.dir === 'asc' ? 'oldest first' : 'newest first') : '');
    items.push({ type: 'sep' }, { type: 'head', label: 'Sort' });
    for (const [k, label] of SORTS) items.push({ label, value: 's:' + k, checked: view.sort === k, note: k === 'title' || k === 'order' ? '' : note(k) });
    items.push({ type: 'sep' }, { type: 'head', label: 'Show only' });
    for (const s of STATUS) items.push({ label: S_LABEL[s], value: 'f:' + s, checked: view.status.includes(s) });
    for (const t of allTags()) items.push({ label: t, value: 't:' + t, checked: view.tags.includes(t), icon: 'type' });
    menu(anchor, items, (it, btn) => {
      const [kind, v] = [it.value.slice(0, 1), it.value.slice(2)];
      if (kind === 'g') { view.group = v; saveView(); render(); return false; }
      if (kind === 's') {
        if (view.sort === v) view.dir = view.dir === 'asc' ? 'desc' : 'asc';
        else { view.sort = v; view.dir = v === 'title' || v === 'order' ? 'asc' : 'desc'; }
        saveView(); render(); return false;
      }
      const list = kind === 'f' ? view.status : view.tags;
      const i = list.indexOf(v);
      if (i < 0) list.push(v); else list.splice(i, 1);
      btn.setAttribute('aria-checked', String(i < 0));
      saveView();
      render();
      return true;
    }, null, null, { align: 'end' });
  }

  /* ---------- Dragging a row: reorder, or move into or out of a project ----------
     A mouse drags at once; a finger holds still a moment first, so a swipe still scrolls. */
  let clickBlockedUntil = 0;
  const suppressClick = () => performance.now() < clickBlockedUntil;

  function armDrag(e, li, d) {
    if (e.button !== 0 || drag || e.target.closest('.dr-props, .dr-more, .dr-twisty')) return;
    const touch = e.pointerType !== 'mouse';
    const a = { id: e.pointerId, x: e.clientX, y: e.clientY, li, d, touch, active: false, timer: 0, rows: lastRows };
    drag = a;
    const onMove = (ev) => {
      if (ev.pointerId !== a.id) return;
      const far = Math.hypot(ev.clientX - a.x, ev.clientY - a.y);
      if (!a.active) {
        if (touch) { if (far > 8) cancel(); return; }
        if (far < 5) return;
        start();
      }
      a.px = ev.clientX; a.py = ev.clientY;
      track();
    };
    const onTouchMove = (ev) => { if (a.active) ev.preventDefault(); };
    const finish = (ev) => {
      if (ev && ev.pointerId !== a.id) return;
      cleanup();
      if (!a.active) { drag = null; return; }
      clickBlockedUntil = performance.now() + 350;
      drop(a, ev && ev.type === 'pointercancel');
    };
    const onKey = (ev) => { if (ev.key === 'Escape' && a.active) { ev.preventDefault(); ev.stopPropagation(); cleanup(); a.target = null; drop(a, true); } };
    function cleanup() {
      clearTimeout(a.timer);
      cancelAnimationFrame(a.raf);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('keydown', onKey, true);
    }
    function cancel() { cleanup(); drag = null; }
    function start() {
      a.active = true;
      a.px = a.px || a.x; a.py = a.py || a.y;
      li.classList.add('is-dragged');
      root.classList.add('is-dragging-draft');
      a.ghost = el('div', { class: 'dr-ghost', 'aria-hidden': 'true', text: P().nameOf(d) });
      a.line = el('div', { class: 'dr-drop', 'aria-hidden': 'true' });
      document.body.append(a.ghost, a.line);
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch (_) { /* fine */ } }
      const scroll = () => {
        const r = listEl.getBoundingClientRect();
        const edge = 40;
        const v = a.py < r.top + edge ? -(r.top + edge - a.py) : a.py > r.bottom - edge ? a.py - (r.bottom - edge) : 0;
        if (v) { listEl.scrollTop += Math.max(-14, Math.min(14, v / 3)); track(); }
        a.raf = requestAnimationFrame(scroll);
      };
      a.raf = requestAnimationFrame(scroll);
      track();
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    document.addEventListener('keydown', onKey, true);
    if (touch) {
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      a.timer = setTimeout(() => { if (drag === a) start(); }, 380);
    }
  }

  function track() {
    const a = drag;
    if (!a || !a.active) return;
    a.ghost.style.transform = 'translate3d(' + (a.px + 12) + 'px,' + (a.py - 14) + 'px,0)';
    const rows = [...listEl.querySelectorAll('.dr-row')];
    let hit = null;
    for (const r of rows) { const b = r.getBoundingClientRect(); if (a.py >= b.top && a.py < b.bottom) { hit = r; break; } }
    for (const r of listEl.querySelectorAll('.is-drop-inside')) r.classList.remove('is-drop-inside');
    a.line.hidden = true;
    a.target = null;
    clearTimeout(a.openTimer);
    if (!hit) {
      // Below the last row: the end of the list, at the top.
      const last = rows[rows.length - 1];
      if (last && a.py > last.getBoundingClientRect().bottom) {
        const i = a.rows.findIndex((r) => r.d.id === last.dataset.id);
        let k = i;
        while (k > 0 && a.rows[k].depth > 0) k--;
        const t = P().dropAt(a.rows, k, 'after', a.d.id, (id) => Store.children(id), () => false, (id) => Store.ancestors(id).map((x) => x.id));
        if (t) { a.target = Object.assign({ parentId: null }, t, { parentId: null }); placeLine(last, 0, 'after'); }
      }
      return;
    }
    const i = a.rows.findIndex((r) => r.d.id === hit.dataset.id);
    const b = hit.getBoundingClientRect();
    const f = (a.py - b.top) / b.height;
    const zone = f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'inside';
    const t = P().dropAt(a.rows, i, zone, a.d.id, (id) => Store.children(id), isOpenRow, (id) => Store.ancestors(id).map((x) => x.id));
    if (!t) return;
    a.target = t;
    if (zone === 'inside') {
      hit.classList.add('is-drop-inside');
      // Rest on a closed project and it opens.
      const id = hit.dataset.id;
      if (hit.classList.contains('has-parts') && !isOpenRow(id)) a.openTimer = setTimeout(() => { if (drag === a) { setOpenRow(id, true); render(); track(); } }, 650);
    } else placeLine(hit, a.rows[i].depth + (zone === 'after' && a.rows[i].kids && isOpenRow(a.rows[i].d.id) ? 1 : 0), zone);
  }

  function placeLine(row, depth, zone) {
    const a = drag;
    const b = row.getBoundingClientRect();
    const indent = 28 + depth * 16;
    a.line.hidden = false;
    a.line.style.left = (b.left + indent) + 'px';
    a.line.style.width = Math.max(40, b.width - indent - 6) + 'px';
    a.line.style.top = (zone === 'before' ? b.top : b.bottom) - 1 + 'px';
  }

  function drop(a, cancelled) {
    drag = null;
    clearTimeout(a.openTimer);
    if (a.ghost) a.ghost.remove();
    if (a.line) a.line.remove();
    root.classList.remove('is-dragging-draft');
    a.li.classList.remove('is-dragged');
    const t = !cancelled && a.target;
    if (!t) { render(); return; }
    const d = a.d;
    const was = { parentId: d.parentId && Store.getDraft(d.parentId) ? d.parentId : null, order: d.order };
    if (was.parentId === t.parentId && Store.children(t.parentId).filter((x) => x.id !== d.id).findIndex((x) => x.order > d.order) === t.index) { render(); return; }
    try { Store.move(d.id, t); } catch (e) { toast(e.code === 'cycle' ? "A draft can't go inside its own parts." : e.message); render(); return; }
    // Reordering at the top shows the list in your order from now on.
    if (t.parentId == null && view.sort !== 'order') { view.sort = 'order'; view.dir = 'asc'; saveView(); }
    if (t.parentId) setOpenRow(t.parentId, true);
    afterMove(d, was);
  }

  function afterMove(d, was) {
    const parent = d.parentId ? Store.getDraft(d.parentId) : null;
    render();
    if (TDW.Project) TDW.Project.render();
    if (app().state.draft === d && TDW.Spine) TDW.Spine.render();
    const undo = () => { try { Store.move(d.id, { parentId: was.parentId, order: was.order }); } catch (_) { /* gone */ } render(); if (TDW.Project) TDW.Project.render(); if (TDW.Spine && app().state.draft) TDW.Spine.render(); };
    if (was.parentId !== d.parentId) toast(parent ? 'Moved into “' + P().nameOf(parent) + '”' : 'Moved out', { label: 'Undo', run: undo });
  }

  /* ---------- Picking a draft (Move to…, Add to a project) ---------- */
  let picker = null;
  function pick(anchor, o, done) {
    if (!picker) { picker = el('dialog', { class: 'picker', 'aria-label': 'Pick a draft' }); document.body.append(picker); }
    const input = el('input', { type: 'search', class: 'picker-find', placeholder: o.title, 'aria-label': o.title, autocomplete: 'off', enterkeyhint: 'go' });
    const list = el('ul', { class: 'picker-list', role: 'listbox' });
    let chosen = false;
    const choose = (d) => { chosen = true; dismiss(picker); done(d); };
    const excluded = o.exclude ? new Set([o.exclude].concat(Store.descendants(o.exclude).map((x) => x.id))) : new Set();
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const rows = [];
      if (o.none && !q) rows.push(el('li', null, el('button', { type: 'button', class: 'picker-row is-none' + (o.current == null ? ' is-on' : ''), onclick: () => choose(null) }, el('span', { text: o.none }))));
      const tree = P().tree((id) => Store.children(id), { has: () => true });
      for (const r of tree) {
        if (excluded.has(r.d.id)) continue;
        const name = P().nameOf(r.d);
        if (q && !name.toLowerCase().includes(q)) continue;
        rows.push(el('li', null, el('button', { type: 'button', class: 'picker-row' + (o.current === r.d.id ? ' is-on' : ''), style: '--depth:' + (q ? 0 : r.depth), onclick: () => choose(r.d) },
          el('span', { class: 'picker-name', text: name }), o.current === r.d.id ? icon('check') : null)));
      }
      if (!rows.length) rows.push(el('li', { class: 'dr-empty', text: 'No draft matches.' }));
      list.replaceChildren(...rows);
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const f = list.querySelector('.picker-row:not(.is-none)'); if (f) f.click(); } });
    picker.replaceChildren(el('div', { class: 'grabber', 'aria-hidden': 'true' }), el('div', { class: 'picker-head' }, icon('search'), input), list);
    draw();
    present(picker, { anchor: TDW.UI.isNarrow() ? null : anchor, align: 'end', onDismiss: () => { if (!chosen && o.onCancel) o.onCancel(); } });
    picker._onDismiss = () => { if (!chosen && o.onCancel) o.onCancel(); };
    if (!TDW.UI.device.touch) input.focus({ preventScroll: true });
  }

  function moveTo(d, anchor) {
    const was = { parentId: d.parentId && Store.getDraft(d.parentId) ? d.parentId : null, order: d.order };
    pick(anchor, { title: 'Move “' + P().nameOf(d) + '” to…', exclude: d.id, none: 'Not in a project', current: was.parentId }, (target) => {
      const pid = target ? target.id : null;
      if (pid === was.parentId) return;
      try { Store.move(d.id, { parentId: pid }); } catch (e) { toast(e.code === 'cycle' ? "A draft can't go inside its own parts." : e.message); return; }
      if (pid) setOpenRow(pid, true);
      afterMove(d, was);
    });
  }

  /* ---------- A draft's properties: a small sheet ---------- */
  let props = null;
  function openProps(d, o) {
    if (!d) return;
    const opts = o || {};
    if (!props) { props = el('dialog', { class: 'props', 'aria-label': 'Properties' }); document.body.append(props); }
    const isOpen = () => app().state.draft === d;
    const title = el('input', { type: 'text', class: 'props-title', placeholder: Store.firstSentence(d.text) || 'Untitled', 'aria-label': 'Title', autocomplete: 'off', enterkeyhint: 'done', value: d.title });
    let tTimer = 0;
    const saveTitle = () => { clearTimeout(tTimer); if (title.value.trim() !== d.title.trim()) { setFields(d, { title: title.value.trim() }); if (isOpen() && TDW.Spine) TDW.Spine.render(); } };
    title.addEventListener('input', () => { clearTimeout(tTimer); tTimer = setTimeout(saveTitle, 400); });
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveTitle(); dismiss(props); } });
    const status = TDW.UI.segmented({ label: 'Status', class: 'props-status', value: d.status, options: STATUS.map((s) => ({ value: s, label: S_LABEL[s] })), onChange: (v) => setFields(d, { status: v }) });
    const date = el('input', { type: 'date', class: 'props-date', 'aria-label': 'Date', value: d.date, required: true });
    date.addEventListener('change', () => { if (date.value) setFields(d, { date: date.value }); else date.value = d.date; });
    const tagsEl = el('div', { class: 'props-tags' });
    const drawTags = () => {
      const add = el('button', { type: 'button', class: 'chip t-tag is-add', 'aria-label': 'Add or remove tags' }, icon('plus'), d.tags.length ? null : el('span', { class: 'chip-text', text: 'Add' }));
      add.addEventListener('click', () => tagMenu(add, d, drawTags));
      tagsEl.replaceChildren(...d.tags.map((t) => el('button', { type: 'button', class: 'chip t-tag', 'aria-label': 'Remove the tag ' + t, onclick: () => { setFields(d, { tags: d.tags.filter((x) => x !== t) }); drawTags(); } }, el('span', { class: 'chip-text', text: t }), icon('close'))), add);
    };
    drawTags();
    const projBtn = el('button', { type: 'button', class: 'props-pick', 'aria-haspopup': 'dialog' });
    const drawProj = () => {
      const p = d.parentId && Store.getDraft(d.parentId);
      projBtn.replaceChildren(el('span', { class: p ? '' : 'is-none', text: p ? P().nameOf(p) : 'None' }), icon('chevDown'));
    };
    drawProj();
    projBtn.addEventListener('click', () => {
      const was = { parentId: d.parentId && Store.getDraft(d.parentId) ? d.parentId : null, order: d.order };
      pick(projBtn, { title: 'Part of…', exclude: d.id, none: 'Not in a project', current: was.parentId }, (target) => {
        const pid = target ? target.id : null;
        if (pid !== was.parentId) {
          try { Store.move(d.id, { parentId: pid }); } catch (e) { toast(e.message); return; }
          if (pid) setOpenRow(pid, true);
          afterMove(d, was);
        }
        drawProj();
        if (props.open) setTimeout(() => present(props, { anchor: opts.anchor && !TDW.UI.isNarrow() ? opts.anchor : null }));
      });
    });
    const fmtBtn = el('button', { type: 'button', class: 'props-pick', 'aria-haspopup': 'menu' });
    const drawFmt = () => fmtBtn.replaceChildren(el('span', { text: TDW.Formats.get(d.format).label }), icon('chevDown'));
    drawFmt();
    fmtBtn.addEventListener('click', () => {
      const cur = TDW.Formats.get(d.format).key;
      menu(fmtBtn, TDW.Formats.LIST.map((f) => ({ label: f.label, value: f.key, checked: f.key === cur })), (it) => {
        if (isOpen()) app().setFormat(it.value); else setFields(d, { format: it.value });
        drawFmt();
      });
    });
    const row = (label, ctl) => el('div', { class: 'props-row' }, el('span', { class: 'props-label', text: label }), ctl);
    props.replaceChildren(el('div', { class: 'grabber', 'aria-hidden': 'true' }),
      el('div', { class: 'props-body' }, title,
        row('Status', status), row('Date', date), row('Tags', tagsEl), row('Project', projBtn), row('Format', fmtBtn)));
    present(props, {
      anchor: opts.anchor && !TDW.UI.isNarrow() ? opts.anchor : null,
      onDismiss() { saveTitle(); render(); if (isOpen() && !(state === 'pinned' && side.contains(document.activeElement))) TDW.Editor.focus(); }
    });
    props._onDismiss = () => { saveTitle(); render(); if (isOpen()) TDW.Editor.focus(); };
    if (!TDW.UI.device.touch) title.focus({ preventScroll: true });
    else props.focus();
  }

  /* ---------- Actions ---------- */
  function closeIfOver() { if (state === 'peek' || state === 'held') setState(null); }

  function openDraft(id) {
    closeIfOver();
    const cur = app().state.draft;
    if (!cur || cur.id !== id) app().openDraft(id);
    if (state !== 'pinned') TDW.Editor.focus();
    render();
  }

  // A new draft: today's date, then its properties (all optional; a tap outside closes them).
  function newDraft(o) {
    closeIfOver();
    const d = app().newDraft('');
    app().setMode('write');
    if (o && o.parentId) { try { Store.move(d.id, { parentId: o.parentId }); setOpenRow(o.parentId, true); } catch (_) { /* gone */ } }
    render();
    if (TDW.Spine) TDW.Spine.render();
    if (o && o.props === false) { TDW.Editor.focus(); return d; }
    openProps(d, { isNew: true });
    return d;
  }

  function deleteDraft(id) {
    const d = Store.getDraft(id);
    if (!d) return;
    const open = app().state.draft;
    if (open) app().saveNow();
    const parts = Store.descendants(id).length;
    const wasOpen = !!open && (open.id === id || Store.ancestors(open.id).some((a) => a.id === id));
    const openId = open && open.id;
    const gone = Store.remove(id);
    if (wasOpen) app().draftDeleted(openId, true);
    render();
    if (TDW.Project) TDW.Project.render();
    let back = false;
    const restore = () => {
      if (back) return false;
      back = true;
      if (!Store.restore(id)) { if (gone.length) toast('That draft is gone for good.'); return false; }
      if (wasOpen) app().openDraft(openId);
      render();
      if (TDW.Project) TDW.Project.render();
    };
    app().did('deleted draft', restore, null);
    toast('Deleted “' + P().nameOf(d) + '”' + (parts ? ' and its ' + parts + (parts === 1 ? ' part' : ' parts') : ''), { label: 'Undo', run: restore });
  }

  /* ---------- Importing from Notion: one quiet line, while it's needed ---------- */
  let importing = null;
  function renderImport() {
    if (!importEl) return;
    const I = TDW.NotionImport;
    const need = !!(I && I.needed && I.needed());
    importEl.hidden = !need && !importing;
    if (importEl.hidden) return;
    if (importing) { importEl.replaceChildren(el('span', { text: importing })); return; }
    importEl.replaceChildren(el('span', { text: 'Some Notion pages aren’t here yet.' }), el('button', { type: 'button', class: 'link', text: 'Import', onclick: runImport }));
  }

  async function runImport() {
    if (importing) return;
    importing = 'Importing…';
    renderImport();
    try {
      const t = await TDW.NotionImport.run((p) => { importing = 'Importing ' + p.done + ' of ' + p.total + '…'; renderImport(); });
      importing = null;
      render();
      toast('Imported ' + t.pages + (t.pages === 1 ? ' page' : ' pages') + ' from Notion');
    } catch (e) {
      importing = null;
      renderImport();
      toast((e && e.message) || "Couldn't import from Notion.");
    }
  }

  /* ---------- Showing and hiding ---------- */
  const canPin = () => window.innerWidth >= PIN_MIN && !narrow();
  const narrow = () => TDW.UI.isNarrow();
  const remember = (on) => { try { localStorage.setItem(PIN_KEY, on ? '1' : ''); } catch (_) { /* private mode */ } };
  const width = () => side.offsetWidth + (narrow() ? 0 : 24);

  function setDx(x) {
    dx = x;
    side.style.setProperty('--dx', x.toFixed(1) + 'px');
    if (scrim) scrim.style.opacity = narrow() ? String(Math.max(0, Math.min(1, 1 + x / (side.offsetWidth || 1)))) : '0';
  }

  // The sidebar rides one spring. A new target starts from where it is and how fast it is going,
  // so changing your mind mid-way never makes it jump or wait.
  function slideTo(shown, instant, velocity) {
    const to = shown ? 0 : -width();
    const from = dx == null ? (shown ? -width() : 0) : dx;
    const v = velocity != null ? velocity : slide ? slide.velocity : 0;
    if (slide) slide.stop();
    const done = () => { slide = null; setDx(to); side.classList.remove('is-moving'); if (!shown) scrim.classList.remove('is-on'); };
    if (instant || from === to) { done(); return; }
    side.classList.add('is-moving');
    scrim.classList.add('is-on');
    slide = TDW.UI.spring({ from, to, velocity: v, response: narrow() ? 0.32 : 0.24, damping: velocity && shown && narrow() ? 0.86 : 1, onUpdate: setDx, onDone: done });
  }

  function setState(next, instant, velocity) {
    clearTimeout(enterTimer);
    clearTimeout(leaveTimer);
    leaveTimer = 0;
    if (next === state) { if (velocity != null) slideTo(!!next, instant, velocity); return; }
    const was = state;
    state = next;
    if (!!was !== !!next || velocity != null) slideTo(!!next, instant, velocity);
    if (next) { app().saveNow(); render(); }
    root.dataset.drafts = next || '';
    side.inert = !next;
    scrim.classList.toggle('is-on', !!next && narrow());
    pinBtn.setAttribute('aria-pressed', String(next === 'pinned' || next === 'held'));
    const sb = $('spine-drafts');
    if (sb) { sb.setAttribute('aria-expanded', String(!!next)); sb.setAttribute('aria-pressed', String(!!next && next !== 'peek')); }
    // The page slides over when the sidebar docks; the margin's fixed parts follow it.
    if ((was === 'pinned') !== (next === 'pinned') && TDW.Margin) {
      const t0 = performance.now();
      root.classList.add('drafts-moving');
      const follow = (now) => { TDW.Margin.measure(); if (now - t0 < 340) requestAnimationFrame(follow); else { root.classList.remove('drafts-moving'); TDW.Margin.onLayout(); } };
      requestAnimationFrame(follow);
    }
    if (!next && side.contains(document.activeElement)) TDW.Editor.focus();
  }

  function open(o) {
    const opts = o || {};
    if (opts.tab && opts.tab !== tab) { tab = opts.tab; query = ''; findEl.value = ''; }
    if (narrow()) { setState('held'); return; }
    setState(canPin() ? 'pinned' : 'held');
    remember(true);
    if (opts.focus !== false) findEl.focus({ preventScroll: true });
  }

  function close(o) {
    if (state === 'pinned' && o && o.quiet) return;
    if ((state === 'pinned' || state === 'held') && !narrow()) remember(false);
    setState(null);
  }

  const isOpen = () => !!state;
  const isPinned = () => state === 'pinned';
  const toggle = () => { if (state === 'pinned' || state === 'held') close(); else open(); };

  function setTab(t) {
    if (t === tab) return;
    tab = t;
    query = '';
    findEl.value = '';
    listEl.scrollTop = 0;
    render();
  }

  function toggleSearch() {
    if (!narrow()) { findEl.focus(); findEl.select(); return; }
    searching = !searching;
    side.classList.toggle('is-searching', searching);
    searchBtn.setAttribute('aria-pressed', String(searching));
    if (searching) findEl.focus({ preventScroll: true });
    else { findEl.blur(); if (query) { query = ''; findEl.value = ''; render(); } }
  }

  function build() {
    side = $('drafts');
    scrim = el('div', { class: 'dr-scrim', 'aria-hidden': 'true' });
    scrim.addEventListener('click', () => setState(null));
    side.before(scrim);
    findEl = el('input', { type: 'search', class: 'dr-find-input', placeholder: 'Find a draft', 'aria-label': 'Find a draft', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' });
    findEl.addEventListener('input', () => { query = findEl.value.trim().toLowerCase(); render(); });
    findEl.addEventListener('keydown', (e) => {
      const f = listEl.querySelector('.dr-open, .idea-row');
      if (e.key === 'ArrowDown' && f) { e.preventDefault(); (listEl.querySelector('.dr-open') || f).focus(); }
      if (e.key === 'Enter' && f) { e.preventDefault(); f.click(); }
    });
    listEl = el('ul', { class: 'dr-list', 'aria-label': 'Drafts' });
    listEl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const rows = [...listEl.querySelectorAll('.dr-open, .dr-group')];
      const i = rows.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      if (e.key === 'ArrowUp' && i === 0) { findEl.focus(); return; }
      rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
    });
    const tabOf = (k, label) => el('button', { type: 'button', role: 'tab', class: 'dr-tab', 'aria-selected': 'false', onclick: () => setTab(k) }, label);
    tabBtns = { drafts: tabOf('drafts', 'Drafts'), ideas: tabOf('ideas', 'Ideas') };
    const tabs = el('div', { class: 'dr-tabs', role: 'tablist', 'aria-label': 'Drafts or ideas' }, tabBtns.drafts, tabBtns.ideas);
    tabs.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setTab(tab === 'drafts' ? 'ideas' : 'drafts'); tabBtns[tab].focus(); } });
    pinBtn = el('button', { type: 'button', class: 'dr-tool dr-pin', 'aria-pressed': 'false', 'aria-label': 'Keep the sidebar open', onclick: toggle }, icon('sidebar'));
    chipsEl = el('div', { class: 'dr-filters', hidden: true });
    findWrap = el('div', { class: 'dr-find' }, icon('search'), findEl);
    importEl = el('p', { class: 'dr-import', hidden: true });
    const tool = (ic, label, run, cls) => { const b = el('button', { type: 'button', class: 'dr-act' + (cls ? ' ' + cls : ''), 'aria-label': label }, icon(ic)); b.addEventListener('click', () => run(b)); return b; };
    searchBtn = tool('search', 'Search', toggleSearch, 'is-search');
    searchBtn.setAttribute('aria-pressed', 'false');
    viewBtn = tool('filter', 'Group, sort and filter', viewMenu);
    viewBtn.setAttribute('aria-haspopup', 'menu');
    const foot = el('div', { class: 'dr-foot' },
      el('button', { type: 'button', class: 'dr-new', onclick: () => newDraft() }, icon('newDoc'), el('span', { text: 'New draft' })),
      tool('idea', 'Catch an idea', () => { closeIfOver(); TDW.Ideas.capture(); }),
      searchBtn, viewBtn,
      tool('gear', 'Settings', () => { closeIfOver(); TDW.Dialogs.openSettings(); }));
    side.append(el('div', { class: 'dr' },
      el('div', { class: 'dr-head' }, tabs, pinBtn),
      findWrap, chipsEl, listEl, importEl, foot));
    side.inert = true;
    const sb = $('spine-drafts');
    if (sb) {
      sb.append(icon('sidebar'));
      sb.addEventListener('mousedown', (e) => e.preventDefault());
      sb.addEventListener('click', toggle);
    }
  }

  /* ---------- The phone's drawer: a swipe from near the left edge, and back ----------
     The zone starts a little in from the edge, so Safari keeps its own back swipe; a touch that
     moves up or down first, or starts on selected text, is left to the page. While the finger is
     down the drawer is the finger; on release a spring finishes, carrying the finger's speed. */
  function wireSwipe() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    let g = null;
    const onMove = (e) => {
      if (!g || e.touches.length !== 1) return;
      const t = e.touches[0];
      const mx = t.clientX - g.x0, my = t.clientY - g.y0;
      if (!g.claimed) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        const wrongWay = g.mode === 'open' ? mx < 0 : mx > 0;
        if (Math.abs(mx) < Math.abs(my) * 1.4 || wrongWay || drag) { stop(); return; }
        g.claimed = true;
        g.x0 = t.clientX - (mx > 0 ? 8 : -8) * 0; // the drawer starts where the finger is now: no jump
        g.base = dx == null ? (g.mode === 'open' ? -width() : 0) : dx;
        g.x0 = t.clientX;
        if (slide) { slide.stop(); slide = null; }
        side.classList.add('is-moving');
        scrim.classList.add('is-on');
        side.inert = false;
        closeMenu();
      }
      e.preventDefault();
      let x = g.base + (t.clientX - g.x0);
      if (x > 0) x = TDW.UI.rubber(x, g.w);
      setDx(Math.max(-g.w, x));
      g.hist.push({ x: t.clientX, t: e.timeStamp });
      if (g.hist.length > 6) g.hist.shift();
    };
    const end = () => {
      const s = g;
      stop();
      if (!s || !s.claimed) return;
      const a = s.hist[0], b = s.hist[s.hist.length - 1];
      const v = b.t > a.t ? ((b.x - a.x) / (b.t - a.t)) * 1000 : 0;
      const land = (dx || 0) + TDW.UI.project(v) * 0.5;
      const shown = land > -s.w / 2;
      if (shown) { app().saveNow(); }
      state = shown ? null : 'held'; // setState below sees a change and settles from here with the speed
      setState(shown ? 'held' : null, false, v);
    };
    function stop() {
      g = null;
      document.removeEventListener('touchmove', onMove, { passive: false });
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', end);
    }
    document.addEventListener('touchstart', (e) => {
      if (!narrow() || e.touches.length !== 1 || drag || g) return;
      const t = e.touches[0];
      const opened = state === 'held';
      if (!opened) {
        const [lo, hi] = standalone ? [0, 44] : [20, 56];
        if (t.clientX < lo || t.clientX > hi) return;
        if (document.querySelector('dialog[open]') || TDW.UI.menuOpen()) return;
        const sel = document.getSelection();
        if (sel && !sel.isCollapsed) return;
        if (e.target.closest && e.target.closest('.bench, .spine, .menu, input, textarea, select')) return;
      } else {
        if (!(side.contains(e.target) || e.target === scrim)) return;
        if (e.target.closest('input, textarea, .menu')) return;
      }
      g = { x0: t.clientX, y0: t.clientY, mode: opened ? 'close' : 'open', claimed: false, hist: [{ x: t.clientX, t: e.timeStamp }], w: side.offsetWidth };
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', end);
      document.addEventListener('touchcancel', end);
    }, { passive: true });
  }

  function init() {
    view = loadView();
    build();
    // Rest on the left edge and the sidebar comes over; move away and it goes.
    const edge = $('drafts-edge');
    // Heading for the edge opens it at once; drifting near it needs a short pause, so reaching
    // for the block handles in the gutter doesn't set it off. Never while a button is held.
    const peek = () => { if (!state && !narrow()) setState('peek'); };
    edge.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch' || e.buttons || state || narrow()) return;
      clearTimeout(enterTimer);
      enterTimer = setTimeout(peek, 60);
    });
    edge.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' || e.buttons || state) return;
      if (e.clientX <= 3 || e.movementX <= -3) { clearTimeout(enterTimer); peek(); }
    });
    edge.addEventListener('pointerleave', () => clearTimeout(enterTimer));
    document.addEventListener('pointermove', (e) => {
      if (state !== 'peek' || drag) return;
      const right = 8 + side.offsetWidth; // where it rests, not where the spring has it now
      const away = e.clientX - right;
      if (away <= 28 || TDW.UI.menuOpen() || (e.target.closest && e.target.closest('.menu')) || document.querySelector('dialog.picker[open], dialog.props[open]')) { clearTimeout(leaveTimer); leaveTimer = 0; return; }
      // Well clear of it, or leaving fast: go now. Just past its edge: a short grace, in case you overshot.
      if (away > 140 || e.movementX > 14) { clearTimeout(leaveTimer); leaveTimer = 0; setState(null); return; }
      if (!leaveTimer) leaveTimer = setTimeout(() => { leaveTimer = 0; if (state === 'peek' && !TDW.UI.menuOpen()) setState(null); }, 130);
    }, { passive: true });
    document.addEventListener('pointerdown', (e) => {
      if (state !== 'held' && state !== 'peek') return;
      const t = e.target;
      if (t.closest && (t.closest('#drafts') || t.closest('.dr-scrim') || t.closest('.menu') || t.closest('#spine-drafts') || t.closest('.toast') || t.closest('dialog'))) return;
      setState(null);
    }, true);
    side.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || TDW.UI.menuOpen() || drag) return;
      e.preventDefault();
      e.stopPropagation();
      if (query) { query = ''; findEl.value = ''; render(); return; }
      if (state === 'pinned') TDW.Editor.focus(); else close();
    });
    wireSwipe();
    TDW.UI.narrowQuery.addEventListener('change', () => { if (state) setState(null, true); else setDx(-width()); });
    window.addEventListener('resize', () => {
      if (state === 'pinned' && !canPin()) setState('held');
      else if (state === 'held' && canPin()) setState('pinned');
    });
    setDx(-width());
    let pinned = false;
    try { pinned = localStorage.getItem(PIN_KEY) === '1'; } catch (_) { pinned = false; }
    if (pinned && canPin()) setState('pinned', true);
  }

  TDW.Drafts = {
    init, open, close, toggle, isOpen, isPinned, render, newDraft, openProps, pick, tagMenu, moveTo,
    expand: (id) => setOpenRow(id, true),
    renderSync() {} // the spine shows sync now
  };
})();

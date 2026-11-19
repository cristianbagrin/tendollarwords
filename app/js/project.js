/* Projects: a draft that holds other drafts (its parts), like a book holds chapters. A project's
   page lists its parts under its own text, with what the whole thing costs; "Read as one" shows
   the project as one manuscript, in order, to read, copy or save as Markdown.

   The top half is pure (tested in Node): names, the tree the sidebar draws, where a drop lands,
   the manuscript, how the sidebar groups and sorts, and the #tags an idea is typed with. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const Store = () => TDW.Store;
  const app = () => TDW.App;

  /* ---------- Pure ---------- */

  // A draft's name: the title it was given, or its first sentence.
  const nameOf = (d) => (d && String(d.title || '').trim()) || (d ? Store().displayTitle(d) : '');

  // Text with ghosts left out (what counts and what gets published).
  function cleanText(d, text) {
    const t = text == null ? String(d.text || '') : text;
    const ghosts = (d.ann && d.ann.ghosts) || [];
    return TDW.Marks && ghosts.length ? TDW.Marks.stripGhosts(t, ghosts) : t;
  }
  const wordsOf = (d, text) => TDW.Engine.countWords(cleanText(d, text));

  /* The rows of a tree, depth first: [{ d, depth, kids, parentId }]. `open` is a Set of ids
     whose parts show; childrenOf(id | null) gives the parts in order. */
  function tree(childrenOf, open, rootId) {
    const out = [];
    const walk = (id, dep) => {
      if (dep > 50) return;
      for (const d of childrenOf(id)) {
        const kids = childrenOf(d.id).length;
        out.push({ d, depth: dep, kids, parentId: id });
        if (kids && open.has(d.id)) walk(d.id, dep + 1);
      }
    };
    walk(rootId == null ? null : rootId, 0);
    return out;
  }

  /* Where a dragged draft lands, from the row it is over and where on that row: 'before',
     'after' or 'inside'. Returns { parentId, index } for Store.move, or null when it would land
     in itself or its own parts. ancestorIds(id) lists the ids holding a draft. */
  function dropAt(rows, i, zone, dragId, childrenOf, isOpen, ancestorIds) {
    const row = rows[i];
    if (!row || row.d.id === dragId || ancestorIds(row.d.id).includes(dragId)) return null;
    const t = row.d;
    const without = (pid) => childrenOf(pid).filter((x) => x.id !== dragId);
    if (zone === 'inside') return { parentId: t.id, index: without(t.id).length };
    if (zone === 'after' && row.kids && isOpen(t.id)) return { parentId: t.id, index: 0 };
    const sibs = without(row.parentId);
    const at = sibs.findIndex((x) => x.id === t.id);
    return { parentId: row.parentId, index: at < 0 ? sibs.length : at + (zone === 'after' ? 1 : 0) };
  }

  // Every draft a draft may move into: not itself, not its own parts.
  function moveTargets(id, all, ancestorsOf) {
    return all.filter((d) => d.id !== id && !ancestorsOf(d.id).some((a) => a.id === id));
  }

  // A draft's text as paragraphs of Markdown: one line per paragraph becomes a blank line between.
  const toParagraphs = (md) => String(md || '').replace(/\s+$/, '').split('\n').filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim())).join('\n\n').replace(/\n{3,}/g, '\n\n');

  const plainHead = (line) => String(line || '').replace(/^#{1,3}\s+/, '').replace(/[*_~`]/g, '').trim().toLowerCase();

  /* The whole project as one Markdown manuscript: the project's name as a heading, its text,
     then every part in reading order under its name (## for a part, ### deeper). A part whose
     text already opens with that name as a heading doesn't get it twice. textOf(d) gives the
     text to use (ghosts already out). */
  function manuscript(root, parts, textOf) {
    const out = [];
    const add = (d, level) => {
      const name = nameOf(d);
      const text = String(textOf(d) || '');
      const first = text.split('\n').find((l) => l.trim()) || '';
      const titled = /^#{1,3}\s/.test(first) && plainHead(first) === plainHead(name);
      const fromTitle = !!String(d.title || '').trim() || !text.trim();
      // A name that is only the first sentence repeats the text: then the text speaks for itself.
      if (!titled && fromTitle) out.push('#'.repeat(level) + ' ' + name);
      if (text.trim()) out.push(toParagraphs(text));
    };
    add(root, 1);
    for (const p of parts) add(p.d || p, Math.min(3, 2 + (p.depth || 0)));
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  /* An idea as typed: #tags at the end become tags and leave the text; a #tag inside a sentence
     becomes a tag and keeps its word. */
  function parseIdea(raw) {
    let text = String(raw || '').replace(/\s+$/, '');
    const tags = [];
    const add = (t) => { if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t); };
    const tail = /(?:^|\s)#([\p{L}][\p{L}\p{N}_-]*)\s*$/u;
    let m;
    const end = [];
    while ((m = tail.exec(text))) { end.unshift(m[1]); text = text.slice(0, m.index).replace(/\s+$/, ''); }
    text = text.replace(/(^|\s)#([\p{L}][\p{L}\p{N}_-]*)/gu, (all, sp, t) => { add(t); return sp + t; });
    for (const t of end) add(t);
    return { text: text.trim(), tags };
  }

  function ideaMatches(idea, q, tag) {
    if (tag && !idea.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
    if (!q) return true;
    const hay = (idea.text + ' ' + idea.tags.join(' ')).toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  const STATUS_LABEL = { idea: 'Idea', drafting: 'Drafting', editing: 'Editing', done: 'Done' };
  const STATUS_ORDER = ['idea', 'drafting', 'editing', 'done'];

  function monthKey(iso) {
    const [y, m] = String(iso || '').split('-').map(Number);
    if (!y || !m) return null;
    const now = new Date();
    const label = new Date(y, m - 1, 15).toLocaleDateString('en-US', y === now.getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' });
    return { key: y + '-' + String(m).padStart(2, '0'), label, order: y * 12 + m };
  }

  /* The sidebar's list when it isn't the tree: drafts filtered, sorted, grouped.
     view: { group: 'status'|'date'|'tag'|'project'|'none', sort, dir, status: [], tags: [] }.
     h: { rootOf(d) → the project at the top or null, words(d) }. Returns [{ key, label, rows }]. */
  function compareBy(view, h) {
    const dir = view.dir === 'asc' ? 1 : -1;
    return (a, b) => {
      let r = 0;
      if (view.sort === 'title') r = nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' });
      else if (view.sort === 'spend') r = h.words(a) - h.words(b);
      else if (view.sort === 'date') r = a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      else if (view.sort === 'created') r = a.createdAt - b.createdAt;
      else if (view.sort === 'order') r = a.order - b.order;
      else r = a.updatedAt - b.updatedAt;
      if (!r) r = a.updatedAt - b.updatedAt;
      return r * dir;
    };
  }

  function passes(d, view, q) {
    if (view.status && view.status.length && !view.status.includes(d.status)) return false;
    if (view.tags && view.tags.length && !d.tags.some((t) => view.tags.includes(t))) return false;
    if (q) {
      const hay = (nameOf(d) + ' ' + d.tags.join(' ')).toLowerCase();
      if (!q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  function groups(list, view, h) {
    const rows = list.slice().sort(compareBy(view, h));
    if (view.group === 'none' || !view.group) return [{ key: 'all', label: '', rows }];
    const map = new Map();
    const push = (key, label, order, d) => { if (!map.has(key)) map.set(key, { key, label, order, rows: [] }); map.get(key).rows.push(d); };
    for (const d of rows) {
      if (view.group === 'status') push(d.status, STATUS_LABEL[d.status], STATUS_ORDER.indexOf(d.status), d);
      else if (view.group === 'date') { const m = monthKey(d.date); if (m) push(m.key, m.label, -m.order, d); else push('~', 'No date', 1e9, d); }
      else if (view.group === 'tag') { if (!d.tags.length) push('~', 'No tags', 1e9, d); for (const t of d.tags) push('#' + t.toLowerCase(), t, 0, d); }
      else if (view.group === 'project') { const r = h.rootOf(d); if (r) push(r.id, nameOf(r), 0, d); else push('~', 'Not in a project', 1e9, d); }
    }
    const last = (g) => (g.key === '~' ? 1 : 0);
    const flip = view.group === 'date' && view.sort === 'date' && view.dir === 'asc' ? -1 : 1;
    return [...map.values()].sort((a, b) => last(a) - last(b) || (a.order - b.order) * flip || a.label.localeCompare(b.label));
  }

  /* ---------- The project's page: its parts, under its text ---------- */
  const $ = (id) => document.getElementById(id);
  let partsEl = null, totalEl = null, cached = null; // cached: { rootId, others: words of every part but the open draft }

  const openDraft = () => app() && app().state.draft;
  const liveText = (d) => (d === openDraft() ? app().publishText() : cleanText(d));
  const money = (n) => TDW.UI.money(n);

  // Words in the project under (and with) `rootId`, the open draft counted as it is now.
  function projectWords(rootId) {
    const S = Store();
    const root = S.getDraft(rootId);
    if (!root) return 0;
    const cur = openDraft();
    if (!cached || cached.rootId !== rootId) {
      let others = 0;
      for (const d of [root].concat(S.descendants(rootId))) if (d !== cur) others += wordsOf(d);
      cached = { rootId, others };
    }
    const curIn = cur && (cur.id === rootId || S.ancestors(cur.id).some((a) => a.id === rootId));
    return cached.others + (curIn ? app().state.words : 0);
  }
  const forget = () => { cached = null; };

  function renderParts() {
    if (!partsEl) return;
    const d = openDraft();
    const kids = d ? Store().children(d.id) : [];
    partsEl.hidden = !kids.length;
    if (!kids.length) { partsEl.replaceChildren(); return; }
    const { el, icon } = TDW.UI;
    forget();
    totalEl = el('span', { class: 'parts-total' });
    const rows = kids.map((p, k) => {
      const n = Store().children(p.id).length;
      const b = el('button', { type: 'button', class: 'part', dataset: { id: p.id } },
        el('span', { class: 'part-n', text: String(k + 1) }),
        el('span', { class: 'part-name', text: nameOf(p) }),
        n ? el('span', { class: 'part-sub', text: n + (n === 1 ? ' part' : ' parts') }) : null,
        el('span', { class: 'status-dot s-' + p.status, role: 'img', 'aria-label': STATUS_LABEL[p.status] }),
        el('span', { class: 'part-cost', text: money(wordsOf(p) * 10) }));
      b.addEventListener('click', () => app().openDraft(p.id));
      return el('li', null, b);
    });
    partsEl.replaceChildren(
      el('div', { class: 'parts-head' },
        el('h2', { class: 'parts-title', text: 'Parts' }), totalEl,
        el('button', { type: 'button', class: 'parts-read', onclick: () => read(d.id) }, icon('book'), el('span', { text: 'Read as one' }))),
      el('ol', { class: 'parts-list' }, rows),
      el('button', { type: 'button', class: 'parts-new', onclick: () => newPart(d.id) }, icon('plus'), el('span', { text: 'New part' })));
    drawTotal();
  }

  function drawTotal() {
    const d = openDraft();
    if (!totalEl || !d || partsEl.hidden) return;
    totalEl.textContent = money(projectWords(d.id) * 10) + ' in all';
  }

  // A new part at the end of `parentId`, opened.
  function newPart(parentId, text) {
    if (app().state.draft && !app().saveNow()) return null;
    const S = Store();
    const parent = S.getDraft(parentId);
    if (!parent) return null;
    const st = app().state.settings;
    const f = TDW.Formats.get(parent.format || st.defaultFormat);
    const d = S.create({ kind: 'draft', parentId, text: text || '', format: f.key, budget: TDW.Formats.budgetOf(f, st) });
    app().openDraft(d.id);
    if (TDW.Drafts) TDW.Drafts.render();
    TDW.Editor.focus();
    return d;
  }

  /* ---------- Read as one ---------- */
  let reader = null;

  function manuscriptOf(rootId) {
    app().saveNow();
    const S = Store();
    const root = S.getDraft(rootId);
    if (!root) return null;
    const parts = [];
    const walk = (id, depth) => { if (depth > 50) return; for (const c of S.children(id)) { parts.push({ d: c, depth }); walk(c.id, depth + 1); } };
    walk(rootId, 0);
    return { root, parts, md: manuscript(root, parts, liveText) };
  }

  function fileName(name) {
    return (String(name || 'manuscript').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'manuscript') + '.md';
  }

  function read(rootId) {
    const m = manuscriptOf(rootId);
    if (!m) return;
    const { el, icon, toast } = TDW.UI;
    if (!reader) {
      reader = el('dialog', { class: 'reader no-sheet', 'aria-label': 'Read as one' });
      document.body.append(reader);
    }
    const name = nameOf(m.root);
    const words = TDW.Engine.countWords(m.md.replace(/^#{1,3} .*$/gm, ''));
    const copy = async () => {
      const html = TDW.Formats.toHTML(m.md.replace(/\n\n/g, '\n'));
      const tries = [
        () => navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([m.md], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]),
        () => navigator.clipboard.writeText(m.md),
        () => {
          const ta = el('textarea', { class: 'copy-buffer', 'aria-hidden': 'true' });
          ta.value = m.md;
          ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;width:1px;height:1px';
          reader.append(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          if (!ok) throw new Error('no copy');
        }
      ];
      for (const t of tries) {
        try { await t(); toast('Copied “' + name + '”'); return; } catch (_) { /* the next way */ }
      }
      toast("Couldn't copy. Select the text and copy it instead.");
    };
    const save = () => {
      const a = el('a', { href: URL.createObjectURL(new Blob([m.md], { type: 'text/markdown' })), download: fileName(name) });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('Saved ' + fileName(name));
    };
    const body = el('article', { class: 'reader-text' });
    body.innerHTML = TDW.Formats.toHTML(m.md.replace(/\n\n/g, '\n'));
    reader.replaceChildren(
      el('header', { class: 'reader-bar' },
        el('button', { type: 'button', class: 'btn-icon reader-close', 'aria-label': 'Close', onclick: () => TDW.UI.dismiss(reader) }, icon('close')),
        el('span', { class: 'reader-meta', text: name + ' · ' + money(words * 10) }),
        el('button', { type: 'button', class: 'reader-act', onclick: copy }, icon('copy'), el('span', { text: 'Copy' })),
        el('button', { type: 'button', class: 'reader-act', onclick: save }, icon('download'), el('span', { text: 'Markdown' }))),
      el('div', { class: 'reader-scroll' }, body));
    TDW.UI.present(reader, { onDismiss: () => TDW.Editor.focus() });
    reader.querySelector('.reader-scroll').scrollTop = 0;
    reader._md = m.md;
    reader.querySelector('.reader-close').focus({ preventScroll: true });
  }

  function init() {
    if (!TDW.icons.book) {
      TDW.icons.book = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4.2C6.6 3 4.6 2.7 2.5 3v9.3c2.1-.3 4.1 0 5.5 1.2 1.4-1.2 3.4-1.5 5.5-1.2V3c-2.1-.3-4.1 0-5.5 1.2z"/><path d="M8 4.2v9.3"/></svg>';
    }
    partsEl = $('parts');
    if (!partsEl) return;
    // The page's own clicks (a caret at the end) stay out of the parts.
    for (const t of ['pointerdown', 'mousedown']) partsEl.addEventListener(t, (e) => e.stopPropagation());
  }

  TDW.Project = {
    // Pure (tests)
    nameOf, wordsOf, cleanText, tree, dropAt, moveTargets, manuscript, toParagraphs, parseIdea, ideaMatches,
    passes, groups, compareBy, monthKey, STATUS_LABEL, STATUS_ORDER,
    // The app hands it the open draft like any module.
    init, load: renderParts, reload: renderParts, onText: drawTotal,
    render: renderParts, read, newPart, projectWords, forget
  };
})();

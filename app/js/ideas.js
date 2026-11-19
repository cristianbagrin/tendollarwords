/* Ideas: catch one from anywhere (the bench's bulb, ⌘⇧I, the palette, /dashboard?idea=…, the
   phone's share sheet), find it again in the sidebar's Ideas, and use it: as a new draft, as a
   part of a project, or dropped into the open draft. Return in the capture sheet saves the idea
   and keeps the sheet open for the next one; #tags at the end become tags. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { el, icon, toast, relTime, menu, present, dismiss } = TDW.UI;
  const Store = TDW.Store;
  const P = () => TDW.Project;
  const app = () => TDW.App;

  TDW.icons.idea = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.8 11.2c0-1.5-2.3-2.6-2.3-5A4.5 4.5 0 018 1.8a4.5 4.5 0 014.5 4.4c0 2.4-2.3 3.5-2.3 5z"/><path d="M6 13.2h4M6.8 14.8h2.4"/></svg>';
  TDW.icons.archive = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v6.5a1 1 0 001 1h8a1 1 0 001-1V6M6.5 9h3"/></svg>';

  /* ---------- Catching ---------- */
  let sheet = null, input = null, caughtEl = null;
  const caught = [];

  function add(raw) {
    const { text, tags } = P().parseIdea(raw);
    if (!text && !tags.length) return null;
    const idea = Store.addIdea(text, tags);
    if (TDW.Drafts) TDW.Drafts.render();
    return idea;
  }

  function fit() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; }

  function drawCaught() {
    caughtEl.replaceChildren(...caught.slice(0, 4).map((i) => el('li', { class: 'caught' },
      el('span', { class: 'caught-text', text: i.text || i.tags.map((t) => '#' + t).join(' ') }),
      i.tags.length && i.text ? el('span', { class: 'caught-tags', text: i.tags.map((t) => '#' + t).join(' ') }) : null)));
    caughtEl.hidden = !caught.length;
  }

  function saveTyped() {
    const v = input.value;
    if (!v.trim()) return false;
    const idea = add(v);
    input.value = '';
    fit();
    if (idea) { caught.unshift(idea); drawCaught(); }
    return true;
  }

  function build() {
    sheet = el('dialog', { class: 'idea-sheet', 'aria-label': 'Catch an idea' });
    input = el('textarea', { class: 'idea-input', rows: '1', placeholder: 'An idea', 'aria-label': 'An idea', enterkeyhint: 'done', autocapitalize: 'sentences' });
    input.addEventListener('input', fit);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      if (!saveTyped()) dismiss(sheet);
    });
    caughtEl = el('ul', { class: 'caught-list', hidden: true, 'aria-live': 'polite' });
    const done = el('button', { type: 'button', class: 'idea-save', 'aria-label': 'Save the idea', onclick: () => { if (!saveTyped()) dismiss(sheet); else input.focus(); } }, icon('check'));
    done.addEventListener('mousedown', (e) => e.preventDefault());
    sheet.append(el('div', { class: 'grabber', 'aria-hidden': 'true' }),
      el('div', { class: 'idea-field' }, icon('idea'), input, done), caughtEl);
    document.body.append(sheet);
    TDW.Drafts.tapOutside(sheet);
  }

  // Open the capture sheet (and, given text, put it in).
  function capture(text) {
    if (!sheet) build();
    if (sheet.open) { input.focus(); return; }
    caught.length = 0;
    drawCaught();
    input.value = text || '';
    present(sheet, {
      onDismiss() {
        saveTyped(); // whatever was typed is kept
        if (TDW.Drafts) TDW.Drafts.render();
        if (!(TDW.Drafts && TDW.Drafts.isOpen())) TDW.Editor.focus();
      }
    });
    fit();
    input.focus({ preventScroll: true });
  }

  // From /dashboard?idea=… (an iOS Shortcut) or the share sheet (title, text, url).
  function fromUrl() {
    let u;
    try { u = new URL(location.href); } catch (_) { return; }
    const p = u.searchParams;
    if (!p.has('idea') && !p.has('title') && !p.has('url')) return;
    const parts = [p.get('title'), p.get('idea'), p.get('url')].map((x) => String(x || '').trim()).filter(Boolean);
    const seen = [];
    for (const x of parts) if (!seen.some((y) => y.includes(x))) seen.push(x);
    for (const k of ['idea', 'title', 'url', 'text']) u.searchParams.delete(k);
    try { history.replaceState(history.state, '', u.pathname + (u.search || '') + u.hash); } catch (_) { /* fine */ }
    const idea = seen.length ? add(seen.join(' ')) : null;
    if (idea) toast('Idea caught', { label: 'Ideas', run: () => TDW.Drafts.open({ tab: 'ideas' }) });
  }

  /* ---------- Using one ---------- */
  function toDraft(idea) {
    if (app().state.draft && !app().saveNow()) return;
    const d = Store.ideaToDraft(idea.id);
    if (!d) return;
    if (TDW.Drafts) TDW.Drafts.close({ quiet: true });
    app().openDraft(d.id);
    TDW.Editor.focus();
    toast('Now a draft');
  }

  function toPart(idea, anchor) {
    TDW.Drafts.pick(anchor, { title: 'Add to a project', exclude: null }, (target) => {
      if (!target) return;
      const d = Store.ideaToDraft(idea.id, { parentId: target.id });
      if (!d) return;
      TDW.Drafts.expand(target.id);
      TDW.Drafts.render();
      if (app().state.draft === target && TDW.Project) TDW.Project.render();
      toast('Added to “' + P().nameOf(target) + '”', { label: 'Open', run: () => { app().openDraft(d.id); TDW.Drafts.close({ quiet: true }); } });
    });
  }

  function insert(idea) {
    const d = app().state.draft;
    if (!d) return;
    if (TDW.Drafts && TDW.Drafts.isOpen() && !TDW.Drafts.isPinned()) TDW.Drafts.close({ quiet: true });
    TDW.Editor.focus();
    // Its own paragraph, wherever the caret is.
    const all = TDW.Editor.getText();
    const at = TDW.Editor.getSelection().start;
    const before = all.slice(all.lastIndexOf('\n', at - 1) + 1, at), after = all.slice(at).split('\n')[0];
    app().insertAtCaret((before.trim() ? '\n' : '') + idea.text + (after.trim() ? '\n' : ''));
    Store.update(idea.id, { archived: true });
    if (TDW.Drafts) TDW.Drafts.render();
    toast('Added to this draft', { label: 'Undo', run: () => { TDW.Editor.undo(); Store.update(idea.id, { archived: false }); if (TDW.Drafts) TDW.Drafts.render(); } });
  }

  function archive(idea, on) {
    Store.update(idea.id, { archived: on });
    if (TDW.Drafts) TDW.Drafts.render();
    toast(on ? 'Archived' : 'Back in Ideas', { label: 'Undo', run: () => { Store.update(idea.id, { archived: !on }); if (TDW.Drafts) TDW.Drafts.render(); } });
  }

  function remove(idea) {
    Store.remove(idea.id);
    if (TDW.Drafts) TDW.Drafts.render();
    toast('Deleted', { label: 'Undo', run: () => { Store.restore(idea.id); if (TDW.Drafts) TDW.Drafts.render(); } });
  }

  // Change the words of an idea, in place.
  function edit(row, idea) {
    const t = row.querySelector('.idea-text');
    const box = el('textarea', { class: 'idea-edit', rows: '2', 'aria-label': 'Idea' });
    box.value = idea.text;
    const save = () => {
      if (!box.isConnected) return;
      const v = box.value.trim();
      if (v && v !== idea.text) Store.update(idea.id, { text: v });
      TDW.Drafts.render();
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); box.value = idea.text; save(); }
    });
    box.addEventListener('blur', save);
    t.replaceWith(box);
    box.style.height = box.scrollHeight + 'px';
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }

  function actions(idea, anchor, row) {
    const open = app().state.draft;
    const items = idea.archived
      ? [{ label: 'Back to Ideas', value: 'unarchive', icon: 'undo' }, { label: 'Turn into a draft', value: 'draft', icon: 'newDoc' }, { type: 'sep' }, { label: 'Delete', value: 'delete', icon: 'trash', danger: true }]
      : [
        { label: 'Turn into a draft', value: 'draft', icon: 'newDoc' },
        { label: 'Add to a project…', value: 'part', icon: 'book' },
        open ? { label: 'Insert into this draft', value: 'insert', icon: 'turn' } : null,
        { type: 'sep' },
        { label: 'Edit', value: 'edit', icon: 'pencil' },
        { label: 'Tags…', value: 'tags', icon: 'type' },
        { label: 'Archive', value: 'archive', icon: 'archive' },
        { label: 'Delete', value: 'delete', icon: 'trash', danger: true }
      ];
    menu(anchor, items, (it) => {
      const v = it.value;
      if (v === 'draft') toDraft(idea);
      else if (v === 'part') setTimeout(() => toPart(idea, anchor));
      else if (v === 'insert') insert(idea);
      else if (v === 'edit') setTimeout(() => edit(row, idea));
      else if (v === 'tags') setTimeout(() => TDW.Drafts.tagMenu(anchor, idea));
      else if (v === 'archive') archive(idea, true);
      else if (v === 'unarchive') archive(idea, false);
      else if (v === 'delete') remove(idea);
    }, null, null, { align: 'end' });
  }

  /* ---------- The list, in the sidebar ---------- */
  function row(idea, onTag) {
    const more = el('button', { type: 'button', class: 'dr-more', 'aria-label': 'More for this idea', 'aria-haspopup': 'menu' }, icon('more'));
    const li = el('li', { class: 'idea-row' + (idea.archived ? ' is-archived' : ''), dataset: { id: idea.id } },
      el('p', { class: 'idea-text', text: idea.text || '…' }),
      el('div', { class: 'idea-meta' },
        idea.tags.map((t) => el('button', { type: 'button', class: 'chip t-tag', 'aria-label': 'Show ideas tagged ' + t, onclick: (e) => { e.stopPropagation(); onTag(t); } }, el('span', { class: 'chip-text', text: t }))),
        el('span', { class: 'idea-when', text: relTime(idea.createdAt) }), more));
    more.addEventListener('click', (e) => { e.stopPropagation(); actions(idea, more, li); });
    li.addEventListener('click', (e) => { if (e.target.closest('textarea')) return; actions(idea, more, li); });
    return li;
  }

  /* The Ideas tab's rows: the ones matching `q` and `tag`, newest first, and at the end a way to
     the archived ones. */
  function rows(q, tag, showArchived, onTag, onToggleArchived) {
    const list = Store.ideas({ archived: false }).filter((i) => P().ideaMatches(i, q, tag));
    const out = list.map((i) => row(i, onTag));
    if (!list.length) {
      out.push(el('li', { class: 'dr-empty' }, q || tag ? 'No idea matches.' : 'No ideas yet. ',
        q || tag ? null : el('button', { type: 'button', class: 'link', text: 'Catch one', onclick: () => capture() })));
    }
    const arch = Store.ideas({ archived: true }).filter((i) => P().ideaMatches(i, q, tag));
    if (arch.length) {
      out.push(el('li', { class: 'dr-group-row' }, el('button', { type: 'button', class: 'dr-group' + (showArchived ? '' : ' is-folded'), 'aria-expanded': String(!!showArchived), onclick: onToggleArchived },
        el('span', { text: 'Archived' }), icon('chevDown'))));
      if (showArchived) for (const i of arch) out.push(row(i, onTag));
    }
    return out;
  }

  function init() {
    TDW.Keys.on('idea', () => capture());
    fromUrl();
  }

  TDW.Ideas = { init, capture, add, rows, toDraft, toPart, insert, archive, fromUrl };
})();

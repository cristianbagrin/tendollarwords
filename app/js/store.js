/* Drafts, ideas and settings in localStorage, with an in-memory fallback. Every item is loaded
   once into memory: getDraft returns the same object every time, and the app and sync both
   change that object and save it.

   An item is a draft (kind 'draft') or an idea (kind 'idea'), kept under tdw.draft.<id>. Since
   5.0 drafts have their own properties instead of Notion's: status ('idea' | 'drafting' |
   'editing' | 'done'), date (YYYY-MM-DD), tags, and a place in a project: parentId (the draft
   holding it, or null) and order (among its siblings, lowest first). Ideas use text, tags,
   createdAt and archived. Deleting leaves a tombstone (deletedAt), so the deletion syncs and can
   be undone; getDraft and the lists skip tombstones. Drafts from before 5.0 get these fields from
   their Notion properties the first time they load (NotionMap.propsToFields).

   items-sync.js keeps what it last synced of each item beside it (tdw.sync.<id>). */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};

  const DEFAULTS = {
    skin: 'typewriter', autoNight: false, sound: 'typewriter', volume: 0.35, typewriterScroll: true, textSize: 0, defaultBudget: 2000,
    dictionary: [], noBackspace: true, defaultFormat: 'basic', fixHighlights: true,
    // What each paragraph costs, in the gutter (off: only what is extra shows); the bench under the
    // page; motion and sounds for cuts, trims and challenges; shortcuts changed from their defaults.
    paragraphCost: false, bench: true, effects: true, effectSounds: true, keys: {},
    highlights: { spelling: true, veryHard: true, hard: true, complex: true, passive: true, adverb: true, qualifier: true }
  };
  const PREFIX = 'tdw.draft.';
  const CONFIG = 'tdw.notion';
  const PROBE = 'tdw.__probe';
  const MARKS = 'tdw.notionMarks';
  const ACCOUNT = 'tdw.account';
  const STASH = 'tdw.accountStash';  // an old (before 4.0) account's fields, until the next sign-in
  const SYNC = 'tdw.sync.';          // per item: what items-sync.js last synced
  const SYNC_STATE = 'tdw.syncState';
  const STATUSES = ['idea', 'drafting', 'editing', 'done'];
  const MARK_MS = 60000;
  // Written only by sync. The open draft keeps its own text while it has unsaved typing,
  // but it still takes these, so a Notion link learned in another tab is never lost.
  const LINK_FIELDS = ['notionId', 'url', 'remoteTitle', 'contentFetchedAt', 'contentEditedAt'];

  const mem = new Map();
  const drafts = new Map();
  const savedText = new Map(); // id -> the text last saved or loaded, to tell when the text changed
  const listeners = [];
  const writers = [];          // told about every key this tab writes (the account watches its keys)
  let checked = false;
  let memoryOnly = false;
  let persistAsked = false;
  let loaded = false;
  let config;
  let openId = null;
  let isBusy = () => false;

  const countWords = (t) => TDW.Engine.countWords(t);
  const isQuota = (e) => !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);

  function useMemory() {
    if (memoryOnly) return;
    memoryOnly = true;
    if (TDW.UI) TDW.UI.toast("This browser won't let the app save. Copy your text before you close it.");
  }

  function check() {
    if (checked) return;
    checked = true;
    try {
      localStorage.getItem('tdw.settings');
      localStorage.setItem(PROBE, '1');
      localStorage.removeItem(PROBE);
    } catch (e) {
      if (!isQuota(e)) useMemory();
    }
  }

  function get(k) {
    check();
    if (!memoryOnly) {
      try { return localStorage.getItem(k); } catch (_) { useMemory(); }
    }
    return mem.has(k) ? mem.get(k) : null;
  }

  function wrote(k) {
    for (const fn of writers) {
      try { fn(k); } catch (e) { setTimeout(() => { throw e; }); }
    }
  }

  // Returns true, or 'quota' when storage is full.
  function set(k, v) {
    check();
    if (!memoryOnly) {
      try { localStorage.setItem(k, v); wrote(k); return true; } catch (e) {
        if (isQuota(e)) return 'quota';
        useMemory();
      }
    }
    mem.set(k, v);
    wrote(k);
    return true;
  }

  function remove(k) {
    check();
    if (!memoryOnly) {
      try { localStorage.removeItem(k); wrote(k); return; } catch (_) { useMemory(); }
    }
    mem.delete(k);
    wrote(k);
  }

  function parse(s, fallback) {
    if (s == null) return fallback;
    try { return JSON.parse(s); } catch (_) { return fallback; }
  }
  const readJSON = (k, fallback) => parse(get(k), fallback);

  const newId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const validBudget = (b) => { const n = Math.round(Number(b) / 10) * 10; return n >= 10 ? n : 0; };
  const str = (v, fallback) => (typeof v === 'string' ? v : fallback);

  const plainLine = (l) => (TDW.Inline ? TDW.Inline.plain(l) : l.replace(/^#+/, '')).trim();

  // The title is the draft's first sentence.
  function firstSentence(text) {
    const line = String(text || '').split('\n').map(plainLine).find(Boolean) || '';
    if (!line) return '';
    const list = TDW.Engine ? TDW.Engine.splitSentences(line) : [];
    const first = (list.length ? line.slice(list[0].start, list[0].end) : line).trim();
    return first.length > 150 ? first.slice(0, 147).replace(/\s+\S*$/, '') + '…' : first;
  }
  // Pages that only have a title in Notion keep it until they get some text.
  const displayTitle = (d) => firstSentence(d.text) || String(d.title || '').trim() || 'Untitled draft';

  const pad = (n) => String(n).padStart(2, '0');
  // A day as YYYY-MM-DD, in this device's time zone.
  const dayOf = (ms) => { const t = new Date(ms); return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()); };
  const today = () => dayOf(Date.now());
  const validDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
  function cleanTags(list) {
    const out = [];
    for (const t of Array.isArray(list) ? list : []) {
      const v = typeof t === 'string' ? t.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
      if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
    }
    return out;
  }

  // A draft from before 5.0: its Notion properties give its status, date and tags, once.
  function migrate(raw) {
    if (!raw || typeof raw !== 'object' || 'status' in raw) return false;
    const props = raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props) ? raw.props : {};
    const c = getNotionConfig();
    const M = TDW.NotionMap;
    const f = M && M.propsToFields ? M.propsToFields(props, c && c.schema) : { status: null, date: null, tags: [] };
    raw.kind = 'draft';
    raw.status = f.status || 'drafting';
    if (!validDate(raw.date)) raw.date = f.date || dayOf(Number(raw.createdAt) || Date.now());
    raw.tags = cleanTags((Array.isArray(raw.tags) ? raw.tags : []).concat(f.tags));
    return true;
  }

  function normalize(d) {
    const now = Date.now();
    const props = d.props && typeof d.props === 'object' && !Array.isArray(d.props) ? d.props : {};
    const kind = d.kind === 'idea' ? 'idea' : 'draft';
    const createdAt = Number(d.createdAt) || now;
    return {
      id: String(d.id),
      kind,
      // Projects: the draft this one is a part of, and its place among its siblings.
      parentId: typeof d.parentId === 'string' && d.parentId && d.parentId !== String(d.id) ? d.parentId : null,
      order: Number.isFinite(d.order) ? d.order : createdAt,
      status: STATUSES.includes(d.status) ? d.status : kind === 'idea' ? 'idea' : 'drafting',
      date: validDate(d.date) ? d.date : dayOf(createdAt),
      tags: cleanTags(d.tags),
      archived: !!d.archived,
      deletedAt: Number(d.deletedAt) || 0,
      notionHash: str(d.notionHash, ''), // the text as Import from Notion last brought it (a hash)
      text: str(d.text, ''),
      title: str(d.title, ''),
      format: d.format === 'email' || d.format === 'instagram' ? 'basic' : str(d.format, 'basic'), // retired formats
      budget: validBudget(d.budget) || DEFAULTS.defaultBudget,
      createdAt,
      updatedAt: Number(d.updatedAt) || now,
      textAt: Number(d.textAt) || 0, // when this text was written, in any tab; 0 = unknown
      intent: str(d.intent, ''),
      notionId: str(d.notionId, '') || null,
      url: str(d.url, '') || null,
      props,
      dirty: !!d.dirty,
      propsDirty: !!d.propsDirty,
      contentFetchedAt: Number(d.contentFetchedAt) || 0,
      contentEditedAt: str(d.contentEditedAt, '') || null,
      remoteTitle: str(d.remoteTitle, null),
      localOnly: !!d.localOnly,
      nb: typeof d.nb === 'boolean' ? d.nb : null, // backspace blocked here, or null to follow the stage
      // Notion's colors are the draft's highlights. Until a page has been read once with that in
      // mind, a push leaves colors other than gray alone, so nothing set in Notion is wiped.
      colorsSynced: !!d.colorsSynced,
      // Alternatives and ghosts laid over the text (marks.js), the Overflow beside it, and the
      // writing challenge, if one is running.
      ann: TDW.Marks ? TDW.Marks.normalize(d.ann, str(d.text, '')) : { alts: [], ghosts: [], hls: [], notes: [] },
      overflow: str(d.overflow, ''),
      challenge: d.challenge && typeof d.challenge === 'object' && !Array.isArray(d.challenge) ? d.challenge : null
    };
  }

  function emit(change) {
    for (const fn of listeners) {
      try { fn(change); } catch (e) { setTimeout(() => { throw e; }); }
    }
  }

  const unlink = (d) => Object.assign(d, { notionId: null, url: null, props: {}, remoteTitle: null });

  // Another tab saved something. Reload that one draft in place so every reference stays valid.
  function onStorage(e) {
    if (!e.key || (e.storageArea && e.storageArea !== localStorage)) return;
    if (e.key === CONFIG) {
      const before = parse(e.oldValue, null);
      config = parse(e.newValue, null);
      if (before && config && before.databaseId && config.databaseId && before.databaseId !== config.databaseId) {
        for (const d of drafts.values()) unlink(d);
      }
      emit({ key: e.key });
      return;
    }
    if (!e.key.startsWith(PREFIX)) { emit({ key: e.key, value: e.newValue }); return; }
    const id = e.key.slice(PREFIX.length);
    const cur = drafts.get(id);
    if (e.newValue == null) {
      if (cur) { drafts.delete(id); savedText.delete(id); emit({ key: e.key, id, draft: null }); }
      return;
    }
    const raw = parse(e.newValue, null);
    if (!raw || typeof raw !== 'object') return;
    const incoming = normalize(Object.assign({}, raw, { id }));
    if (!cur) {
      drafts.set(id, incoming);
      savedText.set(id, incoming.text);
      if (!incoming.deletedAt) emit({ key: e.key, id, draft: incoming });
      return;
    }
    // A stale copy from another tab must never drop a link this tab already has.
    if (cur.notionId && !incoming.notionId) for (const k of LINK_FIELDS) incoming[k] = cur[k];
    if (id === openId && isBusy()) {
      for (const k of LINK_FIELDS) cur[k] = incoming[k];
      // Typed in another tab too: this tab's next save wins, so say so instead of losing it quietly.
      if (incoming.text !== cur.text && incoming.textAt > cur.textAt) emit({ key: e.key, id, conflict: true });
      return;
    }
    // Text older than ours: another tab saved its copy (say, marking it synced) just after we
    // saved newer typing. Keep our text, take the rest, and put our copy back in storage.
    if (incoming.text !== cur.text && incoming.textAt < cur.textAt) {
      Object.assign(cur, incoming, { text: cur.text, textAt: cur.textAt, updatedAt: Math.max(cur.updatedAt, incoming.updatedAt), dirty: cur.dirty || incoming.dirty });
      set(PREFIX + id, JSON.stringify(cur));
      emit({ key: e.key, id, draft: cur });
      return;
    }
    Object.assign(cur, incoming);
    savedText.set(id, cur.text);
    emit({ key: e.key, id, draft: cur.deletedAt ? null : cur });
  }

  function load() {
    if (loaded) return;
    loaded = true;
    check();
    const keys = [];
    if (!memoryOnly) {
      try {
        for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
      } catch (_) { useMemory(); }
    }
    keys.push(...mem.keys());
    for (const k of keys) {
      if (!k || !k.startsWith(PREFIX)) continue;
      const id = k.slice(PREFIX.length);
      const raw = readJSON(k, null);
      if (!drafts.has(id) && raw && typeof raw === 'object') {
        const old = migrate(raw);
        const d = normalize(Object.assign({}, raw, { id }));
        drafts.set(id, d);
        savedText.set(id, d.text);
        if (old) set(k, JSON.stringify(d));
      }
    }
    window.addEventListener('storage', onStorage);
  }

  const live = (d) => !!d && !d.deletedAt;
  const isDraft = (d) => live(d) && d.kind === 'draft';

  // Every draft (not ideas, not deleted), the last changed first.
  function listDrafts() {
    load();
    return [...drafts.values()].filter(isDraft).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // A draft or an idea, or null (deleted ones too: see getAny).
  function getDraft(id) {
    load();
    const d = drafts.get(id);
    return live(d) ? d : null;
  }

  // Deleted or not.
  function getAny(id) {
    load();
    return drafts.get(id) || null;
  }

  // Every item, tombstones included (for sync).
  function allItems() {
    load();
    return [...drafts.values()];
  }

  // `any`: a deleted one too.
  function findByNotionId(notionId, any) {
    load();
    for (const d of drafts.values()) if (d.notionId === notionId && (any || live(d))) return d;
    return null;
  }

  function saveDraft(draft) {
    load();
    drafts.set(draft.id, draft);
    if (savedText.get(draft.id) !== draft.text) {
      draft.textAt = Math.max(Date.now(), (draft.textAt || 0) + 1);
      savedText.set(draft.id, draft.text);
    }
    if (set(PREFIX + draft.id, JSON.stringify(draft)) === 'quota') return false;
    if (!persistAsked) {
      persistAsked = true;
      try {
        const p = navigator.storage && navigator.storage.persist && navigator.storage.persist();
        if (p && p.catch) p.catch(() => {});
      } catch (_) { /* ignore */ }
    }
    return true;
  }

  // Gone from this browser for good, with no tombstone: only for what never synced, or what sync
  // says was deleted for good everywhere.
  function forget(id) {
    load();
    drafts.delete(id);
    savedText.delete(id);
    remove(PREFIX + id);
  }

  const isEmpty = (d) => !d.text.trim() && !d.title.trim() && !String(d.overflow || '').trim();
  const hasChildren = (id) => [...drafts.values()].some((x) => live(x) && x.parentId === id);

  // An empty draft that never synced and holds nothing just goes; anything else becomes a
  // tombstone, with every part inside it (they come back with it). Returns the ids deleted.
  function deleteDraft(id) {
    load();
    const d = drafts.get(id);
    if (!live(d)) return [];
    if (isEmpty(d) && !get(SYNC + id) && !hasChildren(id)) { forget(id); return [id]; }
    const at = Date.now();
    const out = [];
    const walk = (x) => {
      x.deletedAt = at;
      x.updatedAt = Math.max(x.updatedAt, at);
      saveDraft(x);
      out.push(x.id);
      for (const c of [...drafts.values()]) if (live(c) && c.parentId === x.id) walk(c);
    };
    walk(d);
    return out;
  }

  // Undo a delete: the item and the parts deleted with it. Returns it, or null.
  function restore(id) {
    load();
    const d = drafts.get(id);
    if (!d) return null;
    if (!d.deletedAt) return d;
    const at = d.deletedAt;
    const walk = (x) => {
      x.deletedAt = 0;
      x.updatedAt = Date.now();
      saveDraft(x);
      for (const c of [...drafts.values()]) if (c.deletedAt === at && c.parentId === x.id) walk(c);
    };
    // Its project was deleted since: it comes back at the top.
    if (d.parentId && !live(drafts.get(d.parentId))) d.parentId = null;
    walk(d);
    return d;
  }

  // Deleted drafts and ideas, the last deleted first (a project's parts left out: they come back with it).
  function deleted() {
    load();
    return [...drafts.values()].filter((d) => d.deletedAt && !(d.parentId && drafts.get(d.parentId) && drafts.get(d.parentId).deletedAt === d.deletedAt))
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /* ---------- Projects: drafts inside drafts ---------- */

  // The parts of a draft, in order; null: the drafts at the top (not inside any).
  function children(id) {
    load();
    const p = id == null ? null : String(id);
    // At the top: no project, or one that is gone.
    const top = (d) => !d.parentId || !isDraft(drafts.get(d.parentId));
    return [...drafts.values()].filter((d) => isDraft(d) && (p === null ? top(d) : d.parentId === p))
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  // Every part, at any depth, in reading order.
  function descendants(id) {
    const out = [];
    const walk = (pid, depth) => { if (depth > 50) return; for (const c of children(pid)) { out.push(c); walk(c.id, depth + 1); } };
    walk(id, 0);
    return out;
  }

  // The drafts holding this one, the nearest first.
  function ancestors(id) {
    load();
    const out = [];
    let d = drafts.get(id);
    while (d && d.parentId && out.length < 50) {
      const p = drafts.get(d.parentId);
      if (!isDraft(p) || out.includes(p)) break;
      out.push(p);
      d = p;
    }
    return out;
  }

  // An order that puts an item at `index` among `siblings` (already sorted, without it).
  function orderAt(siblings, index) {
    const i = Math.max(0, Math.min(index == null ? siblings.length : index, siblings.length));
    const before = siblings[i - 1], after = siblings[i];
    if (!before && !after) return Date.now();
    if (!before) return after.order - 1;
    if (!after) return before.order + 1;
    return (before.order + after.order) / 2;
  }

  /* Move an item: into another draft (parentId), or to the top (parentId null), and to a place
     among its new siblings: `index` (0 = first; left out = last) or an `order` of its own.
     Refuses (throws) to put a draft inside itself or one of its parts. */
  function move(id, to) {
    load();
    const d = getDraft(id);
    if (!d) return null;
    const o = to || {};
    const parentId = 'parentId' in o ? (o.parentId == null ? null : String(o.parentId)) : d.parentId;
    if (parentId) {
      if (!isDraft(drafts.get(parentId))) throw Object.assign(new Error('That draft is gone.'), { code: 'no_parent' });
      if (parentId === d.id || ancestors(parentId).some((a) => a.id === d.id)) throw Object.assign(new Error("A draft can't go inside itself."), { code: 'cycle' });
    }
    const siblings = children(parentId).filter((x) => x.id !== d.id);
    d.parentId = parentId;
    d.order = Number.isFinite(o.order) ? o.order : orderAt(siblings, o.index);
    d.kind = 'draft';
    d.updatedAt = Date.now();
    saveDraft(d);
    return d;
  }

  /* ---------- Making and changing items ---------- */

  const PATCHABLE = ['text', 'title', 'format', 'budget', 'intent', 'nb', 'status', 'date', 'tags', 'archived', 'overflow', 'kind', 'challenge', 'ann'];

  /* A new draft or idea. opts: { kind: 'draft' | 'idea', text, title, parentId, index | order,
     status, date (today if left out), tags, format, budget, intent, nb, notionId, createdAt,
     updatedAt, archived }. A part of a project goes last among its siblings unless told. */
  function create(opts) {
    load();
    const o = opts || {};
    const now = Date.now();
    const kind = o.kind === 'idea' ? 'idea' : 'draft';
    const parentId = kind === 'draft' && o.parentId && isDraft(drafts.get(o.parentId)) ? String(o.parentId) : null;
    const createdAt = o.createdAt || now;
    const order = Number.isFinite(o.order) ? o.order : parentId || o.index != null ? orderAt(children(parentId), o.index) : createdAt;
    const draft = normalize({
      id: newId(), kind, text: o.text || '', title: o.title || '', format: o.format || 'basic',
      budget: o.budget || getSettings().defaultBudget, notionId: o.notionId || null,
      intent: o.intent || '', nb: typeof o.nb === 'boolean' ? o.nb : null,
      parentId, order, status: o.status || (kind === 'idea' ? 'idea' : 'drafting'),
      date: validDate(o.date) ? o.date : today(), tags: o.tags, archived: !!o.archived, overflow: o.overflow || '',
      createdAt, updatedAt: o.updatedAt || now
    });
    saveDraft(draft);
    return draft;
  }

  // The old name, for the app's callers.
  const newDraft = (opts) => create(Object.assign({ kind: 'draft' }, opts || {}));

  /* Change an item's fields and save it: { text, title, status, date, tags, format, budget, intent,
     nb, archived, overflow, kind }. Bad values are dropped (a status not in the list, say). Use
     move() for parentId and order. Returns the item, or null when there's none. */
  function update(id, patch) {
    const d = getDraft(id);
    if (!d) return null;
    const p = patch || {};
    const next = Object.assign({}, d);
    for (const k of PATCHABLE) if (k in p) next[k] = p[k];
    const n = normalize(next);
    let changed = false;
    for (const k of PATCHABLE) {
      if (!(k in p)) continue;
      if (JSON.stringify(d[k]) !== JSON.stringify(n[k])) { d[k] = n[k]; changed = true; }
    }
    if (!changed) return d;
    if (d.kind === 'idea') d.parentId = null;
    d.updatedAt = Date.now();
    saveDraft(d);
    return d;
  }

  // An item as sync brings it: normalized, saved, and put into the object the app already holds.
  function adopt(raw) {
    load();
    const n = normalize(raw);
    const cur = drafts.get(n.id);
    if (cur) { Object.assign(cur, n); saveDraft(cur); return cur; }
    saveDraft(n);
    return n;
  }

  /* ---------- Ideas ---------- */

  // Ideas, newest first. { archived: true } lists the archived ones instead.
  function ideas(opts) {
    load();
    const arch = !!(opts && opts.archived);
    return [...drafts.values()].filter((d) => live(d) && d.kind === 'idea' && d.archived === arch).sort((a, b) => b.createdAt - a.createdAt);
  }

  const addIdea = (text, tags) => create({ kind: 'idea', text: String(text || ''), tags });

  // An idea becomes a draft, in place (same id, its text and tags), inside a project if given.
  function ideaToDraft(id, to) {
    const d = getDraft(id);
    if (!d || d.kind !== 'idea') return d;
    d.kind = 'draft';
    d.archived = false;
    d.status = 'drafting';
    d.date = today();
    const o = to || {};
    if (o.parentId) return move(id, { parentId: o.parentId, index: o.index });
    d.updatedAt = Date.now();
    saveDraft(d);
    return d;
  }

  function getSettings() {
    const saved = readJSON('tdw.settings', {});
    const obj = saved && typeof saved === 'object' ? saved : {};
    const s = Object.assign({}, DEFAULTS, obj);
    s.highlights = Object.assign({}, DEFAULTS.highlights, obj.highlights);
    s.keys = obj.keys && typeof obj.keys === 'object' && !Array.isArray(obj.keys) ? Object.assign({}, obj.keys) : {};
    s.dictionary = Array.isArray(obj.dictionary) ? obj.dictionary.filter((w) => typeof w === 'string' && w) : [];
    if (TDW.Formats && TDW.Formats.get(s.defaultFormat).key !== s.defaultFormat) s.defaultFormat = 'basic';
    return s;
  }

  // The settings object as saved in this browser, or null before anything was saved.
  function getStoredSettings() {
    const s = readJSON('tdw.settings', null);
    return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
  }

  // The signed-in account (see account.js), or null.
  function getAccount() {
    const a = readJSON(ACCOUNT, null);
    const ok = a && typeof a === 'object' && a.v === 2 && typeof a.email === 'string' && typeof a.dk === 'string' &&
      typeof a.vaultId === 'string' && typeof a.secret === 'string' && typeof a.key === 'string' &&
      a.fields && typeof a.fields === 'object' && Number.isInteger(a.rev);
    return ok ? a : null;
  }

  function getNotionConfig() {
    if (config === undefined) config = readJSON(CONFIG, null);
    return config && typeof config === 'object' ? config : null;
  }

  /* ---------- A backup of everything this browser keeps ----------
     For moving to another browser or web address, where localStorage starts empty. It leaves
     out the account's own record (it holds the key the account is encrypted with; each address
     signs in for itself) and what only matters for a minute. */
  const BACKUP_SKIP = new Set([ACCOUNT, STASH, PROBE, MARKS, SYNC_STATE, 'tdw.syncWant', 'tdw.notionBase']);
  // What this browser last synced belongs to this browser: a backup restored elsewhere syncs afresh.
  const skipped = (k) => BACKUP_SKIP.has(k) || k.startsWith(SYNC);

  function exportAll() {
    check();
    const items = {};
    const keys = [];
    if (!memoryOnly) {
      try { for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); } catch (_) { useMemory(); }
    }
    keys.push(...mem.keys());
    for (const k of keys) if (k && k.startsWith('tdw.') && !skipped(k) && !(k in items)) { const v = get(k); if (v != null) items[k] = v; }
    return { app: 'ten-dollar-words', backup: 1, from: location.origin, at: Date.now(), items };
  }

  /* Fills this browser in from a backup and never overwrites anything newer. A draft goes in
     unless this browser has a newer copy of it (by id, or the same Notion page fetched here
     afresh); everything else goes in only where this browser has nothing. Returns what it did,
     or null when the file isn't a backup. The page reloads after, so nothing holds an old copy. */
  function importAll(backup) {
    if (!backup || backup.app !== 'ten-dollar-words' || !backup.items || typeof backup.items !== 'object') return null;
    load();
    const done = { drafts: 0, kept: 0, other: 0, failed: 0 };
    const put = (k, v) => { if (set(k, v) === true) return true; done.failed++; return false; };
    for (const k of Object.keys(backup.items)) {
      const v = backup.items[k];
      if (typeof v !== 'string' || !k.startsWith('tdw.') || skipped(k)) continue;
      if (!k.startsWith(PREFIX)) {
        if (get(k) == null && put(k, v)) done.other++;
        continue;
      }
      const raw = parse(v, null);
      if (!raw || typeof raw !== 'object') continue;
      const id = k.slice(PREFIX.length);
      const twin = drafts.get(id) || (raw.notionId ? findByNotionId(raw.notionId) : null);
      // A copy here wins only when it is newer: by id, its last save; for the same Notion page
      // under another id (pulled from Notion here), only typing newer than the backup's.
      const mine = twin && (twin.id === id ? twin.updatedAt >= (Number(raw.updatedAt) || 0) : twin.dirty && twin.textAt > (Number(raw.textAt) || 0));
      if (mine) { done.kept++; continue; }
      if (!put(k, v)) continue;
      if (twin && twin.id !== id) { remove(PREFIX + twin.id); drafts.delete(twin.id); }
      migrate(raw); // in memory; the stored copy moves at the next load (the page reloads)
      drafts.set(id, normalize(Object.assign({}, raw, { id })));
      done.drafts++;
    }
    const last = backup.items['tdw.last'];
    if (typeof last === 'string' && drafts.has(last)) set('tdw.last', last);
    return done;
  }

  TDW.Store = {
    DEFAULTS, STATUSES,
    listDrafts, getDraft, findByNotionId, saveDraft, deleteDraft, newDraft, displayTitle, firstSentence, countWords,
    // 5.0: items, projects, ideas.
    create, update, move, children, descendants, ancestors, ideas, addIdea, ideaToDraft,
    remove: deleteDraft, restore, deleted, getAny, allItems, forget, adopt, today, dayOf,
    // What items-sync.js last synced, per item, and its place in the server's list of changes.
    getSyncMeta(id) { const m = readJSON(SYNC + id, null); return m && typeof m === 'object' ? m : null; },
    setSyncMeta(id, m) { if (m) set(SYNC + id, JSON.stringify(m)); else remove(SYNC + id); },
    getSyncState() { const m = readJSON(SYNC_STATE, null); return m && typeof m === 'object' ? m : null; },
    setSyncState(m) { if (m) set(SYNC_STATE, JSON.stringify(m)); else remove(SYNC_STATE); },
    clearSyncMeta() {
      check();
      const keys = [];
      if (!memoryOnly) { try { for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); } catch (_) { useMemory(); } }
      keys.push(...mem.keys());
      for (const k of keys) if (k && (k.startsWith(SYNC) || k === SYNC_STATE)) remove(k);
    },
    getSettings, getStoredSettings, exportAll, importAll,
    saveSettings(s) { set('tdw.settings', JSON.stringify(s)); },
    getAccount,
    setAccount(a) { if (a) set(ACCOUNT, JSON.stringify(a)); else remove(ACCOUNT); },
    getAccountRaw() { const a = readJSON(ACCOUNT, null); return a && typeof a === 'object' ? a : null; },
    getAccountStash() { const a = readJSON(STASH, null); return a && typeof a === 'object' ? a : null; },
    setAccountStash(a) { if (a) set(STASH, JSON.stringify(a)); else remove(STASH); },
    getAccountEmail() { return get('tdw.accountEmail') || ''; },
    setAccountEmail(e) { set('tdw.accountEmail', e); },
    getKey() { return get('tdw.geminiKey') || ''; },
    setKey(k) { set('tdw.geminiKey', k); },
    clearKey() { remove('tdw.geminiKey'); },
    getModel() { return get('tdw.geminiModel') || ''; },
    setModel(m) { if (m) set('tdw.geminiModel', m); else remove('tdw.geminiModel'); },
    getModelMode() { return get('tdw.geminiModelMode') === 'manual' ? 'manual' : 'auto'; },
    setModelMode(m) { if (m === 'manual') set('tdw.geminiModelMode', 'manual'); else remove('tdw.geminiModelMode'); },
    getLast() { return get('tdw.last'); },
    setLast(id) { set('tdw.last', id); },
    hintShown() { return get('tdw.hintShown') === '1'; },
    setHintShown() { set('tdw.hintShown', '1'); },
    threadHintShown() { return get('tdw.hintThread') === '1'; },
    setThreadHintShown() { set('tdw.hintThread', '1'); },
    isMemoryOnly() { check(); return memoryOnly; },

    getNotionToken() { return get('tdw.notionToken') || ''; },
    setNotionToken(t) { set('tdw.notionToken', t); },
    clearNotionToken() { remove('tdw.notionToken'); },
    getNotionConfig,
    setNotionConfig(c) {
      config = c || null;
      if (c) set(CONFIG, JSON.stringify(c)); else remove(CONFIG);
    },
    getNotionTrash() { const l = readJSON('tdw.notionTrash', []); return Array.isArray(l) ? l.filter((x) => typeof x === 'string') : []; },
    setNotionTrash(list) { if (list.length) set('tdw.notionTrash', JSON.stringify(list)); else remove('tdw.notionTrash'); },
    // Pages trashed or restored in the last minute, by any tab: a query can still list a page
    // that was just trashed, or miss one that was just restored. The latest mark wins.
    markPage(notionId, kind) {
      const now = Date.now();
      const old = readJSON(MARKS, {});
      const marks = {};
      for (const id of Object.keys(old && typeof old === 'object' ? old : {})) {
        const m = old[id];
        if (m && now - m.at < MARK_MS) marks[id] = m;
      }
      marks[notionId] = { kind, at: now };
      set(MARKS, JSON.stringify(marks));
    },
    pageMarked(notionId, kind) {
      const marks = readJSON(MARKS, {});
      const m = marks && marks[notionId];
      return !!m && m.kind === kind && Date.now() - m.at < MARK_MS;
    },
    // Tells the syncing tab that another tab came to the front.
    setSyncWant(v) { set('tdw.syncWant', JSON.stringify(v)); },
    unlink,

    // The open draft, and whether it has typing that isn't saved yet (storage events skip it then).
    setOpen(id) { openId = id; },
    setBusyCheck(fn) { isBusy = fn; },
    onExternal(fn) { listeners.push(fn); },
    onWrite(fn) { writers.push(fn); }
  };
})();

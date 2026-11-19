/* Import from Notion, once: every page of the connected database becomes a draft here, with its
   text and formatting, colors (highlights), gray text (ghosts), its Overflow toggle, and its
   properties as the app's own (status, date, tags: NotionMap.propsToFields). A page's subpages
   become its parts, in order. Then Notion is disconnected.

   Safe to run again: a page already here (by its Notion id) is updated, not copied. Its text is
   taken from Notion only while nothing was written here since (it's empty, or still what an
   earlier import or the old Notion sync brought); otherwise the draft keeps its text and Notion's
   version goes into its Overflow. A draft deleted here stays deleted.

   TDW.NotionImport.run(onProgress) → { pages, created, updated, kept, skipped }.
   onProgress({ done, total, title }) is called as pages come in. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { Store, Notion, NotionMap: M } = TDW;

  const DONE_KEY = 'tdw.notionImported';
  const MAX_DEPTH = 4;
  const err = (code, message) => Object.assign(new Error(message), { code });
  const plain = (rich) => (Array.isArray(rich) ? rich : []).map((r) => r.plain_text || (r.text && r.text.content) || '').join('').trim();

  function cyrb(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const textHash = (text, overflow) => cyrb(String(text || '') + '\u0000' + String(overflow || ''));

  const linked = () => !!Store.getNotionToken() && !!(Store.getNotionConfig() && Store.getNotionConfig().dataSourceId);

  // Lost alternatives keep their options in Overflow, one line each: "a / b / c".
  function keepLost(overflow, lost) {
    const lines = (lost || []).map((a) => a.options.map((o) => o.text).join(' / ')).filter(Boolean);
    if (!lines.length) return overflow;
    const cur = String(overflow || '');
    return (cur.trim() ? cur.replace(/\s+$/, '') + '\n' : '') + lines.join('\n');
  }

  function keepNotion(overflow, text) {
    const t = String(text || '').replace(/\s+$/, '');
    const cur = String(overflow || '');
    if (!t.trim() || cur.includes(t)) return cur;
    return (cur.trim() ? cur.replace(/\s+$/, '') + '\n\n' : '') + 'From Notion:\n' + t;
  }

  const day = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

  // A page's blocks: its text (with ghosts and colors), its Overflow, and its subpages.
  async function readPage(id) {
    const all = await Notion.listChildren(id);
    const { blocks, overflow } = M.splitPage(all);
    const subpages = blocks.filter((b) => b && b.type === 'child_page' && !b.in_trash && !b.archived);
    const entries = M.blocksToEntries(blocks.filter((b) => !(b && b.type === 'child_page')));
    let ov = '';
    if (overflow && overflow.has_children !== false) ov = M.entriesToText(M.blocksToEntries(await Notion.listChildren(overflow.id)));
    return {
      text: M.entriesToText(entries).replace(/\n+$/, ''), entries, overflow: ov, subpages
    };
  }

  // One page (a database page, or a subpage) into a draft. `info`: { notionId, title, created,
  // edited, props (plain values), parentId, order }.
  async function bring(info, depth, tally, progress) {
    const page = await readPage(info.notionId);
    const c = Store.getNotionConfig();
    const fields = M.propsToFields(info.props || {}, c && c.schema);
    const meta = (TDW.Account && TDW.Account.draftMeta && TDW.Account.draftMeta(info.notionId)) || {};
    const K = TDW.Marks;
    const ghosts = M.ghostsFromEntries(page.entries);
    const hls = M.hlsFromEntries(page.entries);
    const hash = textHash(page.text, page.overflow);
    let d = Store.findByNotionId(info.notionId, true);

    if (d && d.deletedAt) {
      tally.skipped++;
    } else if (!d) {
      const s = Store.getSettings();
      const fmt = meta.format || (TDW.Formats ? TDW.Formats.get(s.defaultFormat).key : 'basic');
      d = Store.create({
        notionId: info.notionId, text: page.text, title: info.title || '', overflow: page.overflow,
        status: fields.status || 'drafting', date: fields.date || day(info.created) || undefined, tags: fields.tags,
        format: fmt, budget: meta.budget || (TDW.Formats ? TDW.Formats.budgetOf(TDW.Formats.get(fmt), s) : undefined),
        intent: meta.intent, nb: meta.nb, parentId: info.parentId, order: info.order,
        createdAt: Date.parse(info.created) || undefined, updatedAt: Date.parse(info.edited) || undefined
      });
      const ann = { alts: meta.alts || [], ghosts, hls, notes: meta.notes || [] };
      d.ann = K ? K.normalize(ann, d.text) : ann;
      Object.assign(d, { props: info.props || {}, notionHash: hash, colorsSynced: true, challenge: meta.challenge || d.challenge || null });
      Store.saveDraft(d);
      tally.created++;
    } else {
      // Written here since Notion last gave it (or since the last import)? Then it keeps its text.
      const untouched = (!d.text.trim() && !String(d.overflow || '').trim()) ||
        (d.notionHash ? d.notionHash === textHash(d.text, d.overflow) : !d.dirty);
      if (untouched) {
        const old = d.text;
        let overflow = page.overflow;
        let ann = { alts: [], ghosts, hls, notes: [] };
        if (K) {
          const r = K.reanchor(d.ann || K.EMPTY, old, page.text);
          ann = { alts: r.ann.alts, ghosts, hls, notes: r.ann.notes };
          if (!ann.alts.length && meta.alts && meta.alts.length) ann.alts = meta.alts;
          if (!ann.notes.length && meta.notes && meta.notes.length) ann.notes = meta.notes;
          overflow = keepLost(overflow, r.lost);
        }
        d.text = page.text;
        d.ann = K ? K.normalize(ann, page.text) : ann;
        d.overflow = overflow;
        tally.updated++;
      } else {
        // Notion's version waits in Overflow, whole, unless it's the same text.
        if (page.text.trim() && page.text !== d.text) d.overflow = keepNotion(d.overflow, page.text);
        tally.kept++;
      }
      // The first import sets the properties from Notion's (they may have changed since this
      // draft last loaded them); later ones only add tags.
      if (!d.notionHash) {
        if (fields.status) d.status = fields.status;
        if (fields.date) d.date = fields.date;
      }
      const tags = d.tags.slice();
      for (const t of fields.tags) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
      d.tags = tags;
      if (!d.title && info.title) d.title = info.title;
      d.props = info.props || d.props;
      if (info.parentId && !d.parentId) { d.parentId = info.parentId; d.order = info.order; }
      d.notionHash = textHash(d.text, d.overflow);
      d.colorsSynced = true;
      d.dirty = false;
      d.updatedAt = Math.max(d.updatedAt, Date.parse(info.edited) || 0);
      Store.saveDraft(d);
    }
    progress(info.title || (d && Store.displayTitle(d)) || '');

    // Subpages: the draft's parts, in the order they sit on the page.
    if (depth >= MAX_DEPTH || !d || d.deletedAt) return;
    let order = 0;
    for (const b of page.subpages) {
      order++;
      await bring({
        notionId: b.id, title: (b.child_page && b.child_page.title) || '', created: b.created_time, edited: b.last_edited_time,
        props: {}, parentId: d.id, order
      }, depth + 1, tally, progress);
    }
  }

  async function run(onProgress) {
    if (!linked()) throw err('not_connected', 'Connect Notion first: paste the secret and the database link.');
    const c = Store.getNotionConfig();
    const tally = { pages: 0, created: 0, updated: 0, kept: 0, skipped: 0 };
    const pages = (await Notion.queryAll(c.dataSourceId)).filter((p) => p && typeof p.id === 'string' && !p.in_trash && !p.is_archived);
    let total = pages.length;
    let done = 0;
    const progress = (title) => {
      done++;
      if (done > total) total = done;
      if (typeof onProgress === 'function') { try { onProgress({ done, total, title }); } catch (e) { setTimeout(() => { throw e; }); } }
    };
    for (const p of pages) {
      const props = {};
      for (const name of Object.keys(p.properties || {})) {
        if (name === c.titleProp) continue;
        const v = M.propFromNotion(p.properties[name]);
        if (v != null && !(Array.isArray(v) && !v.length)) props[name] = v;
      }
      const title = c.titleProp ? String(M.propFromNotion((p.properties || {})[c.titleProp]) || '') : '';
      await bring({ notionId: p.id, title, created: p.created_time, edited: p.last_edited_time, props, parentId: null }, 0, tally, progress);
      tally.pages++;
    }
    try { localStorage.setItem(DONE_KEY, String(Date.now())); } catch (_) { /* memory only */ }
    // Done with Notion: the secret goes (here and, signed in, everywhere); drafts keep their page ids.
    if (TDW.Sync && TDW.Sync.disconnect) TDW.Sync.disconnect();
    else Store.clearNotionToken();
    if (TDW.ItemsSync) TDW.ItemsSync.syncNow();
    return tally;
  }

  TDW.NotionImport = {
    run,
    // Notion is connected and hasn't been imported from yet: drafts from the old sync may still
    // be missing their text (it used to load when a draft opened).
    needed: () => linked() && !doneAt(),
    doneAt,
    linked
  };
  function doneAt() { try { return Number(localStorage.getItem(DONE_KEY)) || 0; } catch (_) { return 0; } }
})();

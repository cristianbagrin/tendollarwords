/* Every draft and idea syncs through the account, one encrypted record each (worker/vault-api.mjs:
   items, get, put, del). Without an account nothing here runs and everything stays in this browser.

   Each item goes up as { v: 1, id, at, f: { field: value } }, sealed in this browser with the
   vault's key (Vault.sealItem), at an address the server can't read an id from (a hash of the key
   and the id). Beside each item this browser keeps what it last synced (Store.getSyncMeta):
   { k: address, r: the server's revision, h: { field: hash of its value } }. That is the base of
   every merge, field by field:
     - only one side changed a field since the base: that side's value;
     - both changed it: tags and Overflow take both; a deleted item stays alive if the other side
       wrote in it; anything else keeps this browser's value, except the text: this browser's text
       stays, and the other version goes into the draft's Overflow, so no words are ever lost.
   A push names the revision it read; a 409 brings the server's copy, which is merged, then sent.

   Changes go up two seconds after a save; others come down when the app comes to the front and
   every 30 seconds while it's in front. One tab at a time does this (a Web Lock). A deleted item
   is a tombstone (deletedAt) that syncs like any other change; after 30 days it's deleted for good
   (the server keeps only its address and revision). */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { Store, Vault } = TDW;

  const API = '/api/vault/';
  const PUSH_MS = 2000;
  const POLL_MS = 30e3;
  const RETRY_MS = 30e3;
  const PURGE_MS = 30 * 24 * 3600e3;
  const LOCK = 'tdw-items';
  const BATCH = 25;                    // items in one put
  const BATCH_CHARS = 3 * 1024 * 1024; // ciphertext in one put
  const GET_MAX = 100;
  const ITEM_MAX = 1536 * 1024;
  // What syncs. 'content' is the text with what's laid over it (alternatives, ghosts, colors, notes).
  const FIELDS = ['content', 'kind', 'parentId', 'order', 'status', 'date', 'tags', 'archived', 'deletedAt', 'title', 'format',
    'budget', 'intent', 'nb', 'challenge', 'overflow', 'notionId', 'props', 'createdAt', 'notionHash'];

  let hooks = {};
  let timer = 0;
  let pollTimer = 0;
  let running = null;
  let again = false;
  let applying = false;
  let started = false;
  let st = { state: 'off', message: '', at: 0 };
  const sids = new Map(); // key + id → address
  const listeners = [];

  const call = (name, ...args) => (typeof hooks[name] === 'function' ? hooks[name](...args) : undefined);
  const err = (code, message, extra) => Object.assign(new Error(message), { code }, extra || {});
  const account = () => Store.getAccount();

  function report(state, message) {
    st = { state, message: message || '', at: state === 'synced' ? Date.now() : st.at };
    for (const fn of listeners) { try { fn(status()); } catch (e) { setTimeout(() => { throw e; }); } }
    call('onStatus', status());
  }
  const status = () => Object.assign({}, st);

  /* ---------- Values, hashes, merging (pure; tested in Node) ---------- */

  function valueOf(d, f) {
    if (f === 'content') return { text: d.text || '', ann: d.ann || null };
    const v = d[f];
    return v === undefined ? null : v;
  }

  function fieldsOf(d) {
    const out = {};
    for (const f of FIELDS) out[f] = valueOf(d, f);
    return out;
  }

  // cyrb53: a quick 53-bit hash, enough to tell whether a value changed.
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
  const hash = (v) => cyrb(Vault.stable(v === undefined ? null : v));
  function hashes(fields) {
    const out = {};
    for (const f of FIELDS) out[f] = hash(fields[f]);
    return out;
  }
  const sameHashes = (a, b) => !!a && !!b && FIELDS.every((f) => a[f] === b[f]);

  const lines = (t) => String(t || '').replace(/\s+$/, '').split('\n').filter((l, i, all) => l || i < all.length - 1);
  function unionLines(a, b) {
    const mine = lines(a);
    const have = new Set(mine);
    const add = lines(b).filter((l) => l.trim() && !have.has(l));
    if (!add.length) return String(a || '');
    return (mine.length ? mine.join('\n') + '\n' : '') + add.join('\n');
  }

  function stamp(ms) {
    try {
      return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (_) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
  }

  // The other version of a text, kept in Overflow under a line that says where it came from.
  function keepOther(overflow, text, at) {
    const t = String(text || '').replace(/\s+$/, '');
    if (!t.trim()) return String(overflow || '');
    const cur = String(overflow || '');
    if (cur.includes(t)) return cur;
    return (cur.trim() ? cur.replace(/\s+$/, '') + '\n\n' : '') + 'From another device, ' + stamp(at || Date.now()) + ':\n' + t;
  }

  /* Merge the server's fields (`remote`) into this browser's (`local`) over the base hashes `base`
     (what both had last time; {} or null when unknown). Returns { fields, conflict } where
     conflict says the texts both changed (the other text went to Overflow). */
  function mergeFields(local, remote, base, remoteAt) {
    const b = base || {};
    const out = Object.assign({}, local);
    let conflict = false, otherText = null, tookContent = false;
    for (const f of FIELDS) {
      const l = local[f] === undefined ? null : local[f];
      const r = remote[f] === undefined ? null : remote[f];
      const lh = hash(l), rh = hash(r), bh = b[f];
      if (lh === rh) continue;
      if (lh === bh) { out[f] = r; if (f === 'content') tookContent = true; continue; }
      if (rh === bh) continue;
      // Both changed it.
      if (f === 'content') {
        const lt = (l && l.text) || '', rt = (r && r.text) || '';
        if (lt === rt) continue; // only what's laid over the text differs: keep ours
        if (!lt.trim()) { out[f] = r; tookContent = true; continue; } // ours is empty: nothing to keep
        conflict = true;
        otherText = rt;
      } else if (f === 'overflow') out[f] = unionLines(l, r);
      else if (f === 'tags') out[f] = (Array.isArray(l) ? l : []).concat((Array.isArray(r) ? r : []).filter((t) => !(Array.isArray(l) ? l : []).some((x) => String(x).toLowerCase() === String(t).toLowerCase())));
      else if (f === 'deletedAt') out[f] = l && r ? Math.max(l, r) : 0; // written on one side: it stays
    }
    // Deleted on one side, written in on the other: it stays.
    if (tookContent && out.deletedAt && !remote.deletedAt) out.deletedAt = 0;
    if (out.deletedAt && !local.deletedAt && hash(local.content) !== b.content) out.deletedAt = 0;
    if (otherText != null) out.overflow = keepOther(out.overflow, otherText, remoteAt);
    return { fields: out, conflict };
  }

  /* Two versions with no base in common (the same Notion page made into a draft on two devices,
     or a browser filled from a backup): the one changed last leads; the other's text, if it
     differs, goes into Overflow; tags and Overflow take both. */
  function combine(a, b, aAt, bAt) {
    const aFirst = (Number(aAt) || 0) >= (Number(bAt) || 0);
    const lead = aFirst ? a : b, other = aFirst ? b : a, otherAt = aFirst ? bAt : aAt;
    const out = Object.assign({}, lead);
    const lt = (lead.content && lead.content.text) || '', ot = (other.content && other.content.text) || '';
    out.overflow = unionLines(lead.overflow, other.overflow);
    if (!lt.trim() && ot.trim()) out.content = other.content;
    else if (ot.trim() && ot !== lt) out.overflow = keepOther(out.overflow, ot, otherAt);
    const tags = Array.isArray(lead.tags) ? lead.tags.slice() : [];
    for (const t of Array.isArray(other.tags) ? other.tags : []) if (!tags.some((x) => String(x).toLowerCase() === String(t).toLowerCase())) tags.push(t);
    out.tags = tags;
    if (!lead.deletedAt || !other.deletedAt) out.deletedAt = 0;
    return out;
  }

  // Fields → the item's own shape (for Store.adopt).
  function toItem(id, fields, extra) {
    const o = Object.assign({ id }, extra || {});
    for (const f of FIELDS) {
      if (f === 'content') { o.text = (fields.content && fields.content.text) || ''; o.ann = (fields.content && fields.content.ann) || null; } else o[f] = fields[f];
    }
    return o;
  }

  const isEmptyDraft = (d, parents) => d.kind !== 'idea' && !String(d.text || '').trim() && !String(d.title || '').trim() &&
    !String(d.overflow || '').trim() && !parents.has(d.id);

  /* ---------- Talking to the server ---------- */

  async function post(action, body) {
    let res;
    try {
      res = await fetch(API + action, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-TDW': '1' }, body: JSON.stringify(body)
      });
    } catch (_) {
      throw err('offline', navigator.onLine === false ? "You're offline." : "Can't reach your account right now.");
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (!data || typeof data !== 'object') throw err('unavailable', "Can't reach your account right now.");
    if (!res.ok) throw err(data.error || 'error', data.message || 'Something went wrong.', { status: res.status, body: data });
    return data;
  }

  async function sidOf(acc, id) {
    const k = acc.vaultId + '|' + id;
    if (!sids.has(k)) sids.set(k, await Vault.hashHex(acc.key + '|item|' + id, 16));
    return sids.get(k);
  }
  const aad = (acc, k) => acc.vaultId + '/' + k;

  /* ---------- One pass: down, then up ---------- */

  // This browser's place in the server's list, for this vault. Another vault: start over.
  function stateFor(acc) {
    const tag = acc.vaultId.slice(0, 16);
    let s = Store.getSyncState();
    if (!s || s.v !== tag) {
      Store.clearSyncMeta();
      s = { v: tag, seq: 0 };
      Store.setSyncState(s);
    }
    return s;
  }

  function withApplying(fn) {
    applying = true;
    try { return fn(); } finally { applying = false; }
  }

  // Before an item that's open changes under the app, the app saves what's typed.
  function flushOpen(id) {
    const cur = call('current');
    if (cur && cur.id === id && TDW.App && TDW.App.saveNow) TDW.App.saveNow();
  }

  function tell(before, d, wasLive) {
    if (!d) return;
    if (wasLive && d.deletedAt) { call('onRemoteDelete', d); return; }
    if (before !== Vault.stable([d.text, d.ann, d.overflow])) call('onRemoteText', d);
    else call('onList');
  }

  // The server's copy of an item, merged in. Returns the local item (or null).
  async function absorb(acc, k, rec, plan) {
    const obj = await Vault.openItem(rec, acc.key, aad(acc, k));
    if (!obj || typeof obj !== 'object' || typeof obj.id !== 'string' || !obj.f || typeof obj.f !== 'object') return null;
    const id = obj.id;
    const remote = obj.f;
    flushOpen(id);
    let d = Store.getAny(id);
    const meta = Store.getSyncMeta(id);
    // The same Notion page as a draft made here under another id (both devices had it before
    // 5.0): the lower id, the same on every device, takes the other in.
    if (!d && remote.notionId && !remote.deletedAt) {
      const twin = Store.findByNotionId(remote.notionId);
      if (twin && twin.id !== id) {
        if (id < twin.id) {
          d = adoptTwin(twin, id, remote, obj.at);
          plan.retire.push(twin.id);
          Store.setSyncMeta(id, { k, r: rec.rev, h: hashes(remote) });
          return d;
        }
        plan.purge.push({ k, r: rec.rev, id, into: twin.id, remote, at: obj.at });
        return twin;
      }
    }
    if (!d) {
      d = withApplying(() => Store.adopt(toItem(id, remote, { updatedAt: Number(obj.at) || Date.now() })));
      Store.setSyncMeta(id, { k, r: rec.rev, h: hashes(remote) });
      if (!d.deletedAt) call('onList');
      return d;
    }
    const before = Vault.stable([d.text, d.ann, d.overflow]);
    const wasLive = !d.deletedAt;
    const local = fieldsOf(d);
    const m = meta && meta.h ? mergeFields(local, remote, meta.h, obj.at) : { fields: combine(local, remote, d.updatedAt, obj.at) };
    if (!Vault.same(m.fields, local)) {
      withApplying(() => Store.adopt(toItem(id, m.fields, Object.assign({}, d, { updatedAt: Math.max(d.updatedAt, Number(obj.at) || 0) }))));
    }
    Store.setSyncMeta(id, { k, r: rec.rev, h: hashes(remote) });
    tell(before, d, wasLive);
    return d;
  }

  // A twin made here takes the name of the one from the server, and the two versions combine.
  function adoptTwin(twin, id, remote, at) {
    flushOpen(twin.id);
    const fields = combine(remote, fieldsOf(twin), at, twin.updatedAt);
    const d = withApplying(() => {
      const item = Store.adopt(toItem(id, fields, { updatedAt: Math.max(twin.updatedAt, Number(at) || 0), url: twin.url, contentFetchedAt: twin.contentFetchedAt }));
      for (const c of Store.allItems()) if (c.parentId === twin.id) { c.parentId = id; Store.saveDraft(c); }
      return item;
    });
    if ((call('current') || {}).id === twin.id && TDW.App && TDW.App.openDraft) setTimeout(() => TDW.App.openDraft(id));
    if (Store.getLast() === twin.id) Store.setLast(id);
    return d;
  }

  // A tombstone with nothing left (deleted for good elsewhere).
  function absorbGone(id, k, rev) {
    const d = Store.getAny(id);
    const meta = Store.getSyncMeta(id);
    if (!d) { Store.setSyncMeta(id, { k, r: rev, gone: 1 }); return; }
    if (meta && meta.h && sameHashes(hashes(fieldsOf(d)), meta.h)) {
      const wasLive = !d.deletedAt;
      withApplying(() => Store.forget(id));
      Store.setSyncMeta(id, { k, r: rev, gone: 1 });
      if (wasLive) call('onRemoteDelete', d);
      return;
    }
    // Changed here since: it comes back, from this browser.
    Store.setSyncMeta(id, { k, r: rev, h: {} });
  }

  async function pullDown(acc, s) {
    const list = await post('items', { id: acc.vaultId, secret: acc.secret, since: s.seq });
    const bySid = new Map();
    for (const d of Store.allItems()) bySid.set(await sidOf(acc, d.id), d.id);
    // Addresses this browser remembers for items it no longer has (deleted for good).
    const need = [];
    for (const [k, rev, del] of list.items || []) {
      const id = bySid.get(k);
      const meta = id ? Store.getSyncMeta(id) : null;
      if (meta && meta.r >= rev) continue;
      if (del) { if (id) absorbGone(id, k, rev); continue; }
      need.push(k);
    }
    const plan = { retire: [], purge: [] };
    while (need.length) {
      const keys = need.splice(0, GET_MAX);
      const res = await post('get', { id: acc.vaultId, secret: acc.secret, keys });
      for (const rec of res.items || []) {
        if (!rec.ct) { const id = bySid.get(rec.k); if (id && rec.rev) absorbGone(id, rec.k, rec.rev); continue; }
        try { await absorb(acc, rec.k, rec, plan); } catch (e) {
          if (e.code === 'locked') throw e;
          console.warn('items-sync: skipped an item', e);
        }
      }
      if (Array.isArray(res.more) && res.more.length) need.unshift(...res.more);
    }
    await settleTwins(acc, plan);
    s.seq = Math.max(s.seq, Number(list.seq) || 0);
    Store.setSyncState(s);
  }

  // Twins found while pulling: the losing one goes for good (from the server, or from here).
  async function settleTwins(acc, plan) {
    for (const id of plan.retire) {
      const meta = Store.getSyncMeta(id);
      withApplying(() => Store.forget(id));
      if (meta && meta.k && meta.r) {
        try {
          const r = await post('put', { id: acc.vaultId, secret: acc.secret, items: [{ k: meta.k, base: meta.r, del: true }] });
          Store.setSyncMeta(id, { k: meta.k, r: r.items[0].rev || meta.r, gone: 1 });
        } catch (e) { if (e.code === 'offline') throw e; }
      } else Store.setSyncMeta(id, null);
    }
    for (const p of plan.purge) {
      // The one here keeps its name and takes the other in, as a change made here.
      const d = Store.getDraft(p.into);
      if (d) {
        const local = fieldsOf(d);
        const fields = combine(local, p.remote, d.updatedAt, p.at);
        if (!Vault.same(fields, local)) {
          const before = Vault.stable([d.text, d.ann, d.overflow]);
          withApplying(() => Store.adopt(toItem(d.id, fields, d)));
          tell(before, d, true);
        }
      }
      try {
        const r = await post('put', { id: acc.vaultId, secret: acc.secret, items: [{ k: p.k, base: p.r, del: true }] });
        if (!r.items[0].conflict) Store.setSyncMeta(p.id, { k: p.k, r: r.items[0].rev, gone: 1 });
      } catch (e) { if (e.code === 'offline') throw e; }
    }
  }

  // What changed here since it last synced.
  async function pending(acc) {
    const out = [];
    const all = Store.allItems();
    const parents = new Set(all.filter((x) => x.parentId && !x.deletedAt).map((x) => x.parentId));
    for (const d of all) {
      const meta = Store.getSyncMeta(d.id);
      const fields = fieldsOf(d);
      const hs = hashes(fields);
      if (meta && meta.h && sameHashes(hs, meta.h)) continue;
      if (!meta && (d.deletedAt || isEmptyDraft(d, parents))) continue; // nothing anyone else needs yet
      if (meta && meta.tooBig === hs.content) continue;
      out.push({ d, fields, hs, meta, k: (meta && meta.k) || (await sidOf(acc, d.id)) });
    }
    return out;
  }

  async function pushUp(acc) {
    const plan = { retire: [], purge: [] };
    let tooBig = null;
    for (let round = 0; round < 3; round++) {
      const list = await pending(acc);
      if (!list.length) break;
      let conflicts = 0;
      while (list.length) {
        const batch = [], sent = [];
        let size = 0;
        while (list.length && batch.length < BATCH) {
          const p = list[0];
          const sealed = await Vault.sealItem({ v: 1, id: p.d.id, at: p.d.updatedAt, f: p.fields }, acc.key, aad(acc, p.k));
          if (sealed.ct.length > ITEM_MAX) {
            list.shift();
            Store.setSyncMeta(p.d.id, Object.assign({}, p.meta || { k: p.k, r: 0, h: {} }, { tooBig: p.hs.content }));
            tooBig = p.d;
            continue;
          }
          if (batch.length && size + sealed.ct.length > BATCH_CHARS) break;
          list.shift();
          size += sealed.ct.length;
          batch.push({ k: p.k, base: p.meta ? p.meta.r || 0 : 0, iv: sealed.iv, ct: sealed.ct });
          sent.push(p);
        }
        if (!batch.length) continue;
        const res = await post('put', { id: acc.vaultId, secret: acc.secret, items: batch });
        for (let i = 0; i < res.items.length; i++) {
          const r = res.items[i], p = sent[i];
          if (!r.conflict) { Store.setSyncMeta(p.d.id, { k: p.k, r: r.rev, h: p.hs }); continue; }
          conflicts++;
          if (r.ct) await absorb(acc, p.k, r, plan);
          else if (r.rev) Store.setSyncMeta(p.d.id, { k: p.k, r: r.rev, h: (p.meta && p.meta.h) || {} }); // gone there: ours comes back
        }
      }
      if (!conflicts) break;
    }
    await settleTwins(acc, plan);
    return tooBig;
  }

  // Tombstones older than 30 days go for good: from the server (it keeps a bare tombstone) and here.
  async function purgeOld(acc) {
    const cut = Date.now() - PURGE_MS;
    for (const d of Store.allItems()) {
      if (!d.deletedAt || d.deletedAt > cut) continue;
      const meta = Store.getSyncMeta(d.id);
      if (!meta) { Store.forget(d.id); continue; }
      if (!meta.h || !sameHashes(hashes(fieldsOf(d)), meta.h)) continue; // not synced yet
      try {
        const r = await post('put', { id: acc.vaultId, secret: acc.secret, items: [{ k: meta.k, base: meta.r, del: true }] });
        const x = r.items[0];
        if (x.conflict) continue;
        withApplying(() => Store.forget(d.id));
        Store.setSyncMeta(d.id, { k: meta.k, r: x.rev, gone: 1 });
      } catch (e) { if (e.code === 'offline') throw e; }
    }
  }

  async function passLocked() {
    const acc = account();
    if (!acc) { report('off'); return; }
    const s = stateFor(acc);
    report('syncing');
    await pullDown(acc, s);
    if (!account() || account().vaultId !== acc.vaultId) return;
    const big = await pushUp(acc);
    await purgeOld(acc);
    if (big) report('error', '“' + Store.displayTitle(big) + '” is too large to sync. Split it into parts.');
    else report('synced');
  }

  function failed(e) {
    const code = e && e.code;
    if (code === 'gone' || code === 'forbidden' || code === 'locked') { report('error', (e && e.message) || 'Sync stopped.'); return; }
    report(code === 'offline' ? 'offline' : 'error', (e && e.message) || 'Something went wrong.');
    if (code !== 'offline') schedule(RETRY_MS);
  }

  function locked(fn) {
    if (navigator.locks && navigator.locks.request) return navigator.locks.request(LOCK, fn);
    return fn();
  }

  // Sync now. Returns when done; a call while one runs waits for that one and runs once more.
  function syncNow() {
    clearTimeout(timer);
    if (!account()) { report('off'); return Promise.resolve(); }
    if (running) { again = true; return running; }
    running = locked(passLocked).catch(failed).finally(() => {
      running = null;
      if (again) { again = false; schedule(0); }
    });
    return running;
  }

  function schedule(ms) {
    clearTimeout(timer);
    if (!account()) return;
    timer = setTimeout(() => { syncNow(); }, ms == null ? PUSH_MS : ms);
  }

  function start() {
    if (started || !account()) return;
    started = true;
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, POLL_MS);
    schedule(0);
  }

  function stop() {
    started = false;
    clearTimeout(timer);
    clearInterval(pollTimer);
    report('off');
  }

  function init(h) {
    hooks = h || {};
    Store.onWrite((key) => {
      if (applying || !started || !key || !key.startsWith('tdw.draft.')) return;
      schedule();
    });
    document.addEventListener('visibilitychange', () => {
      if (!started) return;
      if (document.visibilityState === 'visible') syncNow();
      else schedule(0);
    });
    window.addEventListener('online', () => { if (started) syncNow(); });
    if (TDW.Account && TDW.Account.onChange) {
      TDW.Account.onChange(() => {
        if (account()) start();
        else if (started) stop();
      });
    }
    if (account()) start();
  }

  TDW.ItemsSync = {
    init, start, stop, syncNow, status,
    onStatus(fn) { listeners.push(fn); },
    // For tests.
    _: { mergeFields, combine, fieldsOf, hashes, hash, unionLines, keepOther, FIELDS }
  };
})();

/* Your account. Sign in once in each browser, and what you set up follows you: the Notion secret
   and database, the Gemini key and model, your settings and dictionary, and each Notion draft's
   format, budget, message and backspace switch (Notion doesn't keep those).
   You sign in with your cristianbagrin.com account, the one all of Chris's apps share. What this
   app syncs is one document of fields (see vault.js), encrypted here with a key made from the
   account's data key (keyring.js), and kept on this app's server at an address made from that key
   too, so neither server can read it. The data key travels only inside the keyring, wrapped by
   the account's master key, which your password and the account's one recovery key open in
   every app (account-keyring.js; keyrings from before it move under it when you sign in: see
   `settle`). This browser keeps its copy, the data key and the master key in
   localStorage['tdw.account']; a change here is stamped, saved, and sent a moment later. Another
   device's changes arrive when the app comes to the front, and every 5 minutes.
   People with an account from before 4.0 move over the first time they sign in: see `move`. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { Store, Vault, Keyring } = TDW;
  const AK = window.AccountKeyring;

  const OLD_API = '/api/account/';       // the old accounts, only for moving
  const VAULT_API = '/api/vault/';
  const SHARED_API = 'https://account.cristianbagrin.com/api/';
  const APP = 'tdw';
  const RING = '@' + APP + '/keyring';
  const ACCOUNT_RING = '@account/keyring';
  const DRAFT = 'tdw.recoveryDraft';
  const PUSH_MS = 1500;
  const RETRY_MS = 30000;
  const POLL_MS = 5 * 60e3;
  const PULL_GAP_MS = 15e3;
  const RING_MS = 60 * 60e3;             // how often a signed-in device checks the keyring
  const LOCK = 'tdw-account';
  const SYNCED = new Set(['tdw.settings', 'tdw.geminiKey', 'tdw.geminiModel', 'tdw.geminiModelMode', 'tdw.notionToken', 'tdw.notion']);

  let hooks = {};
  let applying = false;
  let holds = 0;
  let noteQueued = false;
  let pushTimer = 0;
  let pollTimer = 0;
  let lastPull = 0;
  let status = { state: 'idle', message: '' };
  let peeked = null;
  const listeners = [];

  const call = (name, ...args) => (typeof hooks[name] === 'function' ? hooks[name](...args) : undefined);
  const read = () => Store.getAccount();
  const signedIn = () => !!read();
  const err = (code, message) => Object.assign(new Error(message), { code });

  function write(acc) {
    peeked = null;
    Store.setAccount(acc);
    emit();
  }

  // A read-only copy for lookups that happen often (every page in a full Notion sync).
  function peek() {
    if (!peeked) peeked = { acc: read() };
    return peeked.acc;
  }

  function emit() {
    for (const fn of listeners) {
      try { fn(); } catch (e) { setTimeout(() => { throw e; }); }
    }
  }

  function setStatus(state, message) {
    status = { state, message: message || '' };
    emit();
  }

  /* ---------- This browser's values as fields ---------- */

  // Alternatives go as [kind, start, end, active, [[text, by]…]]; ghosts travel through Notion (gray text).
  const altsOf = (d) => (d.ann && d.ann.alts.length ? d.ann.alts.map((a) => [a.kind, a.start, a.end, a.active, a.options.map((o) => [o.text, o.by])]) : null);
  // Notes go with the words they're on (q), so another device can find them; highlights travel through Notion (colors).
  const notesOf = (d) => (d.ann && d.ann.notes && d.ann.notes.length ? d.ann.notes.map((n) => ({
    s: n.start, e: n.end, q: d.text.slice(n.start, n.end), b: n.body, d: n.done ? 1 : 0, ai: n.ai ? 1 : 0, c: n.color || '', at: n.at,
    t: n.thread.map((m) => [m.by, m.text, m.at, m.options || null])
  })) : null);
  function notesFrom(v) {
    if (!Array.isArray(v)) return [];
    return v.filter((x) => x && typeof x === 'object').map((x) => ({
      start: x.s, end: x.e, quote: x.q, body: x.b, done: !!x.d, ai: !!x.ai, color: x.c, at: x.at,
      thread: (Array.isArray(x.t) ? x.t : []).filter(Array.isArray).map((m) => ({ by: m[0], text: m[1], at: m[2], options: m[3] || undefined }))
    }));
  }
  const metaOf = (d) => ({ f: d.format, b: d.budget, i: d.intent || '', nb: typeof d.nb === 'boolean' ? d.nb : null, al: altsOf(d), no: notesOf(d), ch: d.challenge || null });
  function altsFrom(v) {
    if (!Array.isArray(v)) return [];
    return v.filter((x) => Array.isArray(x) && Array.isArray(x[4])).map((x) => ({
      kind: x[0], start: x[1], end: x[2], active: x[3], options: x[4].filter(Array.isArray).map((o) => ({ text: o[0], by: o[1] }))
    }));
  }

  // What this browser has stored. Settings count only once they've been saved here.
  function localFields() {
    const out = {};
    const s = Store.getStoredSettings();
    if (s) {
      for (const k of Object.keys(Store.DEFAULTS)) if (k !== 'dictionary' && k in s) out['set.' + k] = s[k];
      for (const w of Array.isArray(s.dictionary) ? s.dictionary : []) if (typeof w === 'string' && w) out['dict.' + w.toLowerCase()] = w;
    }
    out['ai.key'] = Store.getKey() || null;
    out['ai.model'] = Store.getModel() || null;
    out['ai.mode'] = Store.getModelMode();
    out['notion.token'] = Store.getNotionToken() || null;
    out['notion.config'] = Store.getNotionConfig() || null;
    return { out, hasSettings: !!s };
  }

  // Everything here, stamped `at`: now for a new account, 0 when signing in (so the account wins).
  function snapshot(at) {
    const fields = {};
    const { out } = localFields();
    for (const n of Object.keys(out)) if (out[n] != null) fields[n] = { v: out[n], at };
    for (const d of Store.listDrafts()) if (d.notionId && !d.localOnly) fields['draft.' + d.notionId] = { v: metaOf(d), at };
    return fields;
  }

  function touched(acc) {
    acc.seq = (acc.seq || 0) + 1;
    acc.dirty = true;
    write(acc);
    pushSoon();
  }

  // A synced value changed here: stamp it. A new stamp always beats the one it replaces, even
  // when another device's clock runs ahead.
  function noteLocal() {
    noteQueued = false;
    if (applying || holds) return;
    const acc = read();
    if (!acc) return;
    const { out, hasSettings } = localFields();
    if (hasSettings) {
      for (const n of Object.keys(acc.fields)) if (n.startsWith('dict.') && acc.fields[n].v != null && !(n in out)) out[n] = null;
    }
    const t = Date.now();
    let changed = false;
    for (const n of Object.keys(out)) {
      const cur = acc.fields[n];
      if (cur ? Vault.same(cur.v, out[n]) : out[n] == null) continue;
      acc.fields[n] = { v: out[n], at: Math.max(t, cur ? cur.at + 1 : 0) };
      changed = true;
    }
    if (changed) touched(acc);
  }

  function queueNote() {
    if (noteQueued) return;
    noteQueued = true;
    queueMicrotask(noteLocal);
  }

  // A Notion draft's format, budget, message or backspace switch changed here.
  function noteDraft(d) {
    if (!d || !d.notionId || d.localOnly || applying) return;
    const acc = read();
    if (!acc) return;
    const name = 'draft.' + d.notionId;
    const v = metaOf(d);
    const cur = acc.fields[name];
    if (cur && Vault.same(cur.v, v)) return;
    acc.fields[name] = { v, at: Math.max(Date.now(), cur ? cur.at + 1 : 0) };
    touched(acc);
  }

  const validBudget = (b) => Number.isFinite(b) && b >= 10 && b % 10 === 0;

  // What the account says about a Notion page's draft, for a draft made from that page.
  function draftMeta(notionId) {
    const acc = peek();
    const f = acc && acc.fields['draft.' + notionId];
    const v = f && f.v;
    if (!v || typeof v !== 'object') return null;
    return {
      format: TDW.Formats && TDW.Formats.get(v.f).key === v.f ? v.f : null,
      budget: validBudget(v.b) ? v.b : null,
      intent: typeof v.i === 'string' ? v.i : '',
      nb: typeof v.nb === 'boolean' ? v.nb : null,
      alts: altsFrom(v.al),
      notes: notesFrom(v.no),
      challenge: v.ch && typeof v.ch === 'object' && !Array.isArray(v.ch) ? v.ch : null
    };
  }

  function validSetting(k, v) {
    const d = Store.DEFAULTS[k];
    if (d === undefined || k === 'dictionary' || typeof v !== typeof d) return false;
    return (k !== 'highlights' && k !== 'keys') || (!!v && !Array.isArray(v));
  }

  /* ---------- The account's values into this browser ---------- */

  function apply(merged) {
    const { out } = localFields();
    const differs = (n) => !!merged[n] && !Vault.same(merged[n].v, out[n] == null ? null : out[n]);
    const changes = { settings: false, ai: false, notion: null, drafts: [] };
    applying = true;
    try {
      const sets = Object.keys(merged).filter((n) => n.startsWith('set.') && differs(n) && validSetting(n.slice(4), merged[n].v));
      const s = Store.getSettings();
      const words = Object.keys(merged).filter((n) => n.startsWith('dict.') && typeof merged[n].v === 'string').map((n) => merged[n].v);
      const hasDict = Object.keys(merged).some((n) => n.startsWith('dict.'));
      const lower = new Set(words.map((w) => w.toLowerCase()));
      const kept = s.dictionary.filter((w) => lower.has(w.toLowerCase()));
      const dict = kept.concat(words.filter((w) => !kept.some((k) => k.toLowerCase() === w.toLowerCase())));
      const dictChanged = hasDict && !Vault.same([...dict].sort(), [...s.dictionary].sort());
      if (sets.length || dictChanged) {
        for (const n of sets) s[n.slice(4)] = merged[n].v;
        if (dictChanged) s.dictionary = dict;
        Store.saveSettings(s);
        changes.settings = true;
      }

      if (differs('ai.key')) { if (merged['ai.key'].v) Store.setKey(merged['ai.key'].v); else Store.clearKey(); changes.ai = true; }
      if (differs('ai.model')) { Store.setModel(merged['ai.model'].v || ''); changes.ai = true; }
      if (differs('ai.mode')) { Store.setModelMode(merged['ai.mode'].v); changes.ai = true; }

      if (differs('notion.token') || differs('notion.config')) {
        changes.notion = { prev: Store.getNotionConfig() };
        if (differs('notion.config')) Store.setNotionConfig(merged['notion.config'].v || null);
        if (differs('notion.token')) { if (merged['notion.token'].v) Store.setNotionToken(merged['notion.token'].v); else Store.clearNotionToken(); }
      }

      for (const n of Object.keys(merged)) {
        if (!n.startsWith('draft.') || !merged[n].v) continue;
        const d = Store.findByNotionId(n.slice(6));
        const m = draftMetaFrom(merged[n].v);
        if (!d || d.localOnly || !m) continue;
        if (TDW.Marks) m.ann = TDW.Marks.normalize(TDW.Marks.withAnn(d.ann, { alts: altsFrom(merged[n].v.al), notes: notesFrom(merged[n].v.no) }), d.text);
        if (Vault.same(metaOf(d), metaOf(Object.assign({}, d, m)))) continue;
        Object.assign(d, m);
        Store.saveDraft(d);
        changes.drafts.push(d);
      }
    } finally {
      applying = false;
    }
    if (changes.settings || changes.ai || changes.notion || changes.drafts.length) call('onApplied', changes);
  }

  function draftMetaFrom(v) {
    if (!v || typeof v !== 'object') return null;
    const m = {};
    if (TDW.Formats && TDW.Formats.get(v.f).key === v.f) m.format = v.f;
    if (validBudget(v.b)) m.budget = v.b;
    if (typeof v.i === 'string') m.intent = v.i;
    m.nb = typeof v.nb === 'boolean' ? v.nb : null;
    m.challenge = v.ch && typeof v.ch === 'object' && !Array.isArray(v.ch) ? v.ch : null;
    return m;
  }


  /* ---------- Talking to the servers ---------- */

  // This app's own server: the vault, and the old accounts.
  async function post(base, action, body) {
    let res;
    try {
      res = await fetch(base + action, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-TDW': '1' },
        body: JSON.stringify(body || {})
      });
    } catch (_) {
      throw err('offline', navigator.onLine === false ? "You're offline." : "Can't reach your account right now.");
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* not JSON: this server has no accounts */ }
    if (!data || typeof data !== 'object') throw err('unavailable', 'Accounts only work in the online app, not in a copy served from this computer.');
    if (!res.ok) throw Object.assign(err(data.error || 'error', data.message || 'Something went wrong.'), { status: res.status, doc: data });
    return data;
  }

  // The shared account service. On this computer a test can point it elsewhere.
  function sharedBase() {
    try {
      if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname)) {
        const dev = localStorage.getItem('tdw.dev.accountApi');
        if (dev) return dev;
      }
    } catch (_) { /* storage blocked */ }
    return SHARED_API;
  }

  async function shared(path, body, token) {
    let res;
    try {
      res = await fetch(sharedBase() + path, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (_) {
      throw err('offline', navigator.onLine === false ? "You're offline." : "Can't reach your account right now.");
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (!data || typeof data !== 'object') throw err('unavailable', "Can't reach your account right now.");
    if (!res.ok) throw Object.assign(err(data.code || 'error', data.error || 'Something went wrong.'), { status: res.status });
    return data;
  }

  // An item of `app` as the account keeps it: { v, s }, `s` being what a write over it must name.
  async function readItem(token, app, k) {
    let since = 0, item = null;
    for (let i = 0; i < 20; i++) {
      const res = await shared('sync', { app, since, changes: [] }, token);
      for (const c of res.changes || []) if (c && c.k === k) item = c;
      if (!res.more) break;
      since = res.seq;
    }
    return { v: item && item.v && typeof item.v === 'object' ? item.v : null, s: (item && item.s) || 0 };
  }

  // Write an item over the one read at `s` (0: none). The account refuses it if anything changed it
  // since, so two devices or apps never write over each other: false when refused.
  async function writeItem(token, app, k, v, s) {
    const res = await shared('sync', { app, since: 0, changes: [{ k, v, t: Date.now(), if: s }] }, token);
    return !(res.rejected || []).includes(k);
  }

  // This app's keyring, and the account's (its master key, shared by every app).
  const getRing = (token) => readItem(token, APP, RING);
  const putRing = (token, ring, s) => writeItem(token, APP, RING, ring, s);
  async function getAccountRing(token) {
    const r = await readItem(token, 'account', ACCOUNT_RING);
    return { ring: AK.isRing(r.v) ? r.v : null, s: r.s };
  }
  const putAccountRing = (token, ring, s) => writeItem(token, 'account', ACCOUNT_RING, ring, s);

  // A recovery key just made, kept here before the keyring holding it is written: if signing in
  // stops right after, the next sign-in still shows it.
  let draftMem = null;
  function keepDraft(email, key) {
    draftMem = key ? { email, key } : null;
    try { if (key) localStorage.setItem(DRAFT, JSON.stringify(draftMem)); else localStorage.removeItem(DRAFT); } catch (_) { /* memory only */ }
  }
  function draftFor(email) {
    let d = draftMem;
    try { d = JSON.parse(localStorage.getItem(DRAFT) || 'null') || d; } catch (_) { /* memory only */ }
    return d && d.email === email ? d.key : null;
  }

  const vaultOf = (acc) => ({ id: acc.vaultId, secret: acc.secret });

  // One tab at a time talks to the servers, so two tabs never send the same change twice.
  function locked(fn) {
    if (navigator.locks && navigator.locks.request) return navigator.locks.request(LOCK, fn);
    return fn();
  }

  // Merge the server's copy into this browser's, and apply what the server won.
  async function absorb(doc, known) {
    noteLocal(); // a change made here a moment ago is part of this browser's copy first
    const acc = read();
    if (!acc) return;
    const remote = known || (doc.ct ? await Vault.open(doc, acc.key, acc.vaultId) : {});
    const now = read();
    if (!now || now.vaultId !== acc.vaultId) return;
    const merged = Vault.merge(now.fields, remote);
    now.fields = merged;
    now.rev = doc.rev;
    now.dirty = Vault.differs(merged, remote);
    write(now);
    apply(merged);
  }

  function failed(e) {
    const code = e && e.code;
    if (code === 'gone') return lost('Your synced data was removed on another device. Sign in again to sync this browser.');
    if (code === 'locked' || code === 'forbidden') return lost("Your account's keys changed on another device. Sign in again in Settings.");
    setStatus(code === 'offline' ? 'offline' : 'error', (e && e.message) || 'Something went wrong.');
    const acc = read();
    if (acc && acc.dirty && code !== 'offline') pushSoon(RETRY_MS);
  }

  // This browser can't sync any more (the keys changed or the data was removed elsewhere). It
  // keeps its settings and keys for Notion and Gemini; signing in again merges them back.
  function lost(message) {
    clearTimeout(pushTimer);
    clearInterval(pollTimer);
    write(null);
    setStatus('idle');
    call('onSignedOut', message);
  }

  async function pushLocked() {
    for (let k = 0; k < 4; k++) {
      const acc = read();
      if (!acc || !acc.dirty) { if (acc) setStatus('synced'); return; }
      const seq = acc.seq;
      setStatus('syncing');
      let res;
      try {
        const sealed = await Vault.seal(acc.fields, acc.key, acc.vaultId);
        res = await post(VAULT_API, 'push', Object.assign(vaultOf(acc), { base: Math.max(acc.rev, 0), iv: sealed.iv, ct: sealed.ct }));
      } catch (e) {
        if (e.code === 'conflict' && e.doc) {
          try { await absorb(e.doc); } catch (e2) { failed(e2); return; }
          continue;
        }
        failed(e);
        return;
      }
      const now = read();
      if (!now || now.vaultId !== acc.vaultId) return;
      now.rev = res.rev;
      now.at = Date.now();
      if (now.seq === seq) now.dirty = false;
      write(now);
    }
    const acc = read();
    if (acc && acc.dirty) pushSoon();
    else if (acc) setStatus('synced');
  }

  function pushNow() {
    clearTimeout(pushTimer);
    return locked(pushLocked);
  }

  function pushSoon(ms) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushNow().catch(failed); }, ms == null ? PUSH_MS : ms);
  }

  // Now and then: is the keyring still the one this browser's key belongs to? A browser whose
  // session ended (the password changed elsewhere) keeps syncing with the key it holds, and asks
  // for the password once, quietly, in Settings.
  async function checkRing() {
    const acc = read();
    if (!acc || !acc.token || Date.now() - (acc.ringAt || 0) < RING_MS) return true;
    let ring, acct;
    try { [{ v: ring }, acct] = await Promise.all([getRing(acc.token), getAccountRing(acc.token)]); } catch (e) {
      const now = read();
      if (e.code === 'signed_out' && now && now.vaultId === acc.vaultId) { now.token = null; now.reauth = true; write(now); }
      return true;
    }
    const now = read();
    if (!now || now.vaultId !== acc.vaultId) return false;
    if (!ring) { lost('Your synced data was removed on another device. Sign in again to sync this browser.'); return false; }
    if (ring.kid && ring.kid !== now.kid) { lost("Your account's keys changed on another device. Sign in again in Settings."); return false; }
    // A recovery key still waiting to be saved, replaced meanwhile (in another app, say): not worth showing.
    if (now.rk && acct.ring && !(await AK.isCurrentRecovery(acct.ring, now.rk))) { delete now.rk; delete now.rkReplaced; keepDraft(now.email, null); }
    now.ringAt = Date.now();
    write(now);
    return true;
  }

  async function pull(force) {
    if (!signedIn() || (!force && Date.now() - lastPull < PULL_GAP_MS)) return;
    lastPull = Date.now();
    if (!(await checkRing())) return;
    await locked(async () => {
      const acc = read();
      if (!acc) return;
      setStatus('syncing');
      try {
        const res = await post(VAULT_API, 'pull', vaultOf(acc));
        if (res.rev !== acc.rev) await absorb(res);
        const now = read();
        if (now && now.dirty) await pushLocked();
        else if (now) { now.at = Date.now(); write(now); setStatus('synced'); }
      } catch (e) {
        failed(e);
      }
    });
  }

  function start() {
    clearInterval(pollTimer);
    if (signedIn()) pollTimer = setInterval(() => { if (document.visibilityState === 'visible') pull(); }, POLL_MS);
  }

  /* ---------- Signing in ----------
     Signing in can need more from you along the way: a recovery key (the password changed and
     this browser doesn't hold the key), the shared account's password (when it differs from an
     old Ten Dollar Words password), or an old account's password. signIn and answer return
     { done: true } or { need: 'recovery' | 'account_password' | 'old_password' }; the sign-in
     waits in `pending` for the answer. */

  let pending = null;

  function checkPassword(password) {
    if (String(password || '').length < 8) throw err('short', 'Use at least 8 characters.');
  }

  async function oldStatus(email) {
    try { return !!(await post(OLD_API, 'status', { email })).legacy; } catch (e) {
      if (e.code === 'offline') throw e;
      return false; // this server has no old accounts
    }
  }

  // Open the old account and its document. Sets p.old, or throws (code 'wrong': not this password).
  async function openOld(p, password) {
    const keys = await Vault.deriveKeys(p.email, password);
    const res = await post(OLD_API, 'login', { email: p.email, auth: keys.auth });
    const fields = res.ct ? await Vault.open(res, keys.key, res.userId) : {};
    p.old = { keys, fields };
  }

  async function begin(email, password, create) {
    const e = Vault.normEmail(email);
    if (create) checkPassword(password);
    pending = { email: e, password: String(password || ''), create: !!create };
    return proceed();
  }

  async function proceed() {
    const p = pending;
    if (!p) throw err('signed_out', 'Start again: sign in.');

    // 1. The shared account.
    if (!p.token) {
      let res;
      if (p.create) {
        res = await shared('signup', { email: p.email, password: p.password });
        p.accountPassword = p.password;
      } else if (p.accountPassword) {
        res = await shared('login', { email: p.email, password: p.accountPassword });
      } else {
        try {
          res = await shared('login', { email: p.email, password: p.password });
          p.accountPassword = p.password;
        } catch (e) {
          // Maybe someone from before 4.0, whose Ten Dollar Words password this is.
          if (e.code !== 'wrong' || p.oldTried || !(await oldStatus(p.email))) throw e;
          p.oldTried = true;
          try { await openOld(p, p.password); } catch (e2) { if (e2.code === 'wrong') throw e; throw e2; }
          try {
            res = await shared('signup', { email: p.email, password: p.password });
            p.accountPassword = p.password;
          } catch (e3) {
            if (e3.code === 'exists') return { need: 'account_password' };
            throw e3;
          }
        }
      }
      p.token = res.token;
      p.email = res.email || p.email;
    }

    // 2. The keys.
    if (!p.dk) {
      const r = await settle(p);
      if (r.need) { p.asked = r.need; return r; }
    }

    // 3. This browser, signed in and synced.
    if (!p.started) {
      await startDevice(p);
      p.started = true;
    }

    // 4. An old account that hasn't moved yet.
    if (!p.oldDone) {
      if (!p.old && !p.skipOld && (await oldStatus(p.email))) {
        try { await openOld(p, p.oldPassword || p.password); } catch (e) {
          if (e.code !== 'wrong') throw e;
          if (p.oldPassword) { p.oldPassword = ''; throw e; }
          return { need: 'old_password' };
        }
      }
      if (p.old) await move(p);
      p.oldDone = true;
    }

    pending = null;
    return p.covered ? { done: true, covered: true } : { done: true };
  }

  /* The keys, from the account's two keyrings (see account-keyring.js):
     1. the master key: opened with the password, or this browser's copy, or a recovery key;
     2. the data key: under the master key, or, in a keyring from before it, under the password
        (or this browser's copy, or the old Ten Dollar Words recovery key);
     3. no account keyring yet: this app makes it (and its recovery key, shown until saved); a
        password that no longer opened it (reset by email) opens it again from now on;
     4. this app's keyring under the master key. One from before gets the new wrap next to its old
        ones first, and loses them only once the new one reads back. The data key never changes.
     Every keyring write names the version it read; when another device or app wrote first, it all
     starts over from what is there now. Sets p.dk and p.mk, or returns { need }. */
  const RETRY = {};
  const sameBytes = (a, b) => !!a && !!b && Keyring.b64(a) === Keyring.b64(b);

  async function settle(p) {
    for (let i = 0; i < 4; i++) {
      const r = await settleOnce(p);
      if (r !== RETRY) return r;
    }
    throw err('error', 'Your account changed on another device just now. Try again.');
  }

  async function settleOnce(p) {
    const [app, acct] = await Promise.all([getRing(p.token), getAccountRing(p.token)]);
    const cur = read();
    const mine = cur && cur.email === p.email ? cur : null;
    const pw = p.accountPassword;
    const keys = p.recoveryKeys || [];
    let ar = acct.ring;

    // 1. The master key.
    let mk = null, fixPw = false;
    if (ar) {
      mk = await AK.openWithPassword(ar, pw);
      if (!mk) {
        const copy = p.heldMk || (mine && mine.mk ? Keyring.unb64(mine.mk) : null);
        if (copy && (await AK.keyId(copy)) === ar.id) mk = copy;
        for (const k of keys) if (!mk) mk = await AK.openWithRecovery(ar, k);
        fixPw = !!mk;
      }
    }

    // 2. The data key.
    let ring = app.v;
    if (ring && !Keyring.isRing(ring) && !Keyring.isMasterRing(ring) && !p.startFresh) throw err('bad_ring', 'Your account’s keys look damaged.');
    let dk = null, created = Date.now(), fromRing = false;
    if (ring) {
      created = ring.created || created;
      if (mk) dk = await Keyring.openWithMaster(ring, mk, ar.id);
      if (!dk && Keyring.isRing(ring)) {
        try { dk = await Keyring.unlockWithPassword(ring, pw); } catch (e) { if (e.code !== 'wrong_password') throw e; }
      }
      const held = p.held || (mine && mine.dk ? Keyring.unb64(mine.dk) : null);
      if (!dk && held && (await Keyring.matches(ring, held))) dk = held;
      if (!dk && Keyring.isRing(ring)) for (const k of keys) if (!dk) { try { dk = await Keyring.unlockWithRecovery(ring, k); } catch (_) { /* not this one */ } }
      fromRing = !!dk;
      if (!dk && !p.startFresh) {
        if (ar && !mk) return { need: 'recovery' };
        // The account's keys opened, but this app's keyring is still under its old recovery key.
        if (Keyring.isRing(ring)) return { need: ar ? 'old_recovery' : 'recovery' };
        throw err('locked', 'Your synced data is locked with keys your account no longer has. Sign in on a browser that still syncs it, or start fresh.');
      }
    } else if (ar && !mk && !p.startFresh) {
      return { need: 'recovery' };
    }
    if (!dk) {
      // No keyring, or starting fresh: new keys for this app (the same ones on every try).
      dk = p.freshDk || (p.freshDk = crypto.getRandomValues(new Uint8Array(32)));
      created = Date.now();
    }
    // The data key opened but not the master key: this browser keeps syncing; Settings asks.
    if (ar && !mk && !p.startFresh) { p.dk = dk; p.mk = null; return {}; }

    // 3. The account's keyring.
    let recovery = null;
    if (!ar || !mk) {
      // None yet (or starting fresh with nothing that opens it): this app makes it.
      const made = await AK.create(pw);
      keepDraft(p.email, made.recovery);
      if (!(await putAccountRing(p.token, made.ring, acct.s))) { keepDraft(p.email, null); return RETRY; }
      const back = await getAccountRing(p.token);
      if (!back.ring || back.ring.id !== made.ring.id) return RETRY;
      ar = back.ring; mk = made.mk; recovery = made.recovery;
    } else if (fixPw) {
      if (!(await putAccountRing(p.token, await AK.rewrapPassword(ar, mk, pw), acct.s))) return RETRY;
    }
    if (!recovery) {
      const draft = draftFor(p.email);
      if (draft && (await AK.isCurrentRecovery(ar, draft))) recovery = draft;
      else if (draft) keepDraft(p.email, null);
    }

    // 4. This app's keyring under the master key.
    const before = !!ring && Keyring.isRing(ring) && fromRing;
    if (!(fromRing && Keyring.isMasterRing(ring) && ring.mkid === ar.id)) {
      let s = app.s;
      if (before && !Keyring.masterWrap(ring, ar.id)) {
        if (!(await putRing(p.token, await Keyring.withMasterWrap(ring, dk, mk, ar.id), s))) return RETRY;
        const back = await getRing(p.token);
        if (!sameBytes(await Keyring.openWithMaster(back.v, mk, ar.id), dk)) return RETRY;
        s = back.s;
      }
      if (!(await putRing(p.token, await Keyring.masterRing(dk, mk, ar.id, created), s))) return RETRY;
      const back = await getRing(p.token);
      if (!Keyring.isMasterRing(back.v) || !sameBytes(await Keyring.openWithMaster(back.v, mk, ar.id), dk)) return RETRY;
    }
    p.dk = dk; p.mk = mk; p.recovery = recovery || '';
    p.covered = before && !recovery;
    p.replaced = before && !!recovery;
    return {};
  }

  async function startDevice(p) {
    const d = await Keyring.derive(p.dk);
    const cur = read();
    if (cur && cur.vaultId === d.vaultId) {
      // Signing in again on a browser that kept syncing: only the session and keyring are new.
      cur.token = p.token;
      cur.reauth = false;
      cur.ringAt = Date.now();
      if (p.mk) {
        cur.mk = Keyring.b64(p.mk);
        if (p.recovery) { cur.rk = p.recovery; cur.rkReplaced = !!p.replaced; } else { delete cur.rk; delete cur.rkReplaced; }
      } else if (p.recovery) cur.rk = p.recovery;
      write(cur);
      return;
    }
    // What this browser had from an old account's session, with its real times, so changes
    // that never reached the server aren't lost.
    const stash = Store.getAccountStash();
    const kept = stash && stash.email === p.email && stash.fields ? stash.fields : {};
    Store.setAccountEmail(p.email);
    write({
      v: 2, email: p.email, token: p.token, dk: Keyring.b64(p.dk), kid: d.kid, vaultId: d.vaultId, secret: d.secret, key: d.key,
      rev: -1, fields: Vault.merge(snapshot(0), kept), seq: 1, dirty: false, at: 0, ringAt: Date.now(), rk: p.recovery || undefined,
      rkReplaced: p.recovery && p.replaced ? true : undefined, mk: p.mk ? Keyring.b64(p.mk) : undefined
    });
    let error = null;
    await locked(async () => {
      try {
        await absorb(await post(VAULT_API, 'pull', vaultOf(read())));
        const now = read();
        if (now && now.dirty) await pushLocked();
        else if (now) { now.at = Date.now(); write(now); setStatus('synced'); }
      } catch (e) { error = e; }
    });
    if (error) {
      if (error.code === 'locked' || error.code === 'gone' || error.code === 'forbidden') { write(null); throw error; }
      failed(error); // offline and the like: it syncs when it can
    }
    if (stash) Store.setAccountStash(null);
    lastPull = Date.now();
    start();
  }

  /* The move from an old account: its document goes into the vault (merged field by field, so
     nothing newer is overwritten), the vault is read back and checked to hold every field the old
     document had, and only then is the old account retired. Its record stays on the server. */
  async function move(p) {
    const old = p.old.fields;
    for (let k = 0; k < 3; k++) {
      await locked(async () => {
        const acc = read();
        if (!acc) throw err('signed_out', "You're signed out.");
        const merged = Vault.merge(acc.fields, old);
        if (Vault.differs(merged, acc.fields)) {
          acc.fields = merged;
          acc.seq = (acc.seq || 0) + 1;
          acc.dirty = true;
          write(acc);
          apply(merged);
        }
        await pushLocked();
      });
      const acc = read();
      if (!acc) throw err('signed_out', "You're signed out.");
      if (acc.dirty) continue;
      const doc = await post(VAULT_API, 'pull', vaultOf(acc));
      const back = doc.ct ? await Vault.open(doc, acc.key, acc.vaultId) : {};
      if (Vault.differs(Vault.merge(back, old), back)) continue; // not all there yet: again
      // Everything is in the vault. If retiring fails (offline, say), the next sign-in finds the
      // old account still there and merges it again, which changes nothing.
      try { await post(OLD_API, 'retire', { auth: p.old.keys.auth }); } catch (e) { console.warn('retire', e); }
      return;
    }
    throw err('move_failed', "Couldn't finish moving your old account. Nothing was lost: sign in again to retry.");
  }

  // Answer what signing in asked for.
  function answer(a) {
    const p = pending;
    if (!p) throw err('signed_out', 'Start again: sign in.');
    if (a.recoveryKey != null) {
      const text = String(a.recoveryKey);
      if (!Keyring.decodeRecovery(text)) return Promise.reject(err('bad_recovery', 'A recovery key has 26 letters and numbers. Check it and try again.'));
      p.recoveryKeys = (p.recoveryKeys || []).concat(text);
    }
    const asked = p.asked;
    if (a.accountPassword != null) p.accountPassword = String(a.accountPassword);
    if (a.oldPassword != null) p.oldPassword = String(a.oldPassword);
    if (a.skipOld) p.skipOld = true;
    if (a.startFresh) p.startFresh = true;
    return proceed().then((res) => {
      // Asked the same again: the key just typed opened nothing.
      if (a.recoveryKey != null && res && res.need && res.need === asked) {
        p.recoveryKeys.pop();
        throw err('wrong_recovery', 'That recovery key doesn’t open your account.');
      }
      return res;
    }).catch((e) => {
      // A wrong answer can be tried again; anything else starts over.
      if (a.recoveryKey != null && /recovery/.test(e.code)) { /* try another key */ }
      else if (a.accountPassword != null && e.code === 'wrong') p.accountPassword = '';
      else if (!(a.oldPassword != null && e.code === 'wrong')) pending = null;
      throw e;
    });
  }

  function signUp(email, password) {
    return begin(email, password, true).catch((e) => { pending = null; throw e; });
  }

  function signIn(email, password) {
    return begin(email, password, false).catch((e) => { pending = null; throw e; });
  }

  // A browser that kept syncing after its session ended: sign in again, and the keyring follows
  // the new password with the key this browser holds (no recovery key needed).
  function reauth(password) {
    const acc = read();
    if (!acc) return signIn(Store.getAccountEmail(), password);
    pending = { email: acc.email, password: String(password || ''), held: Keyring.unb64(acc.dk), heldMk: acc.mk ? Keyring.unb64(acc.mk) : null };
    return proceed().catch((e) => { pending = null; throw e; });
  }

  function cancel() { pending = null; }

  // A forgotten password: the account service emails a link to set a new one.
  function forgot(email) {
    return shared('forgot', { email: Vault.normEmail(email), app: APP });
  }

  // Signing out takes your keys and Notion connection out of this browser. Drafts stay.
  async function signOut() {
    const acc = read();
    if (!acc) return;
    if (acc.dirty) { try { await pushNow(); } catch (_) { /* offline: they wait for the next sign-in */ } }
    if (acc.token) { try { await shared('logout', {}, acc.token); } catch (_) { /* the session expires unused */ } }
    clearTimeout(pushTimer);
    clearInterval(pollTimer);
    write(null);
    setStatus('idle');
    if (TDW.Sync) TDW.Sync.disconnect();
    if (TDW.AI) TDW.AI.disconnect();
    call('onApplied', { settings: false, ai: true, notion: null, drafts: [] });
  }

  function needToken() {
    const acc = read();
    if (!acc) throw err('signed_out', "You're signed out.");
    if (!acc.token) throw err('reauth', 'Sign in again first.');
    return acc;
  }

  // The password changes for the whole cristianbagrin.com account, and the account's master key
  // follows it. A browser not yet on the master key moves onto it with the new password.
  async function changePassword(current, next) {
    checkPassword(next);
    const acc = needToken();
    const before = await getAccountRing(acc.token);
    let mk = acc.mk ? Keyring.unb64(acc.mk) : null;
    if (before.ring && !(mk && (await AK.keyId(mk)) === before.ring.id)) mk = await AK.openWithPassword(before.ring, current);
    await shared('password', { old: current, next }, acc.token);
    const p = { email: acc.email, password: next, accountPassword: next, token: acc.token, held: Keyring.unb64(acc.dk), heldMk: mk, oldDone: true };
    pending = p;
    try {
      const res = await proceed();
      if (res && res.need) console.warn('keys after a password change', res.need); // this browser keeps syncing
    } finally {
      if (pending === p) pending = null;
    }
    if (read() && read().rk) call('onRecoveryKey');
  }

  // A new recovery key for the account (the old one stops working, in every app). It's shown until
  // you say you saved it.
  async function newRecoveryKey() {
    const acc = needToken();
    if (!acc.mk) throw err('switch', 'Enter your password first.');
    const mk = Keyring.unb64(acc.mk);
    const { ring, s } = await getAccountRing(acc.token);
    if (!ring || ring.id !== (await AK.keyId(mk))) throw err('error', "Your account's keys changed on another device. Sign in again.");
    const made = await AK.newRecovery(ring, mk);
    keepDraft(acc.email, made.recovery);
    if (!(await putAccountRing(acc.token, made.ring, s))) {
      keepDraft(acc.email, null);
      throw err('error', 'Your account changed on another device just now. Try again.');
    }
    const now = read();
    if (now) { now.rk = made.recovery; delete now.rkReplaced; write(now); }
    return made.recovery;
  }

  function savedRecoveryKey() {
    const acc = read();
    keepDraft('', null);
    if (acc && acc.rk) { delete acc.rk; delete acc.rkReplaced; write(acc); }
  }

  // Ten Dollar Words' synced data goes (the vault and the keyring); the account stays, and so does
  // what each browser has.
  async function removeSyncedData() {
    const acc = needToken();
    const { s } = await getRing(acc.token);
    await post(VAULT_API, 'remove', vaultOf(acc));
    await putRing(acc.token, null, s);
    clearTimeout(pushTimer);
    clearInterval(pollTimer);
    write(null);
    setStatus('idle');
  }

  function init(h) {
    hooks = h || {};
    Store.onWrite((key) => {
      if (!SYNCED.has(key) || applying || holds) return;
      if (signedIn()) queueNote();
    });
    Store.onExternal((ch) => { if (ch.key === 'tdw.account') { peeked = null; emit(); } });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pull();
      else if (read() && read().dirty) pushNow().catch(failed);
    });
    window.addEventListener('online', () => pull(true));
    // Signed in to an old account (before 4.0): keep what it had, with its times, for the next
    // sign-in, and ask for one.
    const raw = Store.getAccountRaw();
    if (raw && raw.v !== 2) {
      if (typeof raw.email === 'string' && raw.fields && typeof raw.fields === 'object') Store.setAccountStash({ email: raw.email, fields: raw.fields });
      Store.setAccount(null);
      call('onSignedOut', 'Ten Dollar Words now signs in with your cristianbagrin.com account. Sign in again with the same email and password to keep syncing.');
    }
    if (signedIn()) {
      start();
      pull(true);
      if (read().rk) call('onRecoveryKey');
    }
  }

  TDW.Account = {
    init, signUp, signIn, answer, cancel, reauth, forgot, signOut, changePassword, newRecoveryKey, savedRecoveryKey, removeSyncedData,
    pull, pushNow, noteDraft, draftMeta,
    // While held (a Notion secret being tested, say), changes wait, then go as one.
    hold() {
      holds++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        holds--;
        if (!holds && signedIn()) queueNote();
      };
    },
    state() {
      const acc = read();
      return {
        signedIn: !!acc, email: acc ? acc.email : '', at: acc ? acc.at : 0, dirty: !!(acc && acc.dirty), status: status.state, message: status.message,
        reauth: !!(acc && !acc.token), recoveryKey: (acc && acc.rk) || '', recoveryReplaced: !!(acc && acc.rkReplaced),
        // signed in from before the account's master key: the password, once, switches this browser
        switchKeys: !!(acc && acc.token && !acc.mk)
      };
    },
    lastEmail: () => Store.getAccountEmail(),
    accountSite: () => (sharedBase() === SHARED_API ? 'https://account.cristianbagrin.com' : ''),
    onChange(fn) { listeners.push(fn); }
  };
})();

/* The synced data since accounts moved to cristianbagrin.com. Sign-in happens there; this
   server keeps only ciphertext, found by an address the browser derives from the account's data
   key. Whoever writes first sets the write secret (also derived from the data key); the server
   keeps only a SHA-256 of it and asks for the secret on every call. The server never sees a
   password or a key, and can't tell whose data is whose.

   Two kinds of record, both in the key-value store (the same D1 table as the old accounts):
     vault/<64 hex>          the settings document: { rev, iv, ct, at, created, wh: sha256 of the write secret }
                             or { gone: time, wh } after "Remove synced data": everything is refused
     vitems/<64 hex>         the items' index: { wh, seq, n: { <key>: [rev, seq, deleted 0|1] } }
     vitem/<64 hex>/<key>    one item (a draft or an idea): { rev, iv, ct, at } or, deleted for
                             good, { rev, del: time, at } with no ciphertext
   Items are encrypted one by one, so a book of many drafts never outgrows one record. Each write
   names the revision it read (`base`); a stale one gets 409 and the current item back. The index
   gives every change a number (seq), so a device asks only for what changed since it last looked.

   Every call is a POST to /api/vault/<action> with a JSON body and an X-TDW header:
     pull, push, remove      the settings document
     items { since }         → { seq, items: [[key, rev, deleted 0|1]…] } changed after `since`
     get { keys }            → { items: [{ k, rev, iv?, ct?, del? }…], more: [keys not sent, for size] }
     put { items: [{ k, base, iv, ct } | { k, base, del: true }…] }
                             → { seq, items: [{ k, rev } | { k, conflict: true, rev, iv?, ct?, del? }…] }
     del { k, base }         put with del: true, for one item */
import crypto from 'node:crypto';

const MAX_BODY = 1024 * 1024;
const MAX_PUT_BODY = 5 * 1024 * 1024; // a batch of items
const MAX_DOC = 700 * 1024;       // characters of ciphertext, as before
const MAX_ITEM = 1536 * 1024;     // characters of ciphertext in one item (D1 keeps up to 2 MB a row)
const MAX_ITEMS = 20000;          // items in one vault
const MAX_GET = 200;              // keys asked for at once
const GET_BUDGET = 8 * 1024 * 1024; // characters of ciphertext sent back at once
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ID_RE = /^[0-9a-f]{64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const IV_RE = /^[A-Za-z0-9+/]{16}$/;
const CT_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
const fail = (status, error, message, extra) => json(status, Object.assign({ error, message }, extra || {}));
const itemOut = (k, d) => (!d ? { k, rev: 0 } : d.ct ? { k, rev: d.rev, iv: d.iv, ct: d.ct } : { k, rev: d.rev, del: d.del || 1 });
const docOut = (d) => (d && d.ct ? { rev: d.rev, iv: d.iv, ct: d.ct } : { rev: d && d.rev ? d.rev : 0 });

function owns(rec, secret) {
  const want = Buffer.from(String(rec.wh || ''), 'hex');
  const got = Buffer.from(sha(secret), 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function createVaultHandler(opts) {
  const kv = opts.kv;
  const now = opts.now || Date.now;

  // The record and its ETag, or an error Response.
  async function find(body) {
    const id = String(body.id || ''), secret = String(body.secret || '');
    if (!ID_RE.test(id) || !SECRET_RE.test(secret)) return { bad: fail(400, 'bad_request', 'That request is missing something.') };
    const rec = await kv.get('vault/' + id);
    if (rec && rec.data && !owns(rec.data, secret)) return { bad: fail(403, 'forbidden', 'Not allowed.') };
    if (rec && rec.data && rec.data.gone) return { bad: fail(410, 'gone', 'Your synced data was removed.') };
    return { id, secret, rec };
  }

  const actions = {
    async pull(body) {
      const f = await find(body);
      return f.bad || json(200, docOut(f.rec && f.rec.data));
    },

    // Write the document if its revision is still `base`. A first write (base 0) makes it.
    async push(body) {
      const f = await find(body);
      if (f.bad) return f.bad;
      const { base, iv, ct } = body;
      if (!Number.isInteger(base) || base < 0 || !IV_RE.test(String(iv || '')) || typeof ct !== 'string' || !CT_RE.test(ct)) {
        return fail(400, 'bad_request', 'That request is missing something.');
      }
      if (ct.length > MAX_DOC) return fail(413, 'too_big', 'Your settings are too large to save.');
      const cur = f.rec && f.rec.data;
      const rev = cur ? cur.rev : 0;
      if (rev !== base) return fail(409, 'conflict', 'Changed on another device.', docOut(cur));
      const t = now();
      const next = { rev: base + 1, iv, ct, at: t, created: cur ? cur.created : t, wh: cur ? cur.wh : sha(f.secret) };
      const ok = await kv.put('vault/' + f.id, next, cur ? { etag: f.rec.etag } : { isNew: true });
      if (!ok) {
        const fresh = await kv.get('vault/' + f.id);
        return fail(409, 'conflict', 'Changed on another device.', docOut(fresh && fresh.data));
      }
      return json(200, { rev: base + 1 });
    },

    // "Remove synced data": the document goes; its address stays refused, so a device that still
    // has the old key can't write it back.
    async remove(body) {
      const f = await find(body);
      if (f.bad) return f.bad;
      const idx = await kv.get('vitems/' + f.id);
      if (idx && idx.data && !owns(idx.data, f.secret)) return fail(403, 'forbidden', 'Not allowed.');
      if (!(f.rec && f.rec.data) && !(idx && idx.data)) return json(200, { ok: true });
      const wh = (f.rec && f.rec.data && f.rec.data.wh) || idx.data.wh;
      await kv.put('vault/' + f.id, { gone: now(), wh });
      for (const k of await kv.keys('vitem/' + f.id + '/')) await kv.del(k);
      if (idx && idx.data) await kv.put('vitems/' + f.id, { gone: now(), wh });
      return json(200, { ok: true });
    },

    /* ---------- Items ---------- */

    async items(body) {
      const f = await findItems(body);
      if (f.bad) return f.bad;
      const since = Number.isInteger(body.since) && body.since > 0 ? body.since : 0;
      const idx = f.idx ? f.idx.data : null;
      const out = [];
      if (idx) for (const k of Object.keys(idx.n)) { const e = idx.n[k]; if (e[1] > since) out.push([k, e[0], e[2] ? 1 : 0, e[1]]); }
      out.sort((a, b) => a[3] - b[3]);
      return json(200, { seq: idx ? idx.seq : 0, items: out.map((e) => e.slice(0, 3)) });
    },

    async get(body) {
      const f = await findItems(body);
      if (f.bad) return f.bad;
      const keys = body.keys;
      if (!Array.isArray(keys) || keys.length > MAX_GET || !keys.every((k) => typeof k === 'string' && KEY_RE.test(k))) return fail(400, 'bad_request', 'That request is missing something.');
      const items = [], more = [];
      let size = 0;
      for (const k of [...new Set(keys)]) {
        if (size >= GET_BUDGET) { more.push(k); continue; }
        const rec = await kv.get('vitem/' + f.id + '/' + k);
        const out = itemOut(k, rec && rec.data);
        size += out.ct ? out.ct.length : 0;
        items.push(out);
      }
      return json(200, { items, more });
    },

    async put(body) {
      const f = await findItems(body);
      if (f.bad) return f.bad;
      const list = body.items;
      if (!Array.isArray(list) || !list.length || list.length > MAX_GET) return fail(400, 'bad_request', 'That request is missing something.');
      const seen = new Set();
      for (const it of list) {
        const ok = it && typeof it === 'object' && typeof it.k === 'string' && KEY_RE.test(it.k) && !seen.has(it.k) &&
          Number.isInteger(it.base) && it.base >= 0 &&
          (it.del === true ? it.ct === undefined : IV_RE.test(String(it.iv || '')) && typeof it.ct === 'string' && CT_RE.test(it.ct));
        if (!ok) return fail(400, 'bad_request', 'That request is missing something.');
        seen.add(it.k);
        if (it.ct && it.ct.length > MAX_ITEM) return fail(413, 'too_big', 'A draft is too large to sync.', { k: it.k });
      }
      const known = f.idx && f.idx.data ? f.idx.data.n : {};
      if (Object.keys(known).length + list.filter((it) => !(it.k in known)).length > MAX_ITEMS) return fail(413, 'too_many', 'There are too many drafts to sync.');
      const t = now();
      const results = [], done = [];
      for (const it of list) {
        const key = 'vitem/' + f.id + '/' + it.k;
        const rec = await kv.get(key);
        const cur = rec && rec.data;
        const rev = cur ? cur.rev : 0;
        if (rev !== it.base) { results.push(Object.assign({ conflict: true }, itemOut(it.k, cur))); continue; }
        const next = it.del === true ? { rev: rev + 1, del: t, at: t } : { rev: rev + 1, iv: it.iv, ct: it.ct, at: t };
        if (!(await kv.put(key, next, cur ? { etag: rec.etag } : { isNew: true }))) {
          const fresh = await kv.get(key);
          results.push(Object.assign({ conflict: true }, itemOut(it.k, fresh && fresh.data)));
          continue;
        }
        results.push({ k: it.k, rev: next.rev });
        done.push([it.k, next.rev, next.del ? 1 : 0]);
      }
      // The index: one more number for each change. Retried while another write got there first.
      let seq = f.idx && f.idx.data ? f.idx.data.seq : 0;
      for (let i = 0; done.length; i++) {
        if (i >= 12) return fail(503, 'busy', 'Busy. Try again in a moment.');
        const cur = i === 0 ? f.idx : await kv.get('vitems/' + f.id);
        if (cur && cur.data && cur.data.gone) return fail(410, 'gone', 'Your synced data was removed.');
        const idx = cur && cur.data ? cur.data : { wh: sha(f.secret), seq: 0, n: {} };
        const n = Object.assign({}, idx.n);
        seq = idx.seq;
        for (const [k, rev, del] of done) {
          const e = n[k];
          if (e && e[0] > rev) continue; // a later write is already in the index
          n[k] = [rev, ++seq, del];
        }
        if (await kv.put('vitems/' + f.id, { wh: idx.wh, seq, n }, cur && cur.data ? { etag: cur.etag } : { isNew: true })) break;
      }
      return json(200, { seq, items: results });
    },

    // One item, deleted for good (a tombstone): 409 with the current item when `base` is stale.
    async del(body) {
      const res = await actions.put({ id: body.id, secret: body.secret, items: [{ k: body.k, base: body.base, del: true }] });
      if (res.status !== 200) return res;
      const out = await res.json();
      const r = out.items[0];
      return r.conflict ? fail(409, 'conflict', 'Changed on another device.', Object.assign({}, r, { conflict: undefined })) : json(200, out);
    }
  };

  // The settings document and the items' index both say who may write: the first to write sets it.
  async function findItems(body) {
    const f = await find(body);
    if (f.bad) return f;
    const idx = await kv.get('vitems/' + f.id);
    if (idx && idx.data && !owns(idx.data, f.secret)) return { bad: fail(403, 'forbidden', 'Not allowed.') };
    if (idx && idx.data && idx.data.gone) return { bad: fail(410, 'gone', 'Your synced data was removed.') };
    return Object.assign(f, { idx: idx && idx.data ? idx : null });
  }

  return async function handle(req, action) {
    if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
    if (!Object.prototype.hasOwnProperty.call(actions, action)) return fail(404, 'not_found', 'No such action.');
    const site = req.headers.get('sec-fetch-site');
    if (req.headers.get('x-tdw') !== '1' || (site && site !== 'same-origin' && site !== 'none')) return fail(403, 'forbidden', 'Not allowed.');
    let text = '';
    try { text = await req.text(); } catch (_) { /* no body */ }
    if (text.length > (action === 'put' ? MAX_PUT_BODY : MAX_BODY)) return fail(413, 'too_big', 'That request is too large.');
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch (_) { return fail(400, 'bad_request', 'That request is missing something.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_request', 'That request is missing something.');
    return actions[action](body);
  };
}

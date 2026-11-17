/* The synced document since accounts moved to cristianbagrin.com. Sign-in happens there; this
   server keeps only the encrypted document, found by an address the browser derives from the
   account's data key. Whoever writes it first sets its write secret (also derived from the data
   key); the server keeps only a SHA-256 of it and asks for the secret on every call. The server
   never sees a password or a key, and can't tell whose document is whose.

   Records in the key-value store (the same D1 table as the old accounts):
     vault/<64 hex>   { rev, iv, ct, at, created, wh: sha256 of the write secret }
                      or { gone: time, wh } after "Remove synced data": pushes are refused

   Every call is a POST to /api/vault/<action> with a JSON body and an X-TDW header. */
import crypto from 'node:crypto';

const MAX_BODY = 1024 * 1024;
const MAX_DOC = 700 * 1024;       // characters of ciphertext, as before
const ID_RE = /^[0-9a-f]{64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const IV_RE = /^[A-Za-z0-9+/]{16}$/;
const CT_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
const fail = (status, error, message, extra) => json(status, Object.assign({ error, message }, extra || {}));
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
      if (!f.rec || !f.rec.data) return json(200, { ok: true });
      await kv.put('vault/' + f.id, { gone: now(), wh: f.rec.data.wh });
      return json(200, { ok: true });
    }
  };

  return async function handle(req, action) {
    if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
    if (!Object.prototype.hasOwnProperty.call(actions, action)) return fail(404, 'not_found', 'No such action.');
    const site = req.headers.get('sec-fetch-site');
    if (req.headers.get('x-tdw') !== '1' || (site && site !== 'same-origin' && site !== 'none')) return fail(403, 'forbidden', 'Not allowed.');
    let text = '';
    try { text = await req.text(); } catch (_) { /* no body */ }
    if (text.length > MAX_BODY) return fail(413, 'too_big', 'That request is too large.');
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch (_) { return fail(400, 'bad_request', 'That request is missing something.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_request', 'That request is missing something.');
    return actions[action](body);
  };
}

/* The website (/, /how-it-works, /privacy, /whats-new) and Chris's way of editing its words (/edit).
   The pages are files in app/site/; this Worker serves them with his edits put in. The app itself
   is app/index.html, served at /dashboard (see index.mjs).

   Editing the pages: Chris opens /edit (or /edit/how-it-works…), clicks any words and changes them,
   and saves with the password (the EDIT_KEY secret, the same one as cristianbagrin.com/edit). Every
   page is marked as it's served (copy.mjs: each piece of text gets data-copy, each block data-block,
   named after its words in the source) and his edits go in with HTMLRewriter. An edit is tied to the
   words it replaced: when those change in the source, it no longer applies and the page shows the
   source. `node tools/sync-copy.mjs` lists the edits and which no longer apply, to fold them in.
   Same design as chinese.cristianbagrin.com's. */
import { annotate, clean, PAGES } from './copy.mjs';

// (Node, which runs the tests, has no cloudflare:workers: the class is then a plain one.)
const { DurableObject } = await import('cloudflare:workers').catch(() => ({ DurableObject: class {} }));

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha = async (s) => b64(await crypto.subtle.digest('SHA-256', enc.encode(s)));
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

class Fail extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/**
 * Chris's edits to the pages' words, kept in one small database so they outlive every deploy:
 * { v: version, edits: { name: { to?: new HTML, gone?: true, was: the source's words, page, at } } }.
 * The one before the last save is kept too ("previous"), in case a save goes wrong.
 */
export class Copy extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS copy (k TEXT PRIMARY KEY, v TEXT)');
    this.tries = new Map();
  }
  read() {
    const row = this.sql.exec("SELECT v FROM copy WHERE k = 'edits'").toArray()[0];
    return row ? JSON.parse(row.v) : { v: 0, edits: {} };
  }
  /** `updates`: name -> the new edit, or null to drop it. */
  apply(updates) {
    const doc = this.read();
    const put = (k, v) => this.sql.exec('INSERT INTO copy (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, v);
    put('previous', JSON.stringify(doc));
    for (const [k, e] of Object.entries(updates)) {
      if (e) doc.edits[k] = e;
      else delete doc.edits[k];
    }
    doc.v += 1;
    put('edits', JSON.stringify(doc));
    return doc;
  }
  /** Is another try from `who` allowed (at most `max` in `windowMs`)? Keeps password guessing slow. */
  take(who, max, windowMs) {
    const now = Date.now();
    const recent = (this.tries.get(who) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return false;
    recent.push(now);
    this.tries.set(who, recent);
    if (this.tries.size > 500) this.tries.clear();
    return true;
  }
}

const NO_EDITS = { v: 0, edits: {} };
let memo = null; // { at, doc }: the edits, kept a short while in this instance
const MEMO_MS = 30_000;
const cacheKey = (request) => `${new URL(request.url).origin}/__copy`;
const store = (env) => env.COPY.get(env.COPY.idFromName('site'));

/** The saved edits; `fresh` skips the caches (the editor, and right after a save). */
async function editsOf(request, env, fresh = false) {
  if (!env.COPY) return NO_EDITS;
  if (!fresh && memo && Date.now() - memo.at < MEMO_MS) return memo.doc;
  let doc;
  // Each place Cloudflare serves from keeps the edits for a minute, so a page doesn't wait on the database.
  const cache = globalThis.caches?.default;
  if (!fresh && cache) {
    try {
      const hit = await cache.match(cacheKey(request));
      if (hit) doc = await hit.json();
    } catch {}
  }
  if (!doc) {
    doc = await store(env).read();
    if (cache) {
      try {
        await cache.put(cacheKey(request), new Response(JSON.stringify(doc), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } }));
      } catch {}
    }
  }
  memo = { at: Date.now(), doc };
  return doc;
}

/** Pages as marked for editing, by file and version (they only change with a deploy). */
const marked = new Map();
function markedPage(key, etag, html) {
  const id = `${key}|${etag}`;
  let a = etag && marked.get(id);
  if (!a) {
    a = annotate(html);
    if (etag) {
      if (marked.size > 40) marked.clear();
      marked.set(id, a);
    }
  }
  return a;
}

/** A page from the site's files, without the visitor's cache headers (its ETag is ours, not the file's). */
function pageFile(env, request, path) {
  const url = new URL(path, request.url);
  const headers = new Headers(request.headers);
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  return env.ASSETS.fetch(new Request(url, { method: 'GET', headers, redirect: 'manual' }));
}

async function pageWords(env, request, page) {
  const p = PAGES.find((x) => x[1] === page);
  if (!p) throw new Fail(404, 'not_found', 'No such page.');
  const res = await pageFile(env, request, p[2]);
  if (!res.ok) throw new Fail(404, 'not_found', 'No such page.');
  return markedPage(p[2], res.headers.get('ETag') ?? '', await res.text());
}

/** GET /api/copy: every saved edit; with ?page=, also that page's words as in the source. */
async function copyFor(request, env, page) {
  const doc = await editsOf(request, env, true);
  if (!page) return doc;
  const a = await pageWords(env, request, page);
  return { ...doc, texts: a.texts, blocks: a.blocks, pages: PAGES.map(([label, path]) => [label, path]) };
}

/** POST /api/copy { page, changes: { name: new HTML | null, "-name": true | null } }, with the password. */
async function saveCopy(request, env, body) {
  const key = request.headers.get('X-Edit-Key') ?? '';
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  if (env.COPY && !(await store(env).take(ip, 30, 600_000))) throw new Fail(429, 'slow', 'Too many tries from here. Wait a little and try again.');
  if (!env.EDIT_KEY || !env.COPY || !same(await sha(key), await sha(env.EDIT_KEY))) throw new Fail(401, 'wrong', 'Wrong password.');
  const page = String(body.page ?? '');
  const a = await pageWords(env, request, page);
  const { edits } = await editsOf(request, env, true);
  const updates = {};
  for (const [name, v] of Object.entries(body.changes ?? {})) {
    const gone = name.startsWith('-');
    const k = gone ? name.slice(1) : name;
    const known = Object.hasOwn(a.texts, k) || a.blocks.includes(k);
    // Unknown names can only be cleared (an edit whose words changed in the source).
    if (!known) {
      if ((v === null || v === false) && edits[k]) updates[k] = null;
      continue;
    }
    const e = { ...(updates[k] ?? edits[k] ?? {}), was: a.texts[k] ?? a.blockWords[k] ?? '', page, at: Date.now() };
    if (gone) {
      if (v === true) e.gone = true;
      else delete e.gone;
    } else if (v === null || v === false || v === a.texts[k]) delete e.to;
    else if (typeof v === 'string' && v.length <= 8000) e.to = clean(v);
    updates[k] = e.to !== undefined || e.gone ? e : null;
  }
  const doc = await store(env).apply(updates);
  memo = { at: Date.now(), doc };
  try {
    await globalThis.caches?.default?.delete(cacheKey(request));
  } catch {}
  return { ok: true, edited: Object.keys(doc.edits).length };
}

/** /api/copy, for index.mjs. */
export async function copyApi(request, env) {
  try {
    if (request.method === 'GET') return json(await copyFor(request, env, new URL(request.url).searchParams.get('page')));
    if (request.method === 'POST') return json(await saveCopy(request, env, await request.json().catch(() => ({}))));
    return json({ error: 'No such action.', code: 'not_found' }, 405);
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.message, code: e.code }, e.status);
    console.error(e);
    return json({ error: 'Something went wrong on our side. Try again in a moment.', code: 'server' }, 500);
  }
}

/** The edits, put into a page as it streams out; at /edit, the editor too (and none of the page's own scripts). */
function withCopy(res, edits, edit) {
  let rw = new HTMLRewriter().on('[data-copy],[data-block]', {
    element(el) {
      for (const attr of ['data-block', 'data-copy']) {
        const k = el.getAttribute(attr);
        if (!k || !edits[k]?.gone) continue;
        if (edit) el.setAttribute('data-gone', '');
        else {
          // Hidden rather than taken out: the page's scripts may still look for what's inside.
          el.setAttribute('hidden', '');
          el.setAttribute('style', 'display:none!important');
          return;
        }
      }
      const e = edits[el.getAttribute('data-copy')];
      if (typeof e?.to === 'string') el.setInnerContent(clean(e.to), { html: true });
    }
  });
  if (edit) {
    rw = rw
      .on('html', { element: (el) => el.setAttribute('data-edit', '') })
      .on('title', { element: (el) => el.prepend('Edit · ') })
      .on('head', { element: (el) => el.append('<meta name="robots" content="noindex">', { html: true }) })
      // The page's own scripts would act while you edit (the redirect into the app).
      .on('script', { element: (el) => el.remove() })
      .on('body', { element: (el) => el.append('<script src="/site/edit.js" defer></script>', { html: true }) });
  }
  return rw.transform(res);
}

/** Serves a page with the edits in. Anything that isn't a page passes through as it is. */
async function servePage(request, env, res, { key, edit = false, status = res.status }) {
  if (!(res.headers.get('Content-Type') ?? '').startsWith('text/html') || (res.status !== 200 && res.status !== 404)) return res;
  const fileTag = res.headers.get('ETag') ?? '';
  const a = markedPage(key, fileTag, await res.text());
  const doc = await editsOf(request, env, edit);
  const h = new Headers(res.headers);
  h.delete('Content-Length');
  if (edit) {
    h.delete('ETag');
    h.set('Cache-Control', 'no-store');
  } else if (fileTag) {
    // Changes with the file (a deploy) and with the edits, so browsers can still ask "anything new?".
    const tag = `W/"${fileTag.replace(/^W\//, '').replace(/"/g, '')}.${doc.v}"`;
    h.set('ETag', tag);
    if (status === 200 && request.headers.get('If-None-Match') === tag) return new Response(null, { status: 304, headers: h });
  }
  if (request.method === 'HEAD') return new Response(null, { status, headers: h });
  return withCopy(new Response(a.html, { status, headers: h }), doc.edits, edit);
}

/** The app's page: app/index.html, as a file (the asset setting html_handling is "none", so /index.html is a plain file). */
const APP_FILE = '/index.html';

/**
 * The addresses this Worker answers besides /api/ (wrangler.jsonc's run_worker_first lists them):
 * the website, /edit, /dashboard (the app) and the old addresses. Returns null for anything else
 * (the file is then served as it is).
 */
export async function sitePage(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '');
  // The app. Address-bar links from before the move (`/?…`, `/index.html`) go to it.
  // (Its files are found relative to /dashboard, so a trailing slash would lose them.)
  if (url.pathname === '/dashboard/') return Response.redirect(`${url.origin}/dashboard${url.search}`, 301);
  if (path === '/dashboard') return env.ASSETS.fetch(new Request(new URL(APP_FILE, request.url), request));
  if (path === '/index.html' || (path === '' && url.search)) return Response.redirect(`${url.origin}/dashboard${url.search}`, 302);
  if (path === '/edit' || path.startsWith('/edit/')) {
    const page = path.slice(5) || '/';
    const p = PAGES.find((x) => x[1] === page);
    if (!p) return Response.redirect(`${url.origin}/edit`, 302);
    return servePage(request, env, await pageFile(env, request, p[2]), { key: p[2], edit: true, status: 200 });
  }
  // The page files themselves: their address is the clean one.
  const file = PAGES.find((x) => x[2] === url.pathname);
  if (file) return Response.redirect(`${url.origin}${file[1]}${url.search}`, 301);
  const p = PAGES.find((x) => x[1] === (path || '/'));
  if (p) return servePage(request, env, await pageFile(env, request, p[2]), { key: p[2] });
  return null;
}

// Ten Dollar Words in Node, one browser at a time: the app's own account code (app/js/store.js, vault.js,
// account-keyring.js, keyring.js, account.js) in its own context, with its own localStorage, against this app's
// server (worker/, over an in-memory database) and an account service (tests/fake-shared-account.mjs, or the real
// one: see the end-to-end test in Money in Order). Timers never fire by themselves: a test syncs when it says so,
// and nothing is left running after it.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHandler, memoryKV } from '../worker/account-api.mjs';
import { createVaultHandler } from '../worker/vault-api.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['data.js', 'inline.js', 'engine.js', 'store.js', 'vault.js', 'account-keyring.js', 'keyring.js', 'account.js'];

/** The app's files as they are now, or as a git commit had them (an older version still open somewhere). */
function source(file, rev) {
  if (!rev) return fs.readFileSync(path.join(ROOT, 'app', 'js', file), 'utf8');
  try {
    return execFileSync('git', ['show', `${rev}:app/js/${file}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null; // not in that version
  }
}

/** This app's server: the vault and the old accounts, in memory. */
export function appServer() {
  const kv = memoryKV();
  const vault = createVaultHandler({ kv });
  const old = createHandler({ kv, legacySignup: true, secure: false });
  return {
    kv,
    async fetch(url, init = {}) {
      const m = /^\/api\/(vault|account)\/([^/?]+)/.exec(url);
      if (!m) return new Response('{}', { status: 404 });
      const headers = new Headers(init.headers);
      headers.set('Sec-Fetch-Site', 'same-origin');
      const req = new Request('https://tdw.test' + url, { method: init.method || 'GET', headers, body: init.body });
      return (m[1] === 'vault' ? vault : old)(req, m[2]);
    },
  };
}

/**
 * A browser with Ten Dollar Words open. `shared` answers the account service (its base URL is `sharedApi`), `app`
 * this app's server. `rev` loads an older version of the app's code from git.
 */
export function browser({ shared, sharedApi, app, rev }) {
  const items = new Map();
  const localStorage = {
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => void items.set(k, String(v)),
    removeItem: (k) => void items.delete(k),
    key: (i) => [...items.keys()][i] ?? null,
    get length() {
      return items.size;
    },
  };
  localStorage.setItem('tdw.dev.accountApi', sharedApi.replace(/\/?$/, '/'));
  const timers = new Set();
  const later = (fn) => {
    const h = { fn };
    timers.add(h);
    return h;
  };
  const fetchHere = (url, init) => (String(url).startsWith(sharedApi) ? shared(String(url), init) : app.fetch(String(url), init));
  const ctx = {
    console, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, URL, Blob, Request, Response, Headers,
    queueMicrotask, structuredClone, localStorage,
    navigator: { onLine: true },
    location: { hostname: 'localhost', origin: 'http://localhost', protocol: 'http:' },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
    addEventListener() {},
    removeEventListener() {},
    setTimeout: later,
    setInterval: later,
    clearTimeout: (h) => void timers.delete(h),
    clearInterval: (h) => void timers.delete(h),
    fetch: (url, init) => fetchHere(url, init),
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of FILES) {
    const code = source(f, rev);
    if (code != null) vm.runInContext(code, ctx, { filename: `${rev ? rev + ':' : ''}app/js/${f}` });
  }
  const signedOut = [];
  ctx.TDW.Account.init({ onSignedOut: (m) => signedOut.push(m) });
  return {
    TDW: ctx.TDW,
    Account: ctx.TDW.Account,
    Store: ctx.TDW.Store,
    storage: items,
    signedOut,
    /** The account as this browser keeps it. */
    acc: () => JSON.parse(items.get('tdw.account') ?? 'null'),
    /** Stop whatever it had scheduled. */
    close: () => timers.clear(),
  };
}

/* The Cloudflare Worker: app/ is served as static assets (with app/_headers), and this code
   answers only /api/* (wrangler.jsonc sends those here first). Sign-in happens at
   account.cristianbagrin.com; here are /api/vault/<action>, the encrypted synced document
   (vault-api.mjs), and /api/account/<action>, the old accounts, kept so people can move
   (account-api.mjs). Both keep their records in the D1 database bound as DB. */
import { createHandler, d1KV } from './account-api.mjs';
import { createVaultHandler } from './vault-api.mjs';

const ROUTE = /^\/api\/(account|vault)\/([^/]+)$/;
const DEV_ACCOUNT = /^\/api\/dev-account\/(.+)$/;

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    // Local testing only: with DEV_ACCOUNT_API in .dev.vars (never set in production), the shared
    // account service running on this computer answers here, on the app's own origin, so the
    // page's CSP needn't change. The app uses it when localStorage['tdw.dev.accountApi'] says so.
    const dev = DEV_ACCOUNT.exec(url.pathname);
    if (dev && env.DEV_ACCOUNT_API && /^(127\.0\.0\.1|localhost)$/.test(url.hostname)) {
      const to = env.DEV_ACCOUNT_API.replace(/\/?$/, '/') + dev[1] + url.search;
      const headers = {};
      for (const h of ['authorization', 'content-type']) if (req.headers.get(h)) headers[h] = req.headers.get(h);
      return fetch(new Request(to, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer() }));
    }
    const m = ROUTE.exec(url.pathname);
    if (!m) return json(404, { error: 'not_found', message: 'No such action.' });
    const kv = d1KV(env.DB);
    // TDW_LEGACY_SIGNUP (.dev.vars only) reopens old-style sign-ups, to test the move locally.
    const handle = m[1] === 'vault'
      ? createVaultHandler({ kv })
      : createHandler({ kv, resetCode: env.TDW_RESET_CODE || '', legacySignup: env.TDW_LEGACY_SIGNUP === '1', secure: url.protocol === 'https:' });
    try {
      return await handle(req, m[2]);
    } catch (e) {
      console.error(m[1], m[2], e && e.stack ? e.stack : e);
      return json(500, { error: 'server', message: 'Something went wrong on the server. Try again in a moment.' });
    }
  }
};

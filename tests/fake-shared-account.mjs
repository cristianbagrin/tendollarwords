// A stand-in for the shared account service (account.cristianbagrin.com, chinesebrain `site/worker.js`): the
// routes Ten Dollar Words uses, with the same answers and the same sync rules, compare-and-set included.

export const SHARED_API = 'https://account.test/api/';

function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export function sharedAccounts() {
  const accounts = new Map();
  let n = 0;
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const fail = (status, code, error) => json({ error, code }, status);
  const session = (a) => {
    const t = `${a.email}.${++n}`;
    a.sessions.add(t);
    return t;
  };
  function make(email, password) {
    const a = { email, password, sessions: new Set(), items: new Map(), seq: 0, guarded: new Set() };
    accounts.set(email, a);
    return a;
  }

  async function fetch(url, init = {}) {
    const route = String(url).slice(SHARED_API.length);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const bearer = (new Headers(init.headers).get('Authorization') ?? '').replace(/^Bearer /, '');
    const email = String(body.email ?? '').trim().toLowerCase();
    const authed = () => [...accounts.values()].find((a) => a.sessions.has(bearer));
    switch (route) {
      case 'signup': {
        if (String(body.password).length < 8) return fail(400, 'short', 'Use at least 8 characters for your password.');
        if (accounts.has(email)) return fail(409, 'exists', 'This email already has an account. Sign in instead.');
        const a = make(email, body.password);
        return json({ token: session(a), email });
      }
      case 'login': {
        const a = accounts.get(email);
        if (!a || a.password !== body.password) return fail(401, 'wrong', 'That email and password don’t match.');
        return json({ token: session(a), email });
      }
      case 'logout': {
        const a = authed();
        if (a) a.sessions.delete(bearer);
        return a ? json({ ok: true }) : fail(401, 'signed_out', 'You’re signed out. Sign in again.');
      }
      case 'password': {
        const a = authed();
        if (!a) return fail(401, 'signed_out', 'You’re signed out. Sign in again.');
        if (a.password !== body.old) return fail(401, 'wrong', 'Your current password isn’t right.');
        a.password = body.next;
        for (const s of [...a.sessions]) if (s !== bearer) a.sessions.delete(s);
        return json({ ok: true });
      }
      case 'forgot':
        return json({ ok: true });
      case 'sync': {
        const a = authed();
        if (!a) return fail(401, 'signed_out', 'You’re signed out. Sign in again.');
        const app = String(body.app);
        const mine = new Set();
        const rejected = new Set();
        for (const c of body.changes ?? []) {
          if (!String(c.k).startsWith(`@${app}/`)) continue;
          const v = c.v == null ? null : canon(c.v);
          const old = a.items.get(c.k);
          const t = Math.min(Number(c.t) || 0, Date.now());
          const cond = c.if !== undefined && c.if !== null;
          if (cond ? c.if !== (old?.seq ?? 0) : app === 'account' || a.guarded.has(c.k)) {
            rejected.add(c.k);
            continue;
          }
          if (!cond && old && old.t > t) continue;
          if (cond) a.guarded.add(c.k);
          mine.add(c.k);
          if (old && old.v === v) continue;
          a.items.set(c.k, { v, t: Math.max(t, old?.t ?? 0), seq: ++a.seq });
        }
        const changes = [...a.items.entries()]
          .filter(([k, i]) => k.startsWith(`@${app}/`) && (i.seq > (Number(body.since) || 0) || rejected.has(k)) && !mine.has(k))
          .map(([k, i]) => ({ k, v: i.v == null ? null : JSON.parse(i.v), t: i.t, s: i.seq }));
        return json({ seq: a.seq, more: false, changes, ...(rejected.size ? { rejected: [...rejected] } : {}) });
      }
    }
    return fail(404, 'not_found', 'Not found.');
  }

  return {
    fetch,
    accounts,
    make,
    /** A reset by email: a new password, every session ends. */
    reset(email, password) {
      const a = accounts.get(email);
      a.password = password;
      a.sessions.clear();
    },
    item(email, k) {
      const i = accounts.get(email)?.items.get(k);
      return i?.v ? JSON.parse(i.v) : null;
    },
    /** Write an item the way an app without preconditions does. */
    put(email, k, v) {
      const a = accounts.get(email);
      a.items.set(k, { v: JSON.stringify(v), t: Date.now(), seq: ++a.seq });
    },
  };
}

// One recovery key for the whole cristianbagrin.com account: Ten Dollar Words' data key under the account's
// master key. Browsers run the app's real account code (tests/tdw-device.mjs) against this app's server and a
// stand-in for the account service, with real WebCrypto. "Before" browsers run 4.0.0, the version live before this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { appServer, browser } from './tdw-device.mjs';
import { sharedAccounts, SHARED_API } from './fake-shared-account.mjs';

const require = createRequire(import.meta.url);
const AK = require('../app/js/account-keyring.js');
const Keyring = require('../app/js/keyring.js');
const fixture = require('./fixtures/account-keyring.json');

/** Results come from the app's own context: compare them as plain data. */
const eq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);

const BEFORE = '2718ffa'; // 4.0.0: a keyring of its own, under the password and Ten Dollar Words' recovery key

function world() {
  const shared = sharedAccounts();
  const app = appServer();
  const open = [];
  const make = (rev) => {
    const b = browser({ shared: shared.fetch, sharedApi: SHARED_API, app, rev });
    open.push(b);
    return b;
  };
  return { shared, app, browser: make, close: () => open.forEach((b) => b.close()) };
}

const EMAIL = 'ana@example.com';

/** A browser signed in with 4.0.0, with a Gemini key synced: the state Chris's account is in today. */
async function before(w, password = 'the password') {
  const b = w.browser(BEFORE);
  await b.Account.signUp(EMAIL, password);
  const recovery = b.Account.state().recoveryKey;
  b.Account.savedRecoveryKey();
  b.Store.setKey('AIza-before');
  await new Promise((r) => setTimeout(r, 0));
  await b.Account.pushNow();
  assert.equal(b.acc().dirty, false);
  const ring = w.shared.item(EMAIL, '@tdw/keyring');
  assert.equal(ring.v, 1);
  return { b, recovery, ring };
}

test('the shared fixture: Ten Dollar Words opens the account keyring the account service made', async () => {
  const mk = await AK.openWithPassword(fixture.ring, fixture.password);
  assert.equal(AK.b64(mk), fixture.mk);
  assert.equal(AK.b64(await AK.openWithRecovery(fixture.ring, fixture.recovery)), fixture.mk);
  assert.equal(AK.b64(await AK.unwrapAppKey(mk, 'tdw', fixture.tdw)), fixture.dk);
  const ring = { v: 2, kid: 'x', mkid: fixture.ring.id, mk: fixture.tdw, created: 1 };
  assert.equal(Keyring.isMasterRing(ring), true);
  assert.equal(AK.b64(await Keyring.openWithMaster(ring, mk, fixture.ring.id)), fixture.dk);
  assert.equal(await Keyring.openWithMaster(ring, mk, 'other'), null);
});

test('a new account: the account’s keys and one recovery key; another browser joins with the password', async (t) => {
  const w = world();
  t.after(w.close);
  const a = w.browser();
  eq(await a.Account.signUp(EMAIL, 'the password'), { done: true });
  const recovery = a.Account.state().recoveryKey;
  assert.match(recovery, /^([0-9A-Z]{4}-){6}[0-9A-Z]{2}$/);
  const acct = w.shared.item(EMAIL, '@account/keyring');
  assert.equal(await AK.isCurrentRecovery(acct, recovery), true);
  const ring = w.shared.item(EMAIL, '@tdw/keyring');
  assert.deepEqual(Object.keys(ring).sort(), ['created', 'kid', 'mk', 'mkid', 'v']);
  assert.equal(ring.mkid, acct.id);
  assert.equal(a.Account.state().switchKeys, false);
  a.Store.setKey('AIza-one');
  await new Promise((r) => setTimeout(r, 0));
  await a.Account.pushNow();

  const b = w.browser();
  eq(await b.Account.signIn(EMAIL, 'the password'), { done: true });
  assert.equal(b.Store.getKey(), 'AIza-one');
  assert.equal(b.Account.state().recoveryKey, '');
});

test('a 4.0 account moves on the next sign-in: same data key and data, one new recovery key, the old one stops working', async (t) => {
  const w = world();
  t.after(w.close);
  const { recovery: old, ring } = await before(w);
  const b = w.browser();
  eq(await b.Account.signIn(EMAIL, 'the password'), { done: true });
  const st = b.Account.state();
  assert.ok(st.recoveryKey);
  assert.equal(st.recoveryReplaced, true);
  assert.equal(b.Store.getKey(), 'AIza-before');
  const moved = w.shared.item(EMAIL, '@tdw/keyring');
  assert.deepEqual(Object.keys(moved).sort(), ['created', 'kid', 'mk', 'mkid', 'v']);
  assert.equal(moved.kid, ring.kid);
  assert.equal(moved.created, ring.created);
  const acct = w.shared.item(EMAIL, '@account/keyring');
  assert.equal(await AK.openWithRecovery(acct, old), null);
  // After a reset: the account's key works, the old one is refused.
  w.shared.reset(EMAIL, 'new password');
  const c = w.browser();
  eq(await c.Account.signIn(EMAIL, 'new password'), { need: 'recovery' });
  await assert.rejects(c.Account.answer({ recoveryKey: old }), { code: 'wrong_recovery' });
  eq(await c.Account.answer({ recoveryKey: st.recoveryKey.toLowerCase() }), { done: true });
  assert.equal(c.Store.getKey(), 'AIza-before');
  // The password opens it again from now on.
  const d = w.browser();
  eq(await d.Account.signIn(EMAIL, 'new password'), { done: true });
});

test('another app moved first: no new recovery key; the browser from before keeps syncing, and switches with the password', async (t) => {
  const w = world();
  t.after(w.close);
  const { b: old } = await before(w);
  const other = await AK.create('the password');
  w.shared.put(EMAIL, '@account/keyring', other.ring);
  // A browser running this version, signed in before: it syncs on, and asks once for the password.
  old.close();
  const here = w.browser();
  for (const [k, v] of old.storage) here.storage.set(k, v);
  assert.equal(here.Account.state().switchKeys, true);
  eq(await here.Account.reauth('the password'), { done: true, covered: true });
  assert.equal(here.Account.state().switchKeys, false);
  assert.equal(here.Account.state().recoveryKey, '');
  assert.equal(w.shared.item(EMAIL, '@tdw/keyring').mkid, other.ring.id);
  assert.deepEqual(w.shared.item(EMAIL, '@account/keyring'), other.ring);
  // That app's recovery key opens Ten Dollar Words now.
  w.shared.reset(EMAIL, 'new password');
  const c = w.browser();
  eq(await c.Account.signIn(EMAIL, 'new password'), { need: 'recovery' });
  eq(await c.Account.answer({ recoveryKey: other.recovery }), { done: true });
  assert.equal(c.Store.getKey(), 'AIza-before');
});

test('a move cut off between its two keyring writes: the old wraps stay until the new one reads back; the next sign-in finishes', async (t) => {
  const w = world();
  t.after(w.close);
  const { ring } = await before(w);
  const real = w.shared.fetch;
  let writes = 0;
  const b = browser({
    shared: async (url, init) => {
      const body = String(init?.body ?? '');
      if (url.endsWith('/sync') && body.includes('"@tdw/keyring"') && body.includes('"if"') && ++writes === 2) throw new TypeError('Failed to fetch');
      return real(url, init);
    },
    sharedApi: SHARED_API,
    app: w.app,
  });
  t.after(b.close);
  await assert.rejects(b.Account.signIn(EMAIL, 'the password'), { code: 'offline' });
  const half = w.shared.item(EMAIL, '@tdw/keyring');
  assert.equal(half.v, 1);
  assert.deepEqual([half.pw, half.rk, half.salt], [ring.pw, ring.rk, ring.salt]);
  assert.equal(half.mkid, w.shared.item(EMAIL, '@account/keyring').id);
  assert.ok(await Keyring.unlockWithPassword(half, 'the password'));
  // Signing in again finishes it, and shows the recovery key made the first time.
  const made = JSON.parse(b.storage.get('tdw.recoveryDraft')).key;
  eq(await b.Account.signIn(EMAIL, 'the password'), { done: true });
  assert.equal(b.Account.state().recoveryKey, made);
  assert.equal(b.Account.state().recoveryReplaced, true);
  assert.equal(w.shared.item(EMAIL, '@tdw/keyring').v, 2);
  assert.equal(b.Store.getKey(), 'AIza-before');
});

test('two browsers moving at once: one master key, one recovery key that works, the same data key', async (t) => {
  const w = world();
  t.after(w.close);
  await before(w);
  const real = w.shared.fetch;
  const b = w.browser();
  let raced = false;
  const a = browser({
    shared: async (url, init) => {
      const body = String(init?.body ?? '');
      if (!raced && body.includes('"@account/keyring"') && body.includes('"if"')) {
        raced = true;
        eq(await b.Account.signIn(EMAIL, 'the password'), { done: true });
      }
      return real(url, init);
    },
    sharedApi: SHARED_API,
    app: w.app,
  });
  t.after(a.close);
  eq(await a.Account.signIn(EMAIL, 'the password'), { done: true });
  assert.equal(raced, true);
  const acct = w.shared.item(EMAIL, '@account/keyring');
  assert.equal(await AK.isCurrentRecovery(acct, b.Account.state().recoveryKey), true);
  assert.equal(a.Account.state().recoveryKey, '');
  assert.equal(a.acc().dk, b.acc().dk);
  assert.equal(a.acc().mk, b.acc().mk);
  assert.equal(a.Store.getKey(), 'AIza-before');
});

test('reset before the move, the account’s keys made elsewhere after: Ten Dollar Words’ old key is asked for once', async (t) => {
  const w = world();
  t.after(w.close);
  const { recovery: old } = await before(w, 'old password');
  w.shared.reset(EMAIL, 'new password');
  const other = await AK.create('new password');
  w.shared.put(EMAIL, '@account/keyring', other.ring);
  const b = w.browser();
  eq(await b.Account.signIn(EMAIL, 'new password'), { need: 'old_recovery' });
  await assert.rejects(b.Account.answer({ recoveryKey: other.recovery }), { code: 'wrong_recovery' });
  eq(await b.Account.answer({ recoveryKey: old }), { done: true, covered: true });
  assert.equal(b.Store.getKey(), 'AIza-before');
});

test('a new recovery key replaces the account’s, in every app; a password change keeps the master key opening', async (t) => {
  const w = world();
  t.after(w.close);
  const a = w.browser();
  await a.Account.signUp(EMAIL, 'the password');
  const first = a.Account.state().recoveryKey;
  a.Account.savedRecoveryKey();
  const next = await a.Account.newRecoveryKey();
  assert.equal(a.Account.state().recoveryKey, next);
  const acct = w.shared.item(EMAIL, '@account/keyring');
  assert.equal(await AK.openWithRecovery(acct, first), null);
  assert.ok(await AK.openWithRecovery(acct, next));
  a.Account.savedRecoveryKey();
  await a.Account.changePassword('the password', 'second password');
  assert.ok(await AK.openWithPassword(w.shared.item(EMAIL, '@account/keyring'), 'second password'));
  assert.equal(a.Account.state().recoveryKey, '');
  const b = w.browser();
  eq(await b.Account.signIn(EMAIL, 'second password'), { done: true });
});

test('the version live before this one can’t write over the moved keyring, and keeps syncing with the key it holds', async (t) => {
  const w = world();
  t.after(w.close);
  const { b: old } = await before(w);
  const now = w.browser();
  await now.Account.signIn(EMAIL, 'the password');
  const moved = w.shared.item(EMAIL, '@tdw/keyring');
  // Its hourly check: the same key id, so it stays signed in and syncs.
  const acc = old.acc();
  acc.ringAt = 0;
  old.storage.set('tdw.account', JSON.stringify(acc));
  old.Store.setKey('AIza-old-tab');
  await new Promise((r) => setTimeout(r, 0));
  await old.Account.pull(true);
  assert.equal(old.Account.state().signedIn, true);
  assert.deepEqual(old.signedOut, []);
  // A new recovery key or a password change from it: refused by the account, the keyring stays.
  await old.Account.newRecoveryKey().catch(() => {});
  assert.deepEqual(w.shared.item(EMAIL, '@tdw/keyring'), moved);
  // Signing in with it on another browser fails without touching anything.
  const fresh = w.browser(BEFORE);
  await assert.rejects(fresh.Account.signIn(EMAIL, 'the password'));
  assert.deepEqual(w.shared.item(EMAIL, '@tdw/keyring'), moved);
  await now.Account.pull(true);
  assert.equal(now.Store.getKey(), 'AIza-old-tab');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createVaultHandler } from '../worker/vault-api.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryKV, d1KV } from '../worker/account-api.mjs';

const IV = crypto.randomBytes(12).toString('base64');
const CT = crypto.randomBytes(48).toString('base64');
const ID = crypto.randomBytes(32).toString('hex');
const SECRET = crypto.randomBytes(32).toString('base64url');

function setup(store) {
  const kv = store || memoryKV();
  const handle = createVaultHandler({ kv, now: () => 1000 });
  async function call(action, body, headers) {
    const res = await handle(new Request('https://x.test/api/vault/' + action, {
      method: 'POST', headers: Object.assign({ 'X-TDW': '1', 'Sec-Fetch-Site': 'same-origin' }, headers || {}), body: JSON.stringify(body)
    }), action);
    return { status: res.status, body: await res.json() };
  }
  return { kv, call };
}

test('the first push makes the vault; pulls and pushes need its secret; revisions guard it', async () => {
  const { kv, call } = setup();
  assert.deepEqual((await call('pull', { id: ID, secret: SECRET })).body, { rev: 0 });
  assert.deepEqual((await call('push', { id: ID, secret: SECRET, base: 0, iv: IV, ct: CT })).body, { rev: 1 });
  assert.deepEqual((await call('pull', { id: ID, secret: SECRET })).body, { rev: 1, iv: IV, ct: CT });
  const other = crypto.randomBytes(32).toString('base64url');
  assert.equal((await call('pull', { id: ID, secret: other })).status, 403);
  assert.equal((await call('push', { id: ID, secret: other, base: 1, iv: IV, ct: 'AAAA' })).status, 403);
  const stale = await call('push', { id: ID, secret: SECRET, base: 0, iv: IV, ct: 'AAAA' });
  assert.deepEqual([stale.status, stale.body.rev, stale.body.ct], [409, 1, CT]);
  assert.deepEqual((await call('push', { id: ID, secret: SECRET, base: 1, iv: IV, ct: 'BBBB' })).body, { rev: 2 });
  const rec = JSON.parse(kv.dump().get('vault/' + ID).v);
  assert.ok(!JSON.stringify(rec).includes(SECRET), 'only a hash of the secret is kept');
  assert.equal(rec.wh, crypto.createHash('sha256').update(SECRET).digest('hex'));
});

test('a vault nobody has written yet can only be made from revision 0', async () => {
  const { call } = setup();
  assert.equal((await call('push', { id: ID, secret: SECRET, base: 3, iv: IV, ct: CT })).status, 409);
});

test('removing the vault keeps its address refused', async () => {
  const { call } = setup();
  await call('push', { id: ID, secret: SECRET, base: 0, iv: IV, ct: CT });
  assert.equal((await call('remove', { id: ID, secret: crypto.randomBytes(32).toString('base64url') })).status, 403);
  assert.equal((await call('remove', { id: ID, secret: SECRET })).status, 200);
  assert.equal((await call('pull', { id: ID, secret: SECRET })).status, 410);
  assert.equal((await call('push', { id: ID, secret: SECRET, base: 0, iv: IV, ct: CT })).status, 410);
});

test('bad requests, other sites and other methods are refused', async () => {
  const { call } = setup();
  assert.equal((await call('pull', { id: 'nope', secret: SECRET })).status, 400);
  assert.equal((await call('pull', { id: ID, secret: 'short' })).status, 400);
  assert.equal((await call('push', { id: ID, secret: SECRET, base: 0, iv: 'x', ct: CT })).status, 400);
  assert.equal((await call('push', { id: ID, secret: SECRET, base: 0, iv: IV, ct: 'A'.repeat(800 * 1024) })).status, 413);
  assert.equal((await call('pull', { id: ID, secret: SECRET }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await call('pull', { id: ID, secret: SECRET }, { 'X-TDW': '0' })).status, 403);
  assert.equal((await call('nothing', {})).status, 404);
});

/* ---------- Items: one encrypted record per draft or idea ---------- */

const ct = (n) => crypto.randomBytes(n || 48).toString('base64');
const K1 = 'aaaaaaaa1111', K2 = 'bbbbbbbb2222', K3 = 'cccccccc3333';

test('items: a put makes them, the index lists what changed since a cursor, get returns them', async () => {
  const { call } = setup();
  assert.deepEqual((await call('items', { id: ID, secret: SECRET })).body, { seq: 0, items: [] });
  const c1 = ct(), c2 = ct();
  const r = await call('put', { id: ID, secret: SECRET, items: [{ k: K1, base: 0, iv: IV, ct: c1 }, { k: K2, base: 0, iv: IV, ct: c2 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { seq: 2, items: [{ k: K1, rev: 1 }, { k: K2, rev: 1 }] });
  assert.deepEqual((await call('items', { id: ID, secret: SECRET, since: 0 })).body, { seq: 2, items: [[K1, 1, 0], [K2, 1, 0]] });
  await call('put', { id: ID, secret: SECRET, items: [{ k: K1, base: 1, iv: IV, ct: c2 }] });
  assert.deepEqual((await call('items', { id: ID, secret: SECRET, since: 2 })).body, { seq: 3, items: [[K1, 2, 0]] });
  assert.deepEqual((await call('items', { id: ID, secret: SECRET, since: 3 })).body, { seq: 3, items: [] });
  const g = await call('get', { id: ID, secret: SECRET, keys: [K1, K2, K3] });
  assert.deepEqual(g.body, { items: [{ k: K1, rev: 2, iv: IV, ct: c2 }, { k: K2, rev: 1, iv: IV, ct: c2 }, { k: K3, rev: 0 }], more: [] });
});

test('items: a stale base gets 409 with the current item, and nothing changes', async () => {
  const { call } = setup();
  const c1 = ct(), c2 = ct();
  await call('put', { id: ID, secret: SECRET, items: [{ k: K1, base: 0, iv: IV, ct: c1 }] });
  const r = await call('put', { id: ID, secret: SECRET, items: [{ k: K1, base: 0, iv: IV, ct: c2 }, { k: K2, base: 0, iv: IV, ct: c2 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items, [{ conflict: true, k: K1, rev: 1, iv: IV, ct: c1 }, { k: K2, rev: 1 }]);
  assert.equal((await call('get', { id: ID, secret: SECRET, keys: [K1] })).body.items[0].ct, c1);
  // An item nobody has written yet only takes base 0.
  assert.deepEqual((await call('put', { id: ID, secret: SECRET, items: [{ k: K3, base: 2, iv: IV, ct: c1 }] })).body.items, [{ conflict: true, k: K3, rev: 0 }]);
});

test('items: deleting leaves a tombstone, listed, with no ciphertext; a put over it brings it back', async () => {
  const { call } = setup();
  await call('put', { id: ID, secret: SECRET, items: [{ k: K1, base: 0, iv: IV, ct: ct() }] });
  const stale = await call('del', { id: ID, secret: SECRET, k: K1, base: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, 1);
  assert.ok(stale.body.ct);
  assert.deepEqual((await call('del', { id: ID, secret: SECRET, k: K1, base: 1 })).body, { seq: 2, items: [{ k: K1, rev: 2 }] });
  assert.deepEqual((await call('items', { id: ID, secret: SECRET, since: 1 })).body.items, [[K1, 2, 1]]);
  assert.deepEqual((await call('get', { id: ID, secret: SECRET, keys: [K1] })).body.items, [{ k: K1, rev: 2, del: 1000 }]);
  const c = ct();
  assert.deepEqual((await call('put', { id: ID, secret: SECRET, items: [{ k: K1, base: 2, iv: IV, ct: c }] })).body.items, [{ k: K1, rev: 3 }]);
  assert.deepEqual((await call('items', { id: ID, secret: SECRET, since: 2 })).body.items, [[K1, 3, 0]]);
});

test('items: the write secret guards them, as it does the settings document; only its hash is kept', async () => {
  const { kv, call } = setup();
  const other = crypto.randomBytes(32).toString('base64url');
  await call('put', { id: ID, secret: SECRET, items: [{ k: K1, base: 0, iv: IV, ct: ct() }] });
  for (const [a, b] of [['items', {}], ['get', { keys: [K1] }], ['put', { items: [{ k: K1, base: 1, iv: IV, ct: ct() }] }], ['del', { k: K1, base: 1 }]]) {
    assert.equal((await call(a, Object.assign({ id: ID, secret: other }, b))).status, 403, a);
  }
  // The settings document, made by the same secret, still opens; another secret can't take it.
  assert.equal((await call('push', { id: ID, secret: SECRET, base: 0, iv: IV, ct: CT })).status, 200);
  const ID2 = crypto.randomBytes(32).toString('hex');
  await call('push', { id: ID2, secret: SECRET, base: 0, iv: IV, ct: CT });
  assert.equal((await call('put', { id: ID2, secret: other, items: [{ k: K1, base: 0, iv: IV, ct: ct() }] })).status, 403);
  const raw = JSON.stringify([...kv.dump().values()]);
  assert.ok(!raw.includes(SECRET));
});

test('items: size caps, bad keys and bad batches are refused', async () => {
  const { call } = setup();
  const big = 'A'.repeat(1536 * 1024 + 4);
  assert.equal((await call('put', { id: ID, secret: SECRET, items: [{ k: K1, base: 0, iv: IV, ct: big }] })).status, 413);
  assert.equal((await call('put', { id: ID, secret: SECRET, items: [{ k: K1, base: 0, iv: IV, ct: 'A'.repeat(1400 * 1024) }] })).status, 200);
  assert.equal((await call('put', { id: ID, secret: SECRET, items: [{ k: 'bad key!', base: 0, iv: IV, ct: ct() }] })).status, 400);
  assert.equal((await call('put', { id: ID, secret: SECRET, items: [{ k: K2, base: 0, iv: IV, ct: ct() }, { k: K2, base: 0, iv: IV, ct: ct() }] })).status, 400);
  assert.equal((await call('put', { id: ID, secret: SECRET, items: [] })).status, 400);
  assert.equal((await call('put', { id: ID, secret: SECRET, items: [{ k: K2, base: -1, iv: IV, ct: ct() }] })).status, 400);
  assert.equal((await call('get', { id: ID, secret: SECRET, keys: ['x'] })).status, 400);
  assert.equal((await call('get', { id: ID, secret: SECRET, keys: Array.from({ length: 201 }, (_, i) => 'k' + String(i).padStart(8, '0')) })).status, 400);
});

test('items: get sends back at most about 8 MB at once and names the rest', async () => {
  const { call } = setup();
  const keys = [];
  for (let i = 0; i < 7; i++) {
    const k = 'item' + String(i).padStart(6, '0');
    keys.push(k);
    assert.equal((await call('put', { id: ID, secret: SECRET, items: [{ k, base: 0, iv: IV, ct: 'A'.repeat(1500 * 1024) }] })).status, 200);
  }
  const g = await call('get', { id: ID, secret: SECRET, keys });
  assert.equal(g.body.items.length, 6);
  assert.deepEqual(g.body.more, [keys[6]]);
});

test('items: "Remove synced data" takes the items too and keeps their address refused', async () => {
  const { kv, call } = setup();
  await call('push', { id: ID, secret: SECRET, base: 0, iv: IV, ct: CT });
  await call('put', { id: ID, secret: SECRET, items: [{ k: K1, base: 0, iv: IV, ct: ct() }, { k: K2, base: 0, iv: IV, ct: ct() }] });
  assert.equal((await call('remove', { id: ID, secret: SECRET })).status, 200);
  assert.equal([...kv.dump().keys()].filter((k) => k.startsWith('vitem/')).length, 0);
  assert.equal((await call('items', { id: ID, secret: SECRET })).status, 410);
  assert.equal((await call('put', { id: ID, secret: SECRET, items: [{ k: K1, base: 0, iv: IV, ct: ct() }] })).status, 410);
});

test('items: writes racing for the index all land, each with its own number', async () => {
  const { call } = setup();
  const res = await Promise.all(Array.from({ length: 8 }, (_, i) => call('put', { id: ID, secret: SECRET, items: [{ k: 'race' + String(i).padStart(6, '0'), base: 0, iv: IV, ct: ct() }] })));
  assert.ok(res.every((r) => r.status === 200));
  const list = (await call('items', { id: ID, secret: SECRET })).body;
  assert.equal(list.items.length, 8);
  assert.equal(list.seq, 8);
});

// A real D1 database (wrangler's local one, in a temporary folder). Needs `npm install`; skipped without it.
async function localD1(t) {
  const wrangler = await import('wrangler').catch(() => null);
  if (!wrangler) { t.skip('run npm install first'); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdw-d1-'));
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const proxy = await wrangler.getPlatformProxy({ configPath: path.join(root, 'wrangler.jsonc'), persist: { path: dir } });
  const db = proxy.env.DB;
  for (const f of fs.readdirSync(path.join(root, 'migrations')).sort()) {
    for (const sql of fs.readFileSync(path.join(root, 'migrations', f), 'utf8').replace(/--.*$/gm, '').split(';')) if (sql.trim()) await db.prepare(sql).run();
  }
  t.after(async () => { await proxy.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

test('items on D1: a 1.4 MB item, conflicts, tombstones, racing writes, removal', async (t) => {
  const db = await localD1(t);
  if (!db) return;
  const { call } = setup(d1KV(db));
  const big = crypto.randomBytes(1050 * 1024).toString('base64');
  assert.equal((await call('put', { id: ID, secret: SECRET, items: [{ k: K1, base: 0, iv: IV, ct: big }] })).status, 200);
  assert.equal((await call('get', { id: ID, secret: SECRET, keys: [K1] })).body.items[0].ct, big);
  assert.equal((await call('put', { id: ID, secret: SECRET, items: [{ k: K1, base: 0, iv: IV, ct: ct() }] })).body.items[0].conflict, true);
  assert.equal((await call('del', { id: ID, secret: SECRET, k: K1, base: 1 })).status, 200);
  const res = await Promise.all(Array.from({ length: 6 }, (_, i) => call('put', { id: ID, secret: SECRET, items: [{ k: 'race' + String(i).padStart(6, '0'), base: 0, iv: IV, ct: ct() }] })));
  assert.ok(res.every((r) => r.status === 200));
  const list = (await call('items', { id: ID, secret: SECRET })).body;
  assert.equal(list.items.length, 7);
  assert.equal(list.seq, 8);
  assert.equal((await call('remove', { id: ID, secret: SECRET })).status, 200);
  assert.deepEqual((await db.prepare("SELECT k FROM kv WHERE k LIKE 'vitem/%'").all()).results, []);
});

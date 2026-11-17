import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createVaultHandler } from '../worker/vault-api.mjs';
import { memoryKV } from '../worker/account-api.mjs';

const IV = crypto.randomBytes(12).toString('base64');
const CT = crypto.randomBytes(48).toString('base64');
const ID = crypto.randomBytes(32).toString('hex');
const SECRET = crypto.randomBytes(32).toString('base64url');

function setup() {
  const kv = memoryKV();
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

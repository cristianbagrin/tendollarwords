const test = require('node:test');
const assert = require('node:assert/strict');
const Keyring = require('../app/js/keyring.js');
const Vault = require('../app/js/vault.js');

const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

test('a recovery key reads back however it is typed', () => {
  for (let i = 0; i < 50; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const text = Keyring.encodeRecovery(bytes);
    assert.match(text, /^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/);
    assert.ok(same(Keyring.decodeRecovery(text), bytes));
    assert.ok(same(Keyring.decodeRecovery(' ' + text.toLowerCase().replace(/-/g, ' ') + '\n'), bytes));
    assert.ok(same(Keyring.decodeRecovery(text.replace(/-/g, '')), bytes));
  }
  const zeros = Keyring.encodeRecovery(new Uint8Array(16));
  assert.ok(same(Keyring.decodeRecovery(zeros.replace(/0/g, 'o')), new Uint8Array(16)));
  const ones = Keyring.encodeRecovery(new Uint8Array(16).fill(0x08)); // has 1s in it
  assert.ok(same(Keyring.decodeRecovery(ones.replace(/1/g, 'l')), new Uint8Array(16).fill(0x08)));
  assert.equal(Keyring.decodeRecovery('too-short'), null);
  assert.equal(Keyring.decodeRecovery(zeros.slice(0, -1) + 'U'), null);
});

test('a new keyring opens with the password and with the recovery key, and gives the same data key', async () => {
  const { dk, recovery, ring } = await Keyring.create('correct horse');
  assert.equal(dk.length, 32);
  assert.ok(Keyring.isRing(ring));
  assert.equal(ring.v, 1);
  const json = JSON.stringify(ring);
  assert.ok(!json.includes(Keyring.b64(dk)));
  assert.ok(json.length < 1000);
  assert.ok(same(await Keyring.unlockWithPassword(ring, 'correct horse'), dk));
  assert.ok(same(await Keyring.unlockWithRecovery(ring, recovery), dk));
  assert.ok(same(await Keyring.unlockWithRecovery(ring, recovery.toLowerCase().replace(/-/g, '')), dk));
  // Composed and decomposed accents are the same password.
  const r2 = await Keyring.create('café');
  assert.ok(same(await Keyring.unlockWithPassword(r2.ring, 'café'), r2.dk));
  assert.equal(await Keyring.matches(ring, dk), true);
  assert.equal(await Keyring.matches(ring, r2.dk), false);
});

test('a wrong password or recovery key is refused, and says which', async () => {
  const { ring } = await Keyring.create('correct horse');
  await assert.rejects(Keyring.unlockWithPassword(ring, 'correct horsE'), { code: 'wrong_password' });
  const other = await Keyring.create('correct horse');
  await assert.rejects(Keyring.unlockWithRecovery(ring, other.recovery), { code: 'wrong_recovery' });
  await assert.rejects(Keyring.unlockWithRecovery(ring, 'not a key'), { code: 'bad_recovery' });
  await assert.rejects(Keyring.unlockWithPassword({ v: 2 }, 'x'), { code: 'bad_ring' });
  // A keyring changed on the server doesn't open.
  const tampered = JSON.parse(JSON.stringify(ring));
  const ct = Keyring.unb64(tampered.pw.ct); ct[0] ^= 1; tampered.pw.ct = Keyring.b64(ct);
  await assert.rejects(Keyring.unlockWithPassword(tampered, 'correct horse'), { code: 'wrong_password' });
  // The password box can't be swapped into the recovery slot.
  const swapped = Object.assign({}, ring, { rk: ring.pw });
  await assert.rejects(Keyring.unlockWithRecovery(swapped, other.recovery), { code: 'wrong_recovery' });
});

test('after a password reset: the recovery key unlocks, and re-wrapping under the new password keeps the same data key and recovery key', async () => {
  const { dk, recovery, ring } = await Keyring.create('old password');
  await assert.rejects(Keyring.unlockWithPassword(ring, 'new password'), { code: 'wrong_password' });
  const got = await Keyring.unlockWithRecovery(ring, recovery);
  const next = await Keyring.rewrapPassword(ring, got, 'new password');
  assert.notEqual(next.salt, ring.salt);
  assert.deepEqual(next.rk, ring.rk);
  assert.equal(next.kid, ring.kid);
  assert.ok(same(await Keyring.unlockWithPassword(next, 'new password'), dk));
  await assert.rejects(Keyring.unlockWithPassword(next, 'old password'), { code: 'wrong_password' });
  assert.ok(same(await Keyring.unlockWithRecovery(next, recovery), dk));
});

test('a device that holds the data key re-wraps without the recovery key', async () => {
  const { dk, ring } = await Keyring.create('old password');
  // The device kept dk; the password changed on the account page.
  assert.equal(await Keyring.matches(ring, dk), true);
  const next = await Keyring.rewrapPassword(ring, dk, 'changed elsewhere');
  assert.ok(same(await Keyring.unlockWithPassword(next, 'changed elsewhere'), dk));
});

test('a new recovery key replaces the old one', async () => {
  const { dk, recovery, ring } = await Keyring.create('pw pw pw pw');
  const { recovery: fresh, ring: next } = await Keyring.replaceRecovery(ring, dk);
  assert.notEqual(fresh, recovery);
  assert.ok(same(await Keyring.unlockWithRecovery(next, fresh), dk));
  await assert.rejects(Keyring.unlockWithRecovery(next, recovery), { code: 'wrong_recovery' });
  assert.ok(same(await Keyring.unlockWithPassword(next, 'pw pw pw pw'), dk));
});

test('the data key gives a stable vault address, write secret and key, different for each data key', async () => {
  const a = await Keyring.create('x'.repeat(8));
  const b = await Keyring.create('x'.repeat(8));
  const da = await Keyring.derive(a.dk);
  assert.deepEqual(await Keyring.derive(a.dk), da);
  assert.match(da.vaultId, /^[0-9a-f]{64}$/);
  assert.match(da.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.match(da.kid, /^[0-9a-f]{16}$/);
  const all = new Set([da.vaultId, da.secret, da.key, Keyring.b64(a.dk)]);
  assert.equal(all.size, 4);
  const db = await Keyring.derive(b.dk);
  assert.notEqual(db.vaultId, da.vaultId);
  assert.notEqual(db.key, da.key);
  // The vault key seals the account's fields the way it always has.
  const fields = { 'ai.key': { v: 'AIza-secret', at: 5 } };
  const doc = await Vault.seal(fields, da.key, da.vaultId);
  assert.deepEqual(await Vault.open(doc, da.key, da.vaultId), fields);
  await assert.rejects(Vault.open(doc, db.key, da.vaultId), { code: 'locked' });
});

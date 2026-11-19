// Drafts and ideas syncing through the account, one encrypted record each (app/js/items-sync.js against
// worker/vault-api.mjs), between browsers in Node: tests/tdw-device.mjs and tests/fake-shared-account.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appServer, browser } from './tdw-device.mjs';
import { sharedAccounts, SHARED_API } from './fake-shared-account.mjs';

const eq = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);
const EMAIL = 'ana@example.com';
const PW = 'the password';

function world() {
  const shared = sharedAccounts();
  const app = appServer();
  const open = [];
  const make = () => {
    const b = browser({ shared: shared.fetch, sharedApi: SHARED_API, app });
    open.push(b);
    return b;
  };
  return { shared, app, browser: make, close: () => open.forEach((b) => b.close()) };
}

async function two(t) {
  const w = world();
  t.after(w.close);
  const a = w.browser();
  await a.Account.signUp(EMAIL, PW);
  a.Account.savedRecoveryKey();
  const b = w.browser();
  await b.Account.signIn(EMAIL, PW);
  return { w, a, b };
}

const items = (w) => [...w.app.kv.dump().entries()].filter(([k]) => k.startsWith('vitem/'));

/* ---------- Merging, field by field ---------- */

test('merge: one side changed a field: that side wins; both changed: tags and Overflow take both, text goes to Overflow', () => {
  const w = world();
  const { _: M } = w.browser().ItemsSync;
  const base = { content: { text: 'Hello', ann: null }, status: 'drafting', tags: ['a'], overflow: '', title: '', deletedAt: 0 };
  const H = M.hashes(base);
  // Only the other side changed the text; only this side changed the status.
  let r = M.mergeFields({ ...base, status: 'editing' }, { ...base, content: { text: 'Hello there', ann: null } }, H, 0);
  eq([r.fields.content.text, r.fields.status, r.conflict], ['Hello there', 'editing', false]);
  // Both changed the text: ours stays, theirs goes to Overflow under a line saying where from.
  r = M.mergeFields({ ...base, content: { text: 'Mine', ann: null } }, { ...base, content: { text: 'Theirs', ann: null } }, H, Date.parse('2026-11-19T10:00:00Z'));
  assert.equal(r.fields.content.text, 'Mine');
  assert.equal(r.conflict, true);
  assert.match(r.fields.overflow, /^From another device, .+:\nTheirs$/);
  // Both changed tags and Overflow: both kept.
  r = M.mergeFields({ ...base, tags: ['a', 'b'], overflow: 'one' }, { ...base, tags: ['a', 'C'], overflow: 'two' }, H, 0);
  eq([r.fields.tags, r.fields.overflow], [['a', 'b', 'C'], 'one\ntwo']);
  // Deleted on one side, written in on the other: it stays, with the new text.
  r = M.mergeFields({ ...base, deletedAt: 5 }, { ...base, content: { text: 'Still writing', ann: null } }, H, 0);
  eq([r.fields.deletedAt, r.fields.content.text], [0, 'Still writing']);
  // Our text emptied, theirs written: theirs, no conflict.
  r = M.mergeFields({ ...base, content: { text: '', ann: null } }, { ...base, content: { text: 'More', ann: null } }, H, 0);
  eq([r.fields.content.text, r.conflict], ['More', false]);
  // No change anywhere: nothing.
  eq(M.mergeFields(base, base, H, 0).fields, base);
});

test('combine: two versions with nothing in common: the later leads, the other text is kept', () => {
  const w = world();
  const { _: M } = w.browser().ItemsSync;
  const a = { content: { text: 'Old words', ann: null }, overflow: 'x', tags: ['t'], deletedAt: 0 };
  const b = { content: { text: 'New words', ann: null }, overflow: '', tags: ['T', 'u'], deletedAt: 0 };
  const out = M.combine(a, b, 1, 2);
  assert.equal(out.content.text, 'New words');
  assert.match(out.overflow, /^x\n\nFrom another device, .+:\nOld words$/);
  eq(out.tags, ['T', 'u']); // the same tag, whatever its case
  eq(M.combine(a, { ...a }, 1, 2).overflow, 'x');
});

/* ---------- Two browsers ---------- */

test('drafts, a project and an idea go to the other browser, encrypted; changes follow', async (t) => {
  const { w, a, b } = await two(t);
  const book = a.Store.create({ text: 'My book', tags: ['book'] });
  const ch = a.Store.create({ text: 'Chapter one. The secret word is aubergine.', parentId: book.id });
  const idea = a.Store.addIdea('Walks at night', ['later']);
  a.Store.update(book.id, { status: 'editing', date: '2026-12-01' });
  await a.sync();
  assert.equal(a.ItemsSync.status().state, 'synced');
  assert.equal(items(w).length, 3);
  assert.ok(!JSON.stringify(items(w)).includes('aubergine'), 'the server sees only ciphertext');
  assert.ok(!JSON.stringify(items(w)).includes(book.id), 'nor the ids');

  await b.sync();
  const bb = b.Store.getDraft(book.id);
  eq([bb.text, bb.status, bb.date, bb.tags], ['My book', 'editing', '2026-12-01', ['book']]);
  eq(b.Store.children(book.id).map((d) => d.text), ['Chapter one. The secret word is aubergine.']);
  eq(b.Store.ideas().map((i) => [i.text, i.tags]), [['Walks at night', ['later']]]);
  assert.ok(b.told.list > 0);

  // A change on one side reaches the other: text, properties, a move.
  a.Store.update(ch.id, { text: 'Chapter one, rewritten.' });
  a.Store.move(ch.id, { parentId: null });
  await a.sync();
  await b.sync();
  assert.equal(b.Store.getDraft(ch.id).text, 'Chapter one, rewritten.');
  assert.equal(b.Store.getDraft(ch.id).parentId, null);
  assert.ok(b.told.remoteText.includes(ch.id));
  // Nothing new: nothing sent.
  const before = JSON.stringify(items(w));
  await a.sync();
  await b.sync();
  assert.equal(JSON.stringify(items(w)), before);
  assert.ok(idea);
});

test('both browsers change different fields: both changes stay', async (t) => {
  const { a, b } = await two(t);
  const d = a.Store.create({ text: 'Shared draft' });
  await a.sync();
  await b.sync();
  a.Store.update(d.id, { status: 'done' });
  b.Store.update(d.id, { tags: ['linkedin'], text: 'Shared draft, longer' });
  await a.sync();
  await b.sync();
  await a.sync();
  for (const x of [a, b]) eq([x.Store.getDraft(d.id).status, x.Store.getDraft(d.id).tags, x.Store.getDraft(d.id).text], ['done', ['linkedin'], 'Shared draft, longer']);
});

test('both browsers rewrite the same text: no words lost, the other version waits in Overflow', async (t) => {
  const { a, b } = await two(t);
  const d = a.Store.create({ text: 'First line' });
  await a.sync();
  await b.sync();
  a.Store.update(d.id, { text: 'First line, as the laptop wrote it' });
  b.Store.update(d.id, { text: 'First line, as the phone wrote it' });
  await a.sync();
  await b.sync(); // the phone sees the laptop's version: keeps its own, the laptop's goes to Overflow
  const pd = b.Store.getDraft(d.id);
  assert.equal(pd.text, 'First line, as the phone wrote it');
  assert.match(pd.overflow, /as the laptop wrote it/);
  await a.sync(); // the laptop hadn't changed since: it takes the merged draft
  const ld = a.Store.getDraft(d.id);
  eq([ld.text, ld.overflow], [pd.text, pd.overflow]);
  // And it settles: no more changes either way.
  await b.sync();
  await a.sync();
  assert.equal(b.Store.getDraft(d.id).overflow, pd.overflow);
});

test('a write that lost a race (409) merges the server’s copy and sends again', async (t) => {
  const { a, b } = await two(t);
  const d = a.Store.create({ text: 'Base' });
  await a.sync();
  await b.sync();
  a.Store.update(d.id, { text: 'Base from A', status: 'editing' });
  await a.sync();
  b.Store.update(d.id, { text: 'Base from B' });
  // B doesn't see A's change in its pull (as if A wrote between B's pull and push).
  const s = b.Store.getSyncState();
  b.Store.setSyncState({ ...s, seq: 999 });
  await b.sync();
  const bd = b.Store.getDraft(d.id);
  eq([bd.text, bd.status], ['Base from B', 'editing']);
  assert.match(bd.overflow, /Base from A/);
  b.Store.setSyncState({ ...b.Store.getSyncState(), seq: 0 });
  await a.sync();
  eq([a.Store.getDraft(d.id).text, a.Store.getDraft(d.id).overflow], [bd.text, bd.overflow]);
});

test('delete: a tombstone that syncs; restore brings it back everywhere; written in elsewhere, it stays', async (t) => {
  const { a, b } = await two(t);
  const d = a.Store.create({ text: 'To delete' });
  const e = a.Store.create({ text: 'Delete me, but I keep writing' });
  await a.sync();
  await b.sync();
  a.Store.deleteDraft(d.id);
  await a.sync();
  await b.sync();
  assert.equal(b.Store.getDraft(d.id), null);
  assert.ok(b.told.remoteDelete.includes(d.id));
  eq(b.Store.deleted().map((x) => x.id), [d.id]);
  b.Store.restore(d.id);
  await b.sync();
  await a.sync();
  assert.equal(a.Store.getDraft(d.id).text, 'To delete');

  a.Store.deleteDraft(e.id);
  b.Store.update(e.id, { text: 'Delete me, but I keep writing. More.' });
  await a.sync();
  await b.sync();
  await a.sync();
  for (const x of [a, b]) assert.equal(x.Store.getDraft(e.id) && x.Store.getDraft(e.id).text, 'Delete me, but I keep writing. More.');
});

test('a tombstone older than 30 days goes for good, here and on the other browser', async (t) => {
  const { w, a, b } = await two(t);
  const d = a.Store.create({ text: 'Old' });
  await a.sync();
  await b.sync();
  a.Store.deleteDraft(d.id);
  const old = a.Store.getAny(d.id);
  old.deletedAt = Date.now() - 31 * 24 * 3600e3;
  a.Store.saveDraft(old);
  await a.sync(); // sends the tombstone
  await a.sync(); // its 30 days are up: deleted for good
  assert.equal(a.Store.getAny(d.id), null);
  const rec = items(w).map(([, v]) => JSON.parse(v.v)).find((r) => r.del);
  assert.ok(rec && !rec.ct);
  await b.sync();
  assert.equal(b.Store.getAny(d.id), null);
  // A new browser never sees it.
  const c = w.browser();
  await c.Account.signIn(EMAIL, PW);
  await c.sync();
  assert.equal(c.Store.getAny(d.id), null);
});

test('drafts made from the same Notion page on two browsers before 5.0 become one', async (t) => {
  const w = world();
  t.after(w.close);
  const a = w.browser();
  const b = w.browser();
  // Each browser had the page under its own id, from the old Notion sync.
  const da = a.Store.create({ text: 'From Notion', notionId: 'page-1' });
  const db = b.Store.create({ text: 'From Notion', notionId: 'page-1', tags: ['phone'] });
  const solo = b.Store.create({ text: 'Only on the phone' });
  await a.Account.signUp(EMAIL, PW);
  await b.Account.signIn(EMAIL, PW);
  await a.sync();
  await b.sync();
  await a.sync();
  await b.sync();
  const ids = (x) => x.Store.listDrafts().map((d) => d.id).sort();
  eq(ids(a), JSON.parse(JSON.stringify(ids(b))));
  assert.equal(a.Store.listDrafts().filter((d) => d.notionId === 'page-1').length, 1);
  const keep = [da.id, db.id].sort()[0];
  eq(a.Store.getDraft(keep).tags, ['phone']);
  assert.equal(b.Store.getDraft(keep).text, 'From Notion');
  assert.ok(a.Store.getDraft(solo.id));
  // The server holds the losing twin only as a bare tombstone.
  assert.equal(items(w).filter(([, v]) => JSON.parse(v.v).ct).length, 2);
});

test('empty drafts wait until they have words; without an account nothing syncs', async (t) => {
  const w = world();
  t.after(w.close);
  const a = w.browser();
  const d = a.Store.create({ text: 'Local only' });
  await a.sync();
  assert.equal(a.ItemsSync.status().state, 'off');
  assert.equal(items(w).length, 0);
  a.Store.create({});
  await a.Account.signUp(EMAIL, PW);
  await a.sync();
  assert.equal(items(w).length, 1, 'the empty draft stays here');
  assert.ok(d);
});

test('a draft too big to sync says so; the rest still sync', async (t) => {
  const { w, a } = await two(t);
  // Random text doesn't compress: past the 1.5 MB cap once encrypted.
  let big = '';
  while (big.length < 2600 * 1024) big += Math.random().toString(36).slice(2);
  a.Store.create({ text: big });
  a.Store.create({ text: 'Small one' });
  await a.sync();
  assert.equal(a.ItemsSync.status().state, 'error');
  assert.match(a.ItemsSync.status().message, /too large to sync/);
  assert.equal(items(w).length, 1);
});

test('"Remove synced data" takes the items; signing in again sends them afresh', async (t) => {
  const { w, a } = await two(t);
  a.Store.create({ text: 'Keep me' });
  await a.sync();
  assert.equal(items(w).length, 1);
  await a.Account.removeSyncedData();
  assert.equal(items(w).length, 0);
  assert.equal(a.Store.getSyncState(), null);
  // Signing in again makes new keys (the old address stays refused) and sends everything.
  eq(await a.Account.signIn(EMAIL, PW), { done: true });
  await a.sync();
  assert.equal(a.ItemsSync.status().state, 'synced');
  assert.equal(items(w).length, 1);
});

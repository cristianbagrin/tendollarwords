// The 5.0 item model in store.js: properties of its own, projects (drafts inside drafts), ideas,
// tombstones, and the move from Notion's properties.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const eq = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'app', 'js', f), 'utf8');

function browser(items) {
  const m = new Map(Object.entries(items || {}));
  const localStorage = {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }
  };
  const ctx = { localStorage, location: { origin: 'https://x.test' }, navigator: {}, addEventListener() {}, console };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ['data.js', 'inline.js', 'engine.js', 'notion-map.js', 'store.js']) vm.runInContext(src(f), ctx, { filename: f });
  return { Store: ctx.TDW.Store, m };
}

const NOTION = JSON.stringify({ databaseId: 'db', dataSourceId: 'ds', titleProp: 'Name', schema: {
  Name: { type: 'title' }, Stage: { type: 'status' }, Date: { type: 'date' }, Pillar: { type: 'select' }
} });

test('drafts from before 5.0 get a status, date and tags from their Notion properties, once', () => {
  const created = Date.parse('2026-08-03T12:00:00Z');
  const { Store, m } = browser({
    'tdw.notion': NOTION,
    'tdw.draft.a': JSON.stringify({ id: 'a', text: 'One', notionId: 'n1', props: { Stage: 'Draft 2', Date: '2026-09-28', Pillar: '30% Craft' }, createdAt: created }),
    'tdw.draft.b': JSON.stringify({ id: 'b', text: 'Two', props: { Stage: 'Posted' }, createdAt: created }),
    'tdw.draft.c': JSON.stringify({ id: 'c', text: 'Three', createdAt: created })
  });
  const [a, b, c] = ['a', 'b', 'c'].map((id) => Store.getDraft(id));
  eq([a.kind, a.status, a.date, a.tags, a.parentId], ['draft', 'editing', '2026-09-28', ['30% Craft'], null]);
  eq([b.status, b.date, b.tags], ['done', Store.dayOf(created), ['Posted']]);
  eq([c.status, c.date, c.tags], ['drafting', Store.dayOf(created), []]);
  // Saved once: the stored copy has them now, so a status changed later sticks.
  assert.equal(JSON.parse(m.get('tdw.draft.a')).status, 'editing');
  Store.update('a', { status: 'done' });
  const again = browser(Object.fromEntries(m));
  assert.equal(again.Store.getDraft('a').status, 'done');
  eq(a.props, { Stage: 'Draft 2', Date: '2026-09-28', Pillar: '30% Craft' }); // kept as they were
});

test('create: today by default, parts go last in their project, ideas stay out of the drafts', () => {
  const { Store } = browser();
  const book = Store.create({ text: 'A book' });
  eq([book.kind, book.status, book.date, book.parentId], ['draft', 'drafting', Store.today(), null]);
  const ch1 = Store.create({ text: 'Chapter one', parentId: book.id });
  const ch2 = Store.create({ text: 'Chapter two', parentId: book.id });
  const ch0 = Store.create({ text: 'Prologue', parentId: book.id, index: 0 });
  eq(Store.children(book.id).map((d) => d.text), ['Prologue', 'Chapter one', 'Chapter two']);
  eq(Store.children(null).map((d) => d.id), [book.id]);
  const idea = Store.addIdea('Write about walking', ['walks']);
  eq([idea.kind, idea.status, idea.tags, idea.archived], ['idea', 'idea', ['walks'], false]);
  assert.ok(!Store.listDrafts().includes(idea));
  eq(Store.ideas().map((i) => i.id), [idea.id]);
  assert.equal(Store.listDrafts().length, 4);
  Store.update(idea.id, { archived: true });
  eq(Store.ideas(), []);
  eq(Store.ideas({ archived: true }).map((i) => i.id), [idea.id]);
  // An idea becomes a part of the book, in place.
  Store.update(idea.id, { archived: false });
  const d = Store.ideaToDraft(idea.id, { parentId: book.id, index: 1 });
  assert.equal(d.id, idea.id);
  eq(Store.children(book.id).map((x) => x.text), ['Prologue', 'Write about walking', 'Chapter one', 'Chapter two']);
  assert.ok(ch0 && ch1 && ch2);
});

test('update keeps good values and drops bad ones', () => {
  const { Store } = browser();
  const d = Store.create({ text: 'x' });
  const at = d.updatedAt;
  Store.update(d.id, { status: 'nonsense', date: '2026-13-45', tags: [' a ', 'A', 'b', 3, ''], budget: 1234 });
  assert.equal(d.status, 'drafting');
  assert.equal(d.date, Store.today());
  eq(d.tags, ['a', 'b']);
  assert.equal(d.budget, 1230);
  Store.update(d.id, { status: 'editing', date: '2027-01-02' });
  eq([d.status, d.date], ['editing', '2027-01-02']);
  assert.ok(d.updatedAt >= at);
  assert.equal(Store.update('nope', { status: 'done' }), null);
});

test('move: into a project, out of it, between siblings; never inside itself', () => {
  const { Store } = browser();
  const book = Store.create({ text: 'Book' });
  const a = Store.create({ text: 'A', parentId: book.id });
  const b = Store.create({ text: 'B', parentId: book.id });
  const loose = Store.create({ text: 'Loose' });
  Store.move(loose.id, { parentId: book.id, index: 1 });
  eq(Store.children(book.id).map((d) => d.text), ['A', 'Loose', 'B']);
  Store.move(b.id, { index: 0 });
  eq(Store.children(book.id).map((d) => d.text), ['B', 'A', 'Loose']);
  Store.move(a.id, { parentId: loose.id });
  eq(Store.descendants(book.id).map((d) => d.text), ['B', 'Loose', 'A']);
  eq(Store.ancestors(a.id).map((d) => d.text), ['Loose', 'Book']);
  assert.throws(() => Store.move(book.id, { parentId: a.id }), { code: 'cycle' });
  assert.throws(() => Store.move(book.id, { parentId: book.id }), { code: 'cycle' });
  Store.move(loose.id, { parentId: null });
  eq(Store.children(null).map((d) => d.text).sort(), ['Book', 'Loose']);
});

test('delete leaves a tombstone, with the project’s parts; restore brings them back', () => {
  const { Store, m } = browser();
  const book = Store.create({ text: 'Book' });
  const a = Store.create({ text: 'A', parentId: book.id });
  const gone = Store.deleteDraft(book.id);
  eq(gone.sort(), [a.id, book.id].sort());
  assert.equal(Store.getDraft(book.id), null);
  assert.equal(Store.getDraft(a.id), null);
  assert.ok(Store.getAny(book.id).deletedAt);
  eq(Store.listDrafts(), []);
  eq(Store.deleted().map((d) => d.id), [book.id]);
  assert.ok(JSON.parse(m.get('tdw.draft.' + book.id)).deletedAt);
  Store.restore(book.id);
  eq(Store.descendants(book.id).map((d) => d.id), [a.id]);
  eq(Store.deleted(), []);
  // The undo from before restore(): a copy saved over the tombstone brings the parts back too.
  const copy = JSON.parse(JSON.stringify(book));
  Store.deleteDraft(book.id);
  Store.saveDraft(copy);
  eq(Store.children(book.id).map((d) => d.id), [a.id]);
  // An empty draft that never synced just goes.
  const empty = Store.create({});
  Store.deleteDraft(empty.id);
  assert.equal(Store.getAny(empty.id), null);
  assert.ok(!m.has('tdw.draft.' + empty.id));
});

test('a backup leaves out what this browser last synced', () => {
  const { Store } = browser({ 'tdw.draft.a': JSON.stringify({ id: 'a', text: 'x' }), 'tdw.sync.a': '{"r":3}', 'tdw.syncState': '{"seq":3}' });
  eq(Object.keys(Store.exportAll().items), ['tdw.draft.a']);
  eq(Store.getSyncMeta('a'), { r: 3 });
  Store.clearSyncMeta();
  assert.equal(Store.getSyncMeta('a'), null);
  assert.equal(Store.getSyncState(), null);
});

test('tombstones that never synced go after 30 days', () => {
  const old = Date.now() - 31 * 24 * 3600e3;
  const { Store, m } = browser({
    'tdw.draft.a': JSON.stringify({ id: 'a', text: 'gone', deletedAt: old }),
    'tdw.draft.b': JSON.stringify({ id: 'b', text: 'synced, waits for sync', deletedAt: old }), 'tdw.sync.b': '{"r":1}',
    'tdw.draft.c': JSON.stringify({ id: 'c', text: 'recent', deletedAt: Date.now() - 1000 })
  });
  eq(Store.deleted().map((d) => d.id).sort(), ['b', 'c']);
  assert.ok(!m.has('tdw.draft.a'));
});

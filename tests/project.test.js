// Projects and ideas, the pure parts (project.js): names, the sidebar's tree and where a drop
// lands, the manuscript, grouping, and #tags in an idea.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const eq = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'app', 'js', f), 'utf8');

function browser() {
  const m = new Map();
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
  for (const f of ['data.js', 'inline.js', 'engine.js', 'marks.js', 'notion-map.js', 'store.js', 'project.js']) vm.runInContext(src(f), ctx, { filename: f });
  return { Store: ctx.TDW.Store, P: ctx.TDW.Project };
}

function book() {
  const { Store, P } = browser();
  const b = Store.create({ title: 'Book' });
  const ch = [1, 2, 3, 4, 5].map((n) => Store.create({ parentId: b.id, title: 'Chapter ' + n, text: 'Words of chapter ' + n + '.' }));
  return { Store, P, b, ch };
}

test('a name is the title given, else the first sentence', () => {
  const { Store, P } = browser();
  eq(P.nameOf(Store.create({ title: 'Book', text: 'It begins. Then more.' })), 'Book');
  eq(P.nameOf(Store.create({ text: 'It begins. Then more.' })), 'It begins.');
  eq(P.nameOf(Store.create({})), 'Untitled draft');
});

test('the tree shows parts only under open projects, with depth and parent', () => {
  const { Store, P, b, ch } = book();
  const sub = Store.create({ parentId: ch[1].id, title: 'Scene' });
  const loose = Store.create({ title: 'Loose' });
  const kids = (id) => Store.children(id);
  eq(P.tree(kids, new Set()).map((r) => r.d.title), ['Book', 'Loose']);
  const rows = P.tree(kids, new Set([b.id, ch[1].id]));
  eq(rows.map((r) => r.d.title + ':' + r.depth), ['Book:0', 'Chapter 1:1', 'Chapter 2:1', 'Scene:2', 'Chapter 3:1', 'Chapter 4:1', 'Chapter 5:1', 'Loose:0']);
  eq(rows[0].kids, 5);
  eq(rows[3].parentId, ch[1].id);
  eq(rows[7].parentId, null);
  assert.ok(sub && loose);
});

test('a drop lands before, after or inside a row, and never inside itself', () => {
  const { Store, P, b, ch } = book();
  const loose = Store.create({ title: 'Loose' });
  const kids = (id) => Store.children(id);
  const open = new Set([b.id]);
  const rows = P.tree(kids, open);
  const anc = (id) => Store.ancestors(id).map((a) => a.id);
  const at = (title, zone, drag) => P.dropAt(rows, rows.findIndex((r) => r.d.title === title), zone, drag, kids, (id) => open.has(id), anc);
  // Chapter 5 before Chapter 2: index 1 among the book's parts.
  eq(at('Chapter 2', 'before', ch[4].id), { parentId: b.id, index: 1 });
  eq(at('Chapter 2', 'after', ch[4].id), { parentId: b.id, index: 2 });
  // A loose draft into a chapter: its last part.
  eq(at('Chapter 3', 'inside', loose.id), { parentId: ch[2].id, index: 0 });
  // After an open project: its first part.
  eq(at('Book', 'after', loose.id), { parentId: b.id, index: 0 });
  // Out of the book, to the top, after Loose.
  eq(at('Loose', 'after', ch[0].id), { parentId: null, index: 2 });
  // The book into its own chapter: refused.
  eq(at('Chapter 1', 'inside', b.id), null);
  eq(at('Chapter 1', 'before', b.id), null);
  eq(at('Book', 'inside', b.id), null);
  // Applying it reorders.
  const to = at('Chapter 2', 'before', ch[4].id);
  Store.move(ch[4].id, to);
  eq(Store.children(b.id).map((d) => d.title), ['Chapter 1', 'Chapter 5', 'Chapter 2', 'Chapter 3', 'Chapter 4']);
});

test('move targets leave out the draft and its own parts', () => {
  const { Store, P, b, ch } = book();
  const all = Store.listDrafts();
  const t = P.moveTargets(b.id, all, (id) => Store.ancestors(id)).map((d) => d.title);
  eq(t, []);
  const t2 = P.moveTargets(ch[0].id, all, (id) => Store.ancestors(id)).map((d) => d.title).sort();
  eq(t2, ['Book', 'Chapter 2', 'Chapter 3', 'Chapter 4', 'Chapter 5']);
});

test('the manuscript reads the project in order, with headings, ghosts out', () => {
  const { Store, P, b, ch } = book();
  Store.update(b.id, { text: 'A foreword.' });
  const scene = Store.create({ parentId: ch[0].id, title: 'Scene', text: 'Line one\nLine two' });
  // A chapter that already opens with its name as a heading doesn't get it twice.
  Store.update(ch[1].id, { text: '## Chapter 2\nIt rains.' });
  // A part with no title: its first sentence is its name, and the text speaks for itself.
  Store.update(ch[2].id, { title: '' });
  const parts = [];
  const walk = (id, depth) => { for (const c of Store.children(id)) { parts.push({ d: c, depth }); walk(c.id, depth + 1); } };
  walk(b.id, 0);
  const md = P.manuscript(b, parts, (d) => d.text);
  eq(md, [
    '# Book', 'A foreword.',
    '## Chapter 1', 'Words of chapter 1.',
    '### Scene', 'Line one\n\nLine two',
    '## Chapter 2\n\nIt rains.',
    'Words of chapter 3.',
    '## Chapter 4', 'Words of chapter 4.',
    '## Chapter 5', 'Words of chapter 5.'
  ].join('\n\n') + '\n');
  assert.ok(scene);
  const g = Store.create({ text: 'Keep this. Drop that.' });
  g.ann.ghosts = [{ start: 11, end: 21 }];
  eq(P.cleanText(g).trim(), 'Keep this.');
  eq(P.wordsOf(g), 2);
});

test('an idea keeps #tags as tags: at the end they leave the text, inside they keep the word', () => {
  const { P } = browser();
  eq(P.parseIdea('An essay on boredom #book #Essays'), { text: 'An essay on boredom', tags: ['book', 'Essays'] });
  eq(P.parseIdea('Why #boredom helps #book'), { text: 'Why boredom helps', tags: ['boredom', 'book'] });
  eq(P.parseIdea('Item #1 stays, C# too'), { text: 'Item #1 stays, C# too', tags: [] });
  eq(P.parseIdea('  plain  '), { text: 'plain', tags: [] });
  eq(P.parseIdea('#book #book'), { text: '', tags: ['book'] });
});

test('ideas match every word searched, and a tag', () => {
  const { Store, P } = browser();
  const i = Store.addIdea('Write about the long walk home', ['book']);
  assert.ok(P.ideaMatches(i, 'walk home', null));
  assert.ok(P.ideaMatches(i, 'BOOK', null));
  assert.ok(!P.ideaMatches(i, 'walk car', null));
  assert.ok(P.ideaMatches(i, '', 'Book'));
  assert.ok(!P.ideaMatches(i, '', 'essay'));
});

test('the list groups by status, month, tag and project, with filters', () => {
  const { Store, P, b, ch } = book();
  Store.update(ch[0].id, { status: 'done', date: '2026-10-02', tags: ['memoir'] });
  Store.update(ch[1].id, { status: 'editing', date: '2026-11-03', tags: ['memoir', 'draft'] });
  const loose = Store.create({ title: 'Loose', date: '2025-01-09' });
  const all = Store.listDrafts();
  const h = { rootOf: (d) => { const a = Store.ancestors(d.id); return a.length ? a[a.length - 1] : null; }, words: (d) => P.wordsOf(d) };
  const by = (group, extra) => P.groups(all.filter((d) => P.passes(d, Object.assign({ group }, extra || {}), extra && extra.q)), Object.assign({ group, sort: 'title', dir: 'asc' }, extra || {}), h);
  eq(by('status').map((g) => g.label + ':' + g.rows.length), ['Drafting:5', 'Editing:1', 'Done:1']);
  eq(by('tag').map((g) => g.label + ':' + g.rows.length), ['draft:1', 'memoir:2', 'No tags:5']);
  eq(by('project').map((g) => g.label + ':' + g.rows.length), ['Book:5', 'Not in a project:2']);
  const months = by('date').map((g) => g.key);
  eq(months[months.length - 1], '2025-01');
  eq(by('none', { status: ['done', 'editing'] })[0].rows.map((d) => d.title), ['Chapter 1', 'Chapter 2']);
  eq(by('none', { tags: ['draft'] })[0].rows.map((d) => d.title), ['Chapter 2']);
  eq(by('none', { q: 'chap 5' })[0].rows.map((d) => d.title), ['Chapter 5']);
  assert.ok(b && loose);
});

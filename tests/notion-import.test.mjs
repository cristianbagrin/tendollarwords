// Import from Notion (app/js/notion-import.js) against a small stand-in for Notion's API: pages with
// formatting, gray text (ghosts), colors (highlights), an Overflow toggle, subpages, and properties.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['data.js', 'inline.js', 'engine.js', 'marks.js', 'notion-map.js', 'store.js', 'formats.js', 'notion.js', 'sync.js', 'notion-import.js'];
const eq = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);

const ANN = { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' };
const t = (content, ann) => ({ type: 'text', text: { content, link: null }, annotations: { ...ANN, ...(ann || {}) }, plain_text: content, href: null });
let n = 0;
const block = (type, body, extra) => ({ object: 'block', id: 'b' + (++n), type, [type]: body, has_children: false, in_trash: false, created_time: '2026-09-20T09:00:00.000Z', last_edited_time: '2026-09-20T09:00:00.000Z', ...(extra || {}) });
const para = (...rich) => block('paragraph', { rich_text: rich, color: 'default' });

/** Notion as the import sees it: a database, its pages, and every block's children. */
function fakeNotion() {
  const PAGE1 = '11111111-1111-4111-8111-111111111111', PAGE2 = '22222222-2222-4222-8222-222222222222', SUB = '33333333-3333-4333-8333-333333333333', SUB2 = '44444444-4444-4444-8444-444444444444';
  const ov = block('toggle', { rich_text: [t('Overflow')], color: 'default' }, { has_children: true });
  const children = {
    [PAGE1]: [
      block('heading_2', { rich_text: [t('Why no backspace')], color: 'default', is_toggleable: false }),
      para(t('The first draft is for '), t('getting it down', { bold: true }), t('. '), t('Cut this later.', { color: 'gray' })),
      para(t('Every time you hit backspace, you stop thinking about '), t('the reader', { color: 'blue_background' }), t('.')),
      block('child_page', { title: 'Chapter one' }),
      block('child_page', { title: 'Chapter two' }),
      ov
    ],
    [ov.id]: [para(t('A line I cut'))],
    [PAGE2]: [para(t('Desk photo post.'))],
    [SUB]: [para(t('Once upon a time.'))],
    [SUB2]: [para(t('Then it ended.'))]
  };
  children[PAGE1][3].id = SUB;
  children[PAGE1][4].id = SUB2;
  const props = (stage, date, pillar, name) => ({
    Name: { id: 'title', type: 'title', title: [t(name)] },
    Stage: { id: 's', type: 'status', status: stage ? { id: 'x', name: stage, color: 'blue' } : null },
    Date: { id: 'd', type: 'date', date: date ? { start: date, end: null } : null },
    Pillar: { id: 'p', type: 'select', select: pillar ? { id: 'y', name: pillar, color: 'green' } : null }
  });
  const pages = [
    { object: 'page', id: PAGE1, created_time: '2026-09-20T09:00:00.000Z', last_edited_time: '2026-09-21T09:00:00.000Z', in_trash: false, properties: props('Draft 2', '2026-09-28', '30% Craft', 'Why I write without backspace'), url: 'https://notion.so/p1' },
    { object: 'page', id: PAGE2, created_time: '2026-09-22T09:00:00.000Z', last_edited_time: '2026-09-22T09:00:00.000Z', in_trash: false, properties: props('Posted', null, '40% Personal', 'Desk photo post'), url: 'https://notion.so/p2' }
  ];
  const log = [];
  async function fetch(url, init = {}) {
    const u = new URL(String(url));
    const p = u.pathname.replace(/^\/v1/, '');
    log.push((init.method || 'GET') + ' ' + p);
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (new Headers(init.headers).get('Authorization') !== 'Bearer ntn_test') return json({ message: 'bad token' }, 401);
    let m;
    if ((m = /^\/databases\/(\w+)$/.exec(p))) return json({ object: 'database', id: m[1], title: [t('Posts')], data_sources: [{ id: 'ds1' }] });
    if (p === '/data_sources/ds1') return json({ object: 'data_source', id: 'ds1', title: [t('Posts')], properties: {
      Name: { type: 'title', title: {} }, Stage: { type: 'status', status: { options: [{ id: 'x', name: 'Draft 2' }], groups: [] } },
      Date: { type: 'date', date: {} }, Pillar: { type: 'select', select: { options: [{ id: 'y', name: '30% Craft' }] } }
    } });
    if (p === '/data_sources/ds1/query') return json({ results: pages, has_more: false, next_cursor: null });
    if ((m = /^\/blocks\/([\w-]+)\/children$/.exec(p))) return json({ results: children[m[1]] || [], has_more: false, next_cursor: null });
    return json({ message: 'not found' }, 404);
  }
  return { fetch, log, pages, children, ids: { PAGE1, PAGE2, SUB, SUB2 } };
}

function browser(notion, items) {
  const m = new Map(Object.entries(items || {}));
  const localStorage = {
    get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }
  };
  localStorage.setItem('tdw.notionBase', 'http://notion.test/v1');
  const ctx = {
    console, localStorage, URL, Response, Headers, AbortController, navigator: {}, location: { hostname: 'localhost', origin: 'http://localhost' },
    document: { addEventListener() {} }, addEventListener() {}, fetch: notion.fetch,
    setTimeout: (fn) => { queueMicrotask(fn); return 0; }, clearTimeout() {}, queueMicrotask
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'js', f), 'utf8'), ctx, { filename: f });
  return { TDW: ctx.TDW, Store: ctx.TDW.Store, m };
}

test('every page comes in: text, formatting, ghosts, colors, Overflow, subpages as parts, properties; then Notion disconnects', async () => {
  const notion = fakeNotion();
  const { TDW, Store, m } = browser(notion);
  await TDW.Sync.connect('ntn_test', 'https://www.notion.so/me/aaaaaaaabbbbccccddddeeeeeeeeeeee?v=1');
  assert.equal(TDW.NotionImport.needed(), true);
  const seen = [];
  const res = await TDW.NotionImport.run((p) => seen.push([p.done, p.title]));
  eq(res, { pages: 2, created: 4, updated: 0, kept: 0, skipped: 0 });
  eq(seen.map((s) => s[1]), ['Why I write without backspace', 'Chapter one', 'Chapter two', 'Desk photo post']);

  const d = Store.findByNotionId(notion.ids.PAGE1);
  assert.equal(d.text, '## Why no backspace\nThe first draft is for **getting it down**. Cut this later.\nEvery time you hit backspace, you stop thinking about the reader.');
  eq([d.title, d.status, d.date, d.tags], ['Why I write without backspace', 'editing', '2026-09-28', ['30% Craft']]);
  assert.equal(d.overflow, 'A line I cut');
  eq(d.ann.ghosts.map((g) => d.text.slice(g.start, g.end)), ['Cut this later.']);
  eq(d.ann.hls.map((h) => [d.text.slice(h.start, h.end), h.color]), [['the reader', 'blue_background']]);
  eq(Store.children(d.id).map((c) => [c.title, c.text]), [['Chapter one', 'Once upon a time.'], ['Chapter two', 'Then it ended.']]);
  const p2 = Store.findByNotionId(notion.ids.PAGE2);
  eq([p2.status, p2.tags, p2.date], ['done', ['Posted', '40% Personal'], '2026-09-22']);

  // Notion is disconnected: the secret is gone; the database id stays.
  assert.equal(Store.getNotionToken(), '');
  assert.equal(TDW.NotionImport.needed(), false);
  assert.ok(m.get('tdw.notionImported'));
});

test('running it again copies nothing, keeps what was written here, and takes Notion’s new text where nothing was', async () => {
  const notion = fakeNotion();
  const { TDW, Store } = browser(notion);
  await TDW.Sync.connect('ntn_test', 'aaaaaaaabbbbccccddddeeeeeeeeeeee');
  await TDW.NotionImport.run();
  const d1 = Store.findByNotionId(notion.ids.PAGE1);
  const d2 = Store.findByNotionId(notion.ids.PAGE2);
  Store.update(d1.id, { text: d1.text + '\nA line written here.', status: 'done' });
  Store.deleteDraft(Store.findByNotionId(notion.ids.SUB2).id);
  // Meanwhile, in Notion:
  notion.children[notion.ids.PAGE1].splice(1, 0, para(t('Added in Notion.')));
  notion.children[notion.ids.PAGE2] = [para(t('Desk photo post, edited in Notion.'))];

  await TDW.Sync.connect('ntn_test', 'aaaaaaaabbbbccccddddeeeeeeeeeeee');
  const res = await TDW.NotionImport.run();
  eq(res, { pages: 2, created: 0, updated: 2, kept: 1, skipped: 1 });
  assert.equal(Store.listDrafts().length, 3);
  // Written here: kept, with Notion's version in Overflow; the status set here stays.
  assert.match(d1.text, /A line written here\.$/);
  assert.match(d1.overflow, /From Notion:\n## Why no backspace\nAdded in Notion\./);
  assert.equal(d1.status, 'done');
  // Untouched here: Notion's new text.
  assert.equal(d2.text, 'Desk photo post, edited in Notion.');
  // Deleted here: stays deleted.
  assert.equal(Store.findByNotionId(notion.ids.SUB2), null);
});

test('drafts from the old Notion sync: their text comes in where it never loaded; unsent typing is kept', async () => {
  const notion = fakeNotion();
  const schema = { Name: { type: 'title' }, Stage: { type: 'status' }, Date: { type: 'date' }, Pillar: { type: 'select' } };
  const { TDW, Store } = browser(notion, {
    'tdw.notionToken': 'ntn_test',
    'tdw.notion': JSON.stringify({ databaseId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', dataSourceId: 'ds1', titleProp: 'Name', schema }),
    // Never opened, so its text never loaded:
    'tdw.draft.old1': JSON.stringify({ id: 'old1', notionId: notion.ids.PAGE1, title: 'Why I write without backspace', text: '', props: { Stage: 'Idea' } }),
    // Typed in, not yet sent to Notion:
    'tdw.draft.old2': JSON.stringify({ id: 'old2', notionId: notion.ids.PAGE2, text: 'My unsent version.', dirty: true, props: { Stage: 'Posted' } })
  });
  assert.equal(Store.getDraft('old1').status, 'idea'); // from its old properties, at load
  const res = await TDW.NotionImport.run();
  eq(res, { pages: 2, created: 2, updated: 1, kept: 1, skipped: 0 });
  const a = Store.getDraft('old1'), b = Store.getDraft('old2');
  assert.match(a.text, /^## Why no backspace/);
  assert.equal(a.status, 'editing'); // Notion's stage now
  assert.equal(b.text, 'My unsent version.');
  assert.match(b.overflow, /From Notion:\nDesk photo post\./);
  assert.equal(Store.listDrafts().length, 4);
});

test('without a Notion connection it says so', async () => {
  const { TDW } = browser(fakeNotion());
  await assert.rejects(TDW.NotionImport.run(), { code: 'not_connected' });
});

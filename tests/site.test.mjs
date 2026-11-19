// The website: the words /edit can change (worker/copy.mjs), the pages' files, and the routing config.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate, clean, PAGES } from '../worker/copy.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const jsonc = (p) => JSON.parse(read(p).replace(/^\s*\/\/.*$/gm, ''));

test('every page file exists and names its words', () => {
  for (const [, , file] of PAGES) {
    const a = annotate(read(`app${file}`));
    assert.ok(Object.keys(a.texts).length > 3, file);
    assert.equal(a.html.includes('data-copy='), true);
  }
});

test('names stay the same while the words do, and change with them', () => {
  const a = annotate('<html><body><p>Hello there</p><p>Hello there</p></body></html>');
  const b = annotate('<html><body><p>Hello there</p><p>Hello there</p></body></html>');
  assert.deepEqual(Object.keys(a.texts), Object.keys(b.texts));
  assert.equal(Object.keys(a.texts).length, 2); // the second copy gets "-1"
  const c = annotate('<html><body><p>Hello world</p></body></html>');
  assert.notEqual(Object.keys(c.texts)[0], Object.keys(a.texts)[0]);
});

test('scripts and the page head are not editable, and edits are cleaned', () => {
  const a = annotate('<html><head><title>T</title></head><body><script>var x = "words";</script><h1>Words</h1></body></html>');
  assert.deepEqual(Object.values(a.texts), ['Words']);
  assert.equal(clean('a<script>x()</script><b onclick="x()">b</b> <a href="javascript:x()">c</a>'), 'a<b>b</b> <a href="x()">c</a>');
});

test('pages never include inline scripts (strict CSP) and send app users on from the head', () => {
  for (const [, , file] of PAGES) {
    const html = read(`app${file}`);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i, file);
    assert.match(html, /<script src="\/site\/site\.js"><\/script>/);
  }
  assert.match(read('app/site/site.js'), /indexOf\('tdw\.'\) === 0/);
});

test('routing: the app is at /dashboard, files are served as they are, the Worker sees the pages first', () => {
  const w = jsonc('wrangler.jsonc');
  assert.equal(w.assets.html_handling, 'none');
  for (const p of ['/', '/dashboard', '/edit', '/edit/*', '/api/*', '/index.html', ...PAGES.map((x) => x[1]).filter((x) => x !== '/')]) {
    assert.ok(w.assets.run_worker_first.includes(p), p);
  }
  assert.ok(w.durable_objects.bindings.some((b) => b.name === 'COPY' && b.class_name === 'Copy'));
  assert.ok(w.migrations.some((m) => m.new_sqlite_classes?.includes('Copy')));
  const m = JSON.parse(read('app/manifest.webmanifest'));
  assert.equal(m.start_url, '/dashboard');
  assert.ok(fs.existsSync(path.join(root, 'app/index.html')));
});

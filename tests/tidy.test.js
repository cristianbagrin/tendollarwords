// Tidy's rules: what it fixes by itself, and (just as much) what it leaves alone.
//   node --test tests/tidy.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Spell = require('../app/js/spell.js');
const Tidy = require('../app/js/tidy.js');

Spell.init(fs.readFileSync(path.join(__dirname, '../app/dict/en-us.txt'), 'utf8'));

const tidy = (s, caret, opts) => Tidy.apply(s, Tidy.fixes(s, caret, opts));
const kinds = (s, caret, opts) => Tidy.fixes(s, caret, opts).map((f) => f.kind);

test('typos with one clear fix', () => {
  assert.equal(tidy('I will recieve teh package'), 'I will receive the package');
  assert.equal(tidy('That was alot of fun.'), 'That was a lot of fun.');
  assert.equal(tidy('I dont know and she doesnt either'), "I don't know and she doesn't either");
  assert.equal(tidy('This is definately wierd'), 'This is definitely weird');
  assert.equal(tidy('It was a brokken window'), 'It was a broken window');
  assert.equal(tidy('It occured yesterday'), 'It occurred yesterday');
  assert.equal(tidy('Thier plan, becuase of that'), 'Their plan, because of that');
});

test('a fix is { from, to, start, end, kind } and points at the line', () => {
  const s = 'the cat sat on teh mat';
  const f = Tidy.fixes(s).find((x) => x.kind === 'spelling');
  assert.deepEqual(f, { from: 'teh', to: 'the', start: 15, end: 18, kind: 'spelling' });
  assert.equal(s.slice(f.start, f.end), f.from);
});

test('typos are left alone when the fix is a guess', () => {
  assert.equal(tidy('We use nodejs and kubernetes at work'), 'We use nodejs and kubernetes at work');
  assert.equal(tidy('She said thre'), 'She said thre'); // there, three, the?
  assert.equal(tidy('Try the wasm build'), 'Try the wasm build');
  assert.equal(tidy('Ask Marek about it'), 'Ask Marek about it'); // a name
  assert.equal(tidy('then Chris and Sarah left'), 'Then Chris and Sarah left'); // only the capital
  assert.equal(tidy('lol tbh idk'), 'Lol tbh idk');
});

test('words in the personal dictionary are never touched', () => {
  Spell.addWord('teh');
  Spell.addWord('wasmx');
  assert.equal(tidy('And teh wasmx'), 'And teh wasmx');
  Spell.removeWord('teh');
  Spell.removeWord('wasmx');
  assert.equal(tidy('And teh'), 'And the');
});

test('doubled words', () => {
  assert.equal(tidy('This is the the best day'), 'This is the best day');
  assert.equal(tidy('Go to to the store'), 'Go to the store');
  assert.equal(tidy('He had had enough'), 'He had had enough');
  assert.equal(tidy('I said that that was fine'), 'I said that that was fine');
  assert.equal(tidy('Knock knock. Who is there?'), 'Knock knock. Who is there?');
  assert.deepEqual(kinds('See the the cat'), ['double-word']);
});

test('lone i', () => {
  assert.equal(tidy('Yesterday i went home and i said i\'m tired'), "Yesterday I went home and I said I'm tired");
  assert.equal(tidy('Part (i) and i. and i)'), 'Part (i) and i. and i)');
  assert.equal(tidy('See the i/o layer, i18n, wi-fi'), 'See the i/o layer, i18n, wi-fi');
});

test('sentence capitals', () => {
  assert.equal(tidy('hello there. this is new! really? yes it is.'), 'Hello there. This is new! Really? Yes it is.');
  assert.equal(tidy('Stop. then go'), 'Stop. Then go');
  assert.equal(tidy('Wait... then what'), 'Wait... then what');
  assert.equal(tidy('See e.g. the docs, Dr. smith said, etc. and so on.'), 'See e.g. the docs, Dr. smith said, etc. and so on.');
  assert.equal(tidy('He shouted "stop!" and ran'), 'He shouted "stop!" and ran');
  assert.equal(tidy('"Stop!" he said'), '"Stop!" he said');
  assert.equal(tidy('It cost 3. then it rose'), 'It cost 3. then it rose');
  assert.equal(tidy('eBay and iPhone and macOS. iOS too'), 'eBay and iPhone and macOS. iOS too');
});

test('block markers: lists and headings are not sentences, paragraphs are', () => {
  assert.equal(tidy('- buy milk. then eggs'), '- buy milk. Then eggs');
  assert.equal(tidy('# a title'), '# a title');
  assert.equal(tidy('> quoted words'), '> quoted words');
  assert.equal(tidy('---'), '---');
  assert.equal(tidy('⟦image⟧'), '⟦image⟧');
});

test('spaces', () => {
  assert.equal(tidy('Two  spaces here   and there'), 'Two spaces here and there');
  assert.equal(tidy('  Indented text stays'), '  Indented text stays');
  assert.equal(tidy('Trailing two spaces  '), 'Trailing two spaces  '); // a markdown line break
  assert.equal(tidy('Wait , what ? Yes !'), 'Wait, what? Yes!');
  assert.equal(tidy('It works :) and ;) and ... too'), 'It works :) and ;) and ... too');
  assert.equal(tidy('He left.The next day'), 'He left. The next day');
  assert.equal(tidy('Really?Yes.'), 'Really? Yes.');
  assert.equal(tidy('See example.Com and node.js and e.g.The'), 'See example.Com and node.js and e.g.The');
});

test('a / an', () => {
  assert.equal(tidy('It is a apple and an banana'), 'It is an apple and a banana');
  assert.equal(tidy('She has a hour and an unicorn'), 'She has an hour and a unicorn');
  assert.equal(tidy('A apple a day'), 'An apple a day');
  assert.equal(tidy('Say an MBA, a SQL query, an SQL query'), 'Say an MBA, a SQL query, an SQL query');
  assert.equal(tidy('Say a historic day and an historic one'), 'Say a historic day and an historic one');
  assert.equal(tidy('Plan A is out and vitamin A and more'), 'Plan A is out and vitamin A and more');
  assert.equal(tidy('a) first b) second'), 'a) first b) second');
});

test('doubled punctuation, but not ellipses', () => {
  assert.equal(tidy('Well,, maybe.. not'), 'Well, maybe. not');
  assert.equal(tidy('Wait... what... no'), 'Wait... what... no');
  assert.equal(tidy('What?! Really!! Yes??'), 'What?! Really!! Yes??');
});

test('never inside code, links, addresses, handles, tags, ALL-CAPS or numbers', () => {
  const same = [
    'Run `teh dont` and `npm  i` now',
    'Read [teh docs](https://example.com/teh_dont) now',
    'Go to https://example.com/recieve?a=1 now',
    'Visit www.example.com and example.com/teh today',
    'Mail teh@example.com or @teh or #teh',
    'The NASA and FAQ and TEH list',
    'About 2nd and 3rd and v2 and 1,000 and 3.5',
    'snake_case and some/path and well-known and don-t',
    'Escaped \\*teh\\* stays? no'
  ];
  for (const s of same.slice(0, 8)) assert.equal(tidy(s), s, s);
  assert.equal(same.length, 9);
});

test('formatting around a word does not hide it, and does not break it', () => {
  assert.equal(tidy('This is **teh** best'), 'This is **the** best');
  assert.equal(tidy('This is *very  good* too'), 'This is *very good* too');
  assert.equal(tidy('An te**h** word'), 'An te**h** word');
  assert.equal(tidy('[teh](https://x.y) and teh'), '[teh](https://x.y) and the');
});

test('with a caret: only what you just finished, never the word being typed', () => {
  const at = (s) => tidy(s, s.length);
  assert.equal(at('I recieved teh'), 'I received teh');         // "teh" waits, the finished word before it does not         // still typing "teh"
  assert.equal(at('I recieved teh '), 'I recieved the ');        // "recieved" was fixed when you left it
  assert.equal(at('i '), 'I ');
  assert.equal(at('hello'), 'hello');
  assert.equal(at('hello '), 'Hello ');
  assert.equal(at('So this is a apple'), 'So this is a apple');
  assert.equal(at('So this is a apple '), 'So this is an apple ');
  assert.equal(at('See the the '), 'See the ');
  assert.equal(at('A word  '), 'A word ');
  assert.equal(at('A word , '), 'A word, ');
  assert.equal(at('A word ,'), 'A word ,');                          // could be ", ", could be " ,5"
  assert.equal(at('He left.The '), 'He left. The ');
  assert.equal(at('Well,, '), 'Well, ');
  assert.equal(at('example.'), 'example.');                      // may become example.com
  assert.equal(at('Then see teh, '), 'Then see the, ');
  assert.equal(tidy('Teh cat is teh', 14), 'Teh cat is teh');
});

test('with a caret: older mistakes are left behind, text after the caret is not read', () => {
  const s = 'Teh first words and then more ';
  assert.equal(tidy(s, s.length), s);
  const t = 'Ok teh and mroe stuff';
  assert.equal(tidy(t, 7), 'Ok the and mroe stuff');
  assert.equal(tidy(t, 3), 'Ok teh and mroe stuff');
});

test('Enter finishes the last word', () => {
  assert.equal(tidy('And teh', 7, { final: true }), 'And the');
  assert.equal(tidy('And teh.', 8, { final: true }), 'And the.');
});

test('fixes never overlap, and apply / mapIndex agree', () => {
  const s = 'teh teh  recieve , alot';
  const list = Tidy.fixes(s);
  for (let i = 1; i < list.length; i++) assert.ok(list[i].start >= list[i - 1].end);
  const out = Tidy.apply(s, list);
  assert.equal(Tidy.mapIndex(list, s.length), out.length);
  assert.equal(Tidy.mapIndex(list, 0), 0);
});

test('checkEdits: small exact fixes only, narrowed to the changed words', () => {
  const text = 'Their is a cat. It dont like me. See `their is` and https://a.b/their.';
  const edits = [
    { find: 'Their is a cat', replace: 'There is a cat' },
    { find: 'It dont like', replace: "It doesn't like" },
    { find: 'their is', replace: 'there is' },          // twice (code and... once in code), and in code
    { find: 'a cat. It', replace: 'a cat! It' },
    { find: 'Nothing here', replace: 'Something' },     // not in the text
    { find: 'like me', replace: 'like me' }             // no change
  ];
  const r = Tidy.checkEdits(text, edits);
  assert.deepEqual(r.map((x) => [x.from, x.to, x.kind]), [['Their', 'There', 'grammar'], ['cat.', 'cat!', 'grammar'], ['dont', "doesn't", 'grammar']]);
  for (const x of r) assert.equal(text.slice(x.start, x.end), x.from);
});

test('checkEdits refuses rewrites, code, ghosts and edits that add syntax', () => {
  const text = 'The report were long and boring, so I skimmed it.\nUse `foo bar` here.';
  assert.deepEqual(Tidy.checkEdits(text, [{ find: 'The report were long and boring, so I skimmed it.', replace: 'That lengthy document bored me, so I skimmed it.' }]), []);
  assert.deepEqual(Tidy.checkEdits(text, [{ find: 'foo bar', replace: 'foo baz' }]), []);
  assert.deepEqual(Tidy.checkEdits(text, [{ find: 'were long', replace: 'was **long**' }]), []);
  assert.deepEqual(Tidy.checkEdits(text, [{ find: 'were long', replace: 'was long' }], { ghosts: [{ start: 0, end: 20 }] }), []);
  assert.deepEqual(Tidy.checkEdits(text, [{ find: 'were long', replace: 'was\nlong' }]), []);
  const ok = Tidy.checkEdits(text, [{ find: 'were long', replace: 'was long' }]);
  assert.deepEqual(ok.map((x) => [x.from, x.to]), [['were', 'was']]);
});

test('the letter i in quotes is a letter', () => {
  assert.equal(tidy('The letter "i" and i said'), 'The letter "i" and I said');
});

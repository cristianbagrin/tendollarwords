/* Tidy: fixes the low-risk mistakes nobody wants to fix by hand. The rules are pure: they read one
   line of the draft (markdown-lite, see inline.js) and say what to change, never touching code,
   links, addresses, @handles, #tags, ALL-CAPS, names, or words in the personal dictionary.
   The live part lives in editor.js (it asks for fixes as you leave a word); "Tidy with AI" at the
   bottom asks Gemini for grammar fixes and lays them over the page as marks you can click to undo.
   UMD: TDW.Tidy in the browser, module.exports in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./inline.js'), require('./marks.js'), require('./spell.js'));
  else { root.TDW = root.TDW || {}; root.TDW.Tidy = factory(root.TDW.Inline, root.TDW.Marks, root.TDW.Spell, root); }
})(typeof self !== 'undefined' ? self : this, function (Inline, Marks, Spell, host) {
  'use strict';

  const NUL = '\u0000';
  const PROTECT = Inline.MD | Inline.C | Inline.L;

  /* ---------- What is surely a mistake ---------- */

  // Typos that have one right answer and are not words themselves. A word in the dictionary (or the
  // personal dictionary) is never touched, so nothing here needs to be a rare word.
  const TYPOS = (function () {
    const t = {};
    const add = (fix, list) => { for (const w of list.split(' ')) t[w] = fix; };
    add('the', 'teh hte tge');
    add('and', 'adn nad');
    add('that', 'taht thta htat');
    add('what', 'waht');
    add('which', 'whcih wich whihc');
    add('with', 'wiht wtih');
    add('just', 'jsut');
    add('have', 'ahve haev');
    add('you', 'yuo');
    add('your', 'yoru');
    add('can', 'cna');
    add('their', 'thier');
    add('because', 'becuase beacuse becasue becuz');
    add('a lot', 'alot');
    add('a lot', 'alott');
    add('receive', 'recieve');
    add('received', 'recieved');
    add('believe', 'beleive belive');
    add('weird', 'wierd');
    add('friend', 'freind');
    add('definitely', 'definately definitly definately definatly defiantly_');
    add('separate', 'seperate');
    add('separately', 'seperately');
    add('occurred', 'occured');
    add('occurrence', 'occurence');
    add('accommodate', 'accomodate');
    add('until', 'untill');
    add('address', 'adress');
    add('beginning', 'begining beggining');
    add('calendar', 'calender');
    add('colleague', 'collegue');
    add('coming', 'comming');
    add('committed', 'commited');
    add('conscious', 'concious');
    add('environment', 'enviroment');
    add('existence', 'existance');
    add('government', 'goverment');
    add('happened', 'happend');
    add('immediately', 'immediatly');
    add('independent', 'independant');
    add('knowledge', 'knowlege');
    add('maintenance', 'maintainance');
    add('necessary', 'neccessary necesary neccesary');
    add('noticeable', 'noticable');
    add('occasion', 'occassion ocassion');
    add('persistent', 'persistant');
    add('possession', 'posession');
    add('preferred', 'prefered');
    add('publicly', 'publically');
    add('really', 'realy');
    add('referred', 'refered');
    add('relevant', 'relevent');
    add('religious', 'religous');
    add('remember', 'remeber rember');
    add('responsibility', 'responsability');
    add('rhythm', 'rythm');
    add('successful', 'succesful successfull');
    add('supersede', 'supercede');
    add('tomorrow', 'tommorow tomorow tommorrow');
    add('truly', 'truely');
    add('writing', 'writting');
    add('written', 'writen');
    add('achieve', 'acheive');
    add('aggressive', 'agressive');
    add('apparent', 'apparant');
    add('argument', 'arguement');
    add('basically', 'basicly');
    add('business', 'buisness');
    add('ceiling', 'cieling');
    add('committee', 'comittee');
    add('completely', 'completly');
    add('different', 'diffrent');
    add('disappoint', 'dissapoint');
    add('embarrass', 'embarass');
    add('exercise', 'excersise');
    add('finally', 'finaly');
    add('foreign', 'foriegn');
    add('guard', 'gaurd');
    add('height', 'hieght heighth');
    add('interrupt', 'interupt');
    add('length', 'lenght');
    add('license', 'lisense');
    add('opportunity', 'oppurtunity oportunity');
    add('original', 'orignal');
    add('parallel', 'paralell');
    add('piece', 'peice');
    add('perceive', 'percieve');
    add('professional', 'proffesional');
    add('questionnaire', 'questionaire');
    add('recommend', 'reccomend recomend');
    add('reference', 'refrence');
    add('schedule', 'scedule');
    add('strength', 'strenght');
    add('surprise', 'suprise');
    add('temperature', 'temperture');
    add('thorough', 'thourough');
    add('tendency', 'tendancy');
    add('usually', 'usally');
    add('yield', 'yeild');
    add('should', 'shoud');
    add('would', 'woudl');
    add('could', 'coudl');
    add('about', 'abuot');
    add('people', 'poeple peple');
    add('through', 'throught');
    add('thought', 'thougth');
    add('because', 'becaus');
    add('little', 'littel');
    add('probably', 'probly probabaly');
    add('enough', 'enought');
    add('experience', 'experiance');
    add('beautiful', 'beatiful beautifull');
    add('language', 'langauge');
    add('pretty', 'pritty');
    add('sentence', 'sentance');
    add('whether', 'wheather');
    add("don't", 'dont');
    add("doesn't", 'doesnt');
    add("didn't", 'didnt');
    add("isn't", 'isnt');
    add("wasn't", 'wasnt');
    add("aren't", 'arent');
    add("weren't", 'werent');
    add("couldn't", 'couldnt');
    add("wouldn't", 'wouldnt');
    add("shouldn't", 'shouldnt');
    add("haven't", 'havent');
    add("hasn't", 'hasnt');
    add("hadn't", 'hadnt');
    add("I'm", 'im');
    add("I've", 'ive');
    add("you're", 'youre');
    add("they're", 'theyre');
    add("that's", 'thats');
    add("what's", 'whats');
    add("could've", 'couldve');
    add("would've", 'wouldve');
    add("should've", 'shouldve');
    delete t['defiantly_'];
    return t;
  })();

  // Words that are fine twice only when they are the same word on purpose; these never are.
  const DOUBLE_OK = new Set('the a an and or of to in on at by for with from as is are was were be it this we you they but if'.split(' '));

  // Words before a period that do not end a sentence.
  const ABBR = new Set('mr mrs ms dr prof sr jr st vs etc inc ltd co no approx cf al fig vol eg ie am pm ca jan feb mar apr jun jul aug sep sept oct nov dec mon tue wed thu fri sat sun'.split(' '));

  // Little words that follow "a" only by accident (a list letter, a variable): left alone.
  const CLOSED = new Set('the a an and or but is are was were be to of in on at by for with as it if so not'.split(' '));

  // "a historic", "an historic": both are used, so neither is wrong.
  const EITHER_ARTICLE = /^(histor|heroi|hallucin|hotel)/i;

  /* ---------- Small helpers ---------- */

  const isWordCh = (c) => !!c && /[\p{L}\p{N}_]/u.test(c);
  const BAD_ADJ = /[-‐‑/\\@#&%$+=~^<>|]/;

  // Damerau-Levenshtein, enough for words.
  function distance(a, b) {
    const d = [];
    for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }

  const KEY_POS = {};
  ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].forEach((row, y) => { for (let x = 0; x < row.length; x++) KEY_POS[row[x]] = [x + y * 0.4, y]; });
  function neighbors(a, b) {
    const p = KEY_POS[a], q = KEY_POS[b];
    return !!p && !!q && Math.abs(p[1] - q[1]) <= 1 && Math.abs(p[0] - q[0]) <= 1.1;
  }

  // The kinds of slip a finger makes: two letters traded, a letter typed twice (or a double letter
  // missed), or a neighboring key. Anything else (a letter missing or extra) is too often a different word.
  function typoShape(w, c) {
    if (w.length === c.length) {
      let i = 0;
      while (i < w.length && w[i] === c[i]) i++;
      if (i >= w.length) return false;
      if (w[i] === c[i + 1] && w[i + 1] === c[i] && w.slice(i + 2) === c.slice(i + 2)) return true;
      return w.slice(i + 1) === c.slice(i + 1) && neighbors(w[i], c[i]);
    }
    const [longer, shorter] = w.length > c.length ? [w, c] : [c, w];
    if (longer.length - shorter.length !== 1) return false;
    for (let i = 0; i < longer.length; i++) {
      if (longer.slice(0, i) + longer.slice(i + 1) === shorter) return longer[i] === longer[i - 1] || longer[i] === longer[i + 1];
    }
    return false;
  }

  function caseLike(original, word) {
    if (word[0] === 'I' && /^I['’]/.test(word)) return word;
    if (original.length > 1 && original[0] !== original[0].toLowerCase()) return word[0].toUpperCase() + word.slice(1);
    return word;
  }

  /* ---------- Reading a line ---------- */

  const MISSING_SPACE = /[a-z]{2}[.!?][A-Z][a-z]{2,}/;

  function chunkIsProtected(core) {
    if (/^(?:https?:|ftp:|mailto:|www\.)/i.test(core)) return true;
    if (/[@#/\\_\d]/.test(core)) return true;
    return /[A-Za-z0-9]\.[A-Za-z0-9]/.test(core) && !MISSING_SPACE.test(core);
  }

  // The line with everything off limits (block marker, markdown syntax, code, link labels, addresses,
  // handles, tags, numbers) replaced by NUL, so the rules only ever see plain prose.
  function prep(text) {
    const blk = Inline.block(text);
    if (blk.type === 'hr' || blk.type === 'opaque') return null;
    const { flags } = Inline.parse(text, blk.prefix);
    const chars = text.split('');
    for (let i = 0; i < chars.length; i++) if (i < blk.prefix || (flags[i] & PROTECT)) chars[i] = NUL;
    const re = /\S+/g;
    const joined = chars.join('');
    let x;
    while ((x = re.exec(joined))) {
      const core = x[0].replace(/^[\u0000"'“‘(\[{*_~+<]+/, '').replace(/[\u0000"'”’)\]}.,;:!?*_~+>]+$/, '');
      if (core && chunkIsProtected(core)) for (let k = 0; k < x[0].length; k++) chars[x.index + k] = NUL;
    }
    return { m: chars.join(''), type: blk.type };
  }

  // Is the character next to a word glued to it (a hyphen, a digit, a dot between letters...)?
  function glued(m, i, dir) {
    const c = m[i];
    if (c === undefined) return false;
    if (c === NUL) {
      let j = i;
      while (j >= 0 && j < m.length && m[j] === NUL) j += dir;
      return isWordCh(m[j]);
    }
    if (isWordCh(c) || BAD_ADJ.test(c)) return true;
    if (c === '.') return isWordCh(m[i + dir]);
    return false;
  }

  function sentenceStart(raw, a, blockType) {
    const before = raw.slice(0, a);
    if (/^[\s"'“‘(\[*_~+]*$/.test(before)) return blockType === 'p';
    const t = /([.!?])\s+[("'“‘\[\u0000]*$/.exec(before);
    if (!t) return false;
    if (t[1] === '.') {
      if (before[t.index - 1] === '.') return false;
      const tok = (/(\S*)$/.exec(before.slice(0, t.index)) || ['', ''])[1].replace(/^[("'“‘\[\u0000]+/, '');
      if (tok.length < 2 || /[.\d]/.test(tok) || ABBR.has(tok.toLowerCase())) return false;
    }
    return true;
  }

  // The one right spelling of a word, or null.
  function spellFix(raw) {
    if (raw.length < 2 || raw === raw.toUpperCase() || /[A-Z]/.test(raw.slice(1))) return null;
    if (Spell.known(raw)) return null;
    const fix = TYPOS[raw.toLowerCase().replace(/’/g, "'")];
    if (fix) return caseLike(raw, fix);
    if (!Spell.isReady() || raw[0] !== raw[0].toLowerCase() || raw.length < 4 || /['’]/.test(raw)) return null; // a capital may be a name
    const near = Spell.suggest(raw, 10).filter((c) => !/\s/.test(c) && distance(raw, c) <= 1);
    return near.length === 1 && typoShape(raw, near[0]) ? near[0] : null;
  }

  const articleCase = (orig, want) => (orig === orig.toUpperCase() && orig.length > 1 ? want.toUpperCase() : orig[0] !== orig[0].toLowerCase() ? want[0].toUpperCase() + want.slice(1) : want);

  /* ---------- The rules ---------- */

  // fixes(line, caret?, { final? }) → [{ from, to, start, end, kind }], sorted, never overlapping.
  // start/end are offsets in `line`; applying every fix turns `from` into `to`. kind: spelling,
  // double-word, i, capital, space, article, punctuation.
  //
  // Without a caret the whole line is checked. With one, only the text behind the caret is, and
  // only the stretch you just finished (the last word, the word before it for a/an and doubled
  // words, and the spaces and punctuation around them): a word still being typed is left alone, and
  // so is anything you walked away from before, so a fix you undid is not made again.
  // final: the caret is leaving the line (Enter), so the last word counts as finished.
  function fixes(line, caret, opts) {
    const text = String(line == null ? '' : line);
    const p = prep(text);
    if (!p) return [];
    const live = caret != null;
    const bound = live ? Math.max(0, Math.min(caret, text.length)) : text.length;
    const final = !live || !!(opts && opts.final);
    const m = p.m.slice(0, bound);
    const out = [];
    const wordFix = new Map();

    const words = [];
    const re = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
    let x;
    while ((x = re.exec(m))) {
      const w = { text: x[0], start: x.index, end: x.index + x[0].length, ok: true };
      if (glued(m, w.start - 1, -1) || glued(m, w.end, 1)) w.ok = false;
      if (!final && w.end === bound) w.ok = false;                       // still being typed
      if (!final && m[w.end] === '.' && w.end + 1 === bound) w.ok = false; // "example." may become "example.com"
      words.push(w);
    }

    const setWord = (w, to, kind) => {
      const cur = wordFix.get(w.start);
      if (cur) cur.to = to;
      else wordFix.set(w.start, { from: w.text, to, start: w.start, end: w.end, kind });
    };
    const current = (w) => (wordFix.has(w.start) ? wordFix.get(w.start).to : w.text);
    const gap = (a, b) => m.slice(a.end, b.start) === ' ';

    for (const w of words) {
      if (!w.ok) continue;
      const nextCh = m[w.end];
      if (/^i(?:['’](?:m|ll|d|ve))?$/.test(w.text) && nextCh !== '.' && nextCh !== ')' && !(/["“‘']/.test(m[w.start - 1] || '') && /["”’']/.test(nextCh || ''))) { setWord(w, 'I' + w.text.slice(1), 'i'); continue; }
      const fix = spellFix(w.text);
      if (fix) setWord(w, fix, 'spelling');
    }

    for (let k = 0; k + 1 < words.length; k++) {
      const a = words[k], b = words[k + 1];
      if (!a.ok || !b.ok || !gap(a, b)) continue;
      const wa = current(a).toLowerCase();
      // a / an
      const art = a.text === 'a' || a.text === 'an' || ((a.text === 'A' || a.text === 'An') && sentenceStart(text, a.start, p.type));
      if (art) {
        const nb = current(b);
        const known = !Spell.isReady() || Spell.known(nb);
        if (known && /^[a-z]+$/.test(nb) && !CLOSED.has(nb) && !EITHER_ARTICLE.test(nb)) {
          const want = Marks.articleFor(nb);
          if (want && want !== a.text.toLowerCase()) setWord(a, articleCase(a.text, want), 'article');
        }
      }
      // the the
      if (DOUBLE_OK.has(wa) && wa === b.text.toLowerCase() && !wordFix.has(b.start)) {
        out.push({ from: m.slice(a.end, b.end), to: '', start: a.end, end: b.end, kind: 'double-word' });
      }
    }

    // Sentence capitals, last, so they work on the corrected word.
    for (const w of words) {
      if (!w.ok) continue;
      const cur = current(w);
      if (!/^[a-z]/.test(cur) || /[A-Z]/.test(cur) || !sentenceStart(text, w.start, p.type)) continue;
      if (cur.length === 1 && /[).:]/.test(m[w.end] || '')) continue; // a list letter: "a) first"
      setWord(w, cur[0].toUpperCase() + cur.slice(1), 'capital');
    }
    for (const f of wordFix.values()) {
      if (f.to === f.from) continue;
      // A double word's second word is gone, so its fix goes with it.
      if (out.some((o) => o.kind === 'double-word' && f.start >= o.start && f.end <= o.end)) continue;
      out.push(f);
    }

    // Spaces and punctuation. Each needs a space or the end behind it, so "..." or ":)" is never cut short.
    const edge = (i) => (m[i] === undefined ? final : /\s/.test(m[i]));
    const punct = (re2, make, kind) => {
      let y;
      while ((y = re2.exec(m))) {
        const r = make(y);
        if (!r || m.slice(r.start, r.end).includes(NUL)) continue;
        out.push({ from: m.slice(r.start, r.end), to: r.to, start: r.start, end: r.end, kind });
      }
    };
    punct(/ {2,}/g, (y) => {
      const end = y.index + y[0].length;
      if (!m.slice(0, y.index).trim() || (!live && end >= text.length)) return null; // indentation, or two spaces that break a line
      return { start: y.index, end, to: ' ' };
    }, 'space');
    punct(/([\p{L}\p{N})"”'’\]\u0000])( +)(?=[,.!?])/gu, (y) => {
      const start = y.index + 1, at = start + y[2].length;
      return edge(at + 1) ? { start, end: at, to: '' } : null;
    }, 'space');
    punct(/[a-z]{2}[.!?](?=[A-Z][a-z]{2,})/g, (y) => {
      const at = y.index + 3;
      const word = /^[A-Za-z]+/.exec(m.slice(at))[0];
      if (/^(Com|Org|Net|Edu|Gov|Html|Json|Xml|Css|Php)$/.test(word)) return null; // example.Com is an address
      return !final && at + word.length >= bound ? null : { start: at, end: at, to: ' ' };
    }, 'space');
    punct(/[\p{L}\p{N}\u0000](,{2,}|;{2,}|\.\.(?!\.))/gu, (y) => {
      const start = y.index + 1, end = start + y[1].length;
      return edge(end) ? { start, end, to: y[1][0] } : null;
    }, 'punctuation');

    // Live: only what you just finished, so a fix you undid is not made again.
    let lastStart = 0;
    if (live) {
      let head = m.replace(/[\s\u0000.,;:!?)"”'’\]*_~+-]+$/u, '');
      if (!final && head.length === m.length) head = head.replace(/[\p{L}\p{N}'’]+$/u, '').replace(/[\s\u0000.,;:!?)"”'’\]*_~+-]+$/u, '');
      const lastWord = /[\p{L}\p{N}'’]*$/u.exec(head);
      lastStart = lastWord ? lastWord.index : head.length;
    }
    const ordered = out.filter((f) => f.to !== f.from && (!live || f.end >= (f.kind === 'article' ? lastStart - 1 : lastStart)))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const kept = [];
    for (const f of ordered) {
      const last = kept[kept.length - 1];
      if (last && f.start < last.end) continue;
      if (last && f.start === last.start && f.end === last.end) continue;
      kept.push(f);
    }
    return kept;
  }

  // The line with the fixes made.
  function apply(line, list) {
    let s = String(line);
    for (const f of list.slice().sort((a, b) => b.start - a.start)) s = s.slice(0, f.start) + f.to + s.slice(f.end);
    return s;
  }

  // Where an offset of the old line lands in the fixed one.
  function mapIndex(list, i) {
    let d = 0;
    for (const f of list) {
      if (f.end <= i) d += f.to.length - (f.end - f.start);
      else if (f.start < i) return f.start + d + f.to.length;
    }
    return i + d;
  }

  /* ---------- Reading the AI's edits ---------- */

  const MARKERS = /[`*_~+[\]()\\#<>|]/g;
  const wordCount = (s) => (s.match(/[\p{L}\p{N}']+/gu) || []).length;

  // The AI answers with { find, replace } pairs. Only small, exact, one-line fixes outside code,
  // links, and ghosted text get through; each is narrowed to the words that changed.
  // → [{ from, to, start, end, kind: 'grammar' }], in text order, never overlapping.
  function checkEdits(text, edits, opts) {
    const ghosts = (opts && opts.ghosts) || [];
    const starts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    const lineOf = (pos) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };
    const preps = new Map();
    const W = /[\p{L}\p{N}'’]/u;
    const found = [];
    for (const e of Array.isArray(edits) ? edits : []) {
      if (!e || typeof e.find !== 'string' || typeof e.replace !== 'string') continue;
      const find = e.find, rep = e.replace;
      if (!find || find === rep || /\n/.test(find + rep)) continue;
      const at = text.indexOf(find);
      if (at < 0 || text.indexOf(find, at + 1) >= 0) continue;
      let a = 0;
      while (a < find.length && a < rep.length && find[a] === rep[a]) a++;
      let z = 0;
      while (z < find.length - a && z < rep.length - a && find[find.length - 1 - z] === rep[rep.length - 1 - z]) z++;
      let fs = a, fe = find.length - z, rs = a, re = rep.length - z;
      while (fs > 0 && W.test(find[fs - 1])) { fs--; rs--; }
      while (fe < find.length && W.test(find[fe])) { fe++; re++; }
      if (re === rs) { // a pure deletion: show it with the word before it
        while (fs > 0 && find[fs - 1] === ' ') { fs--; rs--; }
        while (fs > 0 && W.test(find[fs - 1])) { fs--; rs--; }
        if (re === rs && fs === fe) continue;
      }
      const from = find.slice(fs, fe), to = rep.slice(rs, re);
      if (!to.trim() || !from.trim() || from.length > 60 || to.length > 80) continue;
      if (Math.abs(wordCount(from) - wordCount(to)) > 2) continue;
      if (distance(from, to) > Math.max(4, Math.ceil(0.6 * Math.max(from.length, to.length)))) continue;
      if ((from.match(MARKERS) || []).join('') !== (to.match(MARKERS) || []).join('')) continue;
      const start = at + fs, end = at + fe;
      const li = lineOf(start);
      const lineText = text.slice(starts[li], li + 1 < starts.length ? starts[li + 1] - 1 : text.length);
      if (!preps.has(li)) preps.set(li, prep(lineText));
      const p = preps.get(li);
      if (!p || p.m.slice(start - starts[li], end - starts[li]).includes(NUL)) continue;
      if (ghosts.some((g) => g.start < end && g.end > start)) continue;
      found.push({ from, to, start, end, kind: 'grammar' });
    }
    found.sort((x, y) => x.start - y.start);
    const kept = [];
    for (const f of found) if (!kept.length || f.start >= kept[kept.length - 1].end) kept.push(f);
    return kept;
  }

  /* ---------- In the app ---------- */

  const api = { fixes, apply, mapIndex, checkEdits, TYPOS };
  if (typeof document === 'undefined' || !host || !host.TDW) return api;
  const TDW = host.TDW;

  // Live tidy is off when the setting says so, and while a challenge runs (its rules count the words).
  api.enabled = function () {
    const s = TDW.App && TDW.App.state && TDW.App.state.settings;
    if (s && s.tidy === false) return false;
    const c = TDW.Challenges && TDW.Challenges.info ? TDW.Challenges.info() : null;
    return !(c && c.running);
  };

  let wired = false;
  let busy = false;
  const E = () => TDW.Editor;
  const toast = (msg, action) => TDW.UI.toast(msg, action);

  function wire() {
    if (wired) return;
    wired = true;
    E().rootEl().addEventListener('click', (e) => {
      const node = e.target.closest && e.target.closest('[data-tidy]');
      if (node) api.revert(node.dataset.tidy);
    });
  }

  // A tidied stretch goes back to what it was.
  api.revert = function (id) {
    const m = E().getTidyMarks().find((x) => x.id === id);
    if (!m) return false;
    const t = E().getText();
    if (t.slice(m.start, m.end) !== m.to) { E().setTidyMarks(E().getTidyMarks().filter((x) => x.id !== id)); return false; }
    E().change({ text: t.slice(0, m.start) + m.was + t.slice(m.end), kind: 'tidy', sel: { start: m.start + m.was.length, end: m.start + m.was.length } });
    E().setTidyMarks(E().getTidyMarks().filter((x) => x.id !== id));
    return true;
  };

  // "Tidy with AI": grammar and typos by Gemini, minimal edits only. scope: 'draft' (default) or
  // 'selection'. Never runs by itself. One undo step; every change is marked, and a click on a mark
  // puts the original back. → the number of changes, or null when nothing ran.
  api.aiPass = async function (scope) {
    if (busy) return null;
    const ed = E();
    const app = TDW.App;
    if (!ed.getText().trim()) { toast('Nothing to tidy yet.'); return null; }
    if (app && app.backspaceOff && app.state.mode === 'write' && app.backspaceOff(app.state.draft)) { toast('Tidy changes words, so it waits while No backspace is on.'); return null; }
    if (TDW.AI.status() === 'none' && !TDW.mockAI) {
      toast('Add your Gemini key in Settings to tidy with AI.', { label: 'Settings', run: () => app.openSettings('ai') });
      return null;
    }
    wire();
    const sel = ed.getSelection();
    const part = scope === 'selection' && sel.end > sel.start ? sel : { start: 0, end: ed.getText().length };
    const sent = ed.getText().slice(part.start, part.end);
    busy = true;
    toast('Tidying…');
    try {
      const out = await TDW.AI.tidy({ text: sent });
      const text = ed.getText();
      const ann = ed.getAnnotations();
      const list = checkEdits(text, out.edits, { ghosts: ann.ghosts })
        .filter((f) => scope !== 'selection' || (f.start >= part.start && f.end <= part.end));
      if (!list.length) { toast('Nothing needed fixing.'); return 0; }
      let t = text, a = ann;
      for (const f of list.slice().reverse()) {
        const next = t.slice(0, f.start) + f.to + t.slice(f.end);
        a = Marks.applyChange(a, t, next);
        t = next;
      }
      if (!ed.change({ text: t, ann: a, kind: 'tidy' })) return 0;
      let d = 0;
      const marks = list.map((f) => {
        const mk = { start: f.start + d, end: f.start + d + f.to.length, type: 'ai', id: Marks.newId('t'), was: f.from, to: f.to };
        d += f.to.length - (f.end - f.start);
        return mk;
      });
      ed.setTidyMarks(marks);
      toast('Fixed ' + list.length + (list.length === 1 ? ' thing' : ' things'), { label: 'Undo', run: () => ed.undo() });
      return list.length;
    } catch (err) {
      if (!err || err.code !== 'cancelled') toast(TDW.AI.errorMessage(err));
      return null;
    } finally {
      busy = false;
    }
  };

  return api;
});

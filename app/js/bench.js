/* The bench: a quiet row under the page with what you reach for while a draft is open. Where it
   is going (the format), Review, the Lab's checks, Trim, a challenge, and posting it. Icons
   only. Every one works like a switch: pressed again, it puts away what it opened (its menu, the
   review, a Lab check, Trim). It steps back while you type, and Settings → Look (or its own ×)
   puts it away. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { UI, Formats } = TDW;
  const { el, icon } = UI;
  const app = () => TDW.App;

  let bar = null, fmtBtn = null, reviewBtn = null, diceBtn = null, labBtn = null, trimBtn = null;

  function tool(ic, name, run) {
    const b = el('button', { type: 'button', class: 'bench-btn', 'aria-label': name, 'aria-haspopup': run.menu ? 'menu' : null }, icon(ic));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => run(b));
    return b;
  }
  const up = { align: 'start' };
  const menuOf = (fn) => Object.assign(fn, { menu: true });

  const formatMenu = menuOf((b) => {
    const cur = Formats.get(app().state.draft.format).key;
    UI.menu(b, Formats.LIST.map((f) => ({ label: f.label, value: f.key, checked: f.key === cur })), (it) => { app().setFormat(it.value); }, null, null, up);
  });

  // A Lab check or Trim on the page: its button ends it. Otherwise it opens its menu.
  const labKind = () => (TDW.Lab && TDW.Lab.isRunning() ? TDW.Lab.kind() : null);
  const labMenu = menuOf((b) => {
    const L = TDW.Lab;
    if (labKind() && labKind() !== 'trim') { UI.closeMenu(); L.done(); return; }
    UI.menu(b, L.ITEMS.map((it) => ({ label: it.label, value: it.id })), (it) => { L.run(it.value); }, null, null, up);
  });

  const trimMenu = menuOf((b) => {
    const L = TDW.Lab;
    if (labKind() === 'trim') { UI.closeMenu(); L.done(); return; }
    UI.menu(b, L.LEVELS.map((lv, k) => (k ? { label: lv.label, note: '~' + lv.pct + '%', value: k } : null)).filter(Boolean), (it) => { L.trim(it.value); }, null, null, up);
  });

  const challengeMenu = menuOf((b) => {
    const C = TDW.Challenges;
    const info = C.info();
    const items = [
      { label: 'Roll', value: 'roll', icon: 'dice', keys: TDW.Keys.combo('roll') },
      { label: 'Roll a combo', value: 'combo', icon: 'dice' },
      { label: 'Today: ' + info.daily, value: 'daily', icon: 'target' },
      { label: 'Pick one', value: 'pick', icon: 'search' },
      { type: 'sep' }
    ].concat(info.levels.map((l) => ({ label: l.name, value: 'level:' + l.id, checked: l.on })));
    if (info.running) items.push({ type: 'sep' }, { label: info.met ? 'Clear it' : 'Give up', value: 'finish', icon: 'close' });
    UI.menu(b, items, (it, btn) => {
      const v = it.value;
      if (v === 'roll') C.roll();
      else if (v === 'combo') C.combo();
      else if (v === 'daily') C.daily();
      else if (v === 'pick') TDW.Palette.open({ page: 'challenges' });
      else if (v === 'finish') C.finish();
      else if (v.startsWith('level:')) {
        C.setLevel(v.slice(6));
        for (const x of btn.parentNode.querySelectorAll('[role="menuitemcheckbox"]')) x.setAttribute('aria-checked', String(x === btn));
        return true;
      }
    }, null, null, up);
  });

  const postMenu = menuOf((b) => {
    const D = TDW.Desk;
    UI.menu(b, [
      { label: 'Post to X', value: 'x', icon: 'x' },
      { label: 'Post to Threads', value: 'threads', icon: 'at' },
      { label: 'Post to LinkedIn', value: 'linkedin', icon: 'linkedin' },
      { type: 'sep' },
      { label: 'Save as Markdown', value: 'save', icon: 'download' }
    ], (it) => { if (it.value === 'save') D.save(); else D.postTo(it.value); }, null, null, up);
  });

  function hide() {
    app().updateSettings({ bench: false });
    UI.toast('Bench hidden', { label: 'Undo', run: () => app().updateSettings({ bench: true }) });
  }

  function build() {
    fmtBtn = el('button', { type: 'button', class: 'bench-format', 'aria-haspopup': 'menu' }, el('span'), icon('chevUp'));
    fmtBtn.addEventListener('mousedown', (e) => e.preventDefault());
    fmtBtn.addEventListener('click', () => formatMenu(fmtBtn));
    reviewBtn = tool('pencil', 'Review', () => app().toggleLens());
    labBtn = tool('flask', 'The Lab', labMenu);
    trimBtn = tool('scissors', 'Trim', trimMenu);
    diceBtn = tool('dice', 'Challenge', challengeMenu);
    const x = el('button', { type: 'button', class: 'bench-btn bench-x', 'aria-label': 'Hide the bench' }, icon('close'));
    x.addEventListener('mousedown', (e) => e.preventDefault());
    x.addEventListener('click', hide);
    bar = el('div', { id: 'bench', class: 'bench', role: 'toolbar', 'aria-label': 'Bench' },
      fmtBtn, el('span', { class: 'bench-sep', 'aria-hidden': 'true' }),
      reviewBtn, labBtn, trimBtn, diceBtn, tool('send', 'Post', postMenu), x);
    document.body.append(bar);
  }

  function render() {
    if (!bar) return;
    const st = app().state;
    bar.hidden = st.settings.bench === false || !st.draft;
    if (bar.hidden) return;
    fmtBtn.firstChild.textContent = Formats.get(st.draft.format).label;
    reviewBtn.classList.toggle('is-on', st.mode === 'edit');
    reviewBtn.setAttribute('aria-pressed', String(st.mode === 'edit'));
    const lab = labKind();
    labBtn.classList.toggle('is-on', !!lab && lab !== 'trim');
    trimBtn.classList.toggle('is-on', lab === 'trim');
    const info = TDW.Challenges && TDW.Challenges.info ? TDW.Challenges.info() : null;
    diceBtn.classList.toggle('is-on', !!(info && info.running));
  }

  TDW.Bench = {
    init() { build(); },
    load() { render(); },
    reload() { render(); },
    onMode() { render(); },
    render,
    dice: () => diceBtn
  };
})();

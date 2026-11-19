/* The drafts switcher (under the title in the spine) and Settings: a window with a sidebar of
   sections, each setting a row in a rounded group with its control inside the row, and a "?"
   (help.js) where a setting needs a word. On a phone it fills the screen: a list of sections,
   and a tap pushes one in. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { el, icon, toast, relTime, segmented, toggle, device, kbd, present, dismiss } = TDW.UI;
  const { Store, Account } = TDW;
  const app = () => TDW.App;
  const $ = (id) => document.getElementById(id);
  const help = (content, label) => (TDW.Help ? TDW.Help.button(content, { label }) : null);

  const SOUNDS = [['typewriter', 'Typewriter'], ['soft', 'Soft keys'], ['off', 'Off']];
  const KINDS = [['spelling', 'Spelling'], ['veryHard', 'Very hard sentences'], ['hard', 'Hard sentences'], ['complex', 'Wordy phrases'], ['passive', 'Passive voice'], ['adverb', 'Adverbs'], ['qualifier', 'Weakeners']];
  const SITE = 'https://cristianbagrin.com/';
  const MAIL = 'mailto:chris@cristianbagrin.com?subject=Ten%20Dollar%20Words';

  let settingsDlg = null;
  let aiStatus = { text: '', error: false };
  let accountRefresh = null;
  let section = 'account';
  let lastBlur = 0; // when a field in Settings last lost focus (see guardTaps)

  /* ---------- Drafts: the sidebar lives in drafts.js ---------- */
  const renderDraftList = () => TDW.Drafts.render();
  const openDrafts = () => TDW.Drafts.open();
  const newDraft = () => TDW.Drafts.newDraft();
  // Settings never opens over the drafts sheet; a docked sidebar stays where it is.
  const closeDraftsSheet = () => { const d = $('drafts-dialog'); if (d && d.open) dismiss(d); };

  /* ---------- Section icons: 24px, the sidebar's own ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  const GLYPHS = {
    account: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c1.2-3.3 3.9-5 7-5s5.8 1.7 7 5"/>',
    writing: '<path d="M4.5 19.5l1.2-4.6L15.6 5a2 2 0 012.8 0l.6.6a2 2 0 010 2.8l-9.9 9.9z"/><path d="M13.8 6.8l3.4 3.4"/>',
    review: '<path d="M4 7h10M4 12h7M4 17h9"/><path d="M15.5 15.5l2 2 3.5-4.5"/>',
    tidy: '<path d="M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/>',
    look: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16z" fill="currentColor"/>',
    sound: '<path d="M4.5 9.5v5h3l4.5 4v-13l-4.5 4z"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11"/>',
    ai: '<path d="M12 3.5c.6 4.4 4.1 7.9 8.5 8.5-4.4.6-7.9 4.1-8.5 8.5-.6-4.4-4.1-7.9-8.5-8.5 4.4-.6 7.9-4.1 8.5-8.5z"/>',
    shortcuts: '<rect x="3" y="6" width="18" height="12" rx="3"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/>',
    about: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
    cloud: '<path d="M7.5 18.5h9.5a4 4 0 00.4-8 5.5 5.5 0 00-10.6-1A4.5 4.5 0 007.5 18.5z"/>',
    refresh: '<path d="M19 12a7 7 0 01-12.2 4.7M5 12a7 7 0 0112.2-4.7"/><path d="M17.5 3.5v4h-4M6.5 20.5v-4h4"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
    out: '<path d="M9 6h9v9M18 6L6.5 17.5"/>'
  };
  function glyph(name, cls) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'st-glyph' + (cls ? ' ' + cls : ''));
    s.innerHTML = GLYPHS[name];
    return s;
  }

  const SECTIONS = [
    ['account', 'Account'], ['writing', 'Writing'], ['review', 'Review'], ['tidy', 'Tidy'], ['look', 'Look'],
    ['sound', 'Sound'], ['ai', 'AI'], ['shortcuts', 'Shortcuts'], ['about', 'About']
  ];
  // Older names other parts of the app still open.
  const ALIAS = { notion: 'account', budget: 'writing' };
  const known = (k) => SECTIONS.some((x) => x[0] === k);

  /* ---------- Building blocks ---------- */
  const update = (patch) => app().updateSettings(patch);
  const settings = () => app().state.settings;
  const rid = () => 'st-' + Math.random().toString(36).slice(2, 8);

  // A setting: its name (and "?") on the left, its control on the right. stack: the control
  // goes under the name, full width.
  function row(label, control, o) {
    const opts = o || {};
    const id = control && control.id ? control.id : null;
    return el('div', { class: 'st-row' + (opts.stack ? ' is-stack' : '') + (opts.class ? ' ' + opts.class : '') },
      el('div', { class: 'st-lab' }, el(id ? 'label' : 'span', { for: id, text: label }), opts.help ? help(opts.help, 'About ' + label.toLowerCase()) : null),
      control ? el('div', { class: 'st-ctl' }, control) : null);
  }
  function switchRow(label, checked, onChange, helpText) {
    return row(label, toggle({ checked, onChange, id: rid() }), { help: helpText });
  }
  // A row that goes somewhere or does one thing.
  function goRow(label, onclick, o) {
    const opts = o || {};
    const kids = [el('span', { class: 'st-go-label', text: label }), opts.end || null, opts.href ? glyph('out', 'st-out') : null];
    return opts.href
      ? el('a', { class: 'st-row st-go' + (opts.danger ? ' is-danger' : ''), href: opts.href, target: '_blank', rel: 'noopener' }, kids)
      : el('button', { type: 'button', class: 'st-row st-go' + (opts.danger ? ' is-danger' : ''), 'aria-expanded': opts.expanded == null ? null : String(opts.expanded), onclick }, kids);
  }
  const group = (...rows) => el('div', { class: 'st-group' }, rows.flat().filter(Boolean));
  const pad = (...kids) => el('div', { class: 'st-group is-pad' }, kids.flat().filter(Boolean));
  const caption = (text) => el('h4', { class: 'st-caption', text });

  // − value +, with the value typed in place. format/parse turn the number into what shows.
  function stepper(o) {
    const id = rid();
    let value = o.value;
    const input = el('input', { type: 'text', id, inputmode: o.decimal ? 'decimal' : 'numeric', class: 'st-step-input', 'aria-label': o.label, autocomplete: 'off', spellcheck: 'false' });
    const minus = el('button', { type: 'button', class: 'st-step-btn', 'aria-label': 'Less', text: '−' });
    const plus = el('button', { type: 'button', class: 'st-step-btn', 'aria-label': 'More', text: '+' });
    const clamp = (n) => Math.max(o.min, Math.min(o.max, n));
    const show = () => {
      input.value = o.format ? o.format(value) : String(value);
      input.style.width = Math.max(2, input.value.length + 0.5) + 'ch';
      minus.disabled = value <= o.min; plus.disabled = value >= o.max;
    };
    const set = (n) => { n = clamp(n); if (n !== value) { value = n; o.onChange(n); } show(); };
    minus.addEventListener('click', () => set(o.down ? o.down(value) : value - o.step));
    plus.addEventListener('click', () => set(o.up ? o.up(value) : value + o.step));
    input.addEventListener('input', () => { input.style.width = Math.max(2, input.value.length + 0.5) + 'ch'; });
    input.addEventListener('change', () => { const n = (o.parse || Number)(input.value.replace(/[^\d.-]/g, '')); if (Number.isFinite(n)) set(n); else show(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); (e.key === 'ArrowUp' ? plus : minus).click(); }
    });
    show();
    const box = el('div', { class: 'st-stepper' }, minus, el('label', { class: 'st-step-val', for: id }, o.prefix ? el('span', { class: 'st-step-unit', text: o.prefix }) : null, input, o.unit ? el('span', { class: 'st-step-unit', text: o.unit }) : null), plus);
    box.id = id; // so the row's name labels the field
    return box;
  }

  /* ---------- Account ---------- */
  function accountSection() {
    const sec = el('div', { id: 'set-account' });
    const status = el('p', { class: 'st-status', role: 'status' });
    // mode: 'in' | 'up' | 'forgot'; step: what signing in asks for next (see Account.signIn).
    let mode = 'in', step = null, open = null, busy = false, lostOpen = false;
    const say = (text, error) => { status.textContent = text || ''; status.classList.toggle('is-error', !!error); };
    const input = (type, id, autocomplete, extra) => el('input', Object.assign({ type, id, name: id, autocomplete, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }, extra || {}));
    const field = (label, inp) => el('div', { class: 'st-field' }, el('label', { for: inp.id, text: label }), inp);
    async function run(btn, label, fn) {
      if (busy) return;
      busy = true; btn.disabled = true; say(label);
      try { await fn(); say(''); } catch (e) { say((e && e.message) || 'Something went wrong.', true); } finally { busy = false; btn.disabled = false; }
    }
    const site = () => Account.accountSite() || 'https://account.cristianbagrin.com';
    const form = (...kids) => { const f = el('form', { class: 'st-form', method: 'post', action: '#' }, kids.flat().filter(Boolean)); f.noValidate = true; return f; };
    const actions = (...kids) => el('div', { class: 'st-actions' }, kids.flat().filter(Boolean));

    // A sign-in step finished: done, or something more to ask.
    function after(res, up) {
      if (res && res.need) { step = res.need; lostOpen = false; render(); const f = sec.querySelector('input:not([hidden])'); if (f) f.focus(); return; }
      step = null; mode = 'in';
      render(); refreshSettings(); app().syncChanged();
      toast(up ? 'Account ready' : res && res.covered ? 'Signed in. Your account’s recovery key covers Ten Dollar Words now' : 'Signed in');
      if (Account.state().recoveryKey) showRecoveryKey();
    }

    function signedOutView() {
      if (step) return stepView();
      const email = input('email', 'acct-email', 'username', { inputmode: 'email', value: Account.lastEmail(), placeholder: 'Email', 'aria-label': 'Email', enterkeyhint: 'next' });
      if (mode === 'forgot') return forgotView(email);
      const up = mode === 'up';
      const pw = input('password', 'acct-password', up ? 'new-password' : 'current-password', { minlength: '8', placeholder: up ? 'New password, 8 characters or more' : 'Password', 'aria-label': 'Password', enterkeyhint: 'go' });
      const go = el('button', { type: 'submit', class: 'btn st-primary', text: up ? 'Create account' : 'Sign in' });
      const other = el('button', { type: 'button', class: 'btn-outline', text: up ? 'I have an account' : 'Create account',
        onclick: () => { mode = up ? 'in' : 'up'; say(''); const typed = email.value; render(); const e = $('acct-email'); if (e) { e.value = typed; (typed ? $('acct-password') : e).focus(); } } });
      const forgot = up ? null : el('button', { type: 'button', class: 'link st-forgot', text: 'Forgot password?', onclick: () => { mode = 'forgot'; say(''); render(); } });
      const f = form(el('div', { class: 'st-fields' }, email, pw), actions(go, other, forgot));
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!email.value.trim()) { email.focus(); return; }
        if (!pw.value) { pw.focus(); return; }
        run(go, up ? 'Creating your account…' : 'Signing in…', async () => {
          after(up ? await Account.signUp(email.value, pw.value) : await Account.signIn(email.value, pw.value), up);
        });
      });
      return [pad(
        el('div', { class: 'st-who' },
          el('span', { class: 'st-disc' }, glyph('cloud')),
          el('div', { class: 'st-who-text' }, el('h3', { text: up ? 'Make your account' : 'Sync your writing' }), el('p', { text: 'Settings, key and dictionary on every device.' })),
          help(['Your cristianbagrin.com account: the same one as Chinese Brain and Money in Order.', 'Everything is encrypted on this device before it syncs. Without an account, everything stays in this browser.'], 'About accounts')),
        f, status)];
    }

    function forgotView(email) {
      const go = el('button', { type: 'submit', class: 'btn st-primary', text: 'Email me a link' });
      const f = form(el('div', { class: 'st-fields' }, email),
        actions(go, el('button', { type: 'button', class: 'btn-outline', text: 'Back', onclick: () => { mode = 'in'; say(''); render(); } })));
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!email.value.trim()) { email.focus(); return; }
        run(go, 'Sending…', async () => {
          await Account.forgot(email.value);
          mode = 'in'; render();
          say('If that email has an account, a link is on its way. Set a new password there, then sign in here with it and your recovery key.');
        });
      });
      return [pad(
        el('div', { class: 'st-who' },
          el('span', { class: 'st-disc' }, glyph('account')),
          el('div', { class: 'st-who-text' }, el('h3', { text: 'Forgot your password?' }), el('p', { text: 'We’ll email you a link to set a new one.' })),
          help('Your synced data stays locked until you sign in with the new password and your recovery key, or on a device that’s still signed in.', 'About a new password')),
        f, status)];
    }

    // What signing in asks for next.
    function stepView() {
      const back = el('button', { type: 'button', class: 'btn-outline', text: 'Cancel', onclick: () => { Account.cancel(); step = null; say(''); render(); } });
      const ask = (title, note, fld, go, extra) => {
        const f = form(fld, actions(go, extra || back));
        return [pad(el('div', { class: 'st-who' }, el('span', { class: 'st-disc' }, glyph('account')),
          el('div', { class: 'st-who-text' }, el('h3', { text: title }), el('p', { text: note }))), f, status), f];
      };
      if (step === 'recovery' || step === 'old_recovery') {
        const old = step === 'old_recovery';
        const key = input('text', 'acct-recovery', 'off', { class: 'st-recovery', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX' });
        const go = el('button', { type: 'submit', class: 'btn st-primary', text: 'Unlock' });
        const lost = el('button', { type: 'button', class: 'link st-forgot', text: 'Lost it?', 'aria-expanded': String(lostOpen), onclick: () => { lostOpen = !lostOpen; render(); } });
        const [box, f] = ask('Your recovery key', old ? 'Your synced data still uses the recovery key Ten Dollar Words gave you before. Enter it once.' : 'Your password changed. Enter your cristianbagrin.com recovery key to unlock your synced data.',
          field('Recovery key', key), go, [back, lost]);
        f.addEventListener('submit', (e) => {
          e.preventDefault();
          if (!key.value.trim()) { key.focus(); return; }
          run(go, 'Unlocking…', async () => after(await Account.answer({ recoveryKey: key.value })));
        });
        const nodes = [box];
        if (lostOpen) {
          const fresh = el('button', { type: 'button', class: 'btn btn-danger', text: 'Start fresh' });
          fresh.addEventListener('click', () => run(fresh, 'Making new keys…', async () => after(await Account.answer({ startFresh: true }))));
          nodes.push(pad(el('p', { class: 'st-sub-text', text: 'Without the recovery key or a signed-in device, synced data can’t be opened. Your data on this device stays.' }),
            el('p', { class: 'st-sub-text is-quiet', text: old ? 'Starting fresh makes new keys for Ten Dollar Words and syncs this device from here on. What it synced before stays locked.'
              : 'Starting fresh makes new keys for your whole account. What was synced before stays locked, in every app, except on devices still signed in.' }), actions(fresh)));
        }
        return nodes;
      }
      if (step === 'account_password') {
        const pw = input('password', 'acct-shared', 'current-password');
        const go = el('button', { type: 'submit', class: 'btn st-primary', text: 'Continue' });
        const [box, f] = ask('One more password', 'Your Ten Dollar Words account is moving to cristianbagrin.com, where this email already has an account with another password. Enter that password to finish.', field('cristianbagrin.com password', pw), go);
        f.addEventListener('submit', (e) => {
          e.preventDefault();
          if (!pw.value) { pw.focus(); return; }
          run(go, 'Signing in…', async () => after(await Account.answer({ accountPassword: pw.value })));
        });
        return [box];
      }
      // 'old_password'
      const pw = input('password', 'acct-old', 'current-password');
      const go = el('button', { type: 'submit', class: 'btn st-primary', text: 'Bring it over' });
      const skip = el('button', { type: 'button', class: 'btn-outline', text: 'Skip for now' });
      skip.addEventListener('click', () => run(skip, 'Finishing…', async () => after(await Account.answer({ skipOld: true }))));
      const [box, f] = ask('Your older account', 'This email also has an older Ten Dollar Words account, with a different password. Enter that password to bring its settings over.', field('Old Ten Dollar Words password', pw), go, skip);
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!pw.value) { pw.focus(); return; }
        run(go, 'Bringing it over…', async () => after(await Account.answer({ oldPassword: pw.value })));
      });
      return [box];
    }

    // The sync line under the email: a dot and a few words.
    const syncLine = el('p', { class: 'st-sync', role: 'status' });
    function drawSync() {
      const st = Account.state();
      let text = st.at ? 'Synced ' + relTime(st.at) : 'Synced', state = 'ok';
      if (st.status === 'syncing') { text = 'Saving…'; state = 'busy'; }
      else if (st.status === 'offline') { text = 'Offline. Changes wait until you’re back.'; state = 'err'; }
      else if (st.status === 'error') { text = st.message || 'Sync stopped.'; state = 'err'; }
      else if (st.reauth) { text = 'Sign in once more to keep syncing.'; state = 'err'; }
      syncLine.textContent = text;
      syncLine.dataset.state = state;
    }

    function signedInView() {
      const st = Account.state();
      const toggleOpen = (k) => () => { open = open === k ? null : k; say(''); render(); };
      const who = el('input', { type: 'email', name: 'acct-user', autocomplete: 'username', value: st.email, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
      const syncNow = el('button', { type: 'button', class: 'btn-icon st-round', 'aria-label': 'Sync now' }, glyph('refresh'));
      syncNow.addEventListener('click', async () => {
        syncNow.classList.add('is-spinning');
        try { await Account.pull(true); } catch (_) { /* the line says so */ }
        setTimeout(() => syncNow.classList.remove('is-spinning'), 500);
        drawSync();
      });
      drawSync();
      const nodes = [pad(el('div', { class: 'st-who' },
        el('a', { class: 'st-who-link', href: site(), target: '_blank', rel: 'noopener' },
          el('span', { class: 'st-disc is-initial', 'aria-hidden': 'true', text: (st.email || '?').trim().charAt(0).toUpperCase() }),
          el('div', { class: 'st-who-text' }, el('h3', {}, el('span', { text: st.email }), glyph('out', 'st-out')), syncLine)),
        syncNow))];
      const passwordAsk = (title, text, id, label, fn) => {
        const pw = input('password', id, 'current-password');
        const go = el('button', { type: 'submit', class: 'btn st-primary', text: label });
        const f = form(who.cloneNode(), field('Password', pw), actions(go));
        f.addEventListener('submit', (e) => { e.preventDefault(); if (!pw.value) { pw.focus(); return; } run(go, label + '…', async () => after(await fn(pw.value))); });
        return pad(el('div', { class: 'st-who-text' }, el('h3', { text: title }), el('p', { text })), f);
      };
      if (st.switchKeys) nodes.push(passwordAsk('One password, once', 'Ten Dollar Words now uses your cristianbagrin.com account’s recovery key. Enter your password once to switch.', 'acct-switch', 'Switch', Account.reauth));
      if (st.reauth) nodes.push(passwordAsk('Your password changed', 'This browser keeps syncing. Sign in once to keep its keys up to date.', 'acct-reauth', 'Sign in', Account.reauth));

      const out = goRow('Sign out', null);
      out.addEventListener('click', () => run(out, 'Signing out…', async () => { await Account.signOut(); render(); refreshSettings(); app().syncChanged(); toast('Signed out'); }));
      const more = [];
      const cancel = el('button', { type: 'button', class: 'btn-outline', text: 'Cancel', onclick: () => { open = null; say(''); render(); } });
      if (open === 'recovery') {
        const go = el('button', { type: 'button', class: 'btn st-primary', text: 'Make a new one' });
        go.addEventListener('click', () => run(go, 'Making a new key…', async () => { await Account.newRecoveryKey(); open = null; render(); showRecoveryKey(); }));
        more.push(pad(el('p', { class: 'st-sub-text', text: 'One recovery key unlocks your synced data, in every app, if you forget your password. A new one stops the old one working everywhere.' }), actions(go, cancel)));
      } else if (open === 'password') {
        const cur = input('password', 'acct-current', 'current-password');
        const next = input('password', 'acct-new', 'new-password', { minlength: '8' });
        const go = el('button', { type: 'submit', class: 'btn st-primary', text: 'Change password' });
        const f = form(who.cloneNode(), field('Current password', cur), field('New password, 8 characters or more', next), actions(go, cancel));
        f.addEventListener('submit', (e) => { e.preventDefault(); run(go, 'Changing your password…', async () => { await Account.changePassword(cur.value, next.value); open = null; render(); toast('Password changed'); }); });
        more.push(pad(f, el('p', { class: 'st-sub-text is-quiet', text: 'It changes for your whole cristianbagrin.com account. Your other devices sign in again.' })));
      } else if (open === 'remove') {
        const go = el('button', { type: 'button', class: 'btn btn-danger', text: 'Remove synced data' });
        go.addEventListener('click', () => run(go, 'Removing…', async () => { await Account.removeSyncedData(); open = null; render(); refreshSettings(); app().syncChanged(); toast('Synced data removed'); }));
        more.push(pad(el('p', { class: 'st-sub-text', text: 'This removes what Ten Dollar Words keeps in your account and signs every browser out of it. Each browser keeps its settings and drafts. Your cristianbagrin.com account stays.' }), actions(go, cancel)));
      }
      nodes.push(group(
        goRow('Recovery key', toggleOpen('recovery'), { expanded: open === 'recovery' }),
        st.reauth ? null : goRow('Change password', toggleOpen('password'), { expanded: open === 'password' }),
        out,
        goRow('Remove synced data', toggleOpen('remove'), { danger: true, expanded: open === 'remove' })), ...more, status);
      return nodes;
    }

    let shown = null;
    function render() {
      shown = Account.state().signedIn;
      // Signed in, a step can still be open: switching to the account's keys may ask for the recovery key.
      sec.replaceChildren(...[...(shown ? (step ? stepView() : signedInView()) : signedOutView()), notionImport()].filter(Boolean));
      wireFields(sec);
    }
    render();
    accountRefresh = () => {
      if (busy) return;
      if (Account.state().signedIn !== shown) render();
      else if (shown) drawSync();
    };
    return sec;
  }

  /* ---------- Import from Notion (notion-import.js does the work) ---------- */
  let importing = null; // { text, frac } while an import runs, so a redraw keeps showing it
  function notionImport() {
    const NI = TDW.NotionImport;
    if (!NI || typeof NI.run !== 'function') return null;
    const bar = el('span', { class: 'st-progress', hidden: !importing }, el('span', { class: 'st-progress-fill' }));
    const note = el('p', { class: 'st-row-status', role: 'status' });
    const go = el('button', { type: 'button', class: 'btn-outline btn-sm', text: importing ? 'Importing…' : 'Import', disabled: !!importing });
    const box = group(el('div', { class: 'st-row is-wrap' },
      el('div', { class: 'st-lab' }, el('span', { text: 'Import from Notion' }),
        help('Every page in a Notion database becomes a draft here, with its text and properties. Your Notion pages stay as they are.', 'About importing from Notion')),
      el('div', { class: 'st-ctl' }, go), note, bar));
    const draw = () => {
      if (!box.isConnected && importing) return;
      bar.hidden = !importing || importing.frac == null;
      if (importing && importing.frac != null) bar.firstChild.style.transform = 'scaleX(' + Math.max(0.02, Math.min(1, importing.frac)) + ')';
      if (importing) note.textContent = importing.text || '';
    };
    // onProgress takes a fraction (0–1), a line of text, or { done, total, text }.
    const onProgress = (p) => {
      if (!importing) return;
      if (typeof p === 'number') importing.frac = p;
      else if (typeof p === 'string') importing.text = p;
      else if (p && typeof p === 'object') {
        if (p.total) importing.frac = (p.done || 0) / p.total;
        else if (typeof p.frac === 'number') importing.frac = p.frac;
        importing.text = p.text || p.message || (p.total ? (p.done || 0) + ' of ' + p.total : importing.text);
      }
      draw();
    };
    go.addEventListener('click', async () => {
      if (importing) return;
      importing = { text: 'Starting…', frac: null };
      go.disabled = true; go.textContent = 'Importing…'; note.classList.remove('is-error');
      draw();
      try {
        const res = await NI.run(onProgress);
        importing = null;
        const n = res && (typeof res === 'number' ? res : res.count != null ? res.count : res.imported);
        note.textContent = typeof n === 'number' ? 'Imported ' + n + (n === 1 ? ' draft.' : ' drafts.') : (res && res.message) || 'Done.';
        app().refreshPanel && app().refreshPanel();
      } catch (e) {
        importing = null;
        if (e && e.name === 'AbortError') note.textContent = '';
        else { note.textContent = (e && e.message) || 'The import stopped. Try again.'; note.classList.add('is-error'); }
      }
      bar.hidden = true;
      go.disabled = false; go.textContent = 'Import';
    });
    draw();
    return box;
  }

  /* ---------- Writing ---------- */
  function writingSection(s) {
    return [
      group(
        row('Budget for new drafts', stepper({ label: 'Budget for new drafts', value: s.defaultBudget, min: 10, max: 100000, step: 100, prefix: '$',
          format: (n) => n.toLocaleString('en-US'), parse: (t) => Math.round(Number(t) / 10) * 10,
          down: (n) => (n > 100 ? Math.ceil(n / 100) * 100 - 100 : n - 10), up: (n) => (n >= 100 ? Math.floor(n / 100) * 100 + 100 : n + 10),
          onChange: (n) => update({ defaultBudget: n }) }),
        { help: ['For Basic drafts. LinkedIn starts at $2,000, X at $500, Threads at $800, Substack at $8,000.', 'Each draft keeps its own: click the spend in the top right to change it.'] }),
        row('New drafts use', segmented({ label: 'New drafts use', value: TDW.Formats.get(s.defaultFormat).key, options: TDW.Formats.LIST.map((f) => ({ value: f.key, label: f.label })), onChange: (v) => update({ defaultFormat: v }) }), { class: 'has-seg' })),
      group(
        switchRow('No backspace while drafting', !!s.noBackspace, (on) => update({ noBackspace: on }),
          ['A draft whose status is Drafting turns the switch on by itself. The palette turns it on or off for any draft.']),
        switchRow('Show what each paragraph costs', !!s.paragraphCost, (on) => update({ paragraphCost: on }), 'In the gutter, above each paragraph. Off, the gutter shows only what is extra.'),
        switchRow('Keep the line you’re typing in the middle', !!s.typewriterScroll, (on) => update({ typewriterScroll: on }), 'While you write, not while you review.')),
      caption('Your dictionary'),
      group(el('div', { class: 'st-row is-stack' }, dictionaryField()))
    ];
  }

  function dictionaryField() {
    const box = el('div', { class: 'dict' });
    const render = () => {
      const words = settings().dictionary;
      box.replaceChildren(...(words.length
        ? words.map((w) => el('span', { class: 'dict-chip' }, w, el('button', { type: 'button', class: 'dict-x', 'aria-label': 'Remove ' + w, onclick: () => { app().removeWord(w); render(); } }, icon('close'))))
        : [el('p', { class: 'st-empty' }, 'Words you add from a spelling note land here.')]));
    };
    render();
    return box;
  }

  /* ---------- Review ---------- */
  function reviewSection(s) {
    const on = s.fixHighlights !== false;
    return [
      group(switchRow('Mark fixes when reviewing', on, (v) => { update({ fixHighlights: v }); refreshSettings(); }, 'Off, the review shows the grade and the spend, and no marks.')),
      on ? caption('Notes to show') : null,
      on ? group(KINDS.map(([k, label]) => switchRow(label, s.highlights[k] !== false, (v) => { const h = settings().highlights; h[k] = v; update({ highlights: h }); }))) : null
    ];
  }

  /* ---------- Tidy ---------- */
  function tidySection(s) {
    return [group(switchRow('Fix small mistakes as I type', s.tidy !== false, (on) => update({ tidy: on }),
      ['Typos with one clear fix, doubled words, “i”, capitals, spaces, a/an and doubled punctuation, as you leave the word or sentence.', 'A brief mark shows each fix; ' + TDW.UI.keys('⌘Z') + ' takes it back.']))];
  }

  /* ---------- Look ---------- */
  function lookSection(s) {
    const font = (label, family) => el('span', { style: 'font-family:' + family, text: label });
    const base = app().fontOf(s) === 'typewriter' ? 18.5 : 20;
    return [
      group(
        row('Theme', segmented({ label: 'Theme', value: app().themeSetting(s), options: [{ value: 'auto', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], onChange: (v) => update({ theme: v }) }), { class: 'has-seg' }),
        row('Font', segmented({ label: 'Font', value: app().fontOf(s), class: 'st-fonts', options: [{ value: 'serif', label: font('Source Serif', 'var(--font-serif)') }, { value: 'typewriter', label: font('Typewriter', 'var(--font-type)') }], onChange: (v) => { update({ pageFont: v }); refreshSettings(); } }), { class: 'has-seg' }),
        row('Text size', stepper({ label: 'Text size', value: Number(s.textSize) || 0, min: -2, max: 4, step: 1, unit: 'px', format: (n) => String(base + n), parse: (t) => Math.round(Number(t) - base), onChange: (n) => update({ textSize: n }) })),
        row('Review marks', segmented({ label: 'Review marks', value: s.marks === 'highlighter' ? 'highlighter' : 'pencil', options: [{ value: 'pencil', label: 'Pencil' }, { value: 'highlighter', label: 'Highlighter' }], onChange: (v) => update({ marks: v }) }),
          { class: 'has-seg', help: 'Pencil underlines what to fix. Highlighter washes it in a light color for each kind.' })),
      group(
        switchRow('The bench under the page', s.bench !== false, (on) => update({ bench: on }), 'Format, Review, the Lab, Trim, a challenge and Post, one press away.'),
        switchRow('Effects', s.effects !== false, (on) => update({ effects: on }), 'Cut words burst, Trim reads down the page, a challenge rolls and gets stamped.'))
    ];
  }

  /* ---------- Sound ---------- */
  function soundSection(s) {
    const test = () => { TDW.Sound.unlock(); ['key', 'key', 'space', 'key', 'enter'].forEach((k, i) => setTimeout(() => TDW.Sound.play(k), i * 90)); };
    const vol = el('input', { type: 'range', id: rid(), min: '0', max: '1', step: '0.05', value: String(s.volume), 'aria-label': 'Volume', class: 'st-range',
      oninput: () => TDW.Sound.setVolume(Number(vol.value)), onchange: () => { update({ volume: Number(vol.value) }); test(); } });
    const play = el('button', { type: 'button', class: 'btn-icon st-round', 'aria-label': 'Play the typing sound', onclick: test }, glyph('play'));
    return [group(
      row('Typing sound', segmented({ label: 'Typing sound', value: s.sound, options: SOUNDS.map(([value, label]) => ({ value, label })), onChange: (v) => { update({ sound: v }); if (v !== 'off') test(); refreshSettings(); } }),
        { class: 'has-seg', help: device.phone && device.apple ? 'Silent mode on your iPhone mutes these sounds.' : null }),
      s.sound === 'off' ? null : row('Volume', el('div', { class: 'st-inline' }, vol, play)),
      switchRow('Desk sounds', s.effectSounds !== false, (on) => { update({ effectSounds: on }); if (on) { TDW.Sound.unlock(); TDW.Sound.play('stamp'); } }, 'The pencil, the stamp and the till, for cuts, trims and challenges.'))];
  }

  /* ---------- AI ---------- */
  function aiSection() {
    const AI = TDW.AI;
    const keyInput = el('input', { type: 'password', id: rid(), autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Gemini API key', class: 'st-key' });
    const status = el('p', { class: 'st-row-status', role: 'status' });
    const modelSel = el('select', { id: rid(), 'aria-label': 'Model', class: 'st-select' });
    const modelRow = row('Model', modelSel, { help: 'Automatic uses the newest Flash model, checks weekly for a newer one, and falls back when Google is busy. A pinned model still falls back if it fails.' });
    const testBtn = el('button', { type: 'button', class: 'btn-outline', text: 'Check' });
    const remove = goRow('Remove key', () => { AI.disconnect(); aiStatus = { text: '', error: false }; showKey(); showStatus(); fillModels(); app().refreshPanel(); }, { danger: true });
    const removeGroup = group(remove);
    const short = (n) => String(n || '').replace(/^models\//, '');
    const showStatus = () => { status.textContent = aiStatus.text; status.classList.toggle('is-error', aiStatus.error); };
    const showKey = () => { const key = Store.getKey(); keyInput.value = ''; keyInput.placeholder = key ? 'Saved ••••' + key.slice(-4) : 'Paste your key'; };
    const fillModels = () => {
      const listing = AI.listing();
      const auto = Store.getModelMode() === 'auto';
      const current = Store.getModel();
      const best = AI.bestModel(listing) || current;
      const names = [...new Set([...AI.usableModels(listing), current].filter(Boolean))];
      modelSel.replaceChildren(el('option', { value: 'auto', text: 'Automatic' + (best ? ' (' + short(best) + ')' : '') }), ...names.map((n) => el('option', { value: n, text: short(n) })));
      modelSel.value = auto ? 'auto' : current;
      const hasKey = !!Store.getKey();
      modelRow.hidden = !hasKey;
      removeGroup.hidden = !hasKey;
    };
    modelSel.addEventListener('change', () => {
      if (modelSel.value === 'auto') AI.useAuto(); else AI.useModel(modelSel.value);
      aiStatus = { text: 'Using ' + short(Store.getModel()) + '.', error: false };
      showStatus(); fillModels();
    });
    const check = () => {
      if (!keyInput.value.trim() && !Store.getKey()) { keyInput.focus(); return; }
      testBtn.disabled = true;
      aiStatus = { text: 'Checking…', error: false };
      showStatus();
      AI.connect(keyInput.value).then((res) => {
        aiStatus = { text: 'Connected. Using ' + short(res.model) + '.', error: false };
      }, (err) => {
        aiStatus = { text: err && err.detail ? 'Something went wrong: ' + err.detail : AI.errorMessage(err), error: true };
      }).then(() => { testBtn.disabled = false; showKey(); showStatus(); fillModels(); app().refreshPanel(); });
    };
    testBtn.addEventListener('click', check);
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); check(); } });
    if (!aiStatus.text && Store.getKey() && Store.getModel()) aiStatus = { text: 'Connected. Using ' + short(Store.getModel()) + '.', error: false };
    showKey(); showStatus(); fillModels();
    const keyRow = el('div', { class: 'st-row is-wrap' },
      el('div', { class: 'st-lab' }, el('label', { for: keyInput.id, text: 'Gemini key' }),
        help([el('p', {}, 'Optional, with your own free key from Google: Ask AI, alternatives, the Lab and Trim. ', el('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener', text: 'Get a key' }), ', paste it here, then Check.'),
          Account.state().signedIn ? 'Only Google sees it. Your account keeps an encrypted copy for your other devices.' : 'It stays in this browser and only goes to Google.',
          'On Google’s free tier, Google may use what you send to improve its products. Keep private client work out, or use a paid key.'], 'About the Gemini key')),
      el('div', { class: 'st-ctl st-key-ctl' }, keyInput, testBtn), status);
    return [
      group(keyRow, modelRow),
      removeGroup,
      Store.getKey() ? null : el('a', { class: 'st-pill', href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'Get a free key', glyph('out', 'st-out'))
    ];
  }

  /* ---------- Shortcuts ---------- */
  function shortcutsSection() {
    const open = () => { dismiss(settingsDlg); setTimeout(() => TDW.Desk.toggleSheet(), 130); };
    const combo = TDW.Keys && TDW.Keys.combo ? TDW.Keys.combo('shortcuts') : '';
    if (device.phone) return [group(goRow('Typing shortcuts', open, { end: el('span', { class: 'st-go-note', text: '# - 1. [] > ---' }) }))];
    const changed = TDW.Keys && TDW.Keys.custom ? Object.keys(TDW.Keys.custom()).length : 0;
    return [group(
      goRow('See and change shortcuts', open, { end: combo ? kbd(combo) : null }),
      changed ? el('div', { class: 'st-row' }, el('div', { class: 'st-lab' }, el('span', { text: changed === 1 ? 'One shortcut changed' : changed + ' shortcuts changed' })),
        el('div', { class: 'st-ctl' }, el('button', { type: 'button', class: 'btn-outline btn-sm', text: 'Reset all', onclick: () => {
          const before = TDW.Keys.custom(); TDW.Keys.reset(); update({ keys: TDW.Keys.custom() }); refreshSettings();
          toast('Shortcuts reset', { label: 'Undo', run: () => { TDW.Keys.load(before); update({ keys: TDW.Keys.custom() }); refreshSettings(); } });
        } }))) : null)];
  }

  /* ---------- About ---------- */
  function aboutSection() {
    return [
      pad(el('div', { class: 'st-chris' },
        el('a', { class: 'st-me', href: SITE, target: '_blank', rel: 'noopener' },
          el('img', { src: 'img/chris-avatar.webp', alt: '', width: '64', height: '64', decoding: 'async' }),
          el('div', { class: 'st-who-text' }, el('h3', { text: 'Made by Chris' }), el('p', { text: 'Ideas, bugs, questions go straight to him.' }))),
        el('a', { class: 'btn st-primary st-feedback', href: MAIL }, 'Give feedback'))),
      group(
        goRow('Save a backup', () => TDW.Desk.backup()),
        goRow('Open a backup', () => TDW.Desk.restore())),
      el('p', { class: 'st-version', text: 'Ten Dollar Words ' + app().APP_VERSION })
    ];
  }

  /* ---------- The recovery key ----------
     Shown once when an account's keys are made (and after "Make a new one"), and again on the
     next visit until you say you saved it. It can't be closed before that. */
  function showRecoveryKey() {
    const dlg = $('recovery-dialog');
    const st = Account.state();
    const key = st.recoveryKey;
    if (!dlg || !key) return;
    if (settingsDlg && settingsDlg.open) dismiss(settingsDlg);
    const copy = el('button', { type: 'button', class: 'btn-outline' }, icon('copy'), el('span', { text: 'Copy' }));
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(key); copy.lastChild.textContent = 'Copied'; setTimeout(() => { copy.lastChild.textContent = 'Copy'; }, 1600); } catch (_) { toast('Select the key and copy it'); }
    });
    const download = el('button', { type: 'button', class: 'btn-outline' }, icon('download'), el('span', { text: 'Download' }));
    download.addEventListener('click', () => {
      const text = ['cristianbagrin.com recovery key', '', key, '', 'Account: ' + st.email, 'Made: ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), '',
        'One key for your cristianbagrin.com account, in every app. If you forget your password, it’s the only way back into your synced data. Keep it somewhere safe, like a password manager.',
        'https://account.cristianbagrin.com', ''].join('\n');
      const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'cristianbagrin.com recovery key.txt' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    const go = el('button', { type: 'button', class: 'btn', text: 'Continue', disabled: true });
    const check = el('input', { type: 'checkbox', id: 'recovery-saved', onchange: () => { go.disabled = !check.checked; } });
    go.addEventListener('click', () => { Account.savedRecoveryKey(); dismiss(dlg); toast('Recovery key saved'); });
    dlg.replaceChildren(
      el('div', { class: 'recovery-card' },
        el('div', { class: 'recovery-seal', 'aria-hidden': 'true' }, keyGlyph()),
        el('h2', { id: 'recovery-title', text: 'Save your recovery key' }),
        el('p', { class: 'recovery-lede', text: 'One key for your cristianbagrin.com account, in every app. If you forget your password, it’s the only way back into your synced data. Keep it somewhere safe, like a password manager.' }),
        st.recoveryReplaced ? el('p', { class: 'recovery-lede', text: 'It replaces the recovery keys Ten Dollar Words and Money in Order gave you before.' }) : null,
        el('div', { class: 'recovery-slip' }, el('code', { class: 'recovery-key', 'aria-label': 'Recovery key ' + key.split('').join(' ') },
          ...key.split('-').flatMap((g, i) => (i === 4 ? [el('i', { class: 'recovery-break' }), el('span', { text: g })] : [el('span', { text: g })])))),
        el('div', { class: 'recovery-actions' }, copy, download),
        el('p', { class: 'recovery-fine', text: 'Lose your password, this key and every signed-in device, and the synced data can’t be opened by anyone, including us. What’s on each device stays.' }),
        el('div', { class: 'recovery-foot' },
          el('label', { class: 'recovery-check', for: 'recovery-saved' }, check, el('span', { text: 'I saved it' })), go)));
    // Not dismissable until saved: no Escape, no click outside.
    if (!dlg._guarded) {
      dlg._guarded = true;
      dlg._wired = true;
      dlg._onDismiss = () => TDW.Editor.focus();
      dlg.addEventListener('cancel', (e) => e.preventDefault());
      // Browsers close a modal on Escape anyway when the page hasn't been clicked yet: open it again.
      dlg.addEventListener('close', () => { if (Account.state().recoveryKey) setTimeout(showRecoveryKey); });
    }
    dlg.classList.add('no-sheet');
    present(dlg);
    copy.focus({ preventScroll: true });
  }

  function keyGlyph() {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '22'); svg.setAttribute('height', '22');
    svg.innerHTML = '<circle cx="8" cy="12" r="4.25" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12.25 12H21M18 12v3M15.5 12v2.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';
    return svg;
  }

  /* ---------- The window ---------- */
  function sectionNodes(k) {
    const s = settings();
    if (k === 'account') return [accountSection()];
    if (k === 'writing') return writingSection(s);
    if (k === 'review') return reviewSection(s);
    if (k === 'tidy') return tidySection(s);
    if (k === 'look') return lookSection(s);
    if (k === 'sound') return soundSection(s);
    if (k === 'ai') return aiSection();
    if (k === 'shortcuts') return shortcutsSection();
    return aboutSection();
  }

  // Fields in Settings: note when one loses focus (see guardTaps).
  function wireFields(root) {
    root.querySelectorAll('input, select, textarea').forEach((f) => { if (!f._stWired) { f._stWired = true; f.addEventListener('blur', () => { lastBlur = Date.now(); }); } });
  }

  const pushed = () => settingsDlg.classList.contains('is-pushed');
  function push(on) {
    settingsDlg.classList.toggle('is-pushed', on);
    const main = settingsDlg.querySelector('.st-main');
    const nav = settingsDlg.querySelector('.st-side');
    // On a phone the hidden half leaves the tab order and the screen reader.
    if (main && nav) { main.inert = !on && phoneLayout(); nav.inert = on && phoneLayout(); }
  }
  const phoneLayout = () => window.matchMedia('(max-width: 640px)').matches;

  function drawSettings(focusMain) {
    const nav = el('nav', { class: 'st-side', 'aria-label': 'Settings sections' },
      el('div', { class: 'st-side-head' }, el('h2', { id: 'settings-title', text: 'Settings' }),
        el('button', { type: 'button', class: 'btn-icon st-close st-close-list', 'aria-label': 'Close settings', onclick: () => dismiss(settingsDlg) }, icon('close'))),
      el('div', { class: 'st-toc' }, SECTIONS.map(([k, label]) => el('button', {
        type: 'button', class: 'st-toc-item', 'aria-current': String(k === section), dataset: { k },
        onclick: () => { const was = section; section = k; if (was !== k || !phoneLayout()) drawSettings(true); push(true); }
      }, glyph(k), el('span', { text: label }), el('span', { class: 'st-chev' }, icon('chevRight'))))));
    const label = SECTIONS.find((x) => x[0] === section)[1];
    const main = el('div', { class: 'st-main', role: 'region', 'aria-label': label },
      el('div', { class: 'st-main-head' },
        el('button', { type: 'button', class: 'st-back', 'aria-label': 'All settings', onclick: () => { push(false); const b = settingsDlg.querySelector('.st-toc-item[aria-current="true"]'); if (b) b.focus({ preventScroll: true }); } }, icon('chevLeft'), el('span', { text: 'Settings' })),
        el('h3', { text: label, tabindex: '-1' }),
        el('button', { type: 'button', class: 'btn-icon st-close', 'aria-label': 'Close settings', onclick: () => dismiss(settingsDlg) }, icon('close'))),
      el('div', { class: 'st-body' }, sectionNodes(section).filter(Boolean)));
    settingsDlg.replaceChildren(nav, main);
    wireFields(settingsDlg);
    push(pushed());
    if (focusMain) main.querySelector('h3').focus({ preventScroll: true });
  }

  function refreshSettings() {
    if (!settingsDlg || !settingsDlg.open) return;
    const active = document.activeElement;
    // Never redraw under a field in use, or a sign-in form that's been typed in or autofilled:
    // the password manager would fill fields that are gone.
    const typing = active && settingsDlg.contains(active) && active.matches('input, textarea, select');
    const filled = section === 'account' && [...settingsDlg.querySelectorAll('#set-account input:not([hidden])')].some((f) => f.value && f.id !== 'acct-email');
    if (typing || filled || Date.now() - lastBlur < 800) { if (accountRefresh) accountRefresh(); return; }
    const body = settingsDlg.querySelector('.st-body');
    const top = body ? body.scrollTop : 0;
    drawSettings(false);
    const next = settingsDlg.querySelector('.st-body');
    if (next) next.scrollTop = top;
  }

  function openSettings(sec) {
    closeDraftsSheet();
    const k = ALIAS[sec] || sec;
    if (known(k)) section = k;
    settingsDlg.classList.toggle('is-pushed', known(k));
    drawSettings(false);
    present(settingsDlg, { onDismiss: () => TDW.Editor.focus() });
    if (k === 'ai') { const f = settingsDlg.querySelector('.st-key'); if (f) f.focus({ preventScroll: true }); }
    else if (k === 'account' && !device.touch) { const f = $('acct-email'); if (f && !f.value) f.focus({ preventScroll: true }); }
    else if (!phoneLayout() || !pushed()) { const b = settingsDlg.querySelector('.st-toc-item[aria-current="true"]'); if (b) b.focus({ preventScroll: true }); }
  }

  /* iOS Passwords: its suggestions sit over the page, and a tap on one can arrive at the page as a
     click on the dialog's backdrop, which closes the window under the form being filled. Settings
     covers the screen on a phone (no backdrop to hit), and a backdrop click that comes while a
     field is focused, or just after one lost focus, is swallowed here before ui.js sees it. */
  function guardTaps(dlg) {
    dlg.addEventListener('click', (e) => {
      if (e.target !== dlg) return;
      const a = document.activeElement;
      if ((a && dlg.contains(a) && a.matches('input, select, textarea')) || Date.now() - lastBlur < 800) e.stopImmediatePropagation();
    }, true);
  }

  TDW.Dialogs = {
    init() {
      settingsDlg = $('settings-dialog');
      // Never a bottom sheet: on a phone it fills the screen (settings.css), with no drag to fight a form.
      settingsDlg.classList.add('no-sheet');
      guardTaps(settingsDlg);
      window.matchMedia('(max-width: 640px)').addEventListener('change', () => { if (settingsDlg.open) push(pushed()); });
      TDW.Drafts.init();
      Account.onChange(() => { if (settingsDlg.open && accountRefresh) accountRefresh(); });
      TDW.Keys.on('newDraft', () => newDraft());
      TDW.Keys.on('settings', () => openSettings());
      TDW.Keys.on('drafts', () => TDW.Drafts.toggle());
    },
    openDrafts, openSettings, refreshSettings, renderDraftList, newDraft, showRecoveryKey,
    isDraftsOpen() { return TDW.Drafts.isOpen(); }
  };
})();

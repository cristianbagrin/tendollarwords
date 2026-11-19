/* A "?" that opens a short note right where the question comes up. No hover: a press opens it,
   Esc or a press anywhere else closes it, and only one is open at a time.

     const q = TDW.Help.button('Typos with one clear fix, doubled words…', { label: 'About Tidy' });
     row.append(q);

   content: a string (one paragraph), a Node, or an array of strings and Nodes (each string a
   paragraph). The note grows out of its "?" (below it, above when there's no room), stays inside
   the window and follows it when the page scrolls. It uses the browser's popover (top layer, so
   it shows over dialogs and outside their overflow; Esc closes the note before the dialog), and
   falls back to a plain fixed box where popover isn't supported.

   TDW.Help.attach(trigger, content, opts): the same note on a button you made yourself.
   TDW.Help.close(): closes whichever note is open. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const GAP = 8, EDGE = 8;
  const native = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;
  let seq = 0;
  let open = null; // { pop, trigger } in the fallback

  const CSS = `
.help {
  position: relative; display: inline-grid; place-items: center; flex: none; vertical-align: middle;
  width: 20px; height: 20px; padding: 0; margin: 0 0 0 6px; border: 0; border-radius: 50%;
  background: var(--hover); color: var(--ink-2); font: 600 12px/1 var(--font-ui); letter-spacing: 0;
  cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  transition: background-color 120ms ease, color 120ms ease, transform var(--press-t, 70ms) ease-out;
}
.help::before { content: ""; position: absolute; inset: -10px; }
.help:active { transform: scale(.9); }
.help[aria-expanded="true"] { background: var(--blue); color: var(--paper); }
@media (hover: hover) and (pointer: fine) { .help:hover:not([aria-expanded="true"]) { background: var(--press); color: var(--ink); } }
.help-pop {
  position: fixed; inset: auto; top: 0; left: 0; z-index: 96; margin: 0; box-sizing: border-box;
  width: max-content; max-width: min(300px, calc(100vw - 16px)); padding: 11px 13px;
  border: 0; border-radius: var(--r, 13px); background: var(--paper); color: var(--ink); box-shadow: var(--shadow-lg);
  font: 400 13.5px/1.5 var(--font-ui); letter-spacing: -.003em; text-align: left; white-space: normal; overflow-wrap: break-word;
  opacity: 1; transform: none;
  transition: opacity 140ms cubic-bezier(.23, 1, .32, 1), transform 200ms cubic-bezier(.23, 1, .32, 1), overlay 200ms allow-discrete, display 200ms allow-discrete;
}
.help-pop:not(:popover-open):not(.is-open) { opacity: 0; transform: scale(.96); transition-duration: 90ms, 110ms, 110ms, 110ms; }
.help-pop.is-fallback:not(.is-open) { display: none; }
@starting-style { .help-pop:popover-open, .help-pop.is-open { opacity: 0; transform: scale(.96); } }
.help-pop p { margin: 0; }
.help-pop p + p, .help-pop p + ul, .help-pop ul + p { margin-top: 7px; }
.help-pop ul { margin: 0; padding-left: 18px; }
.help-pop b { font-weight: 600; }
.help-pop a { color: var(--blue); font-weight: 500; }
.help-pop kbd { height: 18px; }
:root[data-device="phone"] .help-pop { font-size: 15px; }
@media (prefers-reduced-motion: reduce) { .help-pop, .help-pop:not(:popover-open):not(.is-open) { transform: none; } }
`;
  function style() {
    if (document.getElementById('help-css')) return;
    const s = document.createElement('style');
    s.id = 'help-css';
    s.textContent = CSS;
    document.head.append(s);
  }

  function body(content) {
    const list = Array.isArray(content) ? content : [content];
    return list.filter((c) => c != null && c !== false).map((c) => {
      if (typeof c !== 'string') return c;
      const p = document.createElement('p');
      p.textContent = c;
      return p;
    });
  }

  function position(pop, trigger) {
    if (!trigger.isConnected) { close(); return; }
    const t = trigger.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const below = t.bottom + GAP + h <= vh - EDGE || t.top - GAP - h < EDGE;
    const top = below ? t.bottom + GAP : t.top - GAP - h;
    const left = Math.max(EDGE, Math.min(t.left - 10, vw - EDGE - w));
    pop.style.top = Math.round(top) + 'px';
    pop.style.left = Math.round(left) + 'px';
    pop.style.transformOrigin = Math.round(t.left + t.width / 2 - left) + 'px ' + (below ? '0' : h + 'px');
  }

  function attach(trigger, content, opts) {
    style();
    const o = opts || {};
    const id = 'help-' + (++seq);
    const pop = document.createElement('div');
    pop.className = 'help-pop' + (native ? '' : ' is-fallback');
    pop.id = id;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', o.label || trigger.getAttribute('aria-label') || 'Help');
    pop.append(...body(content));
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', id);
    let raf = 0;
    const place = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => position(pop, trigger)); };
    const watch = (on) => {
      trigger.setAttribute('aria-expanded', String(on));
      if (on) { addEventListener('scroll', place, { capture: true, passive: true }); addEventListener('resize', place); }
      else { removeEventListener('scroll', place, { capture: true }); removeEventListener('resize', place); }
    };
    // The note lives inside the dialog the "?" is in, so a modal never makes it inert.
    const mount = () => {
      const host = (trigger.closest && trigger.closest('dialog')) || document.body;
      if (pop.parentNode !== host) host.append(pop);
    };
    if (native) {
      pop.popover = 'auto';
      pop.addEventListener('beforetoggle', (e) => {
        watch(e.newState === 'open');
        if (e.newState === 'closed' && pop.contains(document.activeElement)) trigger.focus({ preventScroll: true });
      });
      // Shown and placed in one go, so it never paints in the wrong spot. A press on the "?" of an
      // open note closes it: light dismiss may already have, so look at how it was on pointerdown.
      let wasOpen = null;
      trigger.addEventListener('pointerdown', () => { wasOpen = pop.matches(':popover-open'); });
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = wasOpen == null ? pop.matches(':popover-open') : wasOpen;
        wasOpen = null;
        if (isOpen) { if (pop.matches(':popover-open')) pop.hidePopover(); return; }
        mount();
        pop.showPopover();
        position(pop, trigger);
      });
    } else {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (open && open.pop === pop) { close(); return; }
        close();
        mount();
        pop.classList.add('is-open');
        open = { pop, trigger, place, watch };
        watch(true);
        position(pop, trigger);
      });
    }
    trigger._helpPop = pop;
    return trigger;
  }

  function button(content, opts) {
    const o = opts || {};
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'help' + (o.class ? ' ' + o.class : '');
    b.setAttribute('aria-label', o.label || 'More about this');
    b.textContent = '?';
    return attach(b, content, o);
  }

  function close() {
    if (native) {
      document.querySelectorAll('.help-pop').forEach((p) => { try { if (p.matches(':popover-open')) p.hidePopover(); } catch (_) { /* gone */ } });
      return;
    }
    if (!open) return;
    const o = open;
    open = null;
    o.pop.classList.remove('is-open');
    o.watch(false);
    o.pop.remove();
  }

  if (!native) {
    document.addEventListener('pointerdown', (e) => {
      if (open && !open.pop.contains(e.target) && !open.trigger.contains(e.target)) close();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const t = open.trigger; close(); t.focus({ preventScroll: true }); }
    }, true);
  }

  TDW.Help = { button, attach, close };
})();

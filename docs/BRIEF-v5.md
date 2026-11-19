# Brief for anyone building 5.0

Read `docs/PLAN-v6.md` (the plan and its decisions), `README.md` (how the app works today) and
`docs/DESIGN.md` before you start.

- The app is plain HTML/CSS/JS, no build step: `app/js/*.js` are IIFEs hanging off `window.TDW`,
  loaded in order by `app/index.html` with `?v=` cache busters. Tests: `npm test` (node --test).
  Run locally: `node tools/dev-server.mjs` → http://127.0.0.1:8765/ (or `npm run dev` for the Worker).
- Work in your own git worktree on your own branch (the lead tells you which). Commit there, often.
  Do not push, do not deploy, do not touch files outside your assignment; if you must, say so in
  your report. Don't bump the version; the lead does it once.
- Chris's rules: no hover tooltips and no `title=` attributes, ever; when something needs explaining,
  a small "?" that opens a short note in place. Controls live inside the thing they change. Few words,
  written from the reader's seat; cut how-it-works explanations. American English. Light by default.
  No counters or explanatory labels in the app. Every button answers a press.
- Phone matters as much as the computer: thumb-reach controls at the bottom, 16px+ inputs (no zoom),
  safe areas, no sticky hover. Read `~/.claude/skills/mobile-native/SKILL.md` and, for anything
  dragged or swiped, `~/.claude/skills/gestures/SKILL.md`.
- Check your work in a real browser (the built-in browser pane), on a computer width and a phone
  width (375×812), before you report.
- Report: what you built, files touched, the API other parts should call, what's left or unsure.

# Ten Dollar Words

A writing app where every word costs $10. One quiet page, a thin bar over it (the spine) with the draft's title and what its words have cost, and a review (⌘E) that marks hard sentences and wordy phrases and says what cutting each one saves. Everything else is in the command palette (⌘K, or ⋯ in the spine).

It lives at https://tendollarwords.cristianbagrin.com: the website at `/` (Home, How it works, What's new, Privacy), the app at `/dashboard`. Someone who has used the app in a browser goes straight from `/` to `/dashboard`. Chris edits the website's words at `/edit`.

Plain HTML, CSS and JavaScript, no build step, on one Cloudflare Worker with a D1 database. `docs/DESIGN.md` is the design; `docs/PLAN-v6.md` is the 5.0 plan and its decisions.

## Writing

- **Drafts** have a status (Idea, Drafting, Editing, Done), a date, tags, a format (Basic, LinkedIn, X, Threads, Substack) and a budget. A new draft opens a small sheet of them; nothing in it is required.
- **Projects.** Any draft can hold other drafts, in order: a book and its chapters. Its page lists its parts and the whole cost; ⋯ → Read as one shows, copies or saves the lot as one Markdown manuscript. Drag rows in the sidebar to reorder them or move them into a project, or use ⋯ → Move to….
- **Ideas.** ⌘⇧I, the bulb (on the bench, in the sidebar), the palette, `/dashboard?idea=…` (for an iOS Shortcut) or the phone's share sheet (the manifest's share target). `#tags` at the end become tags. An idea turns into a draft, a part of a project, or a paragraph in the open draft.
- **Tidy** fixes low-risk mistakes as you leave a word: typos with one right answer, doubled words, "i", sentence capitals, spaces, a/an, doubled punctuation. Never in code, links, names or dictionary words. ⌘Z takes a fix back. Settings → Tidy turns it off; palette → Tidy with AI fixes grammar on request and shows each change.
- **Review** (⌘E), **the Lab and Trim** (⌃⇧L), **alternatives**, **ghosts**, **Overflow**, **notes**, **colors**, **writing challenges**, **no backspace**: in the palette, the right-click menu and the bench under the page.
- **AI** is optional: your own Google Gemini key (Settings → AI, free at https://aistudio.google.com/apikey). Model on Automatic uses the newest Flash model and falls back when Google is busy. Only what you ask about is sent.

## Where drafts live

Without an account, drafts, ideas and settings stay in this browser (localStorage). ⋯ → Save a backup / Open a backup moves them by hand.

Signed in (Settings → Account, the same cristianbagrin.com account as Chris's other apps), each draft and idea syncs as its own encrypted record (`/api/vault/items`), and settings, the dictionary and the Gemini key sync as one encrypted document. Everything is encrypted in the browser (AES-256-GCM) with a data key that sits under the account's master key, which the password and the account's one recovery key open (`app/js/account-keyring.js`). The servers only ever hold ciphertext.

- Merges go field by field over what both sides last synced. When two devices rewrote the same text, this device's version stays and the other one goes into Overflow.
- Deleting leaves a tombstone, so the deletion syncs and Undo works; it's gone for good after 30 days.
- A draft over the size cap won't sync, and the app says so: split it into parts.
- On an iPhone, the Home Screen app has its own storage: sign in there too.

**Coming from Notion:** Settings → Account → Import from Notion copies every page of a database (text, formatting, colors, properties, subpages as parts) once, then forgets the Notion secret. Running it twice is safe. The Notion code (`notion*.js`, `sync.js`) is only there for the import and goes in a later release.

## On a phone

Swipe from near the left edge for the drafts drawer (swipe back or tap beside it to close); its buttons sit at the bottom. The bench carries Review, the Lab, Trim, ideas and the format. While reviewing, notes are chips under their paragraph that open in a sheet. Inputs are 16px, so the page never zooms.

## Run it locally

```
npm install                       # once (set npm_config_cache=~/Library/Caches/claude-npm on Chris's Mac)
npx wrangler d1 migrations apply tendollarwords --local
npx wrangler dev --port 8790 --ip 127.0.0.1
```

Then http://127.0.0.1:8790/ (the website) and http://127.0.0.1:8790/dashboard (the app). Copy `.dev.vars.example` to `.dev.vars` for the `/edit` password and a local account service. To sign in without the real account service, run cristianbagrin's `site/` on this computer, point `DEV_ACCOUNT_API` at it, and in the console: `localStorage.setItem('tdw.dev.accountApi', '/api/dev-account/')`.

`node tools/dev-server.mjs` serves just the app (at `/`) with an in-memory vault, for quick work without wrangler.

Tests: `npm test`.

## Ship an update

1. Bump `APP_VERSION` in `app/js/app.js`, `VERSION` in `app/sw.js` and every `?v=` in `app/index.html` together (`tests/version.test.js` checks). A new file also goes in `PRECACHE` in `sw.js`.
2. Update `app/site/whats-new.html`.
3. `npm test`, then push `main`: Cloudflare Workers Builds runs `npm run deploy` (D1 migrations, then `wrangler deploy`). By hand on Chris's Mac: `set -a; source ~/.cloudflare-deploy.env; set +a; npm run deploy`.
4. The Worker needs the `EDIT_KEY` secret once: `npx wrangler secret put EDIT_KEY`.
5. Check https://tendollarwords.cristianbagrin.com/whats-new and `/dashboard` show the new version (Settings → About).

## Files

```
wrangler.jsonc          the Worker: app/ as static files; /api/*, the website's pages, /edit and /dashboard through the Worker
worker/index.mjs        routes: /api/vault/*, /api/account/*, /api/copy, the website, /dashboard
worker/vault-api.mjs    encrypted records in D1: the settings document and one record per draft or idea
worker/account-api.mjs  the old (before 4.0) accounts, kept so people can move
worker/site.mjs, copy.mjs   the website with Chris's /edit changes put in (a Durable Object keeps them)
migrations/             the D1 tables
tests/                  node tests (engine, Tidy, projects, store, sync, vault, site, version…)
tools/                  dev-server.mjs, build-dict.mjs, sync-copy.mjs (lists /edit changes to fold in), design-tour.mjs
docs/                   DESIGN.md, the plans (PLAN-v6.md is 5.0)
app/
  index.html            the app (served at /dashboard)
  site/                 the website: home, how-it-works, whats-new, privacy, site.css/js, edit.js, shot.png
  sw.js, manifest.webmanifest, _headers, icons/, img/, dict/
  css/base.css          tokens (color, type, spacing, motion), light and dark, buttons, menus, toasts
  css/page.css          the spine, the page, formats, marks, the gutter's costs
  css/margin.css        review notes, the grade ruler, cards, Overflow
  css/surfaces.css      dialogs and sheets, palette, drafts sidebar, ideas, properties, the reader, the bench
  css/settings.css      Settings
  js/store.js           drafts, ideas and settings in localStorage; projects (parentId, order); tombstones
  js/items-sync.js      each draft and idea synced as its own encrypted record, merged field by field
  js/vault.js, keyring.js, account-keyring.js, account.js   encryption, keys, sign-in, the synced settings
  js/editor.js          the editor (one line per paragraph, its own undo, live Tidy, X post windows)
  js/inline.js, engine.js, spell.js, data.js, marks.js, tidy.js, challenges.js, formats.js   pure logic (tested)
  js/project.js         projects: the tree, drops, the manuscript, the project page, Read as one
  js/drafts.js          the drafts and ideas sidebar (the phone's drawer), properties, Move to
  js/ideas.js           catching ideas, the ideas list, turning one into a draft
  js/spine.js, margin.js, review.js, palette.js, bench.js, dialogs.js, help.js, ui.js   the surfaces
  js/alts.js, menu.js, overflow.js, lab.js, notes.js, blocks.js, bubble.js, links.js, fx.js, sound.js, desk.js, challenge-ui.js
  js/ai.js, ai-mock.js  Gemini, and a fake for tests
  js/notion*.js, sync.js   only for Import from Notion
  js/app.js             state, events, startup (loads last)
```

## Later

- Sign in with a passkey.
- Remove the Notion code once imports are done.
- Export a project as .docx or EPUB.
- A focus mode that dims the other sentences.

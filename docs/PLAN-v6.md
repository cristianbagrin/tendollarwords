# Ten Dollar Words 5: standalone

The shared to-do for the 5.0 overhaul. Every session working on it reads this first, ticks what it
finishes (`[x]`, with the commit), and adds what it learns under **Decisions**. Started 2026-11-19.

Chris's brief, in short: drop Notion and stand alone on Cloudflare; projects (a book made of
chapters/essays); a place to catch ideas; settings rebuilt the Chinese Brain way; automatic clean-up
of obvious mistakes; a website he can edit at /edit, listed on his other sites; a pile of phone
fixes; and improve everything else, core layout included. No limits.

## Decisions

- **Notion goes.** Drafts live in this browser and sync, end-to-end encrypted, through the account
  (one encrypted record per item in D1, not one big document: a book would outgrow the 700 KB vault).
  Notion stays only as a one-time **Import from Notion** (pages → drafts, with properties and text),
  then the Notion code is deleted in a later release.
- **Own properties** replace Notion's: Status (Idea → Drafting → Editing → Done), Date (today by
  default), Tags, and Format/Budget as before. A new draft opens a small properties sheet; a tap
  outside closes it.
- **Projects = pages inside pages.** Any draft can hold other drafts (its parts), ordered and nested
  (Notion's subpages, but ordered like a book's chapters). A project shows its parts under its own
  text, can be read and copied/exported as one manuscript, and shows the whole cost. Drag to reorder
  or move a draft into a project.
- **Ideas** are their own collection: catch one from anywhere (a button on the phone's bottom bar,
  ⌘⇧I, the palette, `/dashboard?idea=…` for iOS Shortcuts, Android share target), list/search/tag them,
  and turn one into a draft or a part of a project, or drop it into the open draft.
- **Tidy** fixes low-risk mistakes by itself as you leave a word or sentence (typos with one clear
  fix, doubled words, "i", sentence capitals, spaces, a/an, doubled punctuation), with a brief mark
  and ⌘Z. A wider AI pass (grammar) is a button, never automatic, and shows its changes.
- **Address (Chris, 2026-11-19):** the website is `tendollarwords.cristianbagrin.com/` and the app is `/dashboard`. The home
  page sends anyone who has used the app on that browser straight to `/dashboard`, so it still opens
  like an app. The manifest's start URL is `/dashboard`.
- **The website's words are editable at `/edit`**, the same way as chinese.cristianbagrin.com
  (Copy store in the Worker, HTMLRewriter, `EDIT_KEY` secret).
- **Chinese Brain's rules apply:** no hover tooltips or `title=` anywhere; a small "?" popover where
  an explanation is needed; controls inside what they change; press feedback on every button;
  Chris's photo where the app points to him; American English.
- **Storage (v5-storage):** items live under `tdw.draft.<id>` as before, with `kind`, `status`, `date`,
  `tags`, `parentId`, `order`, `archived`, `deletedAt`. Deleting is a tombstone (undo with
  `Store.restore`), gone for good after 30 days. Each item syncs as its own encrypted record
  (gzipped, AES-GCM, at an address hashed from the key and id); merges go field by field over what
  both sides last synced; when both rewrote the text, this device's stays and the other goes into
  Overflow ("From another device, …:"). Drafts of the same Notion page made on two devices before
  5.0 merge into one (the lower id). The settings document no longer carries draft fields.
- **Phone:** controls sit at the bottom, in thumb reach; the drafts sidebar opens with a swipe from
  the left edge and closes with a swipe back; toggle buttons switch off on a second tap; a tap on a
  toast dismisses it.

## To-do

### 1. Standalone storage and sync
- [x] Draft model: `parentId`, `order`, `status`, `date`, `tags`, `kind` ('draft' | 'idea'); migrate existing drafts (Notion Stage/Date/Pillar → status/date/tags). (v5-storage)
- [x] Worker: per-item encrypted records (`/api/vault/items`: list changed since, get, put with rev, delete), size cap per item, tests. (v5-storage)
- [x] Client sync: items sync through the account (push on change, pull on focus/interval, conflicts keep both: the other version goes to Overflow), tombstones for deletes. (v5-storage)
- [ ] Import from Notion (one time, from Settings): every page with text, properties and colors; then Notion disconnects. (`TDW.NotionImport.run` done in v5-storage; the Settings button is still to do)
- [ ] Remove Notion sync from the app (stage chip, property chips, sync dot, Notion settings). (The live sync loop is gone in v5-storage; `TDW.Sync`'s old calls are no-ops. The UI pieces are still to do.)

### 2. Projects
- [ ] Sidebar as a tree: projects open to their parts; drag to reorder and to move into/out of a project.
- [ ] A project page lists its parts under its text; "New part"; whole-project cost.
- [ ] Read the whole project as one manuscript; copy and export (Markdown) the whole thing.

### 3. Ideas
- [ ] Capture: phone bottom-bar button, ⌘⇧I, palette, `/dashboard?idea=`, manifest share target.
- [ ] Ideas list: search, tags, newest first, swipe/archive, undo.
- [ ] Turn into a draft, into a part of a project, or insert into the open draft.

### 4. Settings (Chinese Brain style)
- [ ] Settings window: sections sidebar (Account, Writing, Review, Tidy, Look, Sound, AI, Shortcuts, About); each setting a row in a rounded group, control inside the row; "?" popovers; phone = section list that pushes in.
- [ ] Account block first-class (avatar, sync status, account.cristianbagrin.com); About with Chris's photo.

### 5. Tidy
- [ ] Rules engine (pure, tested): typos with one clear fix, doubled words, "i", capitals, spaces, a/an, doubled punctuation; never inside code, links, names, or words in the dictionary.
- [ ] Live as you type (after the word/sentence is left), with a brief mark and ⌘Z; a setting to turn it off.
- [ ] "Tidy with AI" for grammar: on demand, minimal edits, shows each change, one undo.

### 6. Bugs and phone
- [ ] A click/tap anywhere below the last paragraph puts the caret at the end (a new empty paragraph if the last one has text).
- [ ] A tap on a toast (Undo included) dismisses it; Undo undoes and dismisses.
- [ ] Sidebar actions at the bottom on a phone; swipe from the left edge opens it, swipe left closes it.
- [ ] New draft: date = today, properties sheet, tap outside to close.
- [ ] Toggle buttons (bench/bottom bar) switch off on a second press.
- [ ] iOS Passwords autofill: its suggestions take taps (find what sits over or intercepts them in the sign-in form).
- [ ] Remove every hover tooltip / `title=`; "?" popovers instead.

### 7. Website
- [ ] Home, How it works, Privacy, What's new at `/`; app moves to `/dashboard` (old `/` users go straight in).
- [ ] `/edit` for the pages' words (Copy store, `EDIT_KEY` secret).
- [ ] Listed on cristianbagrin.com (Projects, jump row, short link, zh-tw too, screenshot), work.cristianbagrin.com, and the account page.

### 8. Overall pass
- [ ] Design review of every surface on a computer and a phone (Emil skills: mobile-native, gestures, review-animations, break-ui).
- [ ] README, What's new, version 5.0.0, deploy, check the live site.

## Status (2026-11-19, session 1 ended at the usage limit)

Wave 1 started in worktrees beside this repo (`../tdw-storage`, `../tdw-website`, `../tdw-settings`,
`../tdw-tidy`, branches `v5-*`) and was stopped part-way. Next session: check each worktree's commits and
uncommitted files, finish or restart each part (briefs: section 1, 7, 4, 5 above + `docs/BRIEF-v5.md`),
merge into main, then wave 2 (projects, ideas, phone fixes), then the design review and listings.
Leads found so far: the iOS Passwords bug likely involves the sheet's pointer handling in `wireDialog`
(`app/js/ui.js`, around line 444); the click-below-the-page bug is in `app/js/editor.js` mousedown handling (around line 1775).
Deploy needs an `EDIT_KEY` secret on the tendollarwords Worker (same password as the other sites).

/* Since 5.0 drafts no longer sync with Notion: they live in this browser and sync through the
   account (items-sync.js). What's left of Notion is connecting to a database once, so Import from
   Notion (notion-import.js) can bring its pages in.

   TDW.Sync keeps its old names so callers from before keep working: the Notion calls do nothing
   (isConnected() is always false, config() null, noteEdit/noteProp/prepare/trash/restore/start
   are no-ops), and init() starts items sync with the app's hooks. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { Store, Notion } = TDW;

  let hooks = {};
  const call = (name, ...args) => (typeof hooks[name] === 'function' ? hooks[name](...args) : undefined);
  const plain = (rich) => (Array.isArray(rich) ? rich : []).map((r) => r.plain_text || (r.text && r.text.content) || '').join('').trim();

  /* ---------- Connecting to a Notion database (for the import) ---------- */

  // The last 32-hex run (or dashed UUID) in the link's path. A "?v=" view id is not the database.
  function parseDatabaseId(link) {
    let s = String(link || '').trim();
    try { s = new URL(s).pathname; } catch (_) { /* not a URL: a bare id */ }
    const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/gi;
    let m, last = null;
    while ((m = re.exec(s))) last = m[0];
    return last ? last.replace(/-/g, '').toLowerCase() : null;
  }

  function buildSchema(properties) {
    const schema = {};
    let titleProp = null;
    for (const name of Object.keys(properties || {})) {
      const p = properties[name];
      if (!p || typeof p.type !== 'string') continue;
      const entry = { type: p.type };
      const body = p[p.type] || {};
      if (p.type === 'select' || p.type === 'status' || p.type === 'multi_select') {
        const opts = (Array.isArray(body.options) ? body.options : []).filter((o) => o && typeof o.name === 'string');
        entry.options = opts.map((o) => o.name);
        entry.colors = {};
        for (const o of opts) if (typeof o.color === 'string') entry.colors[o.name] = o.color;
      }
      if (p.type === 'title' && !titleProp) titleProp = name;
      schema[name] = entry;
    }
    return { schema, titleProp };
  }

  function connectError(e) {
    const code = e && e.code;
    if (code === 'unauthorized') return 'Notion rejected the secret. Copy it again from notion.so/profile/integrations.';
    if (code === 'not_found') return "Notion can't see that database. In Notion, open it, click ••• → Connections, and add your integration.";
    if (code === 'offline') return "Can't reach Notion. Check your internet and try again.";
    return 'Something went wrong: ' + ((e && e.message) || 'unknown error');
  }

  // Check the secret and the database, and keep both for the import. Returns { title, pages: 0 }.
  async function connect(token, link) {
    const databaseId = parseDatabaseId(link);
    if (!databaseId) throw new Error('That link has no database ID. Copy the database link from Notion.');
    const secret = String(token || '').trim();
    if (!secret) throw new Error('Paste the integration secret first.');
    const oldToken = Store.getNotionToken();
    const release = TDW.Account ? TDW.Account.hold() : () => {};
    Store.setNotionToken(secret);
    let db, ds, dsId;
    try {
      db = await Notion.getDatabase(databaseId);
      dsId = Array.isArray(db.data_sources) && db.data_sources[0] ? db.data_sources[0].id : null;
      if (!dsId) throw { code: 'validation', message: 'That database has no data source.' };
      ds = await Notion.getDataSource(dsId);
    } catch (e) {
      if (oldToken) Store.setNotionToken(oldToken); else Store.clearNotionToken();
      release();
      throw new Error(connectError(e));
    }
    const { schema, titleProp } = buildSchema(ds.properties);
    const dbTitle = plain(db.title) || plain(ds.title) || 'your database';
    Store.setNotionConfig({ databaseId, dataSourceId: dsId, dbTitle, titleProp, schema });
    release();
    call('onList');
    return { title: dbTitle, pages: 0 };
  }

  // Forget the Notion secret here (and, signed in, on every device). Keeps the database id, so
  // drafts keep knowing which pages they came from.
  function disconnect() {
    const c = Store.getNotionConfig();
    Store.clearNotionToken();
    Store.setNotionConfig(c && c.databaseId ? { databaseId: c.databaseId } : null);
    call('onList');
  }

  // A secret and a database to import from.
  const linked = () => !!Store.getNotionToken() && !!(Store.getNotionConfig() && Store.getNotionConfig().dataSourceId);

  function init(h) {
    hooks = h || {};
    if (TDW.ItemsSync) TDW.ItemsSync.init(hooks);
  }

  const items = () => TDW.ItemsSync;
  const noop = () => {};

  TDW.Sync = {
    init, connect, disconnect, linked, parseDatabaseId, buildSchema,
    // Notion's live sync is gone: these stay for callers from before and do nothing.
    isConnected: () => false,
    config: () => null,
    adopt: () => call('onList'),
    start: noop, stop: noop, noteEdit: noop, noteProp: noop, trash: noop, restore: noop,
    prepare: () => Promise.resolve(),
    // The account's sync of drafts and ideas.
    status: () => (items() ? items().status() : { state: 'off', message: '', at: 0 }),
    syncNow() { if (items()) items().syncNow(); return !!items(); }
  };
})();

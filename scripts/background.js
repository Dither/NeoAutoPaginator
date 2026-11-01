'use strict';

const STORAGE  = globalThis.napBrowser.storage.local;
const EXT_NAME = '[NeoAutoPaginatorMod]';

class NAPBackground {
  constructor() {
    this.siteinfo      = [];
    this.customInfo    = {};
    this.disabledSites = [];
    this.stats         = { hits: {}, fails: {} };
    this.config        = { ...DEFAULT_CONFIG };
    this.css           = '';
    this.readyPromise  = this.init();
    /* Session-only toggle state: { origin -> bool }
       Lives only in memory, cleared on browser restart */
    this._sessionToggles = {};
  }

  async init() {
    await this.loadConfig();
    await this.loadCSS();
    await this.initDatabase();
    this.registerBrowserAction();
    this.registerMessaging();
  }

  registerBrowserAction() {
    try {
      const action = globalThis.napBrowser.browserAction;
      if (!action?.onClicked?.addListener) return;
      action.onClicked.addListener(async (tab) => {
        if (!tab || typeof tab.id !== 'number') return;
        try {
          await globalThis.napBrowser.tabs.sendMessage(tab.id, { type: 'nap:picker_open' });
        } catch (err) {
          console.warn(EXT_NAME + ' Picker unavailable:', err?.message || err);
        }
      });
    } catch (err) {
      console.warn(EXT_NAME + ' Could not register browser action:', err?.message || err);
    }
  }

  async loadConfig() {
    const data = await STORAGE.get(['nap_config','nap_custom_info','nap_disabled_sites','nap_stats']);
    if (data.nap_config)        this.config        = { ...DEFAULT_CONFIG, ...data.nap_config };
    if (data.nap_custom_info)   this.customInfo    = data.nap_custom_info;
    if (data.nap_disabled_sites) this.disabledSites = data.nap_disabled_sites;
    if (data.nap_stats)         this.stats         = data.nap_stats;
  }

  async loadCSS() {
    try {
      const [main, bar] = await Promise.all([
        fetch(globalThis.napBrowser.runtime.getURL('css/main.css')).then(r => r.text()),
        fetch(globalThis.napBrowser.runtime.getURL('css/bar.css')).then(r => r.text()),
      ]);
      this.css    = main;
      this.barCSS = bar;
    } catch {
      this.css    = '';
      this.barCSS = '';
    }
  }

  async initDatabase() {
    const cached = await STORAGE.get('nap_siteinfo_db');
    if (cached.nap_siteinfo_db?.length) this.siteinfo = cached.nap_siteinfo_db;
    else await this.loadDefaultDatabase();
    this.applyCustomOverrides();
  }

  async loadDefaultDatabase() {
    try {
      const res = await fetch(globalThis.napBrowser.runtime.getURL('db/items_all.json'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.compileDatabase(await res.json());
    } catch (err) {
      console.warn(EXT_NAME + ' Could not load db/items_all.json:', err);
      this.siteinfo = [];
    }
  }

  async updateDatabaseFromURL(url) {
    const targetUrl = url || this.config.custom_db_url;
    if (!targetUrl) return [-1, 'Invalid database URL'];
    try {
      const res = await fetch(targetUrl);
      if (!res.ok) return [-1, `HTTP ${res.status}: ${res.statusText}`];
      const data = await res.json();
      const local = this.siteinfo.filter(i => i.source === 'local');
      this.compileDatabase(data);
      this.siteinfo = [...local, ...this.siteinfo];
      this.applyCustomOverrides();
      await STORAGE.set({ nap_siteinfo_db: this.siteinfo });
      return [this.siteinfo.length, null];
    } catch (err) {
      return [-1, err?.message || 'Unable to fetch or parse database'];
    }
  }

  compileDatabase(items) {
    const compiled = [];
    const entries  = Array.isArray(items) ? items : (items.siteinfo || []);
    for (const item of entries) {
      const d = item.data || item;
      let id = item['wedata.net.id'] || item.id;
      if (!id && item.resource_url) { const m = item.resource_url.match(/items\/(\d+)/i); if (m) id = m[1]; }
      if (!id) id = Math.random().toString(36).slice(2,9);
      id = String(id).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64) || Math.random().toString(36).slice(2,9);
      if (!d.url || (!d.nextLink && !d.nextLinkSelector) || (!d.pageElement && !d.pageElementSelector)) continue;
      try { new RegExp(d.url); } catch { continue; }
  
      const isLocal = item.source === 'local';
  
      compiled.push({
        id, name: item.name||d.name||d.exampleUrl||d.url,
        url: d.url,
        nextLink: d.nextLink||null, nextLinkSelector: d.nextLinkSelector||null,
        pageElement: d.pageElement||null, pageElementSelector: d.pageElementSelector||null,
        insertBefore: d.insertBefore||d.insertBeforeSelector||null,
        removeElement: d.removeElement||null,
        exampleUrl: d.exampleUrl||'',
        cssPatch: d.cssPatch||d.Stylish||null,
        jsPatch: isLocal ? (d.jsPatch||null) : null,
        allowScripts: isLocal ? Boolean(d.allowScripts) : false,
        forceIframe: isLocal ? Boolean(d.forceIframe) : false,
        allowCrossOrigin: isLocal ? Boolean(d.allowCrossOrigin) : false,
        disableSeparator: Boolean(d.disableSeparator),
        disabled: Boolean(d.disabled),
        created_at: item.created_at||'', updated_at: item.updated_at||'',
        created_by: item.created_by||item.author||'wedata',
        resource_url: item.resource_url||(id?`http://wedata.net/items/${id}`:''),
        source: isLocal ? 'local' : 'remote'
      });
    }
    compiled.sort((a,b) => (b.url?.length||0) - (a.url?.length||0));
    this.siteinfo = compiled;
  }

  applyCustomOverrides() {
    for (const item of this.siteinfo) {
      if (this.customInfo[item.id]) Object.assign(item, this.customInfo[item.id]);
    }
  }

  isUrlBlacklisted(url) {
    if (!url.startsWith('http')) return true;
    return this.disabledSites.some(f => {
      try {
        if (f.type==='regexp')  return new RegExp(f.matcher,'i').test(url);
        if (f.type==='prefix')  return url.startsWith(f.matcher);
        if (f.type==='domain')  return new URL(url).hostname.includes(f.matcher);
      } catch {} return false;
    });
  }

  findMatchingRules(url) {
    if (this.isUrlBlacklisted(url)) return [];
    return this.siteinfo.filter(rule => {
      if (rule.disabled) return false;
      try { return new RegExp(rule.url,'i').test(url); } catch { return false; }
    });
  }

  async openOrFocus(path) {
    const fullUrl = path.startsWith('http') ? path : globalThis.napBrowser.runtime.getURL(path);
    const tabs    = await globalThis.napBrowser.tabs.query({});
    const found   = tabs.find(t => t.url === fullUrl);
    if (found) {
      await globalThis.napBrowser.tabs.update(found.id, { active: true, url: fullUrl });
      if (found.windowId) await globalThis.napBrowser.windows.update(found.windowId, { focused: true });
    } else {
      await globalThis.napBrowser.tabs.create({ url: fullUrl });
    }
  }

  registerMessaging() {
    globalThis.napBrowser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message?.type?.startsWith('nap:')) return;
      const action = message.type.replace('nap:','');
      this.handleAction(action, message, sender).then(sendResponse).catch(err => sendResponse({ error: err.message }));
      return true;
    });
  }

  async handleAction(action, msg, sender) {
    await this.readyPromise;

    switch (action) {

    case 'init': {
      const url = msg.url || sender.tab?.url;
      if (!url || (msg.isFrame && this.config.disable_in_frames)) return { active: false };
      return {
        active:   true,
        siteinfo: this.findMatchingRules(url),
        config:   this.config,
        css:      this.css,
        barCSS:   this.barCSS,
      };
    }

      case 'session:set_toggle': {
        const { origin, active } = msg;
        if (origin) this._sessionToggles[origin] = active;
        return { ok: true };
      }

      case 'session:get_toggle': {
        const { origin } = msg;
        if (origin && origin in this._sessionToggles) {
          return { active: this._sessionToggles[origin] };
        }
        return {};   // undefined → content script uses config default
      }

      case 'open:options':  { await this.openOrFocus('options.html');           return { ok: true }; }
      case 'open:manager': {
        const path = msg.ruleId
          ? `siteinfo_manager.html?hl=${encodeURIComponent(msg.ruleId)}`
          : 'siteinfo_manager.html';
        await this.openOrFocus(path);
        return { ok: true };
      }

      case 'siteinfo:get':   return { siteinfo: this.siteinfo, customInfo: this.customInfo, stats: this.stats };

      case 'siteinfo:add_entry': {
        const entry = msg.entry;
        if (!entry?.url) return { ok: false, error: 'Missing url pattern' };
        try { new RegExp(entry.url); } catch (e) { return { ok: false, error: `Invalid url: ${e.message}` }; }
        if (!entry.pageElement && !entry.pageElementSelector) return { ok: false, error: 'Missing pageElement' };
        if (!entry.nextLink && !entry.nextLinkSelector)       return { ok: false, error: 'Missing nextLink' };
        let maxId = 90000;
        for (const item of this.siteinfo) { const n=parseInt(item.id,10); if(!isNaN(n)&&n<100000000&&n>maxId) maxId=n; }
        let assignedId = String(entry.id && !isNaN(entry.id) ? entry.id : maxId + 1);
        if (this.siteinfo.some(i => i.id === assignedId)) {
          return { ok: false, error: `ID ${assignedId} already exists` };
        }
        if (!entry.name) { try { entry.name = new URL(entry.exampleUrl).hostname; } catch { entry.name='Site '+assignedId; } }
        entry.id = assignedId; entry.source='local';
        entry.resource_url = `http://wedata.net/items/${assignedId}`;
        entry.created_at = entry.updated_at = new Date().toISOString();
        entry.created_by = entry.created_by || 'local_user';
        this.siteinfo.unshift(entry);
        await STORAGE.set({ nap_siteinfo_db: this.siteinfo });
        return { ok: true, entry };
      }

      case 'siteinfo:delete_entry': {
        const { id } = msg;
        this.siteinfo = this.siteinfo.filter(i => String(i.id) !== String(id));
        delete this.customInfo[id];
        await STORAGE.set({ nap_siteinfo_db: this.siteinfo, nap_custom_info: this.customInfo });
        return { ok: true };
      }

      case 'siteinfo:update_entry': {
        const { id, info } = msg;
        if (!id) return { ok: false, error: 'Missing ID' };
        this.customInfo[id] = { ...(this.customInfo[id]||{}), ...info };
        await STORAGE.set({ nap_custom_info: this.customInfo });
        this.applyCustomOverrides();
        return { ok: true };
      }

      case 'siteinfo:import': {
        this.compileDatabase(msg.data);
        await STORAGE.set({ nap_siteinfo_db: this.siteinfo });
        return { ok: true, count: this.siteinfo.length };
      }

      case 'stat:hit':  { const id=msg.id||'unknown'; this.stats.hits[id]=(this.stats.hits[id]||0)+1;  await STORAGE.set({nap_stats:this.stats}); return {ok:true}; }
      case 'stat:fail': { const id=msg.id||'unknown'; this.stats.fails[id]=(this.stats.fails[id]||0)+1; await STORAGE.set({nap_stats:this.stats}); return {ok:true}; }

      case 'config:get': return { config: this.config, customInfo: this.customInfo, disabledSites: this.disabledSites, stats: this.stats, dbCount: this.siteinfo.length };

      case 'config:save': {
        if (msg.config)        { this.config = {...this.config,...msg.config}; await STORAGE.set({nap_config:this.config}); }
        if (msg.disabledSites) { this.disabledSites = msg.disabledSites;       await STORAGE.set({nap_disabled_sites:this.disabledSites}); }
        return { ok: true };
      }

      case 'db:reload': { await this.loadDefaultDatabase(); this.applyCustomOverrides(); return { count: this.siteinfo.length }; }
      case 'db:update_from_url': { const [count,error] = await this.updateDatabaseFromURL(msg.url); return {count,error}; }

      default: throw new Error(`Unknown NAP action: ${action}`);
    }
  }
}

globalThis.NAP_BG = new NAPBackground();
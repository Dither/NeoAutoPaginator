'use strict';

(function () {
  if (window.name === 'neoapaginator-request-iframe') return;
  if (window.NAPPicker) return;

  Object.defineProperty(window, "NAPPicker", {
    value: null,
    enumerable: false,
    writable: true,
    configurable: false
  });

  window.NAPPicker = (function () {
    let host           = null;
    let shadow         = null;
    let overlay        = null;
    let hoveredEl       = null;
    let active          = false;
    let currentField     = null;
    let highlightTimer   = null;

    const fieldMode = { pageElement: 'auto', nextLink: 'auto' };

    const candidates = { pageElement: [], nextLink: [], pageElementIdx: 0, nextLinkIdx: 0 };
    let pageHighlights = [];

    function urlPattern() {
      const esc = s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      const path = (location.pathname + location.search)
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\d+/g, '\\d+');
      return '^' + esc(location.protocol) + '//' + esc(location.hostname) + path;
    }

    function toXPath(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
      if (el.id) return `//*[@id="${el.id.replace(/"/g,'\\"')}"]`;
      const tag = el.tagName.toLowerCase();
      const rel = el.getAttribute('rel');
      if (rel) return `//${tag}[@rel="${rel.replace(/"/g,'\\"')}"]`;
      const aria = el.getAttribute('aria-label');
      if (aria) return `//${tag}[@aria-label="${aria.replace(/"/g,'\\"')}"]`;
      const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
      for (const c of classes) {
        if (c.length < 3 || /^(is-|has-|js-|ng-|v-|col-|row-|flex|grid|d-|mt-|mb-|pt-|pb-|px-|py-|mr-|ml-|pl-|pr-|text-|bg-|w-|h-)/.test(c)) continue;
        const xp = `//${tag}[contains(@class,"${c}")]`;
        try { const r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); if (r.snapshotLength >= 1 && r.snapshotLength <= 5) return xp; } catch {}
      }
      if (classes.length) return `//${tag}[@class="${el.className.trim().replace(/"/g,'\\"')}"]`;
      const parent = el.parentElement;
      if (parent && parent !== document.body) {
        if (parent.id) return `//*[@id="${parent.id.replace(/"/g,'\\"')}"]/${tag}`;
        const sibs = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        const idx  = sibs.indexOf(el) + 1;
        const pc   = typeof parent.className === 'string' ? parent.className.trim().split(/\s+/).filter(Boolean) : [];
        const sc   = pc.find(c => c.length > 3 && !/^(is-|has-|js-|col-|row-|flex|grid|d-)/.test(c));
        if (sc) return `//${parent.tagName.toLowerCase()}[contains(@class,"${sc}")]/${tag}` + (sibs.length > 1 ? `[${idx}]` : '');
      }
      const all = Array.from(document.getElementsByTagName(tag));
      return `//${tag}[${all.indexOf(el) + 1}]`;
    }

    function toCSSSelector(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
      if (el.id) return `#${CSS.escape(el.id)}`;
      const tag = el.tagName.toLowerCase();
      const rel = el.getAttribute('rel');
      if (rel) return `${tag}[rel="${rel}"]`;
      const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
      if (classes.length) return `${tag}.${classes.map(c => CSS.escape(c)).join('.')}`;
      const parent = el.parentElement;
      if (parent && parent !== document.body) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        const idx  = sibs.indexOf(el) + 1;
        const baseParent = toCSSSelector(parent);
        return `${baseParent} > ${tag}${sibs.length > 1 ? `:nth-of-type(${idx})` : ''}`;
      }
      return tag;
    }

    function countMatches(selector) {
      if (!selector?.trim()) return { count: 0, method: '' };
      try { const n = document.querySelectorAll(selector); if (n.length) return { count: n.length, method: 'CSS' }; } catch {}
      try { const r = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); if (r.snapshotLength) return { count: r.snapshotLength, method: 'XPath' }; } catch (e) { return { count: 0, method: '', error: e.message }; }
      return { count: 0, method: '' };
    }

    /* ── Generate selector for field respecting mode ── */
    function selectorFor(el, field) {
      const mode = fieldMode[field] || 'auto';
      if (field === 'nextLink') {
        if (mode === 'xpath') return toXPath(el);
        if (mode === 'css')   return toCSSSelector(el);
        return el.tagName?.toLowerCase() === 'link' ? 'link[rel="next"]' : toXPath(el);
      }
      const slider = shadow?.querySelector('#nap-spec-pageElement');
      const spec   = slider ? +slider.value / 100 : 0.8;
      return selectorAtSpecificity(el, spec, mode);
    }

    function selectorAtSpecificity(el, spec, mode = 'auto') {
      let opts = selectorsForElement(el);
      if (mode === 'xpath') opts = opts.filter(o => o.type === 'xpath' || o.type === 'both');
      if (mode === 'css')   opts = opts.filter(o => o.type === 'css'   || o.type === 'both');
      if (!opts.length) return '';
      const idx = Math.round((1 - spec) * (opts.length - 1));
      const chosen = opts[Math.min(idx, opts.length - 1)];
      return chosen.type === 'both' && mode === 'xpath' ? `//${chosen.sel}` : chosen.sel;
    }

    function selectorsForElement(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return [];
      const tag = el.tagName.toLowerCase();
      const out = [];

      if (el.id) {
        out.push({ type: 'css',   sel: `#${CSS.escape(el.id)}` });
        out.push({ type: 'xpath', sel: `//*[@id="${el.id.replace(/"/g,'\\"')}"]` });
      }
      const rel = el.getAttribute('rel');
      if (rel) {
        out.push({ type: 'css',   sel: `${tag}[rel="${rel}"]` });
        out.push({ type: 'xpath', sel: `//${tag}[@rel="${rel.replace(/"/g,'\\"')}"]` });
      }
      const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
      if (classes.length) out.push({ type: 'css', sel: `${tag}.${classes.map(c => CSS.escape(c)).join('.')}` });

      const smart = toXPath(el);
      if (smart && !out.some(o => o.sel === smart)) out.push({ type: 'xpath', sel: smart });

      out.push({ type: 'both', sel: tag });

      return out.filter((o, i, a) => a.findIndex(x => x.sel === o.sel) === i);
    }

    /* ── Content / nextLink scoring ── */
    function scoreContent(el) {
      if (!el || el === document.body || el === document.documentElement) return -1;
      const tag = el.tagName.toLowerCase(), id = (el.id||'').toLowerCase(), cls = typeof el.className==='string'?el.className.toLowerCase():'';
      const combined = id + ' ' + cls;
      let s = 0;
      if (['article','main'].includes(tag)) s += 50; else if (['section','div'].includes(tag)) s += 10;
      if (/\b(content|main|article|post|entry|body|page|story)\b/.test(combined)) s += 35;
      if (/\b(sidebar|nav|menu|header|footer|ad|banner|comment|widget)\b/.test(combined)) s -= 50;
      s += Math.min(el.children.length*2, 20);
      s += Math.min(Math.floor((el.textContent||'').trim().length/200), 20);
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) s -= 25;
      return s;
    }

    function gatherContentCandidates() {
      const pool = [...new Set([
        ...document.querySelectorAll('article,main,[role="main"]'),
        ...document.querySelectorAll('#content,#main,.content,.main,.post,.entry,.article'),
        ...document.querySelectorAll('body>div,body>section,body>main,body>article'),
      ])];
      return pool.filter(e => scoreContent(e) > 0).sort((a,b) => scoreContent(b) - scoreContent(a)).slice(0, 5);
    }

    function scoreNextLink(a) {
      const href = a.getAttribute('href')||''; if (!href||href==='#'||href.startsWith('javascript:')) return -1;
      const text=(a.textContent||'').trim().toLowerCase(), cls=typeof a.className==='string'?a.className.toLowerCase():'', id=(a.id||'').toLowerCase(), rel=(a.getAttribute('rel')||'').toLowerCase(), aria=(a.getAttribute('aria-label')||'').toLowerCase();
      let s = 0;
      if (rel==='next'||rel.split(/\s+/).includes('next')) s += 100;
      if (/\bnext\b/.test(text+' '+aria)) s += 50;
      if (/次|次へ|下一页?|다음|siguiente|weiter|suivant|volgende/.test(text)) s += 50;
      if (/\bnext\b/.test(cls+' '+id)) s += 25;
      if (/[?&/]page[=/]?\d+|\/\d+\/?$/.test(href)) s += 15;
      if (/\b(prev|back|previous|earlier)\b/.test(text+' '+cls)) s -= 60;
      return s;
    }

    function gatherNextLinkCandidates() {
      const results = [];
      const headNext = document.querySelector('link[rel="next"]');
      if (headNext) results.push({ el: headNext, score: 200, label: '<link rel="next">' });
      const scored = Array.from(document.querySelectorAll('a[href]'))
        .map(a => ({ el: a, score: scoreNextLink(a), label: (a.textContent||'').trim().slice(0,40)||a.getAttribute('href') }))
        .filter(x => x.score > 0).sort((a,b) => b.score-a.score).slice(0,8);
      return [...results, ...scored];
    }

    const PICKER_CSS = `
:host { all: initial; display: block; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

#nap-root {
  position: fixed;
  top: 20px; right: 20px;
  width: 440px;
  background: #1e293b;
  color: #f8fafc;
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,.7);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
  overflow: hidden;
  z-index: 2147483647;
  pointer-events: auto;
}

#nap-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px;
  background: #0f172a;
  border-bottom: 1px solid #334155;
  cursor: move; user-select: none;
}
.nap-logo {
  width: 20px; height: 20px; border-radius: 4px;
  background: #6366f1; display: flex; align-items: center; justify-content: center;
  color: #fff; font-weight: 800; font-size: 11px; flex-shrink: 0;
}
#nap-header h3 { flex: 1; font-size: 13px; font-weight: 600; color: #f8fafc; }
#nap-close {
  background: none; border: none; cursor: pointer;
  color: #94a3b8; font-size: 20px; line-height: 1; padding: 0 3px; border-radius: 4px;
}
#nap-close:hover { color: #f87171; background: rgba(248,113,113,.12); }

.nap-body {
  padding: 12px 14px;
  display: flex; flex-direction: column; gap: 10px;
  max-height: 75vh; overflow-y: auto;
  background: #1e293b;
}

.nap-group { display: flex; flex-direction: column; gap: 4px; }

.nap-label {
  display: flex; align-items: center; gap: 6px;
  font-size: 10.5px; font-weight: 700;
  color: #94a3b8; text-transform: uppercase; letter-spacing: .6px;
}
.nap-label span.nap-label-text { flex: 1; }

.nap-mode-btn {
  font-size: 10px; font-weight: 700;
  padding: 2px 7px; border-radius: 4px;
  background: #0f172a; border: 1px solid #334155;
  color: #94a3b8; cursor: pointer;
  letter-spacing: 0; text-transform: none;
  min-width: 46px; text-align: center;
  transition: background .12s, color .12s;
}
.nap-mode-btn:hover  { background: #334155; color: #f8fafc; }
.nap-mode-btn.xpath  { color: #38bdf8; border-color: #38bdf8; }
.nap-mode-btn.css    { color: #a3e635; border-color: #a3e635; }

.nap-pick-btn {
  font-size: 10px; font-weight: 600;
  padding: 2px 8px; border-radius: 4px;
  background: #334155; border: 1px solid #475569;
  color: #f8fafc; cursor: pointer;
  text-transform: none; letter-spacing: 0;
}
.nap-pick-btn:hover  { background: #475569; }
.nap-pick-btn.active { background: #6366f1; border-color: #818cf8; color: #fff; }

.nap-cycle-btn {
  font-size: 11px; font-weight: 600;
  padding: 1px 6px; border-radius: 4px;
  background: #334155; border: 1px solid #475569;
  color: #94a3b8; cursor: pointer; line-height: 1.6;
}
.nap-cycle-btn:hover { background: #475569; color: #f8fafc; }
.nap-cycle-btn:disabled { opacity: .3; cursor: not-allowed; }

textarea.nap-input, input.nap-input {
  width: 100%;
  background: #0f172a;
  border: 1px solid #334155;
  color: #f8fafc;
  border-radius: 8px;
  font-family: 'Fira Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 11.5px;
  padding: 6px 9px;
  resize: vertical; outline: none;
  transition: border-color .15s;
}
textarea.nap-input { min-height: 44px; }
input.nap-input    { height: 30px; resize: none; }
textarea.nap-input:focus, input.nap-input:focus { border-color: #6366f1; }
textarea.nap-input.ok,    input.nap-input.ok    { border-color: #38bdf8; }
textarea.nap-input.err,   input.nap-input.err   { border-color: #f87171; }
textarea.nap-input.warn,  input.nap-input.warn  { border-color: #f59e0b; }

.nap-spec-row {
  display: flex; align-items: center; gap: 6px;
  font-size: 10px; color: #94a3b8;
}
.nap-spec-row span { white-space: nowrap; }
.nap-spec-row input[type=range] {
  flex: 1; height: 4px; accent-color: #6366f1;
  cursor: pointer; background: none; border: none; padding: 0;
}
.nap-spec-label { font-size: 10px; color: #94a3b8; min-width: 52px; text-align: right; white-space: nowrap; }

.nap-status { font-size: 10.5px; min-height: 14px; color: #94a3b8; padding-left: 1px; }
.nap-status.ok   { color: #38bdf8; }
.nap-status.err  { color: #f87171; }
.nap-status.warn { color: #f59e0b; }

hr.nap-sep { border: none; border-top: 1px solid #334155; }

#nap-hint {
  display: none; font-size: 11px;
  padding: 6px 10px; border-radius: 6px;
  background: #0f172a; color: #38bdf8; line-height: 1.5;
}
#nap-hint.on  { display: block; }
#nap-hint.err { background: #3b1a1a; color: #f87171; }

#nap-footer {
  display: flex; align-items: center;
  gap: 8px; padding: 10px 14px;
  background: #0f172a; border-top: 1px solid #334155; flex-shrink: 0;
}
.nap-footer-spacer { flex: 1; }
.nap-btn {
  padding: 6px 18px; border-radius: 8px;
  font-size: 12px; font-weight: 600; cursor: pointer;
  border: 1px solid transparent;
  transition: background .12s, opacity .12s;
}
.nap-btn-cancel { background: #334155; border-color: #475569; color: #f8fafc; }
.nap-btn-cancel:hover { background: #475569; }
.nap-btn-ok { background: #6366f1; color: #fff; }
.nap-btn-ok:hover:not(:disabled) { background: #4f46e5; }
.nap-btn-ok:disabled { opacity: .35; cursor: not-allowed; }
`;

    function buildUI() {
      host = document.createElement('div');
      host.id = 'nap-picker-host';
      host.setAttribute('style', ['all:initial','position:fixed','top:0','left:0','width:0','height:0','overflow:visible','pointer-events:none','z-index:2147483647','display:block'].map(s => s+'!important').join(';')+'!important');
      document.documentElement.appendChild(host);

      shadow = host.attachShadow({ mode: 'open' });
      const st = mkEl('style'); st.textContent = PICKER_CSS; shadow.appendChild(st);

      const root = mkEl('div', { id: 'nap-root' }); shadow.appendChild(root);

      const hdr = mkEl('div', { id: 'nap-header' });
      const logo = mkEl('div', { class: 'nap-logo' }); logo.textContent = 'A';
      const title = mkEl('h3'); title.textContent = 'NeoAutoPaginator — Add SITEINFO Rule';
      const closeBtn = mkEl('button', { id: 'nap-close', title: 'Cancel (Esc)' }); closeBtn.textContent = '×'; closeBtn.addEventListener('click', close);
      hdr.append(logo, title, closeBtn); root.appendChild(hdr);

      const body = mkEl('div', { class: 'nap-body' });
      body.appendChild(makeSimpleGroup('name', 'Site Name', 'input'));
      body.appendChild(mkEl('hr', { class: 'nap-sep' }));
      body.appendChild(makeSimpleGroup('url', 'URL Pattern (RegExp)', 'textarea'));
      body.appendChild(mkEl('hr', { class: 'nap-sep' }));
      body.appendChild(makePickGroup('pageElement', 'Page Element'));
      body.appendChild(mkEl('hr', { class: 'nap-sep' }));
      body.appendChild(makePickGroup('nextLink', 'Next Link'));
      const hint = mkEl('div', { id: 'nap-hint' }); body.appendChild(hint);
      root.appendChild(body);

      const footer = mkEl('div', { id: 'nap-footer' });
      const spacer = mkEl('div', { class: 'nap-footer-spacer' });
      const btnCancel = mkEl('button', { class: 'nap-btn nap-btn-cancel' }); btnCancel.textContent = 'Cancel'; btnCancel.addEventListener('click', close);
      const btnOk = mkEl('button', { class: 'nap-btn nap-btn-ok', id: 'nap-btn-ok' }); btnOk.textContent = 'Add to Database'; btnOk.disabled = true; btnOk.addEventListener('click', commitEntry);
      footer.append(spacer, btnCancel, btnOk); root.appendChild(footer);

      makeDraggable(root, hdr);

      ['name','url','pageElement','nextLink'].forEach(key => {
        const inp = shadow.querySelector(`#nap-f-${key}`);
        if (inp) inp.addEventListener('input', () => onManualInput(key, inp.value));
      });

      shadow.querySelectorAll('.nap-pick-btn').forEach(btn => {
        btn.addEventListener('click', () => startPicking(btn.dataset.field));
      });

      shadow.querySelectorAll('.nap-cycle-btn').forEach(btn => {
        btn.addEventListener('click', () => cycleCandidate(btn.dataset.field, +btn.dataset.dir));
      });

      shadow.querySelectorAll('.nap-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => toggleMode(btn.dataset.field));
      });

      const slider = shadow.querySelector('#nap-spec-pageElement');
      if (slider) slider.addEventListener('input', () => onSpecChange('pageElement', +slider.value));

      document.addEventListener('keydown', onGlobalKey, true);
      setTimeout(populateDefaults, 0);
    }

    function mkEl(tag, attrs = {}) {
      const n = document.createElement(tag);
      for (const [k,v] of Object.entries(attrs)) { if (k==='class') n.className=v; else n.setAttribute(k,v); }
      return n;
    }

    function makeSimpleGroup(key, label, inputTag) {
      const group = mkEl('div', { class: 'nap-group' });
      const lbl   = mkEl('div', { class: 'nap-label' });
      const ls    = mkEl('span', { class: 'nap-label-text' }); ls.textContent = label;
      lbl.appendChild(ls); group.appendChild(lbl);
      const input = document.createElement(inputTag);
      input.id = `nap-f-${key}`; input.className = 'nap-input';
      if (inputTag === 'textarea') input.rows = 2;
      group.appendChild(input);
      group.appendChild(mkEl('div', { class: 'nap-status', id: `nap-st-${key}` }));
      return group;
    }

    function makePickGroup(key, label) {
      const group = mkEl('div', { class: 'nap-group' });
      const lbl   = mkEl('div', { class: 'nap-label' });
      const ls    = mkEl('span', { class: 'nap-label-text' }); ls.textContent = label;

      const btnPrev = mkEl('button', { class: 'nap-cycle-btn', 'data-field': key, 'data-dir': '-1' });
      btnPrev.textContent = '◀'; btnPrev.title = 'Previous candidate'; btnPrev.disabled = true;

      const pickBtn = mkEl('button', { class: 'nap-pick-btn', 'data-field': key }); pickBtn.textContent = '⊕ Pick';

      const btnNext = mkEl('button', { class: 'nap-cycle-btn', 'data-field': key, 'data-dir': '1' });
      btnNext.textContent = '▶'; btnNext.title = 'Next candidate'; btnNext.disabled = true;

      const modeBtn = mkEl('button', { class: 'nap-mode-btn', 'data-field': key });
      modeBtn.textContent = 'auto';
      modeBtn.title = 'Toggle selector mode: auto → xpath → css → auto';

      /* Pick, Auto order */
      lbl.append(ls, btnPrev, pickBtn, modeBtn, btnNext);
      group.appendChild(lbl);

      const ta = document.createElement('textarea');
      ta.id = `nap-f-${key}`; ta.className = 'nap-input'; ta.rows = 2;
      group.appendChild(ta);

      if (key === 'pageElement') {
        const row  = mkEl('div', { class: 'nap-spec-row' });
        const lblL = mkEl('span'); lblL.textContent = 'broad';
        const sl   = document.createElement('input');
        sl.type = 'range'; sl.id = `nap-spec-${key}`; sl.min = '0'; sl.max = '100'; sl.value = '80';
        sl.title = 'Selector specificity';
        const lblR = mkEl('span'); lblR.textContent = 'specific';
        const ctr  = mkEl('span', { class: 'nap-spec-label', id: `nap-spec-preview-${key}` });
        row.append(lblL, sl, lblR, ctr);
        group.appendChild(row);
      } else {
        group.appendChild(mkEl('div', { id: `nap-spec-preview-${key}`, style: 'display:none' }));
      }

      group.appendChild(mkEl('div', { class: 'nap-status', id: `nap-st-${key}` }));
      return group;
    }

    function toggleMode(field) {
      const order = ['auto','xpath','css'];
      const cur   = fieldMode[field] || 'auto';
      fieldMode[field] = order[(order.indexOf(cur) + 1) % order.length];
      const btn = shadow.querySelector(`.nap-mode-btn[data-field="${field}"]`);
      if (btn) { btn.textContent = fieldMode[field]; btn.className = `nap-mode-btn ${fieldMode[field]}`; }
      applyCandidate(field);
      updateOkButton();
    }

    function populateDefaults() {
      const rule = window.NAPed?.status?.rule;
      const hostDefault = location.hostname.replace(/^www\./, '');

      setVal('name', rule?.name || hostDefault);
      const urlPat = rule?.url || urlPattern();
      setVal('url', urlPat); validateSimple('url', urlPat);

      if (rule) {
        seedFromRule('pageElement', rule.pageElementSelector, rule.pageElement);
        seedFromRule('nextLink',    rule.nextLinkSelector,    rule.nextLink);
      } else {
        candidates.pageElement = gatherContentCandidates();
        candidates.pageElementIdx = 0; applyCandidate('pageElement');
        candidates.nextLink = gatherNextLinkCandidates();
        candidates.nextLinkIdx = 0; applyCandidate('nextLink');
      }
      updateOkButton();
    }

    function seedFromRule(field, cssSel, xpathSel) {
      const selector = cssSel || xpathSel;
      fieldMode[field] = cssSel ? 'css' : xpathSel ? 'xpath' : 'auto';
      const btn = shadow?.querySelector(`.nap-mode-btn[data-field="${field}"]`);
      if (btn) { btn.textContent = fieldMode[field]; btn.className = `nap-mode-btn ${fieldMode[field]}`; }

      if (!selector) {
        candidates[field] = []; candidates[field+'Idx'] = 0;
        applyCandidate(field);
        return;
      }

      candidates[field] = [{ el: resolveNode(selector), selector, fromRule: true, label: 'active rule' }];
      candidates[field+'Idx'] = 0;
      updateCycleButtons(field);

      setVal(field, selector);
      validatePick(field, selector);
      highlightPageMatches(selector, field === 'nextLink' ? 'rgba(251,146,60,0.18)' : 'rgba(99,102,241,0.18)');
      setStatus(field, `From active rule — ${countMatches(selector).count} match(es)`, 'ok');
      if (field === 'pageElement') updateSpecPreview(field);
    }

    function resolveNode(sel) {
      try { const n = document.querySelector(sel); if (n) return n; } catch {}
      try { return document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch {}
      return null;
    }

    function applyCandidate(key) {
      const list = candidates[key];
      const idx  = candidates[key+'Idx'];
      updateCycleButtons(key);
      if (!list.length) { setVal(key,''); setStatus(key,'⚠ No candidates found','warn'); clearPageHighlights(); return; }
      const item  = list[idx];
      const elemEl = item.el || item;
      const selector = selectorFor(elemEl, key);
      setVal(key, selector);
      validatePick(key, selector);
      if (key === 'pageElement') updateSpecPreview(key);
      const color = key === 'nextLink' ? 'rgba(251,146,60,0.18)' : 'rgba(99,102,241,0.18)';
      highlightPageMatches(selector, color);
      const label = item.label || (elemEl.textContent||'').trim().slice(0,40) || selector;
      const { count } = countMatches(selector);
      setStatus(key, `Candidate ${idx+1}/${list.length}: "${label}" — ${count} match(es)`, count > 0 ? 'ok' : 'warn');
    }

    function updateCycleButtons(key) {
      const list = candidates[key]; const idx = candidates[key+'Idx'];
      shadow?.querySelectorAll(`.nap-cycle-btn[data-field="${key}"]`).forEach(btn => {
        const dir = +btn.dataset.dir;
        if (dir === -1) btn.disabled = idx <= 0;
        if (dir ===  1) btn.disabled = idx >= list.length - 1;
      });
    }

    function cycleCandidate(key, dir) {
      const ni = candidates[key+'Idx'] + dir;
      if (ni < 0 || ni >= candidates[key].length) return;
      candidates[key+'Idx'] = ni;
      applyCandidate(key);
      updateOkButton();
    }

    function updateSpecPreview(key) {
      const preview = shadow?.querySelector(`#nap-spec-preview-${key}`);
      if (!preview) return;
      const list = candidates[key]; const idx = candidates[key+'Idx'];
      if (!list.length) { preview.textContent = ''; return; }
      const c = selectorsForElement((list[idx].el || list[idx])).length;
      preview.textContent = c ? `${c} options` : '';
    }

    function onSpecChange(key, val) {
      const list = candidates[key]; if (!list.length) return;
      const el = list[candidates[key+'Idx']].el || list[candidates[key+'Idx']];
      const sel = selectorAtSpecificity(el, val/100, fieldMode[key] || 'auto');
      setVal(key, sel); updateSpecPreview(key); validatePick(key, sel);
      highlightPageMatches(sel, 'rgba(99,102,241,0.18)');
      updateOkButton();
    }

    function onManualInput(key, val) {
      if (key === 'url') validateSimple('url', val);
      else {
        validatePick(key, val);
        clearTimeout(highlightTimer);
        highlightTimer = setTimeout(() => {
          const color = key==='nextLink' ? 'rgba(251,146,60,0.18)' : 'rgba(99,102,241,0.18)';
          highlightPageMatches(val, color);
        }, 400);
      }
      updateOkButton();
    }

    function validateSimple(key, val) {
      if (!val.trim()) { markInput(key,''); setStatus(key,''); return false; }
      try {
        new RegExp(val);
        const ok = new RegExp(val,'i').test(location.href);
        markInput(key,'ok');
        setStatus(key, ok ? '✓ Matches current URL' : '⚠ Does not match current URL', ok ? 'ok' : 'warn');
        return true;
      } catch(e) { markInput(key,'err'); setStatus(key,'✗ Invalid RegExp: '+e.message,'err'); return false; }
    }

    function validatePick(key, val) {
      if (!val?.trim()) { markInput(key,''); return false; }
      const { count, error } = countMatches(val);
      if (error)    { markInput(key,'err');  return false; }
      if (count > 0){ markInput(key,'ok');   return true;  }
      markInput(key,'warn'); return false;
    }

    function setVal(key, val) { const i = shadow?.querySelector(`#nap-f-${key}`); if(i) i.value = val; }
    function getVal(key) { return (shadow?.querySelector(`#nap-f-${key}`)?.value||'').trim(); }
    function setStatus(key, text, cls='') { const s=shadow?.querySelector(`#nap-st-${key}`); if(s){s.textContent=text;s.className='nap-status'+(cls?' '+cls:'');} }
    function markInput(key, cls) { const i=shadow?.querySelector(`#nap-f-${key}`); if(i) i.className='nap-input'+(cls?' '+cls:''); }
    function updateOkButton() {
      const btn = shadow?.querySelector('#nap-btn-ok'); if(!btn) return;
      try { new RegExp(getVal('url')); } catch { btn.disabled=true; return; }
      btn.disabled = !(getVal('url') && getVal('pageElement') && getVal('nextLink'));
    }

    /* ── Page highlights (scroll-stable via absolute position) ── */
    function imp(styles) { return Object.entries(styles).map(([k,v])=>`${k}:${v}!important`).join(';')+';'; }

    function clearPageHighlights() { pageHighlights.forEach(d => d.remove()); pageHighlights = []; }

    function highlightPageMatches(selector, color) {
      clearPageHighlights();
      if (!selector?.trim()) return;
      const matched = [];
      try { matched.push(...document.querySelectorAll(selector)); } catch {}
      if (!matched.length) {
        try {
          const r = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i=0; i<r.snapshotLength; i++) { const n=r.snapshotItem(i); if(n.nodeType===Node.ELEMENT_NODE) matched.push(n); }
        } catch {}
      }
      const bg = color || 'rgba(99,102,241,0.18)';
      const border = bg.replace(/[\d.]+\)$/, '0.85)');
      matched.slice(0,20).forEach(el => {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        const scrollX = window.scrollX, scrollY = window.scrollY;
        const d = document.createElement('div');
        d.setAttribute('style', imp({
          position: 'absolute',
          top:    (r.top  + scrollY) + 'px',
          left:   (r.left + scrollX) + 'px',
          width:  r.width  + 'px',
          height: r.height + 'px',
          'pointer-events': 'none',
          'z-index': '2147483644',
          background: bg,
          outline: `2px solid ${border}`,
          'outline-offset': '-1px',
          'box-sizing': 'border-box',
          margin:'0',padding:'0',border:'0',
          'border-radius':'0','box-shadow':'none', display:'block'
        }));
        document.documentElement.appendChild(d);
        pageHighlights.push(d);
      });
    }

    /* ── Hover overlay (fixed, tracks cursor, not scroll) ── */
    function ensureOverlay() {
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.id = 'nap-hl';
      overlay.setAttribute('style', imp({ position:'fixed',top:'0',left:'0',width:'0',height:'0','pointer-events':'none','z-index':'2147483645',display:'block',margin:'0',padding:'0',border:'0',background:'none',outline:'none','box-sizing':'border-box' }));
      const lbl = document.createElement('div');
      lbl.id = 'nap-hl-label';
      lbl.setAttribute('style', imp({ position:'absolute',display:'none',background:'rgba(99,102,241,.92)',color:'#fff','font-family':'monospace','font-size':'11px','line-height':'1',padding:'3px 7px','border-radius':'3px','white-space':'nowrap','pointer-events':'none' }));
      overlay.appendChild(lbl);
      document.documentElement.appendChild(overlay);
    }

    function removeOverlay() { clearPageHighlights(); if(overlay){overlay.remove();overlay=null;} }

    function highlightEl(target) {
      if (!overlay || !target) return;
      const r = target.getBoundingClientRect();
      if (!r.width && !r.height) return;
      overlay.setAttribute('style', imp({ position:'fixed',top:r.top+'px',left:r.left+'px',width:r.width+'px',height:r.height+'px','pointer-events':'none','z-index':'2147483645','box-sizing':'border-box',display:'block',background:'rgba(99,102,241,0.25)',outline:'2px solid rgba(99,102,241,0.95)','outline-offset':'-1px',margin:'0',padding:'0',border:'0','border-radius':'0','box-shadow':'none' }));
      const tag = target.tagName.toLowerCase()+(target.id?'#'+target.id:'')+(typeof target.className==='string'&&target.className.trim()?'.'+target.className.trim().split(/\s+/)[0]:'');
      const lbl = overlay.querySelector('#nap-hl-label');
      if (lbl) {
        lbl.textContent = tag;
        const ly = r.top > 22 ? '-22px' : (r.height+4)+'px';
        lbl.setAttribute('style', imp({ position:'absolute',display:'block',top:ly,left:'0',background:'rgba(99,102,241,.92)',color:'#fff','font-family':'monospace','font-size':'11px','line-height':'1',padding:'3px 7px','border-radius':'3px','white-space':'nowrap','pointer-events':'none' }));
      }
    }

    function clearHighlight() {
      if (!overlay) return;
      overlay.setAttribute('style', imp({ position:'fixed',top:'0',left:'0',width:'0',height:'0','pointer-events':'none','z-index':'2147483645',display:'block',margin:'0',padding:'0',border:'0',background:'none',outline:'none','box-sizing':'border-box' }));
      overlay.querySelector('#nap-hl-label')?.setAttribute('style', imp({ display:'none',position:'absolute' }));
    }

    function startPicking(fieldName) {
      if (currentField === fieldName && active) { stopPicking(); return; }
      shadow?.querySelectorAll('.nap-pick-btn').forEach(b => b.classList.remove('active'));
      shadow?.querySelector(`.nap-pick-btn[data-field="${fieldName}"]`)?.classList.add('active');
      currentField = fieldName; active = true;
      ensureOverlay();
      showHint('Click any element on the page. Esc to cancel.');
      document.addEventListener('mouseover', onPickHover, true);
      document.addEventListener('click',     onPickClick, true);
      document.addEventListener('keydown',   onPickKeydown, true);
    }

    function stopPicking() {
      active=false; currentField=null; hoveredEl=null;
      shadow?.querySelectorAll('.nap-pick-btn').forEach(b=>b.classList.remove('active'));
      hideHint(); clearHighlight();
      document.removeEventListener('mouseover', onPickHover, true);
      document.removeEventListener('click',     onPickClick, true);
      document.removeEventListener('keydown',   onPickKeydown, true);
    }

    function showHint(text) { const h=shadow?.querySelector('#nap-hint'); if(h){h.textContent=text;h.className='on';} }
    function hideHint() { const h=shadow?.querySelector('#nap-hint'); if(h) h.className=''; }

    function onPickHover(e) {
      const t = e.target;
      if (t===overlay||t===host||(host&&host.contains(t))) return;
      hoveredEl = t; highlightEl(t);
    }

    function onPickClick(e) {
      const t = e.target;
      if (t===overlay||t===host||(host&&host.contains(t))) return;
      e.preventDefault(); e.stopPropagation();
      const target = hoveredEl || t; if(!target){stopPicking();return;}
      const entry = currentField==='nextLink'
        ? { el:target, score:999, label:(target.textContent||'').trim().slice(0,40) }
        : target;
      candidates[currentField] = [entry, ...candidates[currentField].filter(c=>(c.el||c)!==target)];
      candidates[currentField+'Idx'] = 0;
      applyCandidate(currentField);
      updateOkButton(); clearHighlight(); stopPicking();
    }

    function onPickKeydown(e) { if(e.key==='Escape'){e.preventDefault();e.stopPropagation();stopPicking();} }
    function onGlobalKey(e)   { if(e.key==='Escape'&&!active){e.preventDefault();close();} }

    /* ── Draggable ── */
    function makeDraggable(panel, handle) {
      let ox=0,oy=0,sR=0,sT=0;
      handle.addEventListener('mousedown', e => {
        if(e.target.tagName==='BUTTON') return;
        e.preventDefault(); sR=parseFloat(panel.style.right)||20; sT=parseFloat(panel.style.top)||20; ox=e.clientX; oy=e.clientY;
        const onMove=ev=>{panel.style.right=Math.max(0,sR-(ev.clientX-ox))+'px';panel.style.top=Math.max(0,sT+(ev.clientY-oy))+'px';};
        const onUp=()=>{document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);};
        document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp);
      });
    }

    async function commitEntry() {
      const nameVal = getVal('name')||location.hostname, urlVal=getVal('url'), peVal=getVal('pageElement'), nlVal=getVal('nextLink');
      try { new RegExp(urlVal); } catch { return; }
      if (!peVal||!nlVal) return;
      const isCSS = s => { try { document.querySelector(s); return true; } catch { return false; } };
      const entry = { name:nameVal, url:urlVal, exampleUrl:location.href, pageElement:isCSS(peVal)?null:peVal, pageElementSelector:isCSS(peVal)?peVal:null, nextLink:isCSS(nlVal)?null:nlVal, nextLinkSelector:isCSS(nlVal)?nlVal:null, source:'local', created_by:'local_user' };
      const btn = shadow?.querySelector('#nap-btn-ok');
      if(btn){btn.disabled=true;btn.textContent='Saving…';}
      try {
        const result = await nap.send('siteinfo:add_entry', { entry });
        if (result?.ok) { if(btn){btn.textContent='✓ Saved!';btn.style.cssText='background:#38bdf8;color:#0f172a;';} setTimeout(close,1000); }
        else { showHint('✗ '+(result?.error||'Save failed')); shadow?.querySelector('#nap-hint')?.classList.add('err'); if(btn){btn.disabled=false;btn.textContent='Add to Database';} }
      } catch(err) { showHint('✗ '+err.message); shadow?.querySelector('#nap-hint')?.classList.add('err'); if(btn){btn.disabled=false;btn.textContent='Add to Database';} }
    }

    function open() { if(host&&document.documentElement.contains(host)) return; buildUI(); }

    function close() {
      stopPicking(); removeOverlay(); clearTimeout(highlightTimer);
      document.removeEventListener('keydown', onGlobalKey, true);
      if(host){host.remove();host=null;shadow=null;}
      candidates.pageElement=[]; candidates.nextLink=[]; candidates.pageElementIdx=0; candidates.nextLinkIdx=0;
      fieldMode.pageElement='auto'; fieldMode.nextLink='auto';
    }

    return { open, close };
  })();
})();
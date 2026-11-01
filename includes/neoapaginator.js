'use strict';

(function NAPContent() {
  if (window.name === 'neoapaginator-request-iframe') return;
  if (window.NAPed?.already) return;
  if (document.documentElement?.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;

  const BAR_TERMINATION_DELAY = 20000;
  const SCROLL_THROTTLE_MS    = 150;
  const LOAD_DELAY_BASE       = 500;
  const RETRY_BASE            = 2.3;
  const RETRY_ZERO_SHIFT      = 0.25;
  const RETRY_MAX             = 2;

  const state = {
    active:              false,
    loading:             false,
    terminated:          false,
    pageNumber:          1,
    nextUrl:             null,
    prevUrl:             null,
    reversed:            false,
    rule:                null,
    config:              {},
    contentParent:       null,
    contentInsertBefore: null,
    requestedUrls:       new Set(),
    loadedHashes:        new Set(),
    barEl:               null,
    barCSS:              '',
    retryBtnEl:          null,
    reverseBtnEl:        null,
    scrollTimer:         null,
    barTermTimer:        null,
    firstPageEl:         null,
    lastPageEl:          null,
    ajaxStartTime:       Date.now(),
    ajaxLastUrl:         '',
    ajaxLoadDelay:       LOAD_DELAY_BASE,
    ajaxLoadCount:       0,
    retryCount:          0,
    nextLinkMask:        null,
  };

  /* ── Logging ────────────────────────────────────────────────────────── */
  const log = {
    badge:      '%c[NeoAutoPaginator]',
    badgeStyle: 'background:#6366f1;color:#fff;padding:2px 5px;border-radius:3px;font-weight:bold;',
    info  (...a) { if (state.config.debug_mode) console.info (this.badge, this.badgeStyle, ...a); },
    debug (...a) { if (state.config.debug_mode) console.debug(this.badge, 'background:#334155;color:#94a3b8;padding:2px 4px;border-radius:3px;', ...a); },
    warn  (...a) { if (state.config.debug_mode) console.warn (this.badge, 'background:#f59e0b;color:#000;padding:2px 4px;border-radius:3px;', ...a); },
    error (...a) { if (state.config.debug_mode) console.error(this.badge, 'background:#ef4444;color:#fff;padding:2px 4px;border-radius:3px;', ...a); },
  };

  /* ── Public event bus (window.NAPed) ────────────────────────── */
  const _handlers = {};
  function napOn(name, cb) {
    if (!name || !cb) return;
    if (_handlers[name]) document.removeEventListener('NeoAutoPaginator.' + name, _handlers[name], false);
    _handlers[name] = cb;
    document.addEventListener('NeoAutoPaginator.' + name, cb, false);
  }
  function napOff(name) {
    if (!name || !_handlers[name]) return;
    document.removeEventListener('NeoAutoPaginator.' + name, _handlers[name], false);
    delete _handlers[name];
  }
  function napTrigger(type, detail) {
    document.dispatchEvent(new CustomEvent('NeoAutoPaginator.' + type, { detail: detail || null }));
  }  

  Object.defineProperty(window, "NAPed", {
     value: {
      on: napOn, off: napOff, trigger: napTrigger,
      status: state,
      create_html: (src) => {
        const d = document.implementation.createHTMLDocument('');
        d.documentElement.innerHTML = src;
        return d;
      },
      get_node:   (doc, path) => doc.querySelector(path),
      get_node_x: (doc, path) =>
        doc.evaluate(path, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue,
      already: true
    },
    enumerable: false,
    writable: false,
    configurable: false
  });

  /* ── Startup ───────────────────────────────────────────────────────── */
  async function startup() {
    try {
      const response = await nap.send('init', {
        url:     location.href,
        isFrame: window.top !== window.self,
      });

      if (!response?.active) return;

      state.config = response.config || {};
      log.info(`Initializing on: ${location.href}`);

      const savedActive = await nap.send('session:get_toggle', { origin: location.origin });
      const wantActive  = typeof savedActive?.active === 'boolean' ? savedActive.active
        : (state.config.auto_start !== false);

      const candidates = response.siteinfo || [];
      for (const candidate of candidates) {
        if (bindCandidateRule(candidate)) {
          state.rule = candidate;
          log.info(`Bound Rule [${candidate.id || 'mf'}] ("${candidate.name || candidate.url}")`);
          await nap.send('stat:hit', { id: candidate.id });
          break;
        }
      }

      if (!state.rule) {
        log.warn('No SITEINFO rules matched the current page');
        return;
      }
      
      if (response.css) injectCSS(response.css, 'nap-core-css');
      state.barCSS = response.barCSS || '';

      state.requestedUrls.add(location.href);

      if (state.config.check_hash) {
        const initialNodes = findMainContent(document, state.rule);
        if (initialNodes.length) {
          const h = await computeNodesHash(initialNodes);
          state.loadedHashes.add(h);
        }
      }

      napOn('reset',      onEvtReset);
      napOn('state',      onEvtState);
      napOn('toggle',     onEvtToggle);
      napOn('request',    onEvtRequest);
      napOn('load',       onEvtLoad);
      napOn('append',     onEvtAppend);
      napOn('error',      onEvtError);
      napOn('terminated', onEvtTerminated);
      napOn('pageloaded', onEvtPageLoaded);
      napOn('update',     getRemHeight);

      if (state.config.bar_status) createStatusBar();

      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });

      window.NAPed.already = true;
      napTrigger('initialized', state);
      napTrigger('ready');

      if (state.rule.jsPatch && (state.rule.allowScripts || state.config.allow_scripts)) {
        injectScript(state.rule.jsPatch);
      }

      toggleState(wantActive);
    } catch (e) {
      log.error('Startup error:', e);
    }
  }

  /* ── Rule binding ──────────────────────────────────────────────────── */
  function bindCandidateRule(rule) {
    if (rule.nextLink && rule.nextLink.includes('|') && rule.nextLink.startsWith('http')) {
      state.nextLinkMask = rule.nextLink;
      const parts   = rule.nextLink.split('|');
      const step    = parseInt(parts[1], 10) || 1;
      const m       = /\d+/.exec(location.href.replace(parts[0] || '').replace(parts[2] || ''));
      state.pageNumber = m ? Math.floor(parseInt(m[0], 10) / step) : 1;
      state.nextUrl    = buildMaskUrl(state.nextLinkMask, state.pageNumber + 1);
    } else {
      const nextNode = findLink(document, rule.nextLinkSelector || rule.nextLink);
      if (!nextNode) return false;
      state.nextUrl = extractHref(nextNode);
      if (!state.nextUrl) return false;

      const prevNode = findLink(document, rule.prevLinkSelector || rule.prevLink);
      if (prevNode) state.prevUrl = extractHref(prevNode);
    }

    const content = findMainContent(document, rule);
    if (!content.length) return false;

    state.firstPageEl = content[0];
    state.lastPageEl  = content[content.length - 1];
    state.contentParent = state.lastPageEl.parentNode;

    if (rule.insertBefore) {
      try { state.contentInsertBefore = nap.query(document, rule.insertBefore); }
      catch { state.contentInsertBefore = null; }
    }
    if (!state.contentInsertBefore) {
      state.contentInsertBefore = state.lastPageEl.nextSibling;
    }

    if (rule.cssPatch) injectCSS(rule.cssPatch, 'nap-site-patch-css');

    getRemHeight();

    return true;
  }

  function buildMaskUrl(mask, pageNum) {
    const parts = mask.split('|');
    const step  = parseInt(parts[1], 10) || 1;
    return (parts[0] || '') + (pageNum * step) + (parts[2] || '');
  }

  /* ── Helpers ───────────────────────────────────────────────────────── */
  function findLink(doc, selectorOrXPath) {
    if (!selectorOrXPath) return null;
    try { return doc.querySelector(selectorOrXPath) || nap.query(doc, selectorOrXPath); }
    catch { return nap.query(doc, selectorOrXPath); }
  }

  function findMainContent(doc, rule) {
    if (rule.pageElementSelector) {
      try { const e = Array.from(doc.querySelectorAll(rule.pageElementSelector)); if (e.length) return e; } catch {}
    }
    if (rule.pageElement) {
      try { return nap.queryAll(doc, rule.pageElement); } catch {}
    }
    return [];
  }

  function extractHref(node) {
    if (!node) return null;
    const raw = node.getAttribute?.('href') || node.getAttribute?.('action') || node.value || node.href;
    if (!raw || raw.startsWith('javascript:') || raw === '#') return null;
    try { return new URL(raw, location.href).href; } catch { return null; }
  }

  function injectCSS(cssText, id) {
      if (!cssText) return;
      let style = document.getElementById(id);
      if (!style) {
          style = document.createElement('style');
          style.id = id;
          (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = cssText;
  }

  function injectScript(text) {
    if (typeof text !== 'string' || text.length < 2) return;
    text = `if(window.NAPed&&!window.NAPed.js_patched){window.NAPed.js_patched=true;\n${text}\n}`;
    try {
      const s = document.createElement('script');
      s.textContent = text;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) { log.error('Script injection error:', e); }
  }

  async function computeNodesHash(nodes) {
    const sig = nodes.map(n => (n.textContent || '').trim().slice(0, 500)).join('|');
    return nap.digest(sig);
  }

  /* ── Distance to page bottom ──────────────────────────────────────────────── */
  function getRootNode() {
    return document.compatMode === 'BackCompat' ? document.body : document.documentElement;
  }

  function calcRemHeight(target) {
    const base = state.config.remaining_height || 900;
    const root = getRootNode();
    let bottom = null;
    let t = target;

    while (t) {
      if (typeof t.getBoundingClientRect === 'function') {
        const r = t.getBoundingClientRect();
        if (r && !(r.top === 0 && r.right === 0 && r.bottom === 0 && r.left === 0)) {
          bottom = r.top + window.scrollY;
          break;
        }
      }
      t = t.nextSibling || null;
    }

    if (bottom === null && state.lastPageEl?.getBoundingClientRect) {
      const r = state.lastPageEl.getBoundingClientRect();
      if (r) bottom = r.bottom + window.scrollY;
    }
    if (bottom === null && state.contentParent?.getBoundingClientRect) {
      const r = state.contentParent.getBoundingClientRect();
      if (r) bottom = r.bottom + window.scrollY;
    }
    if (bottom === null) bottom = Math.round(root.scrollHeight * 0.8);

    const raw = root.scrollHeight - bottom + base;
    // Sanity clamp: remaining-height should never approach the full document
    // height — that would mean "always trigger regardless of scroll position."
    return Math.ceil(Math.max(0, Math.min(raw, root.scrollHeight * 0.5)));
  }

  let _remHeight = 0;
  function getRemHeight() {
    _remHeight = calcRemHeight(state.contentInsertBefore);
  }


  /* ── Toggle / terminate ────────────────────────────────────────────── */
  function toggleState(forceState) {
    if (state.terminated) { log.warn('Terminated'); return; }
    state.active = typeof forceState === 'boolean' ? forceState : !state.active;

    nap.send('session:set_toggle', { origin: location.origin, active: state.active });

    if (state.active) { setBarClass('autopager_on');  verifyScrollAndLoad(); }
    else               setBarClass('autopager_off');
  }

  function terminate(reason) {
    state.active     = false;
    state.loading    = false;
    state.terminated = true;
    state.nextUrl    = null;
    setBarClass('autopager_terminated');
    log.warn(`Terminated: ${reason}`);

    napTrigger('terminated', { message: reason });

    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    teardownPageObserver();

    if (state.barEl) {
      state.barTermTimer = setTimeout(() => {
        if (state.barEl) { state.barEl.remove(); state.barEl = null; }
      }, BAR_TERMINATION_DELAY);
    }
  }

  /* ── Public event handlers ────────────────────────────────────────── */
  function onEvtReset() {
    teardownPageObserver();
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    napOff('reset'); napOff('state'); napOff('toggle'); napOff('request');
    napOff('load'); napOff('append'); napOff('error'); napOff('terminated');
    napOff('pageloaded'); napOff('update');
  
    state.barEl?.remove();
    Object.assign(state, {
      active: false, loading: false, terminated: false, pageNumber: 1,
      nextUrl: null, prevUrl: null, reversed: false, rule: null,
      contentParent: null, contentInsertBefore: null, barEl: null,
      retryBtnEl: null, reverseBtnEl: null, firstPageEl: null, lastPageEl: null,
      retryCount: 0, nextLinkMask: null,
    });
    state.requestedUrls.clear();
    state.loadedHashes.clear();
  
    delete window.NAPed.already;
    startup();
  }

  function onEvtState(ev) {
    if (!ev.detail) return;
    if (ev.detail.state) toggleState(true); else toggleState(false);
  }

  function onEvtToggle() {
    if (state.active) toggleState(false); else { toggleState(true); verifyScrollAndLoad(); }
  }

  function onEvtRequest(ev) {
    if (state.loading || !state.active) return;
    const url = ev.detail?.link || state.nextUrl;
    if (url) loadNextPage(url);
  }

  function onEvtLoad(ev) {
    if (!ev.detail) return;
    const { htmlDoc, url } = ev.detail;
    if (!htmlDoc) { napTrigger('error', { message: 'no document in load event' }); return; }
    try { processLoadedDoc(htmlDoc, url); }
    catch (e) { log.error('processLoadedDoc failed:', e); napTrigger('error', { message: e.message }); }
  }

  function onEvtAppend(ev) {
    if (!ev.detail?.nodes?.length) { napTrigger('error', { message: 'no nodes in append event' }); return; }
    doAppend(ev.detail.nodes, ev.detail.url, ev.detail.title)
      .catch(e => { log.error('doAppend failed:', e); napTrigger('error', { message: e.message }); });
  }

  function onEvtError(ev) {
    log.error('Error event:', ev.detail?.message);
    nap.send('stat:fail', { id: state.rule?.id });
    setBarClass('autopager_error');
    if (state.retryBtnEl) state.retryBtnEl.classList.remove('nap-hidden');
    state.active  = false;
    state.loading = false;
  }

  function onEvtTerminated(ev) {
    state.active  = false;
    state.loading = false;
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    teardownPageObserver();
    if (state.barEl) {
      setBarClass('autopager_terminated');
      clearTimeout(state.barTermTimer);
      state.barTermTimer = setTimeout(() => {
        state.barEl?.remove(); state.barEl = null;
      }, BAR_TERMINATION_DELAY);
    }
  }

   function onEvtPageLoaded() {
     state.loading = false;
     setBarClass(state.active ? 'autopager_on' : 'autopager_off');
   
     // Wait for DOM reflow before checking scroll position
     // Use requestAnimationFrame twice to ensure paint + reflow complete
     requestAnimationFrame(() => {
       requestAnimationFrame(() => {
         verifyScrollAndLoad();
       });
     });
   }

  /* ── Scroll ────────────────────────────────────────────────────────── */
  function onScroll() {
    if (state.scrollTimer) return;
    state.scrollTimer = setTimeout(() => { state.scrollTimer = null; verifyScrollAndLoad(); }, SCROLL_THROTTLE_MS);
  }

  function verifyScrollAndLoad() {
    if (!state.active || state.loading || state.terminated || !state.nextUrl) return;
    const docH    = getRootNode().scrollHeight;
    const scrollB = window.innerHeight + window.scrollY;
    if (docH - scrollB <= _remHeight) napTrigger('request', { link: state.nextUrl });
  }


  /* ── Fetch ─────────────────────────────────────────────────────────── */
  function getRetryDelay(attempt) {
    return (Math.pow(RETRY_BASE, attempt) - RETRY_ZERO_SHIFT) * 1000;
  }
  
  class FetchError extends Error {
    constructor(message, { status, retryAfterMs = null, cause } = {}) {
      super(message, { cause });
  
      this.name = "FetchError";
      this.status = status;
      this.retryAfterMs = retryAfterMs;
    }
  
    static fromResponse(response) {
      const retryAfterMs = FetchError.parseRetryAfter(response.headers.get("Retry-After"));
      return new FetchError( `HTTP ${response.status}`, { status: response.status, retryAfterMs });
    }
  
    static parseRetryAfter(value) {
      if (value == null || value.trim() === "") return null;
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
      }
      const timestamp = Date.parse(value);
      return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - Date.now());
    }
  }

  async function fetchPageDocument(url) {
    let res = await (content?.fetch ?? fetch)(url, { credentials: 'include' });
    if (!res.ok) throw FetchError.fromResponse(res);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  function fetchWithIFrame(url) {
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.name    = 'neoapaginator-request-iframe';
      frame.style.cssText = 'display:none!important';
      frame.sandbox = 'allow-same-origin' + (state.rule.allowScripts ? ' allow-scripts' : '');
      const t = setTimeout(() => { frame.remove(); reject(new Error('IFrame timed out')); }, 30000);
      frame.onload  = () => { clearTimeout(t); const d = frame.contentDocument; frame.remove(); d ? resolve(d) : reject(new Error('No iframe doc')); };
      frame.onerror = (e) => { clearTimeout(t); frame.remove(); reject(e); };
      frame.src = url;
      document.body.appendChild(frame);
    });
  }

  /* ── Load next page ────────────────────────────────────────────────── */
  function isSameSite(url) {
    try {
      const target = new URL(url, location.href);
      if (target.origin === location.origin) return true;
      if (state.rule.allowCrossOrigin) return true;
      return false;
    } catch { return false; }
  }
  
  async function loadNextPage(targetUrl, force = false) {
    if (state.loading && !force || !state.active || state.terminated) return;
    targetUrl = targetUrl || state.nextUrl;
    if (!targetUrl) return;

    if (state.requestedUrls.has(targetUrl)) {
      terminate(`Cyclic pagination detected: ${targetUrl}`);
      return;
    }

    if (!isSameSite(targetUrl)) {
      terminate(`Refused cross-origin next link: ${targetUrl}`);
      return;
    }

    if (!state.loading) setBarClass('autopager_loading');
    state.loading    = true;
    state.ajaxStartTime = Date.now();
    state.ajaxLastUrl   = targetUrl;
    state.requestedUrls.add(targetUrl);
    log.info(`Loading page ${state.pageNumber + 1}: ${targetUrl}`);

    try {
      const doc = state.rule.forceIframe
        ? await fetchWithIFrame(targetUrl)
        : await fetchPageDocument(targetUrl);

      napTrigger('load', { htmlDoc: doc, url: targetUrl });
    } catch (err) {
      log.error('Fetch error:', err.message);
      if (state.retryCount < RETRY_MAX) {
        let delay = getRetryDelay(state.retryCount);
        if ([429, 500, 502, 503, 504].includes(err.status)) {
            delay = err.retryAfterMs || LOAD_DELAY_BASE * 10; // delay rate-limit hit more
            log.info('Delay changed to:', delay);
        }
        state.retryCount++;
        state.requestedUrls.delete(targetUrl);
        setTimeout(() => loadNextPage(targetUrl, true), delay);
      } else {
        state.retryCount = 0;
        napTrigger('error', { message: err.message });
        state.loading = false;
      }
    }
  }

  /* ── Process loaded document ──────────────────────────────────────── */
  function processLoadedDoc(doc, loadedUrl) {
    doc.querySelectorAll('script').forEach(s => s.remove());

    const content = findMainContent(doc, state.rule);
    if (!content.length) {
      napTrigger('error', { message: 'pageElement not found in loaded doc' });
      return;
    }

    let nextHref = null;
    if (state.nextLinkMask) {
      nextHref = buildMaskUrl(state.nextLinkMask, state.pageNumber + 2);
    } else {
      const selector = state.reversed
        ? (state.rule.prevLinkSelector || state.rule.prevLink)
        : (state.rule.nextLinkSelector || state.rule.nextLink);
      const nextNode = findLink(doc, selector);
      nextHref = nextNode ? extractHref(nextNode) : null;
    }

    const titleNode = doc.querySelector('title');
    const title     = titleNode ? titleNode.textContent.trim() : '';

    state.pageNumber++;
    document.nappagenumber = (document.nappagenumber || 1) + 1;

    napTrigger('append', { nodes: content, url: loadedUrl, title });

    state.nextUrl = nextHref;
    if (!nextHref) {
      terminate('No next link found after loading page');
    }
  }

  /* ── Append ────────────────────────────────────────────────────────── */
  function getLoadDelay() {
    const elapsed = Date.now() - state.ajaxStartTime;
    const cur     = LOAD_DELAY_BASE + Math.abs(elapsed);
    const smooth  = state.ajaxLoadCount < 11 ? 1 - 1 / Math.max(state.ajaxLoadCount, 1) : -1;
    if (smooth >= 0 && Math.abs(cur - state.ajaxLoadDelay) < 2000 && cur < 4000) {
      state.ajaxLoadDelay = Math.ceil((cur * smooth + state.ajaxLoadDelay * (1 - smooth)) / 100) * 100;
    }
    return state.ajaxLoadDelay;
  }

  let _pageObserver = null;

  function getPageObserver() {
    if (_pageObserver) return _pageObserver;

    _pageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const zoneBottom = window.innerHeight * 0.6;
          const crossed = entry.isIntersecting || entry.boundingClientRect.bottom < zoneBottom;
          if (!crossed) continue;
    
          const url   = entry.target.dataset.napUrl;
          const title = entry.target.dataset.napTitle;
          if (url) {
            history.replaceState(null, title || '', url);
            if (title) document.title = title;
          }
          _pageObserver.unobserve(entry.target);
        }
      },
      {
        rootMargin: '50% 0px -40% 0px',
        threshold: 0,
      }
    );

    return _pageObserver;
  }

  function observePageBoundary(el, url, title) {
    if (!el || !url) return;
    el.dataset.napUrl   = url;
    el.dataset.napTitle = title || '';
    getPageObserver().observe(el);
  }

  function teardownPageObserver() {
    if (_pageObserver) { _pageObserver.disconnect(); _pageObserver = null; }
  }

  async function doAppend(nodes, pageUrl, pageTitle) {
    if (!nodes) return;

    if (state.config.check_hash) {
      const hash = await computeNodesHash(nodes);
      if (state.loadedHashes.has(hash)) {
        terminate(`Duplicate page content hash: ${hash.slice(0, 8)}`);
        return;
      }
      state.loadedHashes.add(hash);
    }

    const fragment      = document.createDocumentFragment();
    const insertedNodes = [];

    // The separator (or first content node if separators disabled) becomes
    // the boundary marker that the observer watches.
    let boundaryEl = null;

    if (!state.rule.disableSeparator) {
      const sep = createSeparator(state.pageNumber, pageUrl, pageTitle);
      fragment.appendChild(sep);
      boundaryEl = sep;
    }

    for (const node of nodes) {
      const imported = document.importNode(node, true);
      if (state.rule.removeElement) removeNodes(imported, state.rule.removeElement);
      parseImages(imported, pageUrl);
      parseLinks(imported, pageUrl);
      imported.setAttribute('data-nap-page', state.pageNumber);

      if (!boundaryEl) boundaryEl = imported;

      fragment.appendChild(imported);
      insertedNodes.push(imported);
    }

    state.contentParent.insertBefore(fragment, state.contentInsertBefore);

    if (insertedNodes.length) {
      state.lastPageEl = insertedNodes[insertedNodes.length - 1];
    }

    if ((state.config.change_address ^ state.rule.forceAddressChange) && boundaryEl) {
      observePageBoundary(boundaryEl, pageUrl, pageTitle);
    }

    for (const n of insertedNodes) {
      n.dispatchEvent(new CustomEvent('AutoPagerize_DOMNodeInserted', { bubbles: true }));
      n.dispatchEvent(new CustomEvent('NeoAutoPaginator.DOMNodeInserted', {
        bubbles: true, detail: { url: pageUrl }
      }));
    }

    state.retryCount    = 0;
    state.ajaxLoadCount++;
    log.info(`Appended page ${state.pageNumber} (${nodes.length} elements)`);

    setTimeout(
      () => napTrigger('pageloaded', { content: state.rule.pageElementSelector || state.rule.pageElement }),
      getLoadDelay()
    );
  }

  /* ── Separator ─────────────────────────────────────────────────────── */
  function createSeparator(pageNum, url, title) {
    const parent = state.contentParent?.localName?.toLowerCase();
    let root, container;

    if (parent === 'tbody') {
      root = document.createElement('tr');
      container = document.createElement('td');
      container.setAttribute('colspan', '100');
      root.appendChild(container);
    } else if (parent === 'ul' || parent === 'ol') {
      root = container = document.createElement('li');
    } else {
      root = container = document.createElement('div');
    }

    container.className = 'autopagerize_page_separator_blocks';

    const h4   = document.createElement('h4');   h4.className = 'autopagerize_page_separator';
    const span = document.createElement('span'); span.className = 'autopagerize_page_info';
    const a    = document.createElement('a');
    a.className = 'autopagerize_link';
    a.href      = url;
    a.target    = '_blank';
    a.rel       = 'noopener noreferrer';
    a.setAttribute('number', pageNum);
    if (title) a.setAttribute('title', title);

    span.appendChild(a); h4.appendChild(span); container.appendChild(h4);
    return root;
  }

  /* ── Image / link fixing ───────────────────────────────────────────── */
  function parseImages(node, baseUrl) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    const imgs = [...(node.matches?.('img,source') ? [node] : []), ...(node.querySelectorAll?.('img,source') || [])];

    for (const img of imgs) {
      if (state.config.try_correct_lazy) {
        if (img.hasAttribute('loading')) img.setAttribute('loading', 'eager');
        for (const attr of img.attributes) {
          if (!attr.name.startsWith('data-')) continue;
          if (/\.(?:jpe?g|a?png|gif|svg|webp|avif)(?:[?#]|$)/i.test(attr.value)) {
            img.setAttribute('src', attr.value); break;
          }
        }
        const lazySrcset = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
        if (lazySrcset) img.setAttribute('srcset', lazySrcset);
      }
      if (state.config.force_absolute_img_srcs) {
        const src = img.getAttribute('src');
        if (src) { try { img.setAttribute('src', new URL(src, baseUrl).href); } catch {} }
        const srcset = img.getAttribute('srcset');
        if (srcset) img.setAttribute('srcset', fixSrcset(srcset, baseUrl));
      }
    }
  }

  function fixSrcset(srcset, base) {
    return srcset.split(',').map(c => {
      c = c.trim(); if (!c) return '';
      const m = c.match(/^(\S+)(.*)/);
      if (!m) return c;
      try { return new URL(m[1], base).href + m[2]; } catch { return c; }
    }).filter(Boolean).join(', ');
  }

  function parseLinks(node, baseUrl) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    const links = [...(node.matches?.('a') ? [node] : []), ...(node.querySelectorAll?.('a') || [])];
    for (const a of links) {
      const href = a.getAttribute('href');
      if (state.config.target_blank && href && !/^(?:javascript|mailto|data|tel|sms|geo|magnet)\s*:/i.test(href) && !href.startsWith('#') && !a.target) {
        a.target = '_blank'; a.rel = 'noopener noreferrer';
      }
      if (state.config.force_absolute_hrefs && href) {
        try { a.setAttribute('href', new URL(href, baseUrl).href); } catch {}
      }
    }
  }

  function removeNodes(root, sel) {
    if (!root || !sel) return;
    try { root.querySelectorAll(sel).forEach(n => n.remove()); return; } catch {}
    try {
      const r = (root.ownerDocument || root).evaluate(sel, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < r.snapshotLength; i++) r.snapshotItem(i)?.remove();
    } catch (e) { log.warn(`removeNodes failed for "${sel}":`, e.message); }
  }

  /* ── Status bar ────────────────────────────────────────────────────── */
  function setBarClass(cls) {
    if (state.barEl) state.barEl.className = cls;
  }

  function createStatusBar() {
    if (state.barEl || document.getElementById('neoapaginator_bar')) return;

    const host = document.createElement('div');
    host.id = 'neoapaginator_bar_host';
    host.setAttribute('style', [
      'all:initial', 'position:fixed', 'bottom:0', 'right:0',
      'width:0', 'height:0', 'overflow:visible',
      'pointer-events:none', 'z-index:2147483647', 'display:block'
    ].map(s => s + '!important').join(';') + '!important');
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = state.barCSS;
    shadow.appendChild(style);

    const bar = document.createElement('div');
    bar.id        = 'neoapaginator_bar';
    bar.className = 'autopager_off';

    const panel = document.createElement('div');
    panel.id = 'nap-bar-panel';

    const btnToggle = mkBarBtn('bar_onoff', SVG_POWER, e => {
      e.stopPropagation();
      if (e.shiftKey) {
        nap.send('siteinfo:update_entry', { id: state.rule?.id, info: { auto_start: !state.active } });
      }
      napTrigger('toggle');
    });

    const btnImgRefresh = mkBarBtn('bar_img_refresh', SVG_IMAGE, e => {
      e.stopPropagation();
      refreshImages(e.shiftKey);
    });

    const btnReverse = mkBarBtn('bar_reverse', SVG_REVERSE, e => {
      e.stopPropagation();
      swapDirections();
    });
    state.reverseBtnEl = btnReverse;
    if (!state.prevUrl) btnReverse.classList.add('nap-hidden');

    const btnRetry = mkBarBtn('bar_retry', SVG_RETRY, e => {
      e.stopPropagation();
      clearTimeout(state.barTermTimer);
      if (state.terminated) state.terminated = false;
      btnRetry.classList.add('nap-hidden');
      state.loading    = false;
      state.active     = true;
      state.retryCount = 0;
      setBarClass('autopager_on');
      state.requestedUrls.clear();
      napTrigger('request', { link: state.nextUrl });
    });
    btnRetry.classList.add('nap-hidden');
    state.retryBtnEl = btnRetry;

    const btnOption    = mkBarBtn('bar_option',  SVG_GEAR,    e => {
      e.stopPropagation();
      nap.send('open:options');  
    });
    const btnManager = mkBarBtn('bar_manager', SVG_MANAGER, e => {
      e.stopPropagation();
      nap.send('open:manager', { ruleId: state.rule?.id ?? null });
    });

    panel.append(btnToggle, btnImgRefresh, btnReverse, btnRetry, btnOption, btnManager);

    const loader = document.createElement('div');
    loader.id = 'nap-loader';
    loader.innerHTML = '<span></span><span></span><span></span>';

    bar.appendChild(panel);
    bar.appendChild(loader);
    shadow.appendChild(bar);

    state.barEl    = bar;
    state._barHost = host;
  }

  function mkBarBtn(id, svg, onClick) {
    const btn   = document.createElement('button');
    btn.type    = 'button';
    btn.id      = id;
    btn.innerHTML = svg;
    btn.onclick = onClick;
    return btn;
  }

  /* ── SVGs ──────────────────────────────────────────────────────────── */
  const SVG_POWER   = `<svg viewBox="0 0 1792 1792"><path d="M1664 896q0 156-61 298t-164 245-245 164-298 61-298-61-245-164-164-245-61-298q0-182 80.5-343t226.5-270q43-32 95.5-25t83.5 50q32 42 24.5 94.5t-49.5 84.5q-98 74-151.5 181t-53.5 228q0 104 40.5 198.5t109.5 163.5 163.5 109.5 198.5 40.5 198.5-40.5 163.5-109.5 109.5-163.5 40.5-198.5q0-121-53.5-228t-151.5-181q-42-32-49.5-84.5t24.5-94.5q31-43 84-50t95 25q146 109 226.5 270t80.5 343zm-640-768v640q0 52-38 90t-90 38-90-38-38-90v-640q0-52 38-90t90-38 90 38 38 90z"/></svg>`;
  const SVG_IMAGE   = `<svg viewBox="0 0 1792 1792"><path d="M576 576q0 80-56 136t-136 56-136-56-56-136 56-136 136-56 136 56 56 136zm1024 384v448h-1408v-192l320-320 160 160 512-512zm96-704h-1600q-13 0-22.5 9.5t-9.5 22.5v1216q0 13 9.5 22.5t22.5 9.5h1600q13 0 22.5-9.5t9.5-22.5v-1216q0-13-9.5-22.5t-22.5-9.5zm160 32v1216q0 66-47 113t-113 47h-1600q-66 0-113-47t-47-113v-1216q0-66 47-113t113-47h1600q66 0 113 47t47 113z"/></svg>`;
  const SVG_REVERSE = `<svg viewBox="0 0 1792 1792"><path d="M1683 141q19-19 32-13t13 32v1472q0 26-13 32t-32-13l-710-710q-8-9-13-19v710q0 26-13 32t-32-13l-710-710q-19-19-19-45t19-45l710-710q19-19 32-13t13 32v710q5-11 13-19z"/></svg>`;
  const SVG_RETRY   = `<svg viewBox="0 0 1792 1792"><path d="M1639 1056q0 5-1 7-64 268-268 434.5t-478 166.5q-146 0-282.5-55t-243.5-157l-129 129q-19 19-45 19t-45-19-19-45v-448q0-26 19-45t45-19h448q26 0 45 19t19 45-19 45l-137 137q71 66 161 102t187 36q134 0 250-65t186-179q11-17 53-117 8-23 30-23h192q13 0 22.5 9.5t9.5 22.5zm25-800v448q0 26-19 45t-45 19h-448q-26 0-45-19t-19-45 19-45l138-138q-148-137-349-137-134 0-250 65t-186 179q-11 17-53 117-8 23-30 23h-199q-13 0-22.5-9.5t-9.5-22.5v-7q65-268 270-434.5t480-166.5q146 0 284 55.5t245 156.5l130-129q19-19 45-19t45 19 19 45z"/></svg>`;
  const SVG_GEAR    = `<svg viewBox="0 0 1792 1792"><path d="M1152 896q0-106-75-181t-181-75-181 75-75 181 75 181 181 75 181-75 75-181zm512-109v222q0 12-8 23t-20 13l-185 28q-19 54-39 91 35 50 107 138 10 12 10 25t-9 23q-27 37-99 108t-94 71q-12 0-26-9l-138-108q-44 23-91 38-16 136-29 186-7 28-36 28h-222q-14 0-24.5-8.5t-11.5-21.5l-28-184q-49-16-90-37l-141 107q-10 9-25 9-14 0-25-11-126-114-165-168-7-10-7-23 0-12 8-23 15-21 51-66.5t54-70.5q-27-50-41-99l-183-27q-13-2-21-12.5t-8-23.5v-222q0-12 8-23t19-13l186-28q14-46 39-92-40-57-107-138-10-12-10-24 0-10 9-23 26-36 98.5-107.5t94.5-71.5q13 0 26 10l138 107q44-23 91-38 16-136 29-186 7-28 36-28h222q14 0 24.5 8.5t11.5 21.5l28 184q49 16 90 37l142-107q9-9 24-9 13 0 25 10 129 119 165 170 7 8 7 22 0 12-8 23-15 21-51 66.5t-54 70.5q26 50 41 98l183 28q13 2 21 12.5t8 23.5z"/></svg>`;
  const SVG_MANAGER = `<svg viewBox="0 0 1792 1792"><path d="M1664 1344v128q0 26-19 45t-45 19h-1408q-26 0-45-19t-19-45v-128q0-26 19-45t45-19h1408q26 0 45 19t19 45zm0-512v128q0 26-19 45t-45 19h-1408q-26 0-45-19t-19-45v-128q0-26 19-45t45-19h1408q26 0 45 19t19 45zm0-512v128q0 26-19 45t-45 19h-1408q-26 0-45-19t-19-45v-128q0-26 19-45t45-19h1408q26 0 45 19t19 45z"/></svg>`;

  /* ── Swap directions ──────────────────────────────────────────────── */
  function swapDirections() {
    if (!state.prevUrl) return;
    state.reversed      = !state.reversed;
    [state.nextUrl, state.prevUrl] = [state.prevUrl, state.nextUrl];
    state.loadedHashes.clear();
    state.requestedUrls.clear();
    state.requestedUrls.add(location.href);
    toggleState(true);
    log.info(`Direction swapped (reversed: ${state.reversed})`);
  }

  /* ── Refresh images ───────────────────────────────────────────────── */
  function refreshImages(forceAll) {
    let n = 0;
    document.querySelectorAll('img[src]').forEach(img => {
      if (forceAll || !img.complete || img.naturalWidth === 0) {
        try {
          const u = new URL(img.src, location.href);
          u.searchParams.set('_nap_ts', Date.now());
          img.src = u.href; n++;
        } catch {}
      }
    });
    log.info(`Refreshed ${n} image(s)`);
  }

  /* ── Picker bridge ─────────────────────────────────────────────────── */
  (function () {
    const br = globalThis.napBrowser || globalThis.browser || globalThis.chrome;
    br?.runtime?.onMessage?.addListener(msg => {
      if (msg?.type === 'nap:picker_open') window.NAPPicker?.open();
    });
  })();

  startup();
})();
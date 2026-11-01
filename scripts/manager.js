'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const RECORDS_PER_PAGE = 100;
  let pageIndex = 0;
  let allEntries = [];
  let filteredEntries = [];
  let currentSort = { key: 'misses', desc: true };

  const tbody = document.getElementById('siteinfo_tbody');
  const nav = document.getElementById('siteinfo_nav');
  const searchInput = document.getElementById('siteinfo_search_input');
  const loader = document.getElementById('loader');
  const siteinfoView = document.getElementById('siteinfo_view');
  const templateRow = document.getElementById('tmpl_siteinfo_body').firstElementChild;
  const fileInput = document.getElementById('import_file_input');

  init();

  async function init() {
    toggleLoader(true);
    try {
      const response = await nap.send('siteinfo:get');
      if (response && Array.isArray(response.siteinfo)) {
        allEntries = response.siteinfo.map(item => normalizeEntry(item, response.customInfo, response.stats));
        filteredEntries = [...allEntries];
        applyGlobalSort();
        renderNav();
        renderPage();
      }
    } catch (err) {
      console.error('[NAP Manager Error]', err);
    } finally {
      toggleLoader(false);
    }
  
    setupSearch();
    setupHeaderSorting();
    setupToolbar();
  
    const highlightId = new URLSearchParams(location.search).get('hl');
    if (highlightId) focusEntry(highlightId);
  }
  
  function focusEntry(id) {
    const entry = allEntries.find(e => e.id === id);
    if (!entry) return;
    searchInput.value = entry.id;
    searchInput.dispatchEvent(new Event('input'));
    setTimeout(() => {
      const row = tbody.querySelector('.btn-inspect')?.closest('tr');
      row?.classList.add('flash-success');
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => row?.classList.remove('flash-success'), 1200);
    }, 250); // wait for setupSearch's debounce to re-render
  }

  function normalizeEntry(item, customInfo = {}, stats = { hits: {}, fails: {} }) {
    const id = String(item.id || item['wedata.net.id'] || '');
    const custom = customInfo[id] || {};
    const data = item.data || item;

    return {
      id,
      source: item.source || 'remote',
      name: custom.name ?? item.name ?? data.name ?? data.url ?? `Rule #${id}`,
      url: custom.url ?? data.url ?? '',
      nextLink: custom.nextLink ?? data.nextLink ?? '',
      nextLinkSelector: custom.nextLinkSelector ?? data.nextLinkSelector ?? '',
      pageElement: custom.pageElement ?? data.pageElement ?? '',
      pageElementSelector: custom.pageElementSelector ?? data.pageElementSelector ?? '',
      insertBefore: custom.insertBefore ?? data.insertBefore ?? '',
      removeElement: custom.removeElement ?? data.removeElement ?? '',
      exampleUrl: custom.exampleUrl ?? item.exampleUrl ?? data.exampleUrl ?? '',
      cssPatch: custom.cssPatch ?? data.cssPatch ?? '',
      jsPatch: custom.jsPatch ?? data.jsPatch ?? '',
      created_at: item.created_at || '-',
      updated_at: item.updated_at || '-',
      created_by: item.created_by || item.author || 'wedata',
      resource_url: item.resource_url || (id ? `http://wedata.net/items/${id}` : ''),
      hits: stats.hits?.[id] || 0,
      misses: stats.fails?.[id] || 0,
      disabled: Boolean(custom.disabled ?? data.disabled),
      disableSeparator: Boolean(custom.disableSeparator ?? data.disableSeparator),
      forceAddressChange: Boolean(custom.forceAddressChange ?? data.forceAddressChange),
      allowScripts: Boolean(custom.allowScripts ?? data.allowScripts),
      forceIframe: Boolean(custom.forceIframe ?? data.forceIframe),
      isModified: Object.keys(custom).length > 0
    };
  }

  function renderPage() {
    tbody.innerHTML = '';
    const start = pageIndex * RECORDS_PER_PAGE;
    const pageRecords = filteredEntries.slice(start, start + RECORDS_PER_PAGE);

    if (!pageRecords.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding: 32px; color: var(--text-muted);">No entries match the current search.</td></tr>`;
      return;
    }

    const fragment = document.createDocumentFragment();

    pageRecords.forEach((entry, idx) => {
      const tr = templateRow.cloneNode(true);
      tr.setAttribute('data-disabled', entry.disabled);
      tr.setAttribute('data-modified', entry.isModified);

      tr.querySelector('.cell-index').textContent = start + idx + 1;

      setupCheckbox(tr, '.cb-onoff', entry.disabled, async (val) => {
        entry.disabled = val;
        tr.setAttribute('data-disabled', val);
        await saveOverride(entry.id, { disabled: val });
      });

      setupCheckbox(tr, '.cb-nosep', entry.disableSeparator, async (val) => {
        entry.disableSeparator = val;
        await saveOverride(entry.id, { disableSeparator: val });
      });

      setupCheckbox(tr, '.cb-addr', entry.forceAddressChange, async (val) => {
        entry.forceAddressChange = val;
        await saveOverride(entry.id, { forceAddressChange: val });
      });

      setupCheckbox(tr, '.cb-scripts', entry.allowScripts, async (val) => {
        entry.allowScripts = val;
        await saveOverride(entry.id, { allowScripts: val });
      });

      setupCheckbox(tr, '.cb-iframe', entry.forceIframe, async (val) => {
        entry.forceIframe = val;
        await saveOverride(entry.id, { forceIframe: val });
      });

      const nameBtn = tr.querySelector('.btn-inspect');
      nameBtn.textContent = entry.name;
      nameBtn.onclick = () => openInspector(entry, false);

      tr.querySelector('.cell-created').textContent = formatDate(entry.created_at);
      tr.querySelector('.cell-updated').textContent = formatDate(entry.updated_at);
      tr.querySelector('.cell-author').textContent = entry.created_by;

      const resCell = tr.querySelector('.cell-res');
      if (entry.resource_url.startsWith('http')) {
        const a = document.createElement('a');
        a.href = entry.resource_url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.style.color = 'var(--accent)';
        a.textContent = entry.id;
        resCell.replaceChildren(a);
      } else {
        resCell.textContent = entry.id;
      }

      tr.querySelector('.cell-hits').textContent = entry.hits;
      tr.querySelector('.cell-misses').textContent = entry.misses;

      fragment.appendChild(tr);
    });

    tbody.appendChild(fragment);
  }

  function setupCheckbox(parent, selector, initialValue, onChange) {
    const cb = parent.querySelector(selector);
    cb.checked = Boolean(initialValue);
    cb.onchange = (e) => onChange(e.target.checked);
  }

  function renderNav() {
    nav.innerHTML = '';
    const totalPages = Math.ceil(filteredEntries.length / RECORDS_PER_PAGE);
    if (totalPages <= 1) return;

    for (let i = 0; i < totalPages; i++) {
      const li = document.createElement('li');
      if (i === pageIndex) li.className = 'active';
      const a = document.createElement('a');
      a.href = `#page=${i + 1}`;
      a.textContent = i + 1;
      a.onclick = (e) => {
        e.preventDefault();
        pageIndex = i;
        nav.querySelectorAll('li').forEach(el => el.classList.remove('active'));
        li.classList.add('active');
        renderPage();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
      li.appendChild(a);
      nav.appendChild(li);
    }
  }

  /* ==========================================================================
     Global Sorting Engine
     ========================================================================== */

  function setupHeaderSorting() {
    const mapping = {
      sort_name: 'name',
      sort_created_at: 'created_at',
      sort_updated_at: 'updated_at',
      sort_created_by: 'created_by',
      sort_resource_url: 'id',
      sort_hits: 'hits',
      sort_misses: 'misses'
    };

    for (const [btnId, fieldKey] of Object.entries(mapping)) {
      const btn = document.getElementById(btnId);
      if (!btn) continue;
      btn.onclick = () => {
        if (currentSort.key === fieldKey) {
          currentSort.desc = !currentSort.desc;
        } else {
          currentSort.key = fieldKey;
          // Natural default: strings A-Z (asc: false), numbers high-to-low (desc: true)
          currentSort.desc = ['id', 'hits', 'misses'].includes(fieldKey);
        }

        document.querySelectorAll('#siteinfo_head button').forEach(b => {
          b.className = '';
        });
        btn.className = currentSort.desc ? 'c-down' : 'c-up';

        applyGlobalSort();
        // Reset to page 1 so the top results are immediately visible
        pageIndex = 0;

        renderNav();
        renderPage();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
    }
  }

  function applyGlobalSort() {
    const { key, desc } = currentSort;

    const comparator = (a, b) => {
      let vA = a[key] ?? '';
      let vB = b[key] ?? '';

      if (key === 'id' || key === 'hits' || key === 'misses') {
        const nA = parseInt(vA, 10) || 0;
        const nB = parseInt(vB, 10) || 0;
        return desc ? nB - nA : nA - nB;
      }

      if (key === 'created_at' || key === 'updated_at') {
        const tA = Date.parse(vA) || 0;
        const tB = Date.parse(vB) || 0;
        return desc ? tB - tA : tA - tB;
      }

      return desc 
        ? String(vB).localeCompare(String(vA), undefined, { numeric: true, sensitivity: 'base' })
        : String(vA).localeCompare(String(vB), undefined, { numeric: true, sensitivity: 'base' });
    };

    // Sort BOTH lists so searching never resets sort order
    allEntries.sort(comparator);
    filteredEntries.sort(comparator);
  }

  function parseWedataClipboard(text) {
    if (!text || typeof text !== 'string') return null;
    let obj;
    try {
      obj = JSON.parse(text.trim().replace(/,\s*$/, ''));
    } catch (e) {
      console.error('[NAP JSON Import Error]', e);
      return null;
    }

    if (Array.isArray(obj)) {
      if (obj.length === 1 && typeof obj[0] === 'object') obj = obj[0];
      else return null;
    }

    if (!obj || typeof obj !== 'object') return null;

    const d = obj.data && typeof obj.data === 'object' ? obj.data : obj;

    if (!d.url || (!d.nextLink && !d.nextLinkSelector && !d.pageElement && !d.pageElementSelector)) {
      return null;
    }

    let id = obj['wedata.net.id'] || obj.id || '';
    if (!id && obj.resource_url) {
      const m = String(obj.resource_url).match(/items\/(\d+)/i);
      if (m) id = m[1];
    }

    return {
      id: id ? String(id) : '',
      name: obj.name || d.name || d.exampleUrl || d.url || '',
      url: d.url || '',
      exampleUrl: d.exampleUrl || '',
      nextLink: d.nextLink || '',
      nextLinkSelector: d.nextLinkSelector || '',
      pageElement: d.pageElement || '',
      pageElementSelector: d.pageElementSelector || '',
      insertBefore: d.insertBefore || d.insertBeforeSelector || '',
      removeElement: d.removeElement || '',
      cssPatch: d.cssPatch || d.Stylish || '',
      jsPatch: d.jsPatch || ''
    };
  }

  /* ==========================================================================
     Inspector / Add / Edit Modal
     ========================================================================== */

  function openInspector(entry, isNew = false) {
    siteinfoView.innerHTML = `
      <div class="inspector-card">
        <div class="inspector-header">
          <div style="display:flex; align-items:center; gap:10px;">
            <h2>${isNew ? 'Create New SITEINFO Rule' : `Editing: ${escapeHTML(entry.name)}`}</h2>
            <span id="paste_badge" class="paste-badge" style="display:none;">Auto-populated from Clipboard</span>
          </div>
          <span style="font-size:11px;color:var(--text-muted);">${isNew ? 'Ctrl+V JSON to autofill' : `ID: ${entry.id}`}</span>
        </div>
        <div class="inspector-body">
          <dl class="inspector-dl">
            <dt>Database ID</dt>
            <dd>
              <input type="text" id="ins_id" value="${isNew ? '' : escapeHTML(entry.id)}" 
                     placeholder="${isNew ? 'Auto-assigned (e.g. 90001)' : ''}" 
                     ${!isNew ? 'readonly style="opacity:0.6; cursor:not-allowed;"' : ''}>
            </dd>

            <dt>Rule Name</dt>
            <dd><input type="text" id="ins_name" value="${escapeHTML(entry.name || '')}" placeholder="Descriptive Name"></dd>

            <dt>URL Pattern (RegExp)</dt>
            <dd><input type="text" id="ins_url" value="${escapeHTML(entry.url || '')}" placeholder="^https://example\\.com/posts"></dd>

            <dt>Example URL</dt>
            <dd><input type="text" id="ins_example" value="${escapeHTML(entry.exampleUrl || '')}" placeholder="https://example.com/posts/1"></dd>

            <dt>Next Link (XPath)</dt>
            <dd><input type="text" id="ins_next" value="${escapeHTML(entry.nextLink || '')}" placeholder="//a[@rel='next']"></dd>

            <dt>Next Link (CSS Selector)</dt>
            <dd><input type="text" id="ins_next_sel" value="${escapeHTML(entry.nextLinkSelector || '')}" placeholder="a[rel='next']"></dd>

            <dt>Page Element (XPath)</dt>
            <dd><input type="text" id="ins_page" value="${escapeHTML(entry.pageElement || '')}" placeholder="//div[@class='article-item']"></dd>

            <dt>Page Element (CSS)</dt>
            <dd><input type="text" id="ins_page_sel" value="${escapeHTML(entry.pageElementSelector || '')}" placeholder="div.article-item"></dd>

            <dt>Insert Before</dt>
            <dd><input type="text" id="ins_insert" value="${escapeHTML(entry.insertBefore || '')}"></dd>

            <dt>Remove Element</dt>
            <dd><input type="text" id="ins_remove" value="${escapeHTML(entry.removeElement || '')}"></dd>

            <dt style="color:var(--accent);">CSS Patch</dt>
            <dd><textarea id="ins_csspatch" rows="3" placeholder=".sidebar, .banner { display: none !important; }">${escapeHTML(entry.cssPatch || '')}</textarea></dd>

            <dt style="color:var(--accent);">JS Patch</dt>
            <dd><textarea id="ins_jspatch" rows="3" placeholder="window.scrollTo(0,0);">${escapeHTML(entry.jsPatch || '')}</textarea></dd>
          </dl>
        </div>
        <div class="inspector-footer">
          <div>
            ${!isNew ? '<button type="button" class="btn-modal btn-modal-delete" id="ins_btn_delete">Delete Rule</button>' : ''}
          </div>
          <div class="footer-actions">
            <button type="button" class="btn-modal btn-modal-cancel" id="ins_btn_cancel">Cancel</button>
            <button type="button" class="btn-modal btn-modal-save" id="ins_btn_save">Save Rule</button>
          </div>
        </div>
      </div>
    `;

    siteinfoView.classList.add('open');

    const onPaste = (e) => {
      const text = e.clipboardData?.getData('text');
      const parsed = parseWedataClipboard(text);
      if (parsed) {
        e.preventDefault();

        if (parsed.id && isNew) document.getElementById('ins_id').value = parsed.id;
        if (parsed.name) document.getElementById('ins_name').value = parsed.name;
        if (parsed.url) document.getElementById('ins_url').value = parsed.url;
        if (parsed.exampleUrl) document.getElementById('ins_example').value = parsed.exampleUrl;
        if (parsed.nextLink) document.getElementById('ins_next').value = parsed.nextLink;
        if (parsed.nextLinkSelector) document.getElementById('ins_next_sel').value = parsed.nextLinkSelector;
        if (parsed.pageElement) document.getElementById('ins_page').value = parsed.pageElement;
        if (parsed.pageElementSelector) document.getElementById('ins_page_sel').value = parsed.pageElementSelector;
        if (parsed.insertBefore) document.getElementById('ins_insert').value = parsed.insertBefore;
        if (parsed.removeElement) document.getElementById('ins_remove').value = parsed.removeElement;
        if (parsed.cssPatch) document.getElementById('ins_csspatch').value = parsed.cssPatch;
        if (parsed.jsPatch) document.getElementById('ins_jspatch').value = parsed.jsPatch;

        const badge = document.getElementById('paste_badge');
        if (badge) {
          badge.style.display = 'inline-block';
          setTimeout(() => { badge.style.display = 'none'; }, 3500);
        }

        const card = siteinfoView.querySelector('.inspector-card');
        card.classList.add('flash-success');
        setTimeout(() => card.classList.remove('flash-success'), 600);
      }
    };

    window.addEventListener('paste', onPaste);

    const cleanupModal = () => {
      window.removeEventListener('paste', onPaste);
      siteinfoView.classList.remove('open');
      siteinfoView.innerHTML = '';
    };

    siteinfoView.onclick = (e) => {
      if (e.target === siteinfoView) cleanupModal();
    };

    document.getElementById('ins_btn_cancel').onclick = cleanupModal;

    if (!isNew) {
      document.getElementById('ins_btn_delete').onclick = async () => {
        if (confirm(`Are you sure you want to delete rule "${entry.name}" (#${entry.id})?`)) {
          await nap.send('siteinfo:delete_entry', { id: entry.id });
          allEntries = allEntries.filter(e => e.id !== entry.id);
          filteredEntries = filteredEntries.filter(e => e.id !== entry.id);
          cleanupModal();
          renderNav();
          renderPage();
        }
      };
    }

    document.getElementById('ins_btn_save').onclick = async () => {
      const urlPattern = document.getElementById('ins_url').value.trim();
      if (!urlPattern) {
        alert('URL pattern regex is required.');
        return;
      }
      try {
        new RegExp(urlPattern);
      } catch (e) {
        alert('Invalid Regular Expression: ' + e.message);
        return;
      }

      const payload = {
        id: isNew ? document.getElementById('ins_id').value.trim() : entry.id,
        name: document.getElementById('ins_name').value.trim() || urlPattern,
        url: urlPattern,
        exampleUrl: document.getElementById('ins_example').value.trim(),
        nextLink: document.getElementById('ins_next').value.trim(),
        nextLinkSelector: document.getElementById('ins_next_sel').value.trim(),
        pageElement: document.getElementById('ins_page').value.trim(),
        pageElementSelector: document.getElementById('ins_page_sel').value.trim(),
        insertBefore: document.getElementById('ins_insert').value.trim(),
        removeElement: document.getElementById('ins_remove').value.trim(),
        cssPatch: document.getElementById('ins_csspatch').value.trim(),
        jsPatch: document.getElementById('ins_jspatch').value.trim()
      };

      if (isNew) {
        toggleLoader(true);
        const res = await nap.send('siteinfo:add_entry', { entry: payload });
        toggleLoader(false);
        if (res.ok) {
          const normalized = normalizeEntry(res.entry);
          allEntries.unshift(normalized);
          filteredEntries.unshift(normalized);
          applyGlobalSort();
        }
      } else {
        Object.assign(entry, payload);
        entry.isModified = true;
        await saveOverride(entry.id, payload);
        applyGlobalSort();
      }

      cleanupModal();
      pageIndex = 0;
      renderNav();
      renderPage();
    };
  }

  async function saveOverride(id, patch) {
    try {
      await nap.send('siteinfo:update_entry', { id, info: patch });
    } catch (err) {
      console.error('[NAP Save Override Error]', err);
    }
  }

  function setupToolbar() {
    document.getElementById('btn_add_rule').onclick = () => {
      openInspector({
        id: '',
        name: '',
        url: '',
        nextLink: '',
        pageElement: '',
        cssPatch: '',
        jsPatch: ''
      }, true);
    };

    document.getElementById('btn_export_db').onclick = () => {
      const exportData = allEntries.map(e => ({
        id: e.id,
        resource_url: e.resource_url || (e.id ? `http://wedata.net/items/${e.id}` : ''),
        name: e.name,
        source: e.source,
        created_at: e.created_at !== '-' ? e.created_at : '',
        created_by: e.created_by,
        data: {
          url: e.url,
          nextLink: e.nextLink,
          nextLinkSelector: e.nextLinkSelector,
          pageElement: e.pageElement,
          pageElementSelector: e.pageElementSelector,
          insertBefore: e.insertBefore,
          removeElement: e.removeElement,
          exampleUrl: e.exampleUrl,
          cssPatch: e.cssPatch,
          jsPatch: e.jsPatch,
          allowScripts: e.allowScripts,
          forceIframe: e.forceIframe,
          allowCrossOrigin: e.allowCrossOrigin,
          disableSeparator: e.disableSeparator,
          disabled: e.disabled
        }
      }));
      const jsonStr = JSON.stringify(exportData, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = `neoapaginator_db_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(dlUrl);
    };

    const btnImport = document.getElementById('btn_import_db');
    btnImport.onclick = () => fileInput.click();

    fileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const parsed = JSON.parse(evt.target.result);
          toggleLoader(true);
          const res = await nap.send('siteinfo:import', { data: parsed });
          toggleLoader(false);
          alert(`Successfully imported ${res.count} rules.`);
          init();
        } catch (err) {
          toggleLoader(false);
          alert(`Failed to import JSON: ${err.message}`);
        }
      };
      reader.readAsText(file);
      fileInput.value = '';
    };
  }

  function setupSearch() {
    let debounce;
    searchInput.oninput = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const query = searchInput.value.trim().toLowerCase();
        if (!query) {
          filteredEntries = [...allEntries];
        } else {
          filteredEntries = allEntries.filter(item => 
            item.name.toLowerCase().includes(query) ||
            item.url.toLowerCase().includes(query) ||
            item.exampleUrl.toLowerCase().includes(query) ||
            item.id.includes(query) ||
            item.created_by.toLowerCase().includes(query)
          );
        }
        // Retain sort on filtered list and reset view to first page
        applyGlobalSort();
        pageIndex = 0;
        renderNav();
        renderPage();
      }, 200);
    };
  }

  function formatDate(dStr) {
    if (!dStr || dStr === '-') return '-';
    return dStr.split('T')[0] || dStr;
  }

  function toggleLoader(show) {
    loader.style.display = show ? 'block' : 'none';
  }

  function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }
});
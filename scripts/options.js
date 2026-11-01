'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const tabs = document.querySelectorAll('.nav-item');
  const panes = document.querySelectorAll('.tab-pane');

  // Tab Navigation
  tabs.forEach(btn => {
    btn.onclick = () => {
      tabs.forEach(t => t.classList.remove('active'));
      panes.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    };
  });

  // Load configuration from background
  const data = await nap.send('config:get');
  const config = data.config || {};

  // Setup all Boolean Checkbox switches
  const checkboxIds = [
    'auto_start',
    'change_address',
    'bar_status',
    'target_blank',
    'check_hash',
    'debug_mode',
    'allow_scripts',
    'try_correct_lazy',
    'force_absolute_img_srcs',
    'force_absolute_hrefs'
  ];

  checkboxIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.checked = Boolean(config[id]);
      el.onchange = () => saveConfig({ [id]: el.checked });
    }
  });

  // Height range slider
  const range = document.getElementById('remaining_height');
  const heightVal = document.getElementById('height_val');
  range.value = config.remaining_height || 900;
  heightVal.textContent = range.value;
  range.oninput = () => {
    heightVal.textContent = range.value;
    saveConfig({ remaining_height: Number(range.value) });
  };

  async function saveConfig(patch) {
    await nap.send('config:save', { config: patch });
  }

  // Database Tab Actions
  const dbStatus = document.getElementById('db_status_text');
  const dbUrlInput = document.getElementById('custom_db_url');
  dbUrlInput.value = config.custom_db_url ?? '';

  document.getElementById('btn_update_remote').onclick = async () => {
    dbStatus.textContent = 'Fetching remote database...';
    try {
      const url = dbUrlInput.value.trim();
      await saveConfig({ custom_db_url: url });
      const res = await nap.send('db:update_from_url', { url });
      if (res.count !== -1) {
        dbStatus.textContent = `Success: Loaded ${res.count} rules`;
      } else {
        dbStatus.textContent = `Error: ${res.error}`;
     }
    } catch (ex) {
      dbStatus.textContent = `Error: ${ex.message}`;
    }
  };

  document.getElementById('btn_reload_local').onclick = async () => {
    dbStatus.textContent = 'Reloading bundled db/items_all.json...';
    try {
      const res = await nap.send('db:reload');
      dbStatus.textContent = `Success: Restored ${res.count} rules`;
    } catch (err) {
      dbStatus.textContent = `Error: ${err.message}`;
    }
  };

  // Exclusions List
  const filterList = document.getElementById('filter_list');
  let disabledSites = [...(data.disabledSites || [])];

  function renderFilters() {
    filterList.innerHTML = '';
    disabledSites.forEach((f, idx) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span><strong>[${f.type}]</strong> ${f.matcher}</span>
        <button class="filter-del" data-idx="${idx}">Delete</button>
      `;
      filterList.appendChild(li);
    });

    filterList.querySelectorAll('.filter-del').forEach(btn => {
      btn.onclick = () => {
        disabledSites.splice(Number(btn.dataset.idx), 1);
        nap.send('config:save', { disabledSites });
        renderFilters();
      };
    });
  }

  renderFilters();

  document.getElementById('btn_add_filter').onclick = () => {
    const input = document.getElementById('filter_input');
    const type = document.getElementById('filter_type').value;
    const matcher = input.value.trim();
    if (!matcher) return;

    disabledSites.push({ type, matcher });
    input.value = '';
    nap.send('config:save', { disabledSites });
    renderFilters();
  };

  // Custom JSON Patterns
  const patternBox = document.getElementById('custom_patterns_json');
  patternBox.value = data.config?.customPatterns?.length ? JSON.stringify(data.config.customPatterns, null, 2) : '';

  document.getElementById('btn_save_patterns').onclick = () => {
    try {
      const val = patternBox.value.trim();
      const parsed = val ? JSON.parse(val) : [];
      nap.send('config:save', { customPatterns: parsed });
      alert('Custom patterns saved.');
    } catch (e) {
      alert(`Invalid JSON format: ${e.message}`);
    }
  };

  document.getElementById('btn_clear_patterns').onclick = () => {
    patternBox.value = '';
    nap.send('config:save', { customPatterns: [] });
  };

  // Open Manager Button
  document.getElementById('btn_open_manager').onclick = () => {
    nap.send('open:manager');
  };
});
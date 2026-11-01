'use strict';

const DEFAULT_CONFIG = {
  auto_start: true,
  target_blank: true,
  remaining_height: 900,
  disable_in_frames: true,
  change_address: false,
  debug_mode: false,
  check_hash: false,
  bar_status: true,
  force_abs_hrefs: true,
  force_abs_srcs: true,
  enable_notifications: false,
  allow_scripts: false,
  try_correct_lazy: true,
  custom_db_url: 'http://wedata.net/databases/AutoPagerize/items.json'
};

/**
 * Cross-browser runtime resolution (Firefox `browser` / Chrome `chrome`)
 */
globalThis.napBrowser = globalThis.browser ?? globalThis.chrome;

/**
 * Unified messaging bus
 */
globalThis.nap = {
  /**
   * Constructs an nap:... typed message payload
   */
  msg(action, payload = {}) {
    return { type: `nap:${action}`, ...payload };
  },

  /**
   * Dispatches a message to the background or tab with Promise fallback
   */
  async send(action, payload = {}) {
    const message = this.msg(action, payload);
    if (globalThis.browser?.runtime?.sendMessage) {
      return await globalThis.browser.runtime.sendMessage(message);
    }
    return new Promise((resolve, reject) => {
      globalThis.chrome.runtime.sendMessage(message, (response) => {
        const err = globalThis.chrome.runtime.lastError;
        if (err) return reject(err);
        resolve(response);
      });
    });
  },

  /**
   * Send to a specific tab
   */
  async sendTab(tabId, action, payload = {}) {
    const message = this.msg(action, payload);
    if (globalThis.browser?.tabs?.sendMessage) {
      return await globalThis.browser.tabs.sendMessage(tabId, message);
    }
    return new Promise((resolve, reject) => {
      globalThis.chrome.tabs.sendMessage(tabId, message, (response) => {
        const err = globalThis.chrome.runtime.lastError;
        if (err) return reject(err);
        resolve(response);
      });
    });
  },

  /**
   * Computes SHA-256 for duplicate detection
   */
  async digest(content) {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  },

  /**
   * Evaluate XPath with modern return types
   */
  getXPathNodes(doc, xpath) {
    try {
      const result = doc.evaluate(xpath, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const nodes = [];
      for (let i = 0; i < result.snapshotLength; i++) {
        nodes.push(result.snapshotItem(i));
      }
      return nodes;
    } catch {
      return [];
    }
  },

  getXPathFirst(doc, xpath) {
    try {
      return doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    } catch {
      return null;
    }
  },

  /**
   * Query selector or XPath selector wrapper
   */
  query(doc, selectorOrXPath) {
    if (!selectorOrXPath) return null;
    try {
      return doc.querySelector(selectorOrXPath);
    } catch {
      return this.getXPathFirst(doc, selectorOrXPath);
    }
  },

  queryAll(doc, selectorOrXPath) {
    if (!selectorOrXPath) return [];
    try {
      return Array.from(doc.querySelectorAll(selectorOrXPath));
    } catch {
      return this.getXPathNodes(doc, selectorOrXPath);
    }
  }
};
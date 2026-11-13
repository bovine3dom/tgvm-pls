// ==UserScript==
// @name         pls gib TGV-M
// @namespace    https://github.com/bovine3dom/tgvm-pls
// @version      0.0.3
// @description  Puts a nice big box around TGV-M services
// @author       bovine3dom
// @match        https://www.sncf-connect.com/*
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/bovine3dom/tgvm-pls/master/content.user.js.meta.js
// @downloadURL  https://raw.githubusercontent.com/bovine3dom/tgvm-pls/master/content.user.js
// @supportURL   https://github.com/bovine3dom/tgvm-pls/issues/
// @grant        none
// @inject-into  page
// ==/UserScript==

(() => {
  'use strict';

  const SERVICE_CODE = 'AUTONOMOUS_ACCESS_BY_WHEELCHAIR';
  const PROFILE_CODES = ['ACCESSIBLE_TOILET_WITH_GYRATION', 'ONBOARD_INFORMATION_DISPLAY'];
  const MATCH_CLASS = 'userscript-tgv-m-match';
  const BADGE_CLASS = 'userscript-tgv-m-badge';
  const STYLE_ID = 'userscript-tgv-m-style';
  const CARD_SELECTOR = '[data-test="proposal-card"], [data-testid="proposal-card"]';
  const REFERENCE_ATTRIBUTES = ['aria-describedby', 'aria-labelledby', 'aria-controls'];
  const ID_SELECTOR = ['[id^="trip-info-"]', ...REFERENCE_ATTRIBUTES.map((name) => `[${name}*="trip-info-"]`)].join(', ');
  const proposals = new Map();
  let scheduled = false;
  let requestSequence = 0;

  // SNCF uses this ID for the journey heading and its accessibility references.
  const proposalKey = (id) => `trip-info-${id}`.replace(/[, ]/g, '_');

  function isItineraryRequest(input) {
    try {
      const url = new URL(input?.url ?? input, location.href);
      return /^\/bff\/api\/v\d+\/itineraries(?:\/|$)/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function hasTgvMMarker(proposal) {
    const queue = [proposal];
    for (let index = 0; index < queue.length && index < 50000; index++) {
      const value = queue[index];
      if (value && typeof value === 'object' && value.available !== false) {
        if (value.code === SERVICE_CODE) return true;
        if (value.transporter?.logo === 'tgv_inoui' && Array.isArray(value.onBoardServices)
          && PROFILE_CODES.every((code) => value.onBoardServices.some((service) =>
            service?.code === code && service.available !== false))) return true;
        for (const item of Object.values(value)) queue.push(item);
      }
    }
    return false;
  }

  function receiveItinerary(data, sequence) {
    const queue = [data];
    // Find proposals by their record shape, regardless of their JSON wrappers.
    for (let index = 0; index < queue.length && index < 10000; index++) {
      const value = queue[index];
      if (!value || typeof value !== 'object') continue;
      if (typeof value.id === 'string' && value.id.trim() && value.departure && value.arrival) {
        const key = proposalKey(value.id);
        const previous = proposals.get(key);
        if (!previous || previous.sequence <= sequence) {
          proposals.set(key, {
            sequence,
            // Conflicting records with the same ID must not produce a badge.
            isTgvM: hasTgvMMarker(value) && (previous?.sequence !== sequence || previous.isTgvM),
          });
        }
        continue;
      }
      for (const item of Object.values(value)) {
        if (item && typeof item === 'object') queue.push(item);
      }
    }
    scheduleScan();
  }

  // Read the itinerary responses that SNCF Connect already requests.
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const sequence = ++requestSequence;
    const responsePromise = originalFetch.apply(this, args);
    if (isItineraryRequest(args[0])) {
      responsePromise.then((response) => response.ok === false ? null : response.clone().json())
        .then((data) => receiveItinerary(data, sequence))
        .catch(() => {});
    }
    return responsePromise;
  };

  // Also support pages that use XMLHttpRequest instead of fetch.
  const xhrUrl = Symbol('itineraryUrl');
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this[xhrUrl] = url;
    return originalOpen.call(this, method, url, ...args);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (isItineraryRequest(this[xhrUrl])) {
      const sequence = ++requestSequence;
      this.addEventListener('loadend', () => {
        if (this.status < 200 || this.status >= 300) return;
        if (!['', 'text', 'json'].includes(this.responseType)) return;
        try {
          receiveItinerary(this.responseType === 'json'
            ? this.response
            : JSON.parse(this.responseText), sequence);
        } catch {
          // Ignore responses that are not valid itinerary JSON.
        }
      }, { once: true });
    }
    return originalSend.apply(this, args);
  };

  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scanRows();
    });
  }

  function setTgvMMark(row, isMatch) {
    if (row.classList.contains(MATCH_CLASS) !== isMatch) row.classList.toggle(MATCH_CLASS, isMatch);
    let badge = row.querySelector(`:scope > .${BADGE_CLASS}`);
    if (isMatch && !badge) {
      badge = document.createElement('span');
      badge.className = BADGE_CLASS;
      badge.textContent = 'TGV-M';
      badge.setAttribute('aria-label', 'TGV-M service');
      row.appendChild(badge);
    } else if (!isMatch) {
      badge?.remove();
    }
  }

  function scanRows() {
    const anchors = [...document.querySelectorAll(ID_SELECTOR)];
    const rows = new Set([
      ...document.querySelectorAll(`${CARD_SELECTOR}, .${MATCH_CLASS}`),
      ...[...document.querySelectorAll(`.${BADGE_CLASS}`)].map((badge) => badge.parentElement),
      ...anchors.map((node) => node.closest(CARD_SELECTOR) || node.closest('li, article, [role="listitem"]')).filter(Boolean),
    ]);
    for (const row of rows) {
      const ids = new Set();
      for (const node of [row, ...row.querySelectorAll(ID_SELECTOR)]) {
        const references = REFERENCE_ATTRIBUTES.flatMap((name) => (node.getAttribute(name) || '').split(/\s+/));
        for (const id of [node.id, ...references]) {
          if (id?.startsWith('trip-info-')) {
            // Desktop accordion sub-elements share their parent proposal ID.
            ids.add(proposals.has(id) ? id : id.replace(/-(?:summary|content)$/, ''));
          }
        }
      }
      const result = ids.size === 1 ? proposals.get([...ids][0]) : null;
      setTgvMMark(row, Boolean(result?.isTgvM));
    }
  }

  function install() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', install, { once: true });
      return;
    }

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        .${MATCH_CLASS} {
          position: relative !important;
          outline: 2px solid #0073AE !important;
          outline-offset: 2px !important;
          border-radius: 0.875rem !important;
          box-shadow: 0 0 0 4px rgba(0, 115, 174, 0.12) !important;
        }
        .${MATCH_CLASS} > .${BADGE_CLASS} {
          position: absolute !important;
          top: 0.75rem !important;
          right: 0.75rem !important;
          z-index: 100 !important;
          padding: 0.25rem 0.625rem !important;
          border-radius: 0.875rem !important;
          background: #0073AE !important;
          color: #fff !important;
          font-family: 'avenirMedium', 'avenirMedium Fallback', Arial, sans-serif !important;
          font-size: 0.875rem !important;
          font-weight: 500 !important;
          line-height: 1.25rem !important;
          pointer-events: none !important;
        }
      `;
      document.head.appendChild(style);
    }

    new MutationObserver(scheduleScan).observe(document, {
      childList: true,
      attributes: true,
      attributeFilter: ['id', ...REFERENCE_ATTRIBUTES, 'data-test', 'data-testid', 'role', 'class'],
      subtree: true,
    });
    scanRows();
  }

  install();
})();

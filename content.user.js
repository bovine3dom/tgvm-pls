// ==UserScript==
// @name         pls gib TGV-M
// @namespace    https://github.com/bovine3dom/tgvm-pls
// @version      0.0.1
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

  const PHRASE = 'acces autonome en fauteuil roulant';
  const MATCH_CLASS = 'userscript-tgv-m-match';
  const BADGE_CLASS = 'userscript-tgv-m-badge';
  const STYLE_ID = 'userscript-tgv-m-style';
  const CARD_SELECTOR = '[data-test="proposal-card"], [data-testid="proposal-card"]';
  const TIME_SELECTOR = '[data-test="time-label"], [data-testid="time-label"], time';
  const PLACE_SELECTOR = '[data-test="place"], [data-testid="place"]';
  const proposals = new Map();
  const invalidations = new Map();
  const months = ['janv', 'fevr', 'mars', 'avr', 'mai', 'juin', 'juil', 'aout', 'sept', 'oct', 'nov', 'dec'];
  let scheduled = false;
  let requestSequence = 0;

  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const canonical = (value) => normalize(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const stationKey = (value) => canonical(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  function timeKey(value) {
    if (/^P/i.test(normalize(value))) return null;
    const match = normalize(value).match(/(?:^|T|\b)([01]?\d|2[0-3])\s*[:h]\s*([0-5]\d)(?=\D|$)/i);
    return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
  }

  function parseDate(value) {
    const text = canonical(value);
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return { day: `${Number(iso[2])}-${Number(iso[3])}`, year: iso[1] };

    const match = text.match(/\b(\d{1,2})\s+([a-z]+)\.?(?:\s+(\d{4}))?/);
    const month = match ? months.findIndex((prefix) => match[2].startsWith(prefix)) : -1;
    return month < 0 ? null : { day: `${month + 1}-${Number(match[1])}`, year: match[3] || '' };
  }

  function readDate(element) {
    if (!element) return null;
    const values = ['data-date', 'datetime', 'value', 'aria-label'].map((name) => element.getAttribute(name));
    values.push(element.value, element.querySelector('time[datetime]')?.getAttribute('datetime'), element.textContent);
    return values.map(parseDate).find(Boolean) || null;
  }

  function getSelectedDate() {
    const dates = [...document.querySelectorAll('[aria-pressed="true"], [aria-selected="true"], [aria-current="date"]')]
      .map(readDate).filter(Boolean);
    if (dates.length) {
      const selected = dates.find((date) => date.year) || dates[0];
      return dates.every((date) => sameDate(date, selected)) ? selected : null;
    }
    const direction = location.pathname.replace(/\/$/, '').endsWith('/inward') ? 'inward' : 'outward';
    return readDate(document.querySelector(
      `[data-test="${direction}DateInputField"], [data-testid="${direction}DateInputField"]`));
  }

  function sameDate(a, b) {
    return a && b && a.day === b.day && (!a.year || !b.year || a.year === b.year);
  }

  function isItineraryRequest(input) {
    try {
      const url = new URL(input?.url ?? input, location.href);
      return /^\/bff\/api\/v\d+\/itineraries(?:\/|$)/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function isProposal(value) {
    return timeKey(value?.departure?.timeLabel) && timeKey(value?.arrival?.timeLabel)
      && stationKey(value.departure.originStationLabel) && stationKey(value.arrival.destinationStationLabel);
  }

  function readItinerary(data) {
    const queue = [data];
    const results = [];
    let foundEmpty = false;
    let searchDate = null;
    // Check the record shape, not the names of its wrapper objects.
    for (let index = 0; index < queue.length && index < 10000; index++) {
      const value = queue[index];
      if (!value || typeof value !== 'object') continue;
      if (Array.isArray(value)) {
        const items = value.filter(isProposal);
        if (items.length) {
          results.push(...items);
          continue;
        }
      }
      for (const [key, item] of Object.entries(value)) {
        if (key === 'datedepart') searchDate = parseDate(item) || searchDate;
        if (key === 'proposals' && Array.isArray(item) && !item.length) foundEmpty = true;
        if (item && typeof item === 'object') queue.push(item);
      }
    }
    return results.length || foundEmpty ? { results, searchDate } : null;
  }

  function hasTgvMMarker(proposal) {
    const queue = [proposal];
    for (let index = 0; index < queue.length && index < 50000; index++) {
      const value = queue[index];
      if (typeof value === 'string' && canonical(value).includes(PHRASE)) return true;
      if (value && typeof value === 'object' && value.available !== false) {
        for (const item of Object.values(value)) queue.push(item);
      }
    }
    return false;
  }

  function receiveItinerary(data, sequence) {
    const itinerary = readItinerary(data);
    if (!itinerary) return;
    const { results, searchDate } = itinerary;
    // An empty response without a date must not clear unrelated cached days.
    if (!results.length && searchDate) {
      const key = `${searchDate.year}|${searchDate.day}`;
      const previous = invalidations.get(key);
      if (!previous || previous.sequence < sequence) invalidations.set(key, { date: searchDate, sequence });
      for (const [key, result] of proposals) {
        if (sameDate(result.date, searchDate) && result.sequence <= sequence) proposals.delete(key);
      }
    }

    for (const proposal of results) {
      const date = parseDate(proposal.departure?.dateLabel) || searchDate;
      if (!date) continue;
      if (!date.year && searchDate) date.year = searchDate.year;
      if ([...invalidations.values()].some((entry) => sameDate(entry.date, date) && entry.sequence > sequence)) continue;
      const journey = {
        departure: timeKey(proposal.departure.timeLabel),
        arrival: timeKey(proposal.arrival.timeLabel),
        origin: stationKey(proposal.departure.originStationLabel),
        destination: stationKey(proposal.arrival.destinationStationLabel),
      };
      const key = [date.year, date.day, ...Object.values(journey)].join('|');
      const previous = proposals.get(key);
      if (previous && previous.sequence > sequence) continue;
      proposals.set(key, {
        date, journey, sequence,
        // Conflicting records for the same visible journey must not produce a badge.
        hasPhrase: hasTgvMMarker(proposal) && (previous?.sequence !== sequence || previous.hasPhrase),
      });
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

  function contentText(element) {
    const parts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.parentElement.closest(`.${BADGE_CLASS}, script, style`)) {
        parts.push(walker.currentNode.textContent);
      }
    }
    return parts.join(' ');
  }

  function findProposalForRow(row, selectedDate) {
    const rowDate = parseDate(row.querySelector('time[datetime]')?.getAttribute('datetime'));
    if (rowDate && selectedDate && !sameDate(rowDate, selectedDate)) return null;
    const date = rowDate || selectedDate;
    if (!date || !proposals.size) return null;
    const content = contentText(row);
    let times = [...row.querySelectorAll(TIME_SELECTOR)]
      .map((item) => timeKey(item.getAttribute('datetime') || item.textContent)).filter(Boolean);
    if (times.length < 2) {
      for (const text of [row.getAttribute('aria-label'), content]) {
        times = [...normalize(text).matchAll(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g)].map((match) => timeKey(match[0]));
        if (times.length >= 2) break;
      }
    }
    if (times.length < 2 || (!row.matches(CARD_SELECTOR) && times.length !== 2)) return null;
    const places = [...row.querySelectorAll(PLACE_SELECTOR)].map((item) => stationKey(item.textContent));
    const text = ` ${stationKey(`${row.getAttribute('aria-label') || ''} ${content}`)} `;
    const candidates = [...proposals.values()].filter(({ journey, date: proposalDate }) =>
      sameDate(date, proposalDate)
      && times[0] === journey.departure && times.at(-1) === journey.arrival
      && (places.length >= 2
        ? places[0] === journey.origin && places.at(-1) === journey.destination
        : text.includes(` ${journey.origin} `) && text.includes(` ${journey.destination} `)));
    return candidates.length === 1 ? candidates[0] : null;
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
    const date = getSelectedDate();
    const known = [...document.querySelectorAll(CARD_SELECTOR)];
    const fallback = [...document.querySelectorAll('li, article, [role="listitem"], [role="button"], button[aria-label]')]
      .filter((row) => !known.some((card) => card.contains(row) || row.contains(card)));
    const matches = new Map([...known, ...fallback].map((row) => [row, findProposalForRow(row, date)])
      .filter(([, result]) => result));
    const rows = new Set([
      ...document.querySelectorAll(`.${MATCH_CLASS}`),
      ...[...document.querySelectorAll(`.${BADGE_CLASS}`)].map((badge) => badge.parentElement),
      ...matches.keys(),
    ]);
    for (const row of rows) {
      const hasNestedMatch = [...matches.keys()].some((candidate) => candidate !== row && row.contains(candidate));
      setTgvMMark(row, Boolean(matches.get(row)?.hasPhrase) && !hasNestedMatch);
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

    new MutationObserver((records) => {
      if (records.some((record) => {
        if (record.type !== 'attributes' || record.attributeName !== 'class') return true;
        return !record.target.classList.contains(MATCH_CLASS)
          && (record.oldValue?.split(/\s+/).includes(MATCH_CLASS)
            || record.target.querySelector(`:scope > .${BADGE_CLASS}`));
      })) scheduleScan();
    }).observe(document, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['aria-pressed', 'aria-selected', 'aria-current', 'aria-label', 'value',
        'datetime', 'data-date', 'data-test', 'data-testid', 'role', 'class'],
      subtree: true,
    });
    document.addEventListener('input', scheduleScan, true);
    document.addEventListener('change', scheduleScan, true);
    window.addEventListener('popstate', scheduleScan);
    scanRows();
  }

  install();
})();

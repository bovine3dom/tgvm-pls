const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

async function browserTests(source) {
  let frame;
  const results = [];
  const endpoint = 'https://www.sncf-connect.com/bff/api/v1/itineraries';
  const check = (value, message) => { if (!value) throw new Error(message); };
  const card = `<li data-test="proposal-card">
    <span data-test="time-label">14:03</span> <span data-test="place">Marseille Saint-Charles</span>
    <span data-test="time-label">17:22</span> <span data-test="place">Paris - Gare De Lyon - Hall 1 &amp; 2</span>
  </li>`;
  const dates = `<button aria-pressed="true" data-date="2026-11-11">11 novembre</button>
    <button aria-pressed="false" data-date="2026-11-13">13 novembre</button>`;
  const proposal = (day = 11, match = true) => ({
    departure: { dateLabel: `Aller : Mer. ${day} nov.`, timeLabel: '14:03', originStationLabel: 'Marseille Saint-Charles' },
    arrival: { timeLabel: '17:22', destinationStationLabel: 'Paris - Gare De Lyon - Hall 1 & 2' },
    services: match ? [{ label: 'Accès autonome en fauteuil roulant' }] : [],
  });
  const response = (items = [proposal()], day = 11) => ({
    metadata: { adDatalayer: { datedepart: `2026-11-${day}` } },
    longDistance: { proposals: { proposals: items } },
  });
  function setup(html = `${dates}<ul>${card}</ul>`) {
    frame?.remove();
    frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const win = frame.contentWindow;
    const doc = win.document;
    doc.body.innerHTML = html;
    const pending = [];
    let scans = 0;
    win.fetch = () => new Promise((resolve) => pending.push(resolve));
    win.requestAnimationFrame = (callback) => { scans++; return win.setTimeout(callback, 0); };
    const script = doc.createElement('script');
    script.textContent = source;
    doc.head.appendChild(script);
    const flush = () => new Promise((resolve) => win.setTimeout(resolve, 25));
    return {
      win, doc, flush, scans: () => scans,
      marked: () => doc.querySelectorAll('.userscript-tgv-m-match').length,
      async respond(data, index = 0, ok = true) {
        pending.splice(index, 1)[0]({ ok, clone: () => ({ json: async () => data }) });
        await flush();
      },
      async receive(data = response(), url = endpoint, ok = true) {
        win.fetch(url);
        await this.respond(data, 0, ok);
      },
      async select(day) {
        for (const button of doc.querySelectorAll('[aria-pressed]')) {
          button.setAttribute('aria-pressed', String(button.getAttribute('data-date') === `2026-11-${day}`));
        }
        await flush();
      },
    };
  }
  const tests = {
    async 'cached dates and reused rows'() {
      const page = setup();
      await page.receive();
      check(page.marked() === 1, 'Mark the first day');
      await page.receive(response([proposal(13, false)], 13));
      await page.select(13);
      check(page.marked() === 0, 'Clear the mark on the second day');
      await page.select(11);
      check(page.marked() === 1, 'Restore the cached first day');
    },
    async 'data-testid and selected-date attributes'() {
      const page = setup(`${dates}<ul>${card}</ul>`.replaceAll('data-test=', 'data-testid=')
        .replaceAll('aria-pressed=', 'aria-selected='));
      await page.receive();
      check(page.marked() === 1, 'Do not depend on data-test or French button wording');
      check(page.win.getComputedStyle(page.doc.querySelector('li')).outlineStyle === 'solid', 'Style fallback cards');
    },
    async 'semantic markup without test attributes'() {
      const page = setup(`<button aria-current="date"><time datetime="2026-11-11">Wednesday</time></button>
        <article><time datetime="2026-11-11T14:03Z">Departure</time> Marseille Saint-Charles
        <time datetime="17:22">Arrival</time> Paris – Gare de Lyon – Hall 1 &amp; 2
        <time datetime="PT3H19M">3h19</time></article>`);
      await page.receive();
      check(page.marked() === 1, 'Use time elements and the full route');
      const scans = page.scans();
      await page.flush();
      check(page.scans() === scans, 'The badge must not change the route text used for matching');
    },
    async 'plain accessible list items'() {
      const page = setup(`${dates}<ul><li aria-label="Départ de Marseille Saint-Charles 14:03 à destination de Paris - Gare De Lyon - Hall 1 &amp; 2 17:22">Train</li></ul>`);
      await page.receive();
      check(page.marked() === 1, 'Use a complete accessible journey label');
    },
    async 'response wrappers and text formatting'() {
      const page = setup();
      const item = proposal();
      item.services[0].label = 'ACCE\u0300S\u00a0AUTONOME\n EN FAUTEUIL ROULANT';
      item.departure.timeLabel = '14h03';
      item.departure.originStationLabel = 'MARSEILLE SAINT–CHARLES';
      await page.receive({ data: { experiment: response([null, item]) } }, endpoint.replace('/v1/', '/v2/'));
      check(page.marked() === 1, 'Normalize text and find valid proposals inside new wrappers');
    },
    async 'stale responses cannot overwrite newer journeys'() {
      const page = setup();
      page.win.fetch(endpoint);
      page.win.fetch(endpoint);
      await page.respond(response([proposal(11, false)]), 1);
      await page.respond(response());
      check(page.marked() === 0, 'Ignore the older positive response');
    },
    async 'pagination can arrive out of order'() {
      const page = setup();
      page.win.fetch(endpoint);
      page.win.fetch(endpoint);
      const later = proposal(11, false);
      later.departure.timeLabel = '16:04';
      await page.respond(response([later]), 1);
      await page.respond(response());
      check(page.marked() === 1, 'Keep earlier pages that contain different journeys');
    },
    async 'empty responses invalidate older in-flight results'() {
      const page = setup();
      page.win.fetch(endpoint);
      page.win.fetch(endpoint);
      await page.respond(response([]), 1);
      await page.respond(response());
      check(page.marked() === 0, 'Do not restore a result cleared by a newer response');
      await page.receive();
      check(page.marked() === 1, 'Accept a newer result after an empty response');
    },
    async 'late empty and unscoped empty responses preserve newer results'() {
      const page = setup();
      page.win.fetch(endpoint);
      page.win.fetch(endpoint);
      await page.respond(response(), 1);
      await page.respond(response([]));
      check(page.marked() === 1, 'Ignore an older empty response');
      await page.receive({ longDistance: { proposals: { proposals: [] } } });
      check(page.marked() === 1, 'An unknown date cannot clear the whole cache');
    },
    async 'conflicting records do not produce a badge'() {
      const page = setup();
      await page.receive(response([proposal(), proposal(11, false)]));
      check(page.marked() === 0, 'Do not choose an arbitrary duplicate');
      await page.receive(response([proposal(11, false), proposal()]));
      check(page.marked() === 0, 'The record order must not change the answer');
    },
    async 'unavailable accessibility features do not identify a TGV-M'() {
      const page = setup();
      const item = proposal();
      item.services[0].available = false;
      await page.receive(response([item]));
      check(page.marked() === 0, 'An unavailable service is not positive evidence');
    },
    async 'conflicting selected years are not guessed'() {
      const page = setup(`<button aria-pressed="true">11 novembre</button>
        <button aria-selected="true" data-date="2026-11-11">2026</button>
        <button aria-current="date" data-date="2027-11-11">2027</button><ul>${card}</ul>`);
      await page.receive();
      check(page.marked() === 0, 'A partial date must not hide a year conflict');
    },
    async 'HTTP failures and malformed payloads preserve valid data'() {
      const page = setup();
      await page.receive();
      await page.receive(response([]), endpoint, false);
      await page.receive({ unexpected: true });
      await page.receive(response([null, { departure: null }]));
      check(page.marked() === 1, 'Do not clear valid data on errors or unknown schemas');
    },
    async 'framework class resets and row replacements'() {
      const page = setup();
      await page.receive();
      page.doc.querySelector('li').className = 'experiment';
      await page.flush();
      check(page.marked() === 1, 'Restore a class removed by the page');
      page.doc.querySelector('ul').innerHTML = card;
      await page.flush();
      check(page.marked() === 1, 'Mark replacement rows');
      const scans = page.scans();
      await page.flush();
      check(page.scans() === scans, 'Do not scan in a mutation loop');
    },
    async 'body replacement keeps observation active'() {
      const page = setup();
      await page.receive();
      const body = page.doc.createElement('body');
      body.innerHTML = `${dates}<ul>${card}</ul>`;
      page.doc.body.replaceWith(body);
      await page.flush();
      check(page.marked() === 1, 'Observe the document rather than the old body');
    },
    async 'unknown dates and mismatched routes remove badges'() {
      const page = setup();
      await page.receive();
      page.doc.querySelector('[data-test="place"]').textContent = 'Nice Ville';
      await page.flush();
      check(page.marked() === 0, 'Require both stations');
      page.doc.querySelector('ul').innerHTML = card;
      page.doc.querySelector('[aria-pressed="true"]').removeAttribute('data-date');
      page.doc.querySelector('[aria-pressed="true"]').textContent = 'Choose a day';
      await page.flush();
      check(page.marked() === 0, 'Do not guess a missing date');
    },
    async 'nested fallback containers do not receive duplicate badges'() {
      const page = setup(`${dates}<article><ul>${card.replaceAll('data-test=', 'data-unused=')}</ul></article>`);
      await page.receive();
      check(page.marked() === 1, 'Mark only the innermost complete journey');
    },
  };
  for (const [name, run] of Object.entries(tests)) {
    try { await run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  }
  frame?.remove();
  document.querySelector('#results').textContent = JSON.stringify(results);
}

test('headless browser resilience checks', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tgv-m-browser-'));
  try {
    const source = readFileSync(join(__dirname, 'content.user.js'), 'utf8');
    const path = join(directory, 'tests.html');
    writeFileSync(path, `<body><pre id="results"></pre><script>
      (${browserTests})(${JSON.stringify(source)}).catch((error) => {
        document.querySelector('#results').textContent = JSON.stringify([{ passed: false, error: error.message }]);
      });
    </script>`);
    let output;
    try {
      output = execFileSync(process.env.CHROMIUM || 'chromium', [
        '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
        `--user-data-dir=${join(directory, 'profile')}`, '--dump-dom', '--virtual-time-budget=5000', pathToFileURL(path).href,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      t.skip('Install Chromium or set CHROMIUM to run the browser checks');
      return;
    }
    const match = output.match(/<pre id="results">([^<]+)<\/pre>/);
    assert.ok(match, 'The browser must finish the checks');
    const results = JSON.parse(match[1].replaceAll('&amp;', '&'));
    for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}: ${result.error || ''}`);
    assert.equal(results.length, 17);
    assert.deepEqual(results.filter((result) => !result.passed), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

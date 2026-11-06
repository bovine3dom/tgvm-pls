const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

async function browserTests(source, fixture) {
  let frame;
  const results = [];
  const endpoint = 'https://www.sncf-connect.com/bff/api/v1/itineraries';
  const check = (value, message) => { if (!value) throw new Error(message); };
  const card = `<li data-test="proposal-card"><div data-test="trip-info" id="trip-info-proposal-11">
    Marseille Saint-Charles 14:03 → Paris - Gare de Lyon 17:22
  </div></li>`;
  const proposal = (day = 11, match = true) => ({
    id: `proposal-${day}`,
    departure: { timeLabel: '14:03', originStationLabel: 'Marseille Saint-Charles' },
    arrival: { timeLabel: '17:22', destinationStationLabel: 'Paris - Gare de Lyon' },
    services: match ? [{ code: 'AUTONOMOUS_ACCESS_BY_WHEELCHAIR', label: 'Accès autonome en fauteuil roulant' }] : [],
  });
  const response = (items = [proposal()]) => ({ longDistance: { proposals: { proposals: items } } });

  function setup(html = `<ul>${card}</ul>`) {
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
        doc.querySelector('[data-test="trip-info"]').id = `trip-info-proposal-${day}`;
        await flush();
      },
    };
  }

  const tests = {
    async 'cached journeys with identical timetables stay distinct'() {
      const page = setup();
      await page.receive();
      check(page.marked() === 1, 'Mark the first proposal');
      await page.receive(response([proposal(13, false)]));
      check(page.marked() === 1, 'An unrelated response must not change the current card');
      await page.select(13);
      check(page.marked() === 0, 'Use the new proposal ID on a reused row');
      await page.select(11);
      check(page.marked() === 1, 'Restore the cached proposal without a new request');
    },
    async 'unknown IDs never inherit a matching timetable'() {
      const page = setup();
      await page.receive();
      await page.select(99);
      check(page.marked() === 0, 'Do not guess from stations or times');
      page.doc.querySelector('[data-test="trip-info"]').removeAttribute('id');
      await page.flush();
      check(page.marked() === 0, 'A missing ID must not produce a badge');
    },
    async 'translated labels and calendar text do not affect matching'() {
      const page = setup();
      for (const [lang, label] of [
        ['fr', 'Accès autonome en fauteuil roulant'], ['en', 'Autonomous acess for wheelchair users'],
        ['de', 'Selbstsandiger'], ['it', ''], ['nl', 'A new translation'],
      ]) {
        page.doc.documentElement.lang = lang;
        const item = proposal();
        item.services[0].label = label;
        page.doc.querySelector('[data-test="trip-info"]').textContent = `Train — ${lang}`;
        await page.receive(response([item]));
        check(page.marked() === 1, 'No month names, date labels or timetable text are needed');
      }
    },
    async 'data-testid and semantic containers'() {
      for (const html of [
        card.replaceAll('data-test=', 'data-testid='),
        '<article><div id="trip-info-proposal-11">Train</div></article>',
        '<div role="listitem"><div id="trip-info-proposal-11">Train</div></div>',
      ]) {
        const page = setup(html);
        await page.receive();
        check(page.marked() === 1, 'Find the container from the proposal ID');
        check(page.win.getComputedStyle(page.doc.querySelector('.userscript-tgv-m-match')).outlineStyle === 'solid', 'Style the matching container');
      }
    },
    async 'desktop accordion IDs retain the ring across breakpoints'() {
      const page = setup('<ul><li data-test="proposal-card" class="css-1l14mvk"></li></ul>');
      const item = proposal();
      item.id = 'dc23d7b5-4d45-4daa-af67-0a0a1cf6371b';
      const id = `trip-info-${item.id}`;
      const row = page.doc.querySelector('li');
      await page.receive(response([item]));
      for (const width of [960, 1280, 1600, 800]) {
        page.win.frameElement.style.width = `${width}px`;
        const wide = page.win.matchMedia('(min-width: 64rem)').matches;
        check(wide === (width >= 1024), 'Exercise both sides of the real media query');
        row.innerHTML = wide
          ? `<div class="MuiAccordion-root" id="${id}" data-test="${id}">
              <div data-test="trip-info">Train</div>
              <button id="${id}-summary" aria-controls="${id}-content" aria-expanded="false">Fares</button>
              <div id="${id}-content" role="region" aria-labelledby="${id}-summary">Offers</div>
            </div>`
          : `<div data-test="trip-info" id="${id}">Train</div>`;
        await page.flush();
        check(page.marked() === 1, `Keep the highlight at ${width}px`);
        check(page.win.getComputedStyle(row).outlineStyle === 'solid', 'Show the ring');
        check(row.querySelectorAll('.userscript-tgv-m-badge').length === 1, 'Keep only one badge');
        const scans = page.scans();
        await page.flush();
        check(page.scans() === scans, 'Do not scan in a mutation loop');
      }
    },
    async 'accessibility references can identify the card'() {
      for (const attribute of ['aria-describedby', 'aria-labelledby', 'aria-controls']) {
        const reference = attribute === 'aria-controls' ? 'trip-info-proposal-11-content' : 'trip-info-proposal-11';
        const page = setup(`<ul><li><button ${attribute}="price ${reference} help">Train</button></li></ul>`);
        await page.receive();
        check(page.marked() === 1, 'Read the proposal ID from an accessibility reference');
        page.doc.querySelector('button').setAttribute(attribute, 'trip-info-unknown');
        await page.flush();
        check(page.marked() === 0, 'Watch changes to the reference');
      }
    },
    async 'accordion aliases do not hide real or unknown proposal IDs'() {
      const page = setup();
      await page.receive();
      const info = page.doc.querySelector('[data-test="trip-info"]');
      info.id = 'trip-info-proposal-11-other';
      await page.flush();
      check(page.marked() === 0, 'Do not strip arbitrary ID suffixes');
      info.id = 'trip-info-proposal-11-summary';
      const other = proposal(13, false);
      other.id = 'proposal-11-summary';
      await page.receive(response([other]));
      check(page.marked() === 0, 'An exact API ID takes precedence over an accordion alias');
    },
    async 'combined proposal IDs use the same escaping as SNCF'() {
      const page = setup('<li data-test="proposal-card"><div id="trip-info-first__second">Train</div></li>');
      const item = proposal();
      item.id = 'first, second';
      await page.receive(response([item]));
      check(page.marked() === 1, 'Replace commas and spaces with underscores');
    },
    async 'the supplied response identifies only its TGV-M'() {
      const page = setup('<ul></ul>');
      for (const item of fixture.longDistance.proposals.proposals) {
        const row = page.doc.createElement('li');
        row.setAttribute('data-test', 'proposal-card');
        const info = page.doc.createElement('div');
        info.id = `trip-info-${item.id}`.replace(/[, ]/g, '_');
        info.textContent = item.departure.timeLabel;
        row.appendChild(info);
        page.doc.querySelector('ul').appendChild(row);
      }
      await page.receive(fixture);
      check(page.marked() === 1, 'Do not confuse ordinary accessibility with autonomous access');
      check(page.doc.querySelector('.userscript-tgv-m-match').textContent.includes('10:10'), 'Mark the 10:10 proposal');
    },
    async 'response wrappers and API versions can change'() {
      const page = setup();
      await page.receive({ data: { experiment: response([null, proposal()]) } }, endpoint.replace('/v1/', '/v2/'));
      check(page.marked() === 1, 'Find proposals inside different wrappers');
    },
    async 'late responses cannot overwrite newer data for the same ID'() {
      const page = setup();
      page.win.fetch(endpoint);
      page.win.fetch(endpoint);
      await page.respond(response([proposal(11, false)]), 1);
      await page.respond(response());
      check(page.marked() === 0, 'Keep the newer classification');
    },
    async 'pages can arrive out of order without changing the current card'() {
      const page = setup();
      page.win.fetch(endpoint);
      page.win.fetch(endpoint);
      await page.respond(response([proposal(13, false)]), 1);
      await page.respond(response());
      check(page.marked() === 1, 'Keep both proposals keyed by ID');
      await page.select(13);
      check(page.marked() === 0, 'The other proposal must remain non-TGV-M');
    },
    async 'empty results do not discard other cached journeys'() {
      const page = setup();
      await page.receive();
      page.doc.querySelector('ul').replaceChildren();
      await page.receive(response([]));
      check(page.marked() === 0, 'An empty page has no badges');
      page.doc.querySelector('ul').innerHTML = card;
      await page.flush();
      check(page.marked() === 1, 'A cached card can return without another response');
    },
    async 'conflicting duplicate IDs do not produce a badge'() {
      const page = setup();
      for (const items of [[proposal(), proposal(11, false)], [proposal(11, false), proposal()]]) {
        await page.receive(response(items));
        check(page.marked() === 0, 'Do not choose an arbitrary duplicate');
      }
    },
    async 'translated labels and generic icons are not sufficient'() {
      const page = setup();
      for (const code of ['HANDICAPE', 'ACCESSIBLE_TOILET_WITH_GYRATION', undefined]) {
        const item = proposal();
        item.services[0].code = code;
        item.services[0].icon = { iconGroup: 'Services', iconName: 'elevator' };
        await page.receive(response([item]));
        check(page.marked() === 0, 'Require the exact autonomous-access code');
      }
    },
    async 'unavailable services and ambiguous cards stay unmarked'() {
      const page = setup();
      const item = proposal();
      item.services[0].available = false;
      await page.receive(response([item]));
      check(page.marked() === 0, 'Ignore unavailable services');
      await page.receive();
      const extra = page.doc.createElement('div');
      extra.id = 'trip-info-another-proposal';
      page.doc.querySelector('li').appendChild(extra);
      await page.flush();
      check(page.marked() === 0, 'Do not guess when a container refers to multiple proposals');
    },
    async 'HTTP failures and malformed payloads preserve valid data'() {
      const page = setup();
      await page.receive();
      await page.receive(response([]), endpoint, false);
      await page.receive({ unexpected: true });
      await page.receive(response([null, { id: 'proposal-11', departure: null }]));
      check(page.marked() === 1, 'Keep valid data after an error');
    },
    async 'framework class resets and row replacements'() {
      const page = setup();
      await page.receive();
      page.doc.querySelector('li').className = 'experiment';
      await page.flush();
      check(page.marked() === 1, 'Restore a class removed by the page');
      page.doc.querySelector('ul').innerHTML = card;
      await page.flush();
      check(page.marked() === 1, 'Mark a replacement row');
      const scans = page.scans();
      await page.flush();
      check(page.scans() === scans, 'Do not scan in a mutation loop');
    },
    async 'body replacement keeps observation active'() {
      const page = setup();
      await page.receive();
      const body = page.doc.createElement('body');
      body.innerHTML = `<ul>${card}</ul>`;
      page.doc.body.replaceWith(body);
      await page.flush();
      check(page.marked() === 1, 'Observe the document rather than the old body');
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
    const fixture = JSON.parse(readFileSync(join(__dirname, 'test-fixtures/itinerary.json'), 'utf8'));
    const path = join(directory, 'tests.html');
    writeFileSync(path, `<body><pre id="results"></pre><script>
      (${browserTests})(${JSON.stringify(source)}, ${JSON.stringify(fixture)}).catch((error) => {
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
    assert.equal(results.length, 19);
    assert.deepEqual(results.filter((result) => !result.passed), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

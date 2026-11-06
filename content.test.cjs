const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, 'content.user.js'), 'utf8');
const endpoint = 'https://www.sncf-connect.com/bff/api/v1/itineraries';
const cases = [
  ['base endpoint', endpoint, true],
  ['query string', `${endpoint}?date=2026-11-26`, true],
  ['trailing slash', `${endpoint}/`, true],
  ['subpath', `${endpoint}/search`, true],
  ['new API version', endpoint.replace('/v1/', '/v2/'), true],
  ['relative URL', '/bff/api/v1/itineraries', true],
  ['URL object', new URL(endpoint), true],
  ['similar prefix', `${endpoint}-other`, false],
  ['unrelated endpoint', 'https://www.sncf-connect.com/bff/api/v1/prices', false],
  ['nested path', 'https://www.sncf-connect.com/other/bff/api/v1/itineraries/search', false],
];

function install() {
  const data = { longDistance: { proposals: { proposals: [] } } };
  let reads = 0;
  const response = { clone: () => ({ json: async () => { reads++; return data; } }) };
  const responsePromise = Promise.resolve(response);
  class XHR extends EventTarget {
    open() {}
    send() {}
    get response() { reads++; return data; }
    get responseText() { reads++; return JSON.stringify(data); }
  }
  const window = { fetch: () => responsePromise };
  runInNewContext(source, {
    window,
    XMLHttpRequest: XHR,
    URL,
    location: new URL('https://www.sncf-connect.com/home/shop/results/outward'),
    document: { addEventListener() {} },
    requestAnimationFrame() {},
  });
  return { window, XHR, responsePromise, reads: () => reads };
}

test('fetch captures itinerary responses', async (t) => {
  for (const [label, input, expected] of [
    ...cases,
    ['Request object', new Request(endpoint, { method: 'POST' }), true],
  ]) {
    await t.test(label, async () => {
      const page = install();
      const pending = page.window.fetch(input, { method: 'POST' });
      assert.equal(pending, page.responsePromise, 'Keep the original fetch promise');
      await pending;
      await new Promise(setImmediate);
      assert.equal(page.reads(), Number(expected));
    });
  }
});

test('XMLHttpRequest captures JSON and text itinerary responses', async (t) => {
  for (const [label, input, expected] of cases) {
    for (const responseType of ['json', '']) {
      await t.test(`${label}, ${responseType || 'text'}`, () => {
        const page = install();
        const xhr = new page.XHR();
        xhr.open('POST', input);
        xhr.responseType = responseType;
        xhr.status = 200;
        xhr.send();
        xhr.dispatchEvent(new Event('loadend'));
        assert.equal(page.reads(), Number(expected));
      });
    }
  }
});

test('aborted and failed XHRs do not leak listeners into a reused request', () => {
  const page = install();
  const xhr = new page.XHR();
  for (const status of [0, 500, 200]) {
    xhr.open('POST', endpoint);
    xhr.responseType = 'json';
    xhr.status = status;
    xhr.send();
    xhr.dispatchEvent(new Event('loadend'));
    assert.equal(page.reads(), status === 200 ? 1 : 0);
  }
});

test('the update metadata matches the userscript header', () => {
  const metadata = source.match(/^\/\/ ==UserScript==\n[\s\S]*?\/\/ ==\/UserScript==\n/)?.[0];
  assert.ok(metadata);
  assert.equal(readFileSync(join(__dirname, 'content.user.js.meta.js'), 'utf8'), metadata);
});

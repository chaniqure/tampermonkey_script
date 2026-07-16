const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadTestApi() {
  const filename = path.join(__dirname, '..', 'fofa-domain-extractor.user.js');
  const source = fs.readFileSync(filename, 'utf8');
  const context = {
    URL,
    console,
    TextDecoder,
    atob: globalThis.atob.bind(globalThis),
    btoa: globalThis.btoa.bind(globalThis),
    Uint8Array,
    location: { href: 'https://fofa.info/result' },
    __FDX_TEST_MODE__: true,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename });
  return context.__FDX_TEST_API__;
}

test('extractDomainFromUrl keeps DNS hosts and IP hosts from FOFA hrefs', () => {
  const { extractDomainFromUrl } = loadTestApi();

  assert.equal(extractDomainFromUrl('https://Admin.Example.com:8443/login'), 'admin.example.com');
  assert.equal(extractDomainFromUrl('http://1.2.3.4:8080'), '1.2.3.4');
  assert.equal(extractDomainFromUrl('https://[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(extractDomainFromUrl('http://localhost:3000'), '');
  assert.equal(extractDomainFromUrl('not a url'), '');
});

test('normalizeHostHref accepts protocol-less FOFA host text', () => {
  const { normalizeHostHref } = loadTestApi();

  assert.equal(normalizeHostHref('https://app.example.com:443/path'), 'https://app.example.com/path');
  assert.equal(normalizeHostHref('https://app.example.com:8443/path'), 'https://app.example.com:8443/path');
  assert.equal(normalizeHostHref('1.2.3.4:8080'), 'http://1.2.3.4:8080/');
  assert.equal(normalizeHostHref('portal.example.com'), 'http://portal.example.com/');
  assert.equal(normalizeHostHref('javascript:void(0)'), '');
  assert.equal(normalizeHostHref('not a url'), '');
});

test('aggregateDomainRecords merges FOFA host records across pages', () => {
  const { aggregateDomainRecords } = loadTestApi();
  const assets = aggregateDomainRecords([
    { domain: '1.2.3.4', page: 1, url: 'http://1.2.3.4:80', title: 'Nginx', protocol: 'http:', port: '80' },
    { domain: '1.2.3.4', page: 2, url: 'https://1.2.3.4:443', title: 'Nginx HTTPS', protocol: 'https:', port: '443' },
    { domain: 'cdn.example.com', page: 2, url: 'https://cdn.example.com:443', title: 'CDN', protocol: 'https:', port: '443' },
  ]);

  assert.equal(assets.length, 2);
  assert.equal(assets[0].domain, '1.2.3.4');
  assert.deepEqual(Array.from(assets[0].pages), [1, 2]);
  assert.deepEqual(Array.from(assets[0].ports), ['80', '443']);
  assert.equal(assets[0].preferredUrl, 'https://1.2.3.4:443');
});

test('choosePreferredUrl favors an observed HTTPS URL and preserves its port/path', () => {
  const { choosePreferredUrl } = loadTestApi();
  const urls = [
    'http://example.com:8080/admin',
    'https://example.com:9443/console',
    'https://example.com:443',
  ];

  assert.equal(choosePreferredUrl(urls), 'https://example.com:9443/console');
});

test('filterDomainAssets combines text search with persisted manual review state', () => {
  const { filterDomainAssets } = loadTestApi();
  const assets = [
    { domain: 'admin.example.com', titles: ['Admin Console'], urls: ['https://admin.example.com'] },
    { domain: '10.0.0.8', titles: ['Camera'], urls: ['http://10.0.0.8:8080'] },
  ];
  const reviews = {
    'admin.example.com': 'usable',
    '10.0.0.8': 'unusable',
  };

  assert.deepEqual(
    Array.from(filterDomainAssets(assets, { query: 'console', review: 'usable', reviews }), (item) => item.domain),
    ['admin.example.com'],
  );
  assert.deepEqual(
    Array.from(filterDomainAssets(assets, { query: '10.0', review: 'unusable', reviews }), (item) => item.domain),
    ['10.0.0.8'],
  );
});

test('decodeQbase64 restores FOFA search query text', () => {
  const { decodeQbase64 } = loadTestApi();
  const encoded = Buffer.from('title="测试"', 'utf8').toString('base64');
  assert.equal(decodeQbase64(encoded), 'title="测试"');
});

test('normalizeSettings clamps unsafe pagination values', () => {
  const { normalizeSettings } = loadTestApi();
  const settings = normalizeSettings({
    maxPages: '0',
    targetDomains: '-12',
    pageWaitMs: '200',
    pageDelayMinMs: '3000',
    pageDelayMaxMs: '1000',
    resultPageSize: '999',
  });

  assert.equal(settings.maxPages, 1);
  assert.equal(settings.targetDomains, 0);
  assert.equal(settings.pageWaitMs, 1500);
  assert.equal(settings.pageDelayMinMs, 1000);
  assert.equal(settings.pageDelayMaxMs, 3000);
  assert.equal(settings.resultPageSize, 50);
});

test('randomPageDelayMs stays within configured inclusive range', () => {
  const { randomPageDelayMs } = loadTestApi();
  const samples = [0, 0.01, 0.5, 0.99, 1].map((value) => randomPageDelayMs(1000, 3000, () => value));

  for (const delay of samples) {
    assert.ok(delay >= 1000 && delay <= 3000);
  }
  assert.equal(randomPageDelayMs(1000, 3000, () => 0), 1000);
  assert.equal(randomPageDelayMs(1000, 3000, () => 1), 3000);
});

test('page transition state only changes for a non-empty new page', () => {
  const { pageStateChanged, samePageState } = loadTestApi();
  const firstPage = { pageNumber: 1, resultCount: 10, signature: 'a|b' };
  const loading = { pageNumber: 0, resultCount: 0, signature: '' };
  const secondPage = { pageNumber: 2, resultCount: 10, signature: 'c|d' };

  assert.equal(pageStateChanged(firstPage, loading), false);
  assert.equal(pageStateChanged(firstPage, secondPage), true);
  assert.equal(samePageState(secondPage, { ...secondPage }), true);
  assert.equal(samePageState(secondPage, { ...secondPage, resultCount: 3 }), false);
});

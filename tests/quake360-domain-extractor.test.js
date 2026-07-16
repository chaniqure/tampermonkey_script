const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadTestApi() {
  const filename = path.join(__dirname, '..', 'quake360-domain-extractor.user.js');
  const source = fs.readFileSync(filename, 'utf8');
  const context = {
    URL,
    console,
    __QDX_TEST_MODE__: true,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename });
  return context.__QDX_TEST_API__;
}

test('extractDomainFromUrl extracts DNS hostnames and rejects IP/localhost assets', () => {
  const { extractDomainFromUrl } = loadTestApi();

  assert.equal(extractDomainFromUrl('https://Admin.Example.com:8443/login'), 'admin.example.com');
  assert.equal(extractDomainFromUrl('http://1.2.3.4:8080'), '');
  assert.equal(extractDomainFromUrl('https://[2001:db8::1]:443'), '');
  assert.equal(extractDomainFromUrl('http://localhost:3000'), '');
  assert.equal(extractDomainFromUrl('not a url'), '');
});

test('aggregateDomainRecords merges cross-page records without losing source details', () => {
  const { aggregateDomainRecords } = loadTestApi();
  const assets = aggregateDomainRecords([
    { domain: 'app.example.com', page: 1, url: 'http://app.example.com:80', title: 'Portal', protocol: 'http:', port: '80' },
    { domain: 'app.example.com', page: 2, url: 'https://app.example.com:443/login', title: 'Portal Login', protocol: 'https:', port: '443' },
    { domain: 'cdn.example.com', page: 2, url: 'https://cdn.example.com:443', title: 'CDN', protocol: 'https:', port: '443' },
  ]);

  assert.equal(assets.length, 2);
  assert.equal(assets[0].domain, 'app.example.com');
  assert.deepEqual(Array.from(assets[0].pages), [1, 2]);
  assert.deepEqual(Array.from(assets[0].urls), ['http://app.example.com:80', 'https://app.example.com:443/login']);
  assert.deepEqual(Array.from(assets[0].titles), ['Portal', 'Portal Login']);
  assert.equal(assets[0].preferredUrl, 'https://app.example.com:443/login');
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
    { domain: 'shop.example.com', titles: ['Store'], urls: ['https://shop.example.com'] },
  ];
  const reviews = {
    'admin.example.com': 'usable',
    'shop.example.com': 'unusable',
  };

  assert.deepEqual(
    Array.from(filterDomainAssets(assets, { query: 'console', review: 'usable', reviews }), item => item.domain),
    ['admin.example.com'],
  );
  assert.deepEqual(
    Array.from(filterDomainAssets(assets, { query: '', review: 'unusable', reviews }), item => item.domain),
    ['shop.example.com'],
  );
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

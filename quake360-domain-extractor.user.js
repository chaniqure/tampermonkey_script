// ==UserScript==
// @name         Quake360 域名资产提取与人工审核
// @namespace    local.codex.quake
// @version      1.0.0
// @description  跨页提取 Quake 搜索结果中的域名，聚合展示、批量打开并由用户人工标记可用性。
// @author       you
// @match        *://quake.360.net/*
// @match        *://quake.360.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const APP_ID = 'qdx-domain-review-host';
  const SETTINGS_KEY = 'qdx-domain-extractor-settings-v1';
  const REVIEWS_KEY = 'qdx-domain-extractor-reviews-v1';
  const RESULT_LINK_SELECTOR = 'a[rel~="noreferrer"][rel~="noopener"][rel~="nofollow"][href]';
  const NEXT_PAGE_SELECTOR = [
    '.siem-pagination button.btn-next',
    '.el-pagination button.btn-next',
    '.ant-pagination-next',
    'button[aria-label*="下一页"]',
    'button[title*="下一页"]',
  ].join(', ');
  const ACTIVE_PAGE_SELECTORS = [
    '.siem-pagination .el-pager .number.active',
    '.el-pagination .el-pager .number.active',
    '.ant-pagination-item-active',
    '[aria-current="page"]',
  ];
  const DEFAULT_SETTINGS = Object.freeze({
    autoPaginate: true,
    maxPages: 10,
    targetDomains: 0,
    pageWaitMs: 5000,
    resultPageSize: 12,
  });
  const REVIEW_VALUES = new Set(['pending', 'usable', 'unusable']);

  function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function normalizeSettings(raw = {}) {
    return {
      autoPaginate: raw.autoPaginate !== false,
      maxPages: clampInt(raw.maxPages, DEFAULT_SETTINGS.maxPages, 1, 200),
      targetDomains: clampInt(raw.targetDomains, DEFAULT_SETTINGS.targetDomains, 0, 100000),
      pageWaitMs: clampInt(raw.pageWaitMs, DEFAULT_SETTINGS.pageWaitMs, 1500, 30000),
      resultPageSize: clampInt(raw.resultPageSize, DEFAULT_SETTINGS.resultPageSize, 6, 50),
    };
  }

  function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function isIpHostname(hostname) {
    const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return false;
    if (host.includes(':')) return true;
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
    return host.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
  }

  function extractDomainFromUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || '').trim());
      const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
      if (!hostname || hostname === 'localhost' || !hostname.includes('.') || isIpHostname(hostname)) return '';
      return hostname;
    } catch {
      return '';
    }
  }

  function choosePreferredUrl(urls) {
    const values = unique(Array.from(urls || [], (url) => String(url || '').trim()));
    return values.find((url) => /^https:\/\//i.test(url))
      || values.find((url) => /^http:\/\//i.test(url))
      || values[0]
      || '';
  }

  function aggregateDomainRecords(records) {
    const assets = new Map();
    for (const record of records || []) {
      const domain = String(record.domain || extractDomainFromUrl(record.url)).toLowerCase();
      if (!domain) continue;
      if (!assets.has(domain)) {
        assets.set(domain, {
          domain,
          recordCount: 0,
          pages: new Set(),
          urls: new Set(),
          titles: new Set(),
          protocols: new Set(),
          ports: new Set(),
        });
      }
      const asset = assets.get(domain);
      asset.recordCount += 1;
      if (record.page) asset.pages.add(Number(record.page));
      if (record.url) asset.urls.add(record.url);
      if (record.title) asset.titles.add(record.title);
      if (record.protocol) asset.protocols.add(record.protocol);
      if (record.port) asset.ports.add(record.port);
    }

    return [...assets.values()].map((asset) => {
      const urls = [...asset.urls];
      return {
        domain: asset.domain,
        recordCount: asset.recordCount,
        pages: [...asset.pages].sort((a, b) => a - b),
        urls,
        titles: [...asset.titles],
        protocols: [...asset.protocols].sort(),
        ports: [...asset.ports].sort((a, b) => Number(a) - Number(b)),
        preferredUrl: choosePreferredUrl(urls),
      };
    }).sort((a, b) => a.domain.localeCompare(b.domain));
  }

  function reviewStatus(domain, reviews) {
    const value = reviews?.[String(domain || '').toLowerCase()];
    return REVIEW_VALUES.has(value) ? value : 'pending';
  }

  function filterDomainAssets(assets, { query = '', review = 'all', reviews = {} } = {}) {
    const keyword = normalizeText(query).toLowerCase();
    return (assets || []).filter((asset) => {
      if (review !== 'all' && reviewStatus(asset.domain, reviews) !== review) return false;
      if (!keyword) return true;
      const searchable = [
        asset.domain,
        ...(asset.titles || []),
        ...(asset.urls || []),
        ...(asset.protocols || []),
        ...(asset.ports || []),
        ...(asset.pages || []),
      ].join(' ').toLowerCase();
      return searchable.includes(keyword);
    });
  }

  const TEST_API = {
    aggregateDomainRecords,
    choosePreferredUrl,
    extractDomainFromUrl,
    filterDomainAssets,
    normalizeSettings,
    pageStateChanged,
    samePageState,
  };
  if (globalThis.__QDX_TEST_MODE__) {
    globalThis.__QDX_TEST_API__ = TEST_API;
    return;
  }

  function readStoredJson(key, fallback) {
    try {
      const stored = typeof GM_getValue === 'function' ? GM_getValue(key, '') : '';
      if (!stored) return fallback;
      const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function writeStoredJson(key, value) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, JSON.stringify(value));
    } catch (error) {
      console.warn('[Quake 域名审核台] 保存配置失败', error);
    }
  }

  const state = {
    settings: normalizeSettings(readStoredJson(SETTINGS_KEY, DEFAULT_SETTINGS)),
    reviews: readStoredJson(REVIEWS_KEY, {}),
    records: [],
    assets: [],
    running: false,
    cancelled: false,
    pagesCollected: 0,
    resultView: {
      query: '',
      review: 'all',
      page: 1,
      pageItems: [],
    },
    ui: null,
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(value) {
    const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, (character) => replacements[character]);
  }

  function cleanTitle(raw) {
    const title = normalizeText(raw)
      .replace(/\bBody相同网页\b/gi, '')
      .replace(/\bFavicon相同网页\b/gi, '');
    return normalizeText(title) || '(无标题)';
  }

  function getNodeTitle(anchor) {
    const ownTitle = cleanTitle(anchor.getAttribute('title') || '');
    if (ownTitle !== '(无标题)') return ownTitle;

    const ownText = normalizeText(anchor.textContent);
    if (ownText && !/^(https?:|www\.)/i.test(ownText) && ownText.length > 2) return cleanTitle(ownText);

    let container = anchor.parentElement;
    for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
      const candidates = container.querySelectorAll('h1,h2,h3,h4,strong,[class*="title"]');
      for (const candidate of candidates) {
        const text = normalizeText(candidate.textContent);
        if (text && text.length > 2 && text !== ownText) return cleanTitle(text);
      }
    }
    return ownText ? cleanTitle(ownText) : '(无标题)';
  }

  function getActivePageNumber() {
    for (const selector of ACTIVE_PAGE_SELECTORS) {
      const node = document.querySelector(selector);
      const page = Number.parseInt(normalizeText(node?.textContent), 10);
      if (Number.isFinite(page) && page > 0) return page;
    }
    return 0;
  }

  function getPageState() {
    const links = [...document.querySelectorAll(RESULT_LINK_SELECTOR)];
    return {
      pageNumber: getActivePageNumber(),
      resultCount: links.length,
      signature: links.slice(0, 20).map((link) => link.getAttribute('href') || '').join('|'),
    };
  }

  function pageStateChanged(previous, current) {
    if (!current.resultCount || !current.signature) return false;
    const pageChanged = previous.pageNumber && current.pageNumber && previous.pageNumber !== current.pageNumber;
    const signatureChanged = previous.signature && previous.signature !== current.signature;
    return Boolean(pageChanged || signatureChanged);
  }

  function samePageState(left, right) {
    return Boolean(left && right)
      && left.pageNumber === right.pageNumber
      && left.resultCount === right.resultCount
      && left.signature === right.signature;
  }

  async function waitForStableResults(previous = null, timeoutMs = state.settings.pageWaitMs) {
    const startedAt = Date.now();
    let candidate = null;
    while (!state.cancelled && Date.now() - startedAt < timeoutMs) {
      const current = getPageState();
      const ready = current.resultCount > 0 && current.signature
        && (!previous || pageStateChanged(previous, current));
      if (ready) {
        if (samePageState(candidate, current)) return current;
        candidate = current;
      }
      await sleep(200);
    }
    return null;
  }

  function isNextButtonDisabled(button) {
    if (!button) return true;
    if (button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true') return true;
    return /disabled|is-disabled/i.test(String(button.className || ''));
  }

  async function gotoNextPage() {
    const previous = getPageState();
    const button = document.querySelector(NEXT_PAGE_SELECTOR);
    if (!button || isNextButtonDisabled(button)) return null;
    button.scrollIntoView({ behavior: 'auto', block: 'center' });
    await sleep(80);
    button.click();
    return waitForStableResults(previous, state.settings.pageWaitMs);
  }

  function extractRecordsFromCurrentPage(fallbackPage) {
    const page = getActivePageNumber() || fallbackPage;
    const seen = new Set();
    const records = [];
    for (const anchor of document.querySelectorAll(RESULT_LINK_SELECTOR)) {
      const rawUrl = anchor.getAttribute('href');
      let url;
      try {
        url = new URL(rawUrl, location.href);
      } catch {
        continue;
      }
      const domain = extractDomainFromUrl(url.href);
      if (!domain || seen.has(url.href)) continue;
      seen.add(url.href);
      records.push({
        domain,
        page,
        title: getNodeTitle(anchor),
        url: url.href,
        protocol: url.protocol,
        port: url.port || (url.protocol === 'https:' ? '443' : (url.protocol === 'http:' ? '80' : '')),
      });
    }
    return records;
  }

  function mergePageRecords(records) {
    const existing = new Set(state.records.map((record) => `${record.page}\n${record.url}`));
    for (const record of records) {
      const key = `${record.page}\n${record.url}`;
      if (!existing.has(key)) {
        existing.add(key);
        state.records.push(record);
      }
    }
    state.assets = aggregateDomainRecords(state.records);
  }

  function settingsFromUi() {
    return normalizeSettings({
      autoPaginate: state.ui.autoPaginate.checked,
      maxPages: state.ui.maxPages.value,
      targetDomains: state.ui.targetDomains.value,
      pageWaitMs: state.ui.pageWaitMs.value,
      resultPageSize: state.ui.resultPageSize.value,
    });
  }

  function saveSettingsFromUi() {
    state.settings = settingsFromUi();
    writeStoredJson(SETTINGS_KEY, state.settings);
    state.ui.maxPages.value = String(state.settings.maxPages);
    state.ui.targetDomains.value = String(state.settings.targetDomains);
    state.ui.pageWaitMs.value = String(state.settings.pageWaitMs);
  }

  function setStatus(message, tone = 'idle') {
    if (!state.ui) return;
    state.ui.status.textContent = message;
    state.ui.status.dataset.tone = tone;
  }

  function updateStats() {
    if (!state.ui) return;
    state.ui.pageCount.textContent = String(state.pagesCollected);
    state.ui.recordCount.textContent = String(state.records.length);
    state.ui.domainCount.textContent = String(state.assets.length);
    const hasResults = state.assets.length > 0;
    for (const button of state.ui.resultActions) button.disabled = !hasResults || state.running;
    if (!state.ui.resultOverlay.hidden) renderResults();
  }

  function setRunning(running) {
    state.running = running;
    state.ui.start.hidden = running;
    state.ui.stop.hidden = !running;
    state.ui.settingsFieldset.disabled = running;
    updateStats();
  }

  async function runExtraction() {
    if (state.running) return;
    saveSettingsFromUi();
    state.records = [];
    state.assets = [];
    state.pagesCollected = 0;
    state.cancelled = false;
    state.resultView.page = 1;
    setRunning(true);
    setStatus('正在等待当前 Quake 结果页稳定…', 'working');

    try {
      const initial = await waitForStableResults(null, state.settings.pageWaitMs);
      if (!initial) {
        setStatus('未发现搜索结果。请先在 Quake 完成检索，再开始提取。', 'warning');
        return;
      }

      for (let step = 1; step <= state.settings.maxPages && !state.cancelled; step += 1) {
        const pageRecords = extractRecordsFromCurrentPage(step);
        mergePageRecords(pageRecords);
        state.pagesCollected += 1;
        updateStats();
        setStatus(`第 ${getActivePageNumber() || step} 页完成：本页 ${pageRecords.length} 条域名记录，累计 ${state.assets.length} 个域名`, 'working');

        if (state.settings.targetDomains > 0 && state.assets.length >= state.settings.targetDomains) {
          setStatus(`已达到目标域名数 ${state.settings.targetDomains}，采集完成`, 'success');
          break;
        }
        if (!state.settings.autoPaginate || step >= state.settings.maxPages) {
          setStatus(`采集完成：${state.pagesCollected} 页、${state.assets.length} 个域名`, 'success');
          break;
        }

        setStatus(`已完成 ${state.pagesCollected} 页，正在切换下一页…`, 'working');
        const nextState = await gotoNextPage();
        if (!nextState) {
          setStatus(`已到末页或翻页未在 ${state.settings.pageWaitMs}ms 内稳定，共提取 ${state.assets.length} 个域名`, state.assets.length ? 'success' : 'warning');
          break;
        }
      }

      if (state.cancelled) setStatus(`已停止，保留已提取的 ${state.assets.length} 个域名`, 'warning');
      if (state.assets.length) openResultView();
    } catch (error) {
      console.error('[Quake 域名审核台] 提取失败', error);
      setStatus(`提取失败：${error.message || error}`, 'error');
    } finally {
      setRunning(false);
    }
  }

  function getReview(domain) {
    return reviewStatus(domain, state.reviews);
  }

  function saveReviews() {
    writeStoredJson(REVIEWS_KEY, state.reviews);
  }

  function setReview(domain, status, shouldRender = true) {
    const key = String(domain || '').toLowerCase();
    if (!key || !REVIEW_VALUES.has(status)) return;
    state.reviews[key] = status;
    saveReviews();
    if (shouldRender) renderResults();
  }

  function reviewMeta(status) {
    const values = {
      pending: { label: '待确认', code: 'PENDING' },
      usable: { label: '可用', code: 'USABLE' },
      unusable: { label: '不可用', code: 'BLOCKED' },
    };
    return values[status] || values.pending;
  }

  function filteredAssets() {
    return filterDomainAssets(state.assets, {
      query: state.resultView.query,
      review: state.resultView.review,
      reviews: state.reviews,
    });
  }

  function compactTags(values, limit = 3) {
    const shown = (values || []).slice(0, limit);
    if (!shown.length) return '<span class="empty-tag">暂无</span>';
    const tags = shown.map((value) => `<span class="mini-tag">${escapeHtml(value)}</span>`).join('');
    const remaining = values.length - shown.length;
    return `${tags}${remaining > 0 ? `<span class="mini-tag more">+${remaining}</span>` : ''}`;
  }

  function renderAsset(asset) {
    const review = getReview(asset.domain);
    const meta = reviewMeta(review);
    const domain = escapeHtml(asset.domain);
    const preferredUrl = escapeHtml(asset.preferredUrl);
    const pageLabel = asset.pages.length === 1 ? `第 ${asset.pages[0]} 页` : `${asset.pages[0]}–${asset.pages.at(-1)} 页`;
    const protocolLabel = unique(asset.protocols.map((value) => value.replace(':', '').toUpperCase())).join(' / ') || 'UNKNOWN';
    return `
      <article class="asset-row" data-review-tone="${review}">
        <div class="asset-identity">
          <div class="asset-kicker">DOMAIN · ${asset.recordCount} RECORD${asset.recordCount > 1 ? 'S' : ''}</div>
          <div class="asset-domain" title="${domain}">${domain}</div>
          <div class="tag-line">${compactTags(asset.ports.map((port) => `:${port}`))}</div>
        </div>
        <div class="asset-evidence">
          <div class="evidence-title" title="${escapeHtml(asset.titles.join(' · '))}">${escapeHtml(asset.titles[0] || '(无标题)')}</div>
          <div class="evidence-url" title="${preferredUrl}">${preferredUrl}</div>
        </div>
        <div class="asset-source">
          <span>${escapeHtml(pageLabel)}</span>
          <strong>${escapeHtml(protocolLabel)}</strong>
          <small>${asset.urls.length} 个入口</small>
        </div>
        <div class="review-state" data-tone="${review}">
          <span class="review-code">${meta.code}</span>
          <strong>${meta.label}</strong>
        </div>
        <div class="review-controls" aria-label="人工可用性标记">
          ${['pending', 'usable', 'unusable'].map((status) => {
            const active = review === status;
            return `<button type="button" data-set-review="${status}" data-domain="${domain}" aria-pressed="${active}" class="review-choice${active ? ' active' : ''}">${reviewMeta(status).label}</button>`;
          }).join('')}
        </div>
        <div class="row-actions">
          <button type="button" class="row-button ghost" data-copy-domain="${domain}">复制域名</button>
          <button type="button" class="row-button primary" data-open-domain="${domain}">打开网站 ↗</button>
        </div>
      </article>`;
  }

  function updateReviewCounts() {
    const counts = { all: state.assets.length, pending: 0, usable: 0, unusable: 0 };
    for (const asset of state.assets) counts[getReview(asset.domain)] += 1;
    for (const button of state.ui.reviewFilters) {
      const status = button.dataset.reviewFilter;
      button.querySelector('span').textContent = String(counts[status]);
      button.classList.toggle('active', state.resultView.review === status);
    }
  }

  function renderResults() {
    if (!state.ui) return;
    const items = filteredAssets();
    const pageSize = state.settings.resultPageSize;
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    state.resultView.page = Math.min(Math.max(1, state.resultView.page), totalPages);
    const start = (state.resultView.page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);
    state.resultView.pageItems = pageItems;

    state.ui.resultList.innerHTML = pageItems.map(renderAsset).join('');
    state.ui.resultEmpty.hidden = pageItems.length > 0;
    state.ui.resultRange.textContent = items.length ? `${start + 1}–${start + pageItems.length}` : '0';
    state.ui.resultTotal.textContent = String(items.length);
    state.ui.resultPage.textContent = `${state.resultView.page} / ${totalPages}`;
    state.ui.resultPrev.disabled = state.resultView.page <= 1;
    state.ui.resultNext.disabled = state.resultView.page >= totalPages;
    state.ui.openCurrent.textContent = `批量打开当前页 · ${pageItems.length}`;
    state.ui.openFiltered.textContent = `批量打开筛选结果 · ${items.length}`;
    state.ui.openCurrent.disabled = pageItems.length === 0;
    state.ui.openFiltered.disabled = items.length === 0;
    state.ui.markCurrent.disabled = pageItems.length === 0;
    updateReviewCounts();
  }

  function openResultView() {
    if (!state.assets.length) {
      setStatus('暂无域名，请先开始提取', 'warning');
      return;
    }
    state.ui.resultOverlay.hidden = false;
    state.resultView.page = 1;
    state.ui.resultSearch.value = state.resultView.query;
    renderResults();
    requestAnimationFrame(() => state.ui.resultSearch.focus());
  }

  function closeResultView() {
    state.ui.resultOverlay.hidden = true;
  }

  function findAsset(domain) {
    return state.assets.find((asset) => asset.domain === domain);
  }

  function openBackgroundTab(url) {
    if (!url) return false;
    if (typeof GM_openInTab === 'function') {
      GM_openInTab(url, { active: false, insert: true, setParent: true });
      return true;
    }
    return Boolean(window.open(url, '_blank', 'noopener,noreferrer'));
  }

  function openSingleDomain(domain) {
    const asset = findAsset(domain);
    if (!asset?.preferredUrl) return;
    openBackgroundTab(asset.preferredUrl);
  }

  function openAssetBatch(assets, label) {
    const values = unique((assets || []).map((asset) => asset.preferredUrl));
    if (!values.length) return;
    const warning = `将在后台打开 ${values.length} 个从 Quake 提取的真实网站。\n这些站点可能包含恶意或失陷资产，请仅在隔离环境中访问。\n\n是否继续？`;
    if (!window.confirm(warning)) return;
    let opened = 0;
    for (const url of values) if (openBackgroundTab(url)) opened += 1;
    setStatus(`已打开 ${opened}/${values.length} 个${label}`, opened === values.length ? 'success' : 'warning');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
  }

  function copyDomains(assets = state.assets) {
    const domains = unique(assets.map((asset) => asset.domain));
    copyText(domains.join('\n')).then(() => setStatus(`已复制 ${domains.length} 个域名`, 'success'));
  }

  function csvCell(value) {
    const text = Array.isArray(value) ? value.join(' | ') : String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function buildCsv() {
    const columns = ['domain', 'review', 'preferred_url', 'record_count', 'pages', 'titles', 'urls', 'protocols', 'ports'];
    const rows = state.assets.map((asset) => ({
      domain: asset.domain,
      review: getReview(asset.domain),
      preferred_url: asset.preferredUrl,
      record_count: asset.recordCount,
      pages: asset.pages,
      titles: asset.titles,
      urls: asset.urls,
      protocols: asset.protocols,
      ports: asset.ports,
    }));
    return `\uFEFF${[columns, ...rows.map((row) => columns.map((column) => row[column]))].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
  }

  function buildJson() {
    return JSON.stringify({
      exported_at: new Date().toISOString(),
      source: location.href,
      pages_collected: state.pagesCollected,
      domains: state.assets.map((asset) => ({ ...asset, review: getReview(asset.domain) })),
    }, null, 2);
  }

  function download(text, extension, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `quake-domains-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function currentSearchQuery() {
    try {
      const query = location.hash.split('?')[1] || '';
      return new URLSearchParams(query).get('searchVal') || '当前 Quake 搜索结果';
    } catch {
      return '当前 Quake 搜索结果';
    }
  }

  function mountUi() {
    if (document.getElementById(APP_ID)) return;
    const host = document.createElement('div');
    host.id = APP_ID;
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; --ink:#10181c; --paper:#fbfcfc; --line:#d9e0e2; --muted:#67747a; --teal:#0d9f91; --teal-dark:#08766d; --amber:#d98518; --red:#c74343; }
      * { box-sizing:border-box; }
      button,input,select { font:inherit; }
      [hidden] { display:none !important; }
      .launcher { position:fixed; right:22px; bottom:22px; z-index:2147483646; height:46px; border:1px solid #0b312e; border-radius:5px; padding:0 16px; background:#102522; color:#d9fffa; box-shadow:0 10px 28px rgba(0,0,0,.24); cursor:pointer; font:700 13px/1 "Microsoft YaHei",sans-serif; letter-spacing:.02em; }
      .launcher::before { content:"Q"; display:inline-grid; width:22px; height:22px; margin-right:8px; place-items:center; border:1px solid #62d6ca; color:#62d6ca; font:800 11px/1 Consolas,monospace; }
      .launcher:hover { background:#17332f; transform:translateY(-1px); }
      .panel { position:fixed; right:22px; bottom:22px; z-index:2147483647; width:min(410px,calc(100vw - 24px)); overflow:hidden; border:1px solid #233438; border-top:4px solid var(--teal); border-radius:7px; background:#f8faf9; color:var(--ink); box-shadow:0 24px 64px rgba(0,0,0,.28); font:12px/1.5 "Microsoft YaHei",sans-serif; }
      .panel-head { display:flex; align-items:center; justify-content:space-between; min-height:58px; padding:0 16px; border-bottom:1px solid var(--line); background:#fff; }
      .panel-eyebrow { color:var(--teal-dark); font:700 9px/1.2 Consolas,monospace; letter-spacing:.16em; }
      .panel-title { margin:3px 0 0; font-size:15px; }
      .icon-button { width:34px; height:34px; border:1px solid transparent; background:transparent; color:#66747a; font-size:21px; cursor:pointer; }
      .icon-button:hover { border-color:var(--line); background:#f5f7f7; color:var(--ink); }
      .panel-body { padding:14px 16px 16px; }
      .query { display:flex; align-items:center; gap:8px; margin-bottom:12px; min-width:0; }
      .query-label { flex:none; border:1px solid #b8cecb; border-radius:3px; padding:2px 6px; color:#15776f; font:700 9px/1.3 Consolas,monospace; }
      .query-value { overflow:hidden; color:#313d42; font:11px/1.4 Consolas,monospace; text-overflow:ellipsis; white-space:nowrap; }
      .stats { display:grid; grid-template-columns:repeat(3,1fr); border:1px solid var(--line); background:#fff; }
      .stat { padding:10px 8px; text-align:center; }
      .stat + .stat { border-left:1px solid var(--line); }
      .stat strong { display:block; color:#142226; font:800 20px/1 Consolas,monospace; }
      .stat span { display:block; margin-top:5px; color:#718087; font-size:10px; }
      .status { min-height:42px; margin:11px 0; border-left:3px solid #9ba7ab; padding:9px 10px; background:#eef1f2; color:#4c595f; overflow-wrap:anywhere; }
      .status[data-tone="working"] { border-color:#198c9d; background:#eaf7f8; color:#17616b; }
      .status[data-tone="success"] { border-color:var(--teal); background:#e9f8f4; color:#0c665e; }
      .status[data-tone="warning"] { border-color:var(--amber); background:#fff6e8; color:#7b5014; }
      .status[data-tone="error"] { border-color:var(--red); background:#fff0f0; color:#922e2e; }
      .settings { margin:0 0 12px; padding:0; border:0; }
      .option-line { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:9px; }
      .check { display:inline-flex; align-items:center; gap:7px; color:#3c494e; cursor:pointer; }
      .check input { width:15px; height:15px; accent-color:var(--teal); }
      .advanced { border-top:1px solid var(--line); padding-top:8px; }
      .advanced summary { color:#66757b; cursor:pointer; user-select:none; }
      .setting-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:7px; margin-top:9px; }
      .setting-field { display:grid; gap:4px; color:#718087; font-size:9px; }
      .setting-field input { width:100%; height:32px; border:1px solid #cad3d6; border-radius:3px; padding:0 7px; background:#fff; color:#273337; font:700 11px/1 Consolas,monospace; outline:none; }
      .setting-field input:focus { border-color:var(--teal); box-shadow:0 0 0 2px rgba(13,159,145,.1); }
      .actions { display:grid; grid-template-columns:1fr auto; gap:8px; }
      .button { min-height:38px; border:1px solid #bdc8cb; border-radius:4px; padding:0 12px; background:#fff; color:#29363a; cursor:pointer; }
      .button:hover:not(:disabled) { border-color:#738187; background:#f6f8f8; }
      .button.primary { border-color:#102522; background:#102522; color:#e9fffc; font-weight:700; }
      .button.stop { border-color:#b63b3b; background:#b63b3b; color:#fff; font-weight:700; }
      .button:disabled { opacity:.4; cursor:not-allowed; }
      .result-actions { display:grid; grid-template-columns:repeat(3,1fr); gap:7px; margin-top:8px; }
      .result-actions .review-open { grid-column:1/-1; min-height:42px; border-color:#137f75; background:#e9f7f4; color:#0c665e; font-weight:800; }

      .result-overlay { position:fixed; inset:0; z-index:2147483647; display:grid; place-items:center; padding:18px; background:rgba(8,15,18,.72); backdrop-filter:blur(4px); font:12px/1.5 "Microsoft YaHei",sans-serif; }
      .result-modal { display:grid; grid-template-rows:auto auto auto minmax(0,1fr) auto; width:min(1180px,calc(100vw - 36px)); height:min(820px,calc(100vh - 36px)); overflow:hidden; border:1px solid #2b3a3f; border-top:4px solid var(--teal); border-radius:8px; background:#eef2f2; color:var(--ink); box-shadow:0 34px 100px rgba(0,0,0,.4); }
      .result-head { display:flex; align-items:center; justify-content:space-between; gap:20px; min-height:72px; padding:13px 20px; border-bottom:1px solid var(--line); background:#fff; }
      .result-eyebrow { color:var(--teal-dark); font:800 9px/1.2 Consolas,monospace; letter-spacing:.18em; }
      .result-title { margin:3px 0 0; font-size:20px; }
      .result-subtitle { margin-top:3px; color:var(--muted); font-size:11px; }
      .result-close { width:38px; height:38px; border:1px solid var(--line); border-radius:4px; background:#fff; color:#58666c; font-size:22px; cursor:pointer; }
      .review-strip { display:grid; grid-template-columns:repeat(4,1fr); min-height:54px; border-bottom:1px solid var(--line); background:#fff; }
      .review-filter { position:relative; border:0; border-right:1px solid #e6eaeb; padding:0 16px; background:transparent; color:#637177; text-align:left; cursor:pointer; }
      .review-filter::after { content:""; position:absolute; right:14px; bottom:0; left:14px; height:3px; background:transparent; }
      .review-filter.active { color:#152226; font-weight:800; }
      .review-filter.active::after { background:var(--teal); }
      .review-filter span { float:right; border-radius:10px; padding:1px 7px; background:#edf1f2; color:#536166; font:800 10px/1.5 Consolas,monospace; }
      .result-tools { display:grid; grid-template-columns:minmax(240px,1fr) auto auto; gap:9px; padding:11px 20px; border-bottom:1px solid var(--line); background:#f7f9f9; }
      .search-wrap { position:relative; }
      .search-wrap::before { content:"⌕"; position:absolute; top:50%; left:12px; color:#77868b; font:800 17px/1 Consolas,monospace; transform:translateY(-50%); }
      .result-search { width:100%; height:36px; border:1px solid #c8d1d4; border-radius:4px; padding:0 12px 0 34px; background:#fff; color:#233034; outline:none; }
      .result-search:focus { border-color:var(--teal); box-shadow:0 0 0 2px rgba(13,159,145,.1); }
      .tool-button,.tool-select { height:36px; border:1px solid #c4ced1; border-radius:4px; padding:0 10px; background:#fff; color:#344247; cursor:pointer; }
      .tool-button:disabled { opacity:.4; cursor:not-allowed; }
      .mark-current { display:flex; align-items:center; gap:5px; }
      .mark-current .tool-select { max-width:92px; }
      .result-content { min-height:0; overflow:auto; padding:13px 20px 18px; scrollbar-color:#99a8ac transparent; scrollbar-width:thin; }
      .result-list { display:grid; gap:8px; }
      .asset-row { display:grid; grid-template-columns:minmax(220px,1.2fr) minmax(260px,1.4fr) 105px 92px minmax(220px,auto) 94px; align-items:center; gap:12px; min-height:96px; border:1px solid #d4dcde; border-left:4px solid #8c999d; border-radius:5px; padding:11px 12px; background:#fff; transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease; }
      .asset-row:hover { transform:translateY(-1px); border-color:#a9b5b8; box-shadow:0 6px 18px rgba(14,25,29,.07); }
      .asset-row[data-review-tone="usable"] { border-left-color:var(--teal); }
      .asset-row[data-review-tone="unusable"] { border-left-color:var(--red); }
      .asset-row[data-review-tone="pending"] { border-left-color:#94a1a5; }
      .asset-identity,.asset-evidence { min-width:0; }
      .asset-kicker { margin-bottom:4px; color:#849196; font:800 9px/1.2 Consolas,monospace; letter-spacing:.1em; }
      .asset-domain { overflow:hidden; color:#101b1f; font:800 14px/1.35 Consolas,"Microsoft YaHei",monospace; text-overflow:ellipsis; white-space:nowrap; }
      .tag-line { display:flex; gap:4px; margin-top:6px; }
      .mini-tag { max-width:110px; overflow:hidden; border:1px solid #dce3e5; border-radius:3px; padding:1px 5px; background:#f3f6f6; color:#5f6d72; font:10px/1.4 Consolas,monospace; text-overflow:ellipsis; white-space:nowrap; }
      .mini-tag.more { color:#273438; font-weight:800; }
      .empty-tag { color:#9aa5a9; font-size:10px; }
      .evidence-title { overflow:hidden; color:#344146; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
      .evidence-url { margin-top:5px; overflow:hidden; color:#758388; font:10px/1.4 Consolas,monospace; text-overflow:ellipsis; white-space:nowrap; }
      .asset-source { display:grid; gap:3px; color:#6f7d82; font-size:10px; }
      .asset-source strong { color:#263337; font:800 10px/1.2 Consolas,monospace; }
      .asset-source small { color:#8c989c; }
      .review-state { display:grid; gap:2px; border-left:1px solid #e1e6e7; padding-left:11px; }
      .review-code { color:#849095; font:800 8px/1.2 Consolas,monospace; letter-spacing:.08em; }
      .review-state strong { color:#536166; font-size:11px; }
      .review-state[data-tone="usable"] strong { color:var(--teal-dark); }
      .review-state[data-tone="unusable"] strong { color:#a83636; }
      .review-controls { display:grid; grid-template-columns:repeat(3,1fr); overflow:hidden; border:1px solid #d2dadd; border-radius:4px; }
      .review-choice { height:29px; border:0; border-right:1px solid #dfe5e7; padding:0 7px; background:#fff; color:#68767b; font-size:10px; cursor:pointer; white-space:nowrap; }
      .review-choice:last-child { border-right:0; }
      .review-choice.active { background:#172427; color:#fff; font-weight:800; }
      .row-actions { display:grid; gap:5px; }
      .row-button { height:29px; border:1px solid #c8d1d4; border-radius:4px; background:#fff; color:#3b494e; font-size:10px; cursor:pointer; }
      .row-button.primary { border-color:#173c38; background:#173c38; color:#eafffc; }
      .row-button:hover { filter:brightness(.97); }
      .result-empty { display:grid; min-height:280px; place-items:center; border:1px dashed #bdc8cb; background:rgba(255,255,255,.5); color:#718086; text-align:center; }
      .result-empty strong { display:block; margin-bottom:4px; color:#2f3c41; font-size:15px; }
      .result-footer { display:grid; grid-template-columns:minmax(0,1fr) auto auto; align-items:center; gap:12px; min-height:66px; padding:10px 20px; border-top:1px solid var(--line); background:#fff; }
      .result-summary { color:#6e7c81; font-size:10px; }
      .result-summary strong { color:#263337; font:800 11px/1 Consolas,monospace; }
      .page-controls,.batch-actions { display:flex; align-items:center; gap:6px; }
      .page-button { min-width:34px; height:34px; border:1px solid #c7d0d3; border-radius:4px; background:#fff; color:#344247; cursor:pointer; }
      .page-button:disabled { opacity:.35; cursor:not-allowed; }
      .page-indicator { min-width:66px; color:#3c494e; font:800 10px/1 Consolas,monospace; text-align:center; }
      .batch-button { height:36px; border:1px solid #1b4843; border-radius:4px; padding:0 11px; background:#fff; color:#155f58; font-size:10px; font-weight:800; cursor:pointer; }
      .batch-button.primary { background:#173c38; color:#eafffc; }
      .batch-button:disabled { opacity:.4; cursor:not-allowed; }
      @media (max-width:980px) { .asset-row { grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) 90px minmax(210px,auto); } .review-state { display:none; } .row-actions { grid-column:4; } .result-modal { width:calc(100vw - 20px); height:calc(100vh - 20px); } .result-overlay { padding:10px; } }
      @media (max-width:720px) { .result-head { min-height:62px; padding:10px 13px; } .result-subtitle { display:none; } .result-tools { grid-template-columns:1fr auto; padding:9px 12px; } .result-tools .tool-button { display:none; } .result-content { padding:9px 12px 13px; } .asset-row { grid-template-columns:1fr auto; } .asset-evidence { grid-column:1/-1; } .asset-source { grid-column:1; } .review-controls { grid-column:1/-1; } .row-actions { grid-column:2; grid-row:1; } .result-footer { grid-template-columns:1fr auto; padding:9px 12px; } .batch-actions { grid-column:1/-1; } .batch-button { flex:1; } }
      @media (max-width:500px) { .panel,.launcher { right:12px; bottom:12px; } .panel { width:calc(100vw - 24px); } .review-strip { overflow-x:auto; grid-template-columns:repeat(4,minmax(105px,1fr)); } .result-tools { grid-template-columns:1fr; } .asset-row { grid-template-columns:1fr; } .row-actions { grid-column:1; grid-row:auto; grid-template-columns:1fr 1fr; } .asset-source { grid-column:1; } .result-footer { grid-template-columns:1fr; } .result-summary { display:none; } .page-controls { justify-content:space-between; } }
    `;

    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'launcher';
    launcher.textContent = '域名提取与审核';

    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.hidden = true;
    panel.innerHTML = `
      <header class="panel-head">
        <div><div class="panel-eyebrow">QUAKE DOMAIN WORKBENCH</div><h2 class="panel-title">域名提取与人工审核</h2></div>
        <button class="icon-button" type="button" data-action="close-panel" aria-label="关闭">×</button>
      </header>
      <div class="panel-body">
        <div class="query"><span class="query-label">QUERY</span><span class="query-value"></span></div>
        <div class="stats">
          <div class="stat"><strong data-stat="pages">0</strong><span>已采集页</span></div>
          <div class="stat"><strong data-stat="records">0</strong><span>域名记录</span></div>
          <div class="stat"><strong data-stat="domains">0</strong><span>聚合域名</span></div>
        </div>
        <div class="status" data-tone="idle">等待从当前 Quake 结果页提取</div>
        <fieldset class="settings">
          <div class="option-line">
            <label class="check"><input type="checkbox" data-setting="autoPaginate">自动翻页，全部提取后统一展示</label>
          </div>
          <details class="advanced">
            <summary>采集范围与等待设置</summary>
            <div class="setting-grid">
              <label class="setting-field">最多页数<input type="number" min="1" max="200" data-setting="maxPages"></label>
              <label class="setting-field">目标域名（0=不限）<input type="number" min="0" max="100000" data-setting="targetDomains"></label>
              <label class="setting-field">翻页等待 ms<input type="number" min="1500" max="30000" step="500" data-setting="pageWaitMs"></label>
            </div>
          </details>
        </fieldset>
        <div class="actions">
          <button class="button primary" type="button" data-action="start">开始提取全部域名</button>
          <button class="button stop" type="button" data-action="stop" hidden>停止提取</button>
          <button class="button" type="button" data-action="copy" disabled>复制域名</button>
        </div>
        <div class="result-actions">
          <button class="button" type="button" data-action="csv" disabled>CSV</button>
          <button class="button" type="button" data-action="json" disabled>JSON</button>
          <button class="button" type="button" data-action="copy-filtered" disabled>复制筛选</button>
          <button class="button review-open" type="button" data-action="review" disabled>打开域名审核台</button>
        </div>
      </div>`;

    const resultOverlay = document.createElement('div');
    resultOverlay.className = 'result-overlay';
    resultOverlay.hidden = true;
    resultOverlay.innerHTML = `
      <section class="result-modal" role="dialog" aria-modal="true" aria-labelledby="qdx-result-title">
        <header class="result-head">
          <div><div class="result-eyebrow">MANUAL ASSET REVIEW / NO NETWORK PROBING</div><h2 class="result-title" id="qdx-result-title">Quake 域名人工审核台</h2><div class="result-subtitle">先批量打开实际采集入口，再由你标记可用、不可用或待确认</div></div>
          <button class="result-close" type="button" data-result-close aria-label="关闭审核台">×</button>
        </header>
        <nav class="review-strip" aria-label="人工状态筛选">
          <button class="review-filter active" type="button" data-review-filter="all">全部域名<span>0</span></button>
          <button class="review-filter" type="button" data-review-filter="pending">待确认<span>0</span></button>
          <button class="review-filter" type="button" data-review-filter="usable">可用<span>0</span></button>
          <button class="review-filter" type="button" data-review-filter="unusable">不可用<span>0</span></button>
        </nav>
        <div class="result-tools">
          <label class="search-wrap"><span hidden>搜索域名</span><input class="result-search" type="search" placeholder="搜索域名、标题、URL、端口或页码…" autocomplete="off"></label>
          <select class="tool-select" data-result-page-size aria-label="每页数量"><option value="8">8 条/页</option><option value="12">12 条/页</option><option value="20">20 条/页</option><option value="50">50 条/页</option></select>
          <div class="mark-current"><select class="tool-select" data-mark-status aria-label="当前页目标状态"><option value="usable">可用</option><option value="unusable">不可用</option><option value="pending">待确认</option></select><button class="tool-button" type="button" data-mark-current>应用到当前页</button></div>
        </div>
        <div class="result-content"><div class="result-list"></div><div class="result-empty" hidden><div><strong>没有匹配的域名</strong>尝试清除搜索词或切换人工状态筛选</div></div></div>
        <footer class="result-footer">
          <div class="result-summary">当前显示 <strong data-result-range>0</strong>，筛选结果 <strong data-result-total>0</strong> 个域名</div>
          <div class="page-controls"><button class="page-button" type="button" data-page-action="prev">←</button><span class="page-indicator" data-result-page>1 / 1</span><button class="page-button" type="button" data-page-action="next">→</button></div>
          <div class="batch-actions"><button class="batch-button" type="button" data-open-batch="current">批量打开当前页 · 0</button><button class="batch-button primary" type="button" data-open-batch="filtered">批量打开筛选结果 · 0</button></div>
        </footer>
      </section>`;

    shadow.append(style, launcher, panel, resultOverlay);
    const get = (selector) => shadow.querySelector(selector);
    state.ui = {
      launcher,
      panel,
      resultOverlay,
      start: get('[data-action="start"]'),
      stop: get('[data-action="stop"]'),
      status: get('.status'),
      settingsFieldset: get('.settings'),
      autoPaginate: get('[data-setting="autoPaginate"]'),
      maxPages: get('[data-setting="maxPages"]'),
      targetDomains: get('[data-setting="targetDomains"]'),
      pageWaitMs: get('[data-setting="pageWaitMs"]'),
      pageCount: get('[data-stat="pages"]'),
      recordCount: get('[data-stat="records"]'),
      domainCount: get('[data-stat="domains"]'),
      resultActions: [...shadow.querySelectorAll('[data-action="copy"],[data-action="csv"],[data-action="json"],[data-action="copy-filtered"],[data-action="review"]')],
      resultList: get('.result-list'),
      resultEmpty: get('.result-empty'),
      resultSearch: get('.result-search'),
      reviewFilters: [...shadow.querySelectorAll('[data-review-filter]')],
      resultRange: get('[data-result-range]'),
      resultTotal: get('[data-result-total]'),
      resultPage: get('[data-result-page]'),
      resultPrev: get('[data-page-action="prev"]'),
      resultNext: get('[data-page-action="next"]'),
      resultPageSize: get('[data-result-page-size]'),
      openCurrent: get('[data-open-batch="current"]'),
      openFiltered: get('[data-open-batch="filtered"]'),
      markCurrent: get('[data-mark-current]'),
      markStatus: get('[data-mark-status]'),
    };

    get('.query-value').textContent = currentSearchQuery();
    state.ui.autoPaginate.checked = state.settings.autoPaginate;
    state.ui.maxPages.value = String(state.settings.maxPages);
    state.ui.targetDomains.value = String(state.settings.targetDomains);
    state.ui.pageWaitMs.value = String(state.settings.pageWaitMs);
    state.ui.resultPageSize.value = String(state.settings.resultPageSize);

    launcher.addEventListener('click', () => {
      panel.hidden = false;
      launcher.hidden = true;
    });
    get('[data-action="close-panel"]').addEventListener('click', () => {
      panel.hidden = true;
      launcher.hidden = false;
    });
    state.ui.start.addEventListener('click', runExtraction);
    state.ui.stop.addEventListener('click', () => {
      state.cancelled = true;
      setStatus('正在停止，等待当前翻页操作结束…', 'warning');
    });
    get('[data-action="copy"]').addEventListener('click', () => copyDomains());
    get('[data-action="csv"]').addEventListener('click', () => download(buildCsv(), 'csv', 'text/csv;charset=utf-8'));
    get('[data-action="json"]').addEventListener('click', () => download(buildJson(), 'json', 'application/json;charset=utf-8'));
    get('[data-action="copy-filtered"]').addEventListener('click', () => copyDomains(filteredAssets()));
    get('[data-action="review"]').addEventListener('click', openResultView);
    get('[data-result-close]').addEventListener('click', closeResultView);
    resultOverlay.addEventListener('click', (event) => {
      if (event.target === resultOverlay) closeResultView();
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.reviewFilter) {
        state.resultView.review = button.dataset.reviewFilter;
        state.resultView.page = 1;
        renderResults();
      } else if (button.dataset.pageAction) {
        state.resultView.page += button.dataset.pageAction === 'next' ? 1 : -1;
        renderResults();
      } else if (button.dataset.setReview) {
        setReview(button.dataset.domain, button.dataset.setReview);
      } else if (button.dataset.openDomain) {
        openSingleDomain(button.dataset.openDomain);
      } else if (button.dataset.copyDomain) {
        copyText(button.dataset.copyDomain).then(() => setStatus(`已复制 ${button.dataset.copyDomain}`, 'success'));
      } else if (button.dataset.openBatch === 'current') {
        openAssetBatch(state.resultView.pageItems, '当前页网站');
      } else if (button.dataset.openBatch === 'filtered') {
        openAssetBatch(filteredAssets(), '筛选结果网站');
      } else if (button.hasAttribute('data-mark-current')) {
        const choice = state.ui.markStatus.value;
        if (!REVIEW_VALUES.has(choice)) return;
        for (const asset of state.resultView.pageItems) setReview(asset.domain, choice, false);
        renderResults();
      }
    });
    state.ui.resultSearch.addEventListener('input', (event) => {
      state.resultView.query = event.target.value;
      state.resultView.page = 1;
      renderResults();
    });
    state.ui.resultPageSize.addEventListener('change', (event) => {
      state.settings.resultPageSize = clampInt(event.target.value, DEFAULT_SETTINGS.resultPageSize, 6, 50);
      state.resultView.page = 1;
      writeStoredJson(SETTINGS_KEY, state.settings);
      renderResults();
    });
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !resultOverlay.hidden) closeResultView();
    });
  }

  function boot() {
    mountUi();
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('打开 Quake 域名提取面板', () => {
        state.ui.panel.hidden = false;
        state.ui.launcher.hidden = true;
      });
      GM_registerMenuCommand('开始提取全部域名', runExtraction);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

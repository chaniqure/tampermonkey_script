// ==UserScript==
// @name         FOFA 域名资产提取与人工审核
// @namespace    local.codex.fofa
// @version      1.0.0
// @description  跨页提取 FOFA 搜索结果中的主机/域名，聚合展示、批量打开并由用户人工标记可用性。
// @author       you
// @match        *://fofa.info/*
// @match        *://*.fofa.info/*
// @match        *://fofa.so/*
// @match        *://*.fofa.so/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const APP_ID = 'fdx-domain-review-host';
  const SETTINGS_KEY = 'fdx-domain-extractor-settings-v1';
  const REVIEWS_KEY = 'fdx-domain-extractor-reviews-v1';
  const RESULT_LINK_SELECTOR = [
    'span.hsxa-host a[href]',
    '.hsxa-host a[href]',
    'a.hsxa-host[href]',
  ].join(', ');
  const NEXT_PAGE_SELECTOR = [
    '.hsxa-pagination button.btn-next',
    '.el-pagination button.btn-next',
    '.ant-pagination-next:not(.ant-pagination-disabled)',
    'button[aria-label*="下一页"]',
    'button[title*="下一页"]',
  ].join(', ');
  const ACTIVE_PAGE_SELECTORS = [
    '.hsxa-pagination .el-pager .number.active',
    '.el-pagination .el-pager .number.active',
    '.el-pagination li.number.is-active',
    '.ant-pagination-item-active',
    '[aria-current="page"]',
  ];
  const DEFAULT_SETTINGS = Object.freeze({
    autoPaginate: true,
    maxPages: 10,
    targetDomains: 0,
    pageWaitMs: 5000,
    resultPageSize: 12,
    launcherPosition: null,
  });
  const REVIEW_VALUES = new Set(['pending', 'usable', 'unusable']);
  const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

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
      launcherPosition: raw.launcherPosition || DEFAULT_SETTINGS.launcherPosition,
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
    if (!IPV4.test(host)) return false;
    return true;
  }

  function normalizeHostHref(rawHref) {
    const text = normalizeText(rawHref);
    if (!text || text === '#' || text.startsWith('javascript:')) return '';
    try {
      if (/^https?:\/\//i.test(text)) return new URL(text).href;
      if (text.startsWith('//')) return new URL(`https:${text}`).href;
      if (/^\[?[0-9a-fA-F:.]+\]?:\d+$/.test(text) || /^[\w.-]+:\d+$/.test(text)) {
        return new URL(`http://${text}`).href;
      }
      if (IPV4.test(text) || (/^[a-z0-9.-]+\.[a-z0-9.-]+$/i.test(text) && text.includes('.'))) {
        return new URL(`http://${text}`).href;
      }
      return '';
    } catch {
      return '';
    }
  }

  function extractDomainFromUrl(rawUrl) {
    try {
      const normalized = normalizeHostHref(rawUrl) || String(rawUrl || '').trim();
      const url = new URL(normalized);
      const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
      if (!hostname || hostname === 'localhost') return '';
      return hostname;
    } catch {
      return '';
    }
  }

  function decodeQbase64(value) {
    try {
      const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      try {
        return decodeURIComponent(escape(atob(String(value || ''))));
      } catch {
        return String(value || '');
      }
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
    decodeQbase64,
    extractDomainFromUrl,
    filterDomainAssets,
    isIpHostname,
    normalizeHostHref,
    normalizeSettings,
    pageStateChanged,
    samePageState,
  };
  if (globalThis.__FDX_TEST_MODE__) {
    globalThis.__FDX_TEST_API__ = TEST_API;
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
      console.warn('[FOFA 域名审核台] 保存配置失败', error);
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
      .replace(/\bFavicon相同网页\b/gi, '')
      .replace(/\b相似网站\b/gi, '');
    return normalizeText(title) || '(无标题)';
  }

  function getCardRoot(anchor) {
    return anchor.closest('.hsxa-meta-data-item, .hsxa-meta-data-list-item, [class*="hsxa-meta-data"]')
      || anchor.parentElement;
  }

  function getNodeTitle(anchor) {
    const card = getCardRoot(anchor);
    if (card) {
      const selectors = [
        '[class*="title"]',
        '.hsxa-meta-data-list-main-left p',
        '.hsxa-meta-data-list-main-left span',
        'h1,h2,h3,h4,strong',
      ];
      for (const selector of selectors) {
        for (const candidate of card.querySelectorAll(selector)) {
          if (candidate.contains(anchor) || candidate === anchor) continue;
          const text = normalizeText(candidate.textContent);
          if (!text || text.length < 2 || text.length > 180) continue;
          if (/^(https?:|www\.|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$)/i.test(text)) continue;
          if (/^\d+$/.test(text)) continue;
          return cleanTitle(text);
        }
      }
    }

    const ownTitle = cleanTitle(anchor.getAttribute('title') || '');
    if (ownTitle !== '(无标题)') return ownTitle;

    const ownText = normalizeText(anchor.textContent);
    if (ownText && !/^(https?:|www\.|\d{1,3}(?:\.\d{1,3}){3})/i.test(ownText) && ownText.length > 2) {
      return cleanTitle(ownText);
    }
    return ownText ? cleanTitle(ownText) : '(无标题)';
  }

  function getPortFromCard(anchor, url) {
    const card = getCardRoot(anchor);
    const portNode = card?.querySelector('a.hsxa-port, .hsxa-port, [class*="hsxa-port"]');
    const fromCard = normalizeText(portNode?.textContent);
    if (/^\d{1,5}$/.test(fromCard)) return fromCard;
    if (url.port) return url.port;
    if (url.protocol === 'https:') return '443';
    if (url.protocol === 'http:') return '80';
    return '';
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
      const rawHref = anchor.getAttribute('href') || normalizeText(anchor.textContent);
      const normalizedHref = normalizeHostHref(rawHref);
      if (!normalizedHref) continue;
      let url;
      try {
        url = new URL(normalizedHref);
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
        port: getPortFromCard(anchor, url),
        kind: isIpHostname(domain) ? 'ip' : 'domain',
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
      launcherPosition: state.settings.launcherPosition,
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
    setStatus('正在等待当前 FOFA 结果页稳定…', 'working');

    try {
      const initial = await waitForStableResults(null, state.settings.pageWaitMs);
      if (!initial) {
        setStatus('未发现搜索结果。请先在 FOFA 完成检索，再开始提取。', 'warning');
        return;
      }

      for (let step = 1; step <= state.settings.maxPages && !state.cancelled; step += 1) {
        const pageRecords = extractRecordsFromCurrentPage(step);
        mergePageRecords(pageRecords);
        state.pagesCollected += 1;
        updateStats();
        setStatus(`第 ${getActivePageNumber() || step} 页完成：本页 ${pageRecords.length} 条主机记录，累计 ${state.assets.length} 个主机`, 'working');

        if (state.settings.targetDomains > 0 && state.assets.length >= state.settings.targetDomains) {
          setStatus(`已达到目标主机数 ${state.settings.targetDomains}，采集完成`, 'success');
          break;
        }
        if (!state.settings.autoPaginate || step >= state.settings.maxPages) {
          setStatus(`采集完成：${state.pagesCollected} 页、${state.assets.length} 个主机`, 'success');
          break;
        }

        setStatus(`已完成 ${state.pagesCollected} 页，正在切换下一页…`, 'working');
        const nextState = await gotoNextPage();
        if (!nextState) {
          setStatus(`已到末页或翻页未在 ${state.settings.pageWaitMs}ms 内稳定，共提取 ${state.assets.length} 个主机`, state.assets.length ? 'success' : 'warning');
          break;
        }
      }

      if (state.cancelled) setStatus(`已停止，保留已提取的 ${state.assets.length} 个主机`, 'warning');
      if (state.assets.length) openResultView();
    } catch (error) {
      console.error('[FOFA 域名审核台] 提取失败', error);
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
    const kindLabel = isIpHostname(asset.domain) ? 'IP' : 'DOMAIN';
    return `
      <article class="asset-row" data-review-tone="${review}">
        <div class="asset-identity">
          <div class="asset-kicker">${kindLabel} · ${asset.recordCount} RECORD${asset.recordCount > 1 ? 'S' : ''}</div>
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
          <button type="button" class="row-button ghost" data-copy-domain="${domain}">复制主机</button>
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
      setStatus('暂无主机，请先开始提取', 'warning');
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
    const warning = `将在后台打开 ${values.length} 个从 FOFA 提取的真实网站。\n这些站点可能包含恶意或失陷资产，请仅在隔离环境中访问。\n\n是否继续？`;
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
    copyText(domains.join('\n')).then(() => setStatus(`已复制 ${domains.length} 个主机`, 'success'));
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
    anchor.download = `fofa-hosts-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function currentSearchQuery() {
    try {
      const params = new URLSearchParams(location.search);
      const qbase64 = params.get('qbase64');
      if (qbase64) {
        const decoded = decodeQbase64(qbase64);
        return decoded || '当前 FOFA 搜索结果';
      }
      return '当前 FOFA 搜索结果';
    } catch {
      return '当前 FOFA 搜索结果';
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
      @keyframes fdx-fadein { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
      @keyframes fdx-overlay-in { from { opacity:0; } to { opacity:1; } }
      @keyframes fdx-modal-in { from { opacity:0; transform:scale(.98) translateY(4px); } to { opacity:1; transform:none; } }
      @keyframes fdx-pulse { 0%,100% { opacity:.5; } 50% { opacity:1; } }
      :host { all:initial; --ink:#1a2332; --ink-soft:#3d4f66; --paper:#fff; --bg:#f3f6fa; --line:#d5deea; --line-light:#e8eef6; --muted:#7a8ba3; --accent:#2f6fed; --accent-hover:#2458c7; --accent-bg:#e8f0fe; --accent-border:#a8c4f5; --green:#0eb194; --green-bg:#e6f5f4; --amber:#d97a00; --amber-bg:#fdf3e6; --red:#d93025; --red-bg:#fceae9; --radius:4px; --radius-sm:3px; --shadow-sm:0 1px 2px rgba(0,0,0,.04); --shadow-md:0 4px 12px rgba(0,0,0,.08); --shadow-lg:0 8px 30px rgba(0,0,0,.12); --font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; --font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; }
      * { box-sizing:border-box; }
      button,input,select { font:inherit; }
      [hidden] { display:none !important; }

      /* === Launcher === */
      .launcher { position:fixed; right:20px; bottom:20px; z-index:2147483646; display:inline-flex; align-items:center; gap:6px; height:32px; border:1px solid var(--line); border-radius:var(--radius); padding:0 12px 0 8px; background:var(--paper); color:var(--ink); box-shadow:var(--shadow-sm); cursor:pointer; font:500 13px/1 var(--font-sans); transition:all .15s; }
      .launcher::before { content:"F"; display:flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:var(--radius-sm); background:var(--accent); color:var(--paper); font-size:10px; font-weight:bold; }
      .launcher:hover { border-color:var(--muted); box-shadow:var(--shadow-md); }

      /* === Panel === */
      .panel { position:fixed; right:20px; bottom:20px; z-index:2147483647; width:min(340px,calc(100vw - 24px)); border:1px solid var(--line); border-radius:var(--radius); background:var(--paper); color:var(--ink); box-shadow:var(--shadow-lg); font:13px/1.5 var(--font-sans); animation:fdx-fadein .2s ease; }
      .panel-head { display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:1px solid var(--line-light); background:var(--bg); }
      .panel-eyebrow { color:var(--muted); font:500 10px/1.2 var(--font-mono); letter-spacing:.5px; text-transform:uppercase; }
      .panel-title { margin:0; font-size:14px; font-weight:600; color:var(--ink); }
      .icon-button { display:flex; align-items:center; justify-content:center; width:24px; height:24px; border:1px solid transparent; border-radius:var(--radius-sm); background:transparent; color:var(--muted); font-size:15px; cursor:pointer; transition:all .15s; }
      .icon-button:hover { background:var(--line-light); color:var(--ink); border-color:var(--line); }

      /* === Panel Body === */
      .panel-body { padding:10px 12px; }
      .query { display:flex; align-items:center; gap:6px; margin-bottom:10px; }
      .query-label { flex:none; border-radius:2px; padding:2px 4px; background:var(--line-light); color:var(--ink-soft); font:500 10px/1.2 var(--font-mono); }
      .query-value { overflow:hidden; color:var(--ink); font:12px/1.4 var(--font-mono); text-overflow:ellipsis; white-space:nowrap; }

      /* === Stats === */
      .stats { display:flex; border:1px solid var(--line); border-radius:var(--radius-sm); overflow:hidden; }
      .stat { flex:1; padding:6px; text-align:center; border-right:1px solid var(--line); background:var(--bg); }
      .stat:last-child { border-right:0; }
      .stat strong { display:block; color:var(--ink); font:600 15px/1 var(--font-mono); }
      .stat span { display:block; margin-top:2px; color:var(--muted); font-size:10px; }

      /* === Status === */
      .status { margin:8px 0; border-radius:var(--radius-sm); padding:6px 8px; font-size:12px; transition:all .2s ease; border:1px solid transparent; }
      .status[data-tone="idle"] { background:var(--line-light); color:var(--ink-soft); }
      .status[data-tone="working"] { background:var(--bg); color:var(--ink); border-color:var(--line); }
      .status[data-tone="working"]::before { content:"● "; color:var(--accent); animation:fdx-pulse 1.5s ease infinite; }
      .status[data-tone="success"] { background:var(--green-bg); color:var(--green); border-color:rgba(0,122,51,.2); }
      .status[data-tone="success"]::before { content:"✓ "; }
      .status[data-tone="warning"] { background:var(--amber-bg); color:var(--amber); border-color:rgba(153,92,0,.2); }
      .status[data-tone="warning"]::before { content:"⚠ "; }
      .status[data-tone="error"] { background:var(--red-bg); color:var(--red); border-color:rgba(179,0,0,.2); }
      .status[data-tone="error"]::before { content:"✕ "; }

      /* === Settings === */
      .settings { margin:0 0 10px; padding:0; border:0; }
      .option-line { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
      .check { display:inline-flex; align-items:center; gap:6px; color:var(--ink-soft); font-size:12px; cursor:pointer; }
      .check input { width:13px; height:13px; margin:0; accent-color:var(--ink); cursor:pointer; }
      .advanced { border-top:1px dashed var(--line); padding-top:6px; }
      .advanced summary { color:var(--muted); font-size:11px; cursor:pointer; user-select:none; }
      .advanced summary:hover { color:var(--ink); }
      .setting-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin-top:6px; }
      .setting-field { display:grid; gap:2px; color:var(--muted); font-size:10px; }
      .setting-field input { width:100%; height:26px; border:1px solid var(--line); border-radius:var(--radius-sm); padding:0 6px; background:var(--paper); color:var(--ink); font:500 11px/1 var(--font-mono); outline:none; transition:border-color .15s; }
      .setting-field input:focus { border-color:var(--ink); }

      /* === Action Buttons === */
      .actions { display:grid; grid-template-columns:1fr auto; gap:6px; }
      .button { height:28px; border:1px solid var(--line); border-radius:var(--radius-sm); padding:0 10px; background:var(--paper); color:var(--ink-soft); font-size:12px; cursor:pointer; transition:all .15s; }
      .button:hover:not(:disabled) { border-color:var(--muted); color:var(--ink); background:var(--bg); }
      .button.primary { border-color:var(--accent); background:var(--accent); color:var(--paper); font-weight:500; }
      .button.primary:hover:not(:disabled) { background:var(--accent-hover); border-color:var(--accent-hover); }
      .button.stop { border-color:var(--red); background:var(--red); color:var(--paper); }
      .button.stop:hover:not(:disabled) { background:#900; border-color:#900; }
      .button:disabled { opacity:.4; cursor:not-allowed; }
      .result-actions { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin-top:6px; }
      .result-actions .review-open { grid-column:1/-1; height:32px; border:1px solid var(--accent); background:var(--paper); color:var(--accent); font-weight:600; }
      .result-actions .review-open:hover:not(:disabled) { background:var(--accent); color:var(--paper); }

      /* === Result Overlay === */
      .result-overlay { position:fixed; inset:0; z-index:2147483647; display:grid; place-items:center; padding:16px; background:rgba(0,0,0,.3); backdrop-filter:blur(2px); -webkit-backdrop-filter:blur(2px); font:13px/1.5 var(--font-sans); animation:fdx-overlay-in .2s ease; }
      .result-modal { display:flex; flex-direction:column; width:min(1100px,calc(100vw - 32px)); height:min(720px,calc(100vh - 32px)); background:var(--paper); border-radius:var(--radius); box-shadow:var(--shadow-lg); border:1px solid var(--line); animation:fdx-modal-in .2s ease; overflow:hidden; }
      
      /* === Result Header === */
      .result-head { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--line); background:var(--bg); flex-shrink:0; }
      .result-eyebrow { color:var(--muted); font:500 10px/1.2 var(--font-mono); letter-spacing:.5px; text-transform:uppercase; }
      .result-title { margin:2px 0 0; font-size:16px; font-weight:600; color:var(--ink); }
      .result-subtitle { margin-top:1px; color:var(--muted); font-size:11px; }
      .result-close { display:flex; align-items:center; justify-content:center; width:28px; height:28px; border:1px solid transparent; border-radius:var(--radius-sm); color:var(--muted); font-size:18px; cursor:pointer; transition:all .15s; }
      .result-close:hover { background:var(--line); color:var(--ink); }

      /* === Review Strip === */
      .review-strip { display:flex; border-bottom:1px solid var(--line); flex-shrink:0; }
      .review-filter { flex:1; display:flex; align-items:center; justify-content:space-between; height:40px; padding:0 16px; border:0; border-right:1px solid var(--line); background:transparent; color:var(--muted); font-size:13px; cursor:pointer; transition:all .15s; }
      .review-filter:last-child { border-right:0; }
      .review-filter:hover { background:var(--bg); color:var(--ink); }
      .review-filter.active { background:var(--bg); color:var(--accent); font-weight:600; box-shadow:inset 0 -2px 0 var(--accent); }
      .review-filter span { border-radius:10px; padding:2px 6px; background:var(--line-light); color:var(--muted); font:500 10px/1.2 var(--font-mono); }
      .review-filter.active span { background:var(--accent); color:var(--paper); }

      /* === Tools Bar === */
      .result-tools { display:flex; align-items:center; gap:8px; padding:8px 16px; border-bottom:1px solid var(--line); background:var(--paper); flex-shrink:0; }
      .search-wrap { flex:1; position:relative; }
      .search-wrap::before { content:"⌕"; position:absolute; top:50%; left:8px; color:var(--muted); font-size:15px; transform:translateY(-50%); }
      .result-search { width:100%; height:30px; border:1px solid var(--line); border-radius:var(--radius-sm); padding:0 8px 0 24px; background:var(--bg); color:var(--ink); font-size:12px; outline:none; transition:border-color .15s; }
      .result-search:focus { border-color:var(--ink); background:var(--paper); }
      .tool-button,.tool-select { height:30px; border:1px solid var(--line); border-radius:var(--radius-sm); padding:0 8px; background:var(--paper); color:var(--ink-soft); font-size:12px; cursor:pointer; transition:all .15s; }
      .tool-button:hover:not(:disabled),.tool-select:hover { border-color:var(--muted); color:var(--ink); }
      .tool-button:disabled { opacity:.4; cursor:not-allowed; }
      .mark-current { display:flex; align-items:center; gap:4px; margin-left:auto; }

      /* === Result Content === */
      .result-content { flex:1; min-height:0; overflow-y:auto; padding:8px 16px; scrollbar-width:thin; background:var(--bg); }
      .result-list { display:flex; flex-direction:column; gap:6px; }

      /* === Asset Row === */
      .asset-row { display:flex; align-items:center; gap:14px; padding:10px 14px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--paper); transition:all .15s; }
      .asset-row:hover { border-color:var(--muted); box-shadow:var(--shadow-sm); }
      .asset-row[data-review-tone="usable"] { border-left:3px solid var(--green); }
      .asset-row[data-review-tone="unusable"] { border-left:3px solid var(--red); }
      .asset-row[data-review-tone="pending"] { border-left:3px solid var(--line); }
      
      .asset-identity { width:220px; flex-shrink:0; }
      .asset-kicker { margin-bottom:2px; color:var(--muted); font:500 9px/1 var(--font-mono); letter-spacing:.5px; text-transform:uppercase; }
      .asset-domain { font:600 14px/1.2 var(--font-mono); color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .tag-line { display:flex; flex-wrap:wrap; gap:2px; margin-top:4px; }
      .mini-tag { max-width:90px; border-radius:2px; padding:2px 5px; background:var(--line-light); color:var(--ink-soft); font:500 10px/1.2 var(--font-mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .mini-tag.more { color:var(--ink); font-weight:600; }
      .empty-tag { color:var(--muted); font-size:10px; }
      
      .asset-evidence { flex:1; min-width:0; }
      .evidence-title { font:500 13px/1.3 var(--font-sans); color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .evidence-url { margin-top:3px; font:400 11px/1.2 var(--font-mono); color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      
      .asset-source { width:110px; flex-shrink:0; display:flex; flex-direction:column; gap:2px; font-size:10px; color:var(--muted); }
      .asset-source strong { color:var(--ink-soft); font-weight:600; font-family:var(--font-mono); font-size:11px; }
      
      /* Hide redundant review state to save horizontal space */
      .review-state { display:none; }

      .review-controls { display:flex; flex-shrink:0; border:1px solid var(--line); border-radius:var(--radius-sm); overflow:hidden; }
      .review-choice { height:26px; border:0; border-right:1px solid var(--line); padding:0 10px; background:var(--paper); color:var(--muted); font-size:11px; cursor:pointer; transition:all .1s; }
      .review-choice:last-child { border-right:0; }
      .review-choice:hover { background:var(--bg); color:var(--ink); }
      .review-choice.active { background:var(--accent); color:var(--paper); font-weight:600; }

      .row-actions { display:flex; gap:6px; flex-shrink:0; }
      .row-button { height:26px; border:1px solid var(--line); border-radius:var(--radius-sm); padding:0 10px; background:var(--paper); color:var(--ink-soft); font-size:11px; cursor:pointer; transition:all .1s; }
      .row-button:hover { background:var(--bg); color:var(--ink); border-color:var(--muted); }
      .row-button.primary { border-color:var(--accent); color:var(--accent); font-weight:500; }
      .row-button.primary:hover { background:var(--accent); color:var(--paper); }

      /* === Empty & Footer === */
      .result-empty { display:flex; flex-direction:column; justify-content:center; align-items:center; height:200px; border:1px dashed var(--line); border-radius:var(--radius); color:var(--muted); font-size:12px; }
      .result-empty strong { color:var(--ink); font-size:14px; font-weight:500; margin-bottom:4px; }
      
      .result-footer { display:flex; align-items:center; justify-content:space-between; padding:8px 16px; border-top:1px solid var(--line); background:var(--paper); flex-shrink:0; }
      .result-summary { color:var(--muted); font-size:11px; }
      .result-summary strong { color:var(--ink); font:500 12px/1 var(--font-mono); }
      
      .page-controls { display:flex; align-items:center; gap:4px; }
      .page-button { display:flex; align-items:center; justify-content:center; width:26px; height:26px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--paper); color:var(--ink-soft); cursor:pointer; transition:all .1s; }
      .page-button:hover:not(:disabled) { background:var(--bg); color:var(--ink); }
      .page-button:disabled { opacity:.3; cursor:not-allowed; }
      .page-indicator { min-width:50px; text-align:center; color:var(--ink); font:500 11px/1 var(--font-mono); }
      
      .batch-actions { display:flex; gap:6px; }
      .batch-button { height:30px; border:1px solid var(--line); border-radius:var(--radius-sm); padding:0 12px; background:var(--paper); color:var(--ink-soft); font-size:11px; font-weight:500; cursor:pointer; transition:all .15s; }
      .batch-button:hover:not(:disabled) { background:var(--bg); color:var(--ink); border-color:var(--muted); }
      .batch-button.primary { background:var(--accent); border-color:var(--accent); color:var(--paper); }
      .batch-button.primary:hover:not(:disabled) { background:var(--accent-hover); border-color:var(--accent-hover); }
      .batch-button:disabled { opacity:.4; cursor:not-allowed; }

      /* === Responsive === */
      @media (max-width:900px) {
        .asset-row { flex-wrap:wrap; }
        .asset-identity { width:40%; }
        .asset-evidence { width:50%; }
        .asset-source { width:100%; display:flex; flex-direction:row; gap:12px; padding-top:6px; border-top:1px dashed var(--line-light); }
        .review-controls { margin-left:auto; }
      }
      @media (max-width:600px) {
        .result-tools { flex-wrap:wrap; }
        .mark-current { width:100%; justify-content:flex-end; }
        .asset-row { flex-direction:column; align-items:flex-start; }
        .asset-identity, .asset-evidence, .asset-source { width:100%; }
        .review-controls, .row-actions { width:100%; justify-content:space-between; }
        .review-choice, .row-button { flex:1; text-align:center; }
      }
    `;

    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'launcher';
    launcher.textContent = 'FOFA 主机提取';
    if (state.settings.launcherPosition) {
      launcher.style.right = state.settings.launcherPosition.right;
      launcher.style.bottom = state.settings.launcherPosition.bottom;
    }

    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.hidden = true;
    panel.innerHTML = `
      <header class="panel-head">
        <div><div class="panel-eyebrow">FOFA HOST WORKBENCH</div><h2 class="panel-title">主机提取与人工审核</h2></div>
        <button class="icon-button" type="button" data-action="close-panel" aria-label="关闭">×</button>
      </header>
      <div class="panel-body">
        <div class="query"><span class="query-label">QUERY</span><span class="query-value"></span></div>
        <div class="stats">
          <div class="stat"><strong data-stat="pages">0</strong><span>已采集页</span></div>
          <div class="stat"><strong data-stat="records">0</strong><span>主机记录</span></div>
          <div class="stat"><strong data-stat="domains">0</strong><span>聚合主机</span></div>
        </div>
        <div class="status" data-tone="idle">等待从当前 FOFA 结果页提取</div>
        <fieldset class="settings">
          <div class="option-line">
            <label class="check"><input type="checkbox" data-setting="autoPaginate">自动翻页，全部提取后统一展示</label>
          </div>
          <details class="advanced">
            <summary>采集范围与等待设置</summary>
            <div class="setting-grid">
              <label class="setting-field">最多页数<input type="number" min="1" max="200" data-setting="maxPages"></label>
              <label class="setting-field">目标主机（0=不限）<input type="number" min="0" max="100000" data-setting="targetDomains"></label>
              <label class="setting-field">翻页等待 ms<input type="number" min="1500" max="30000" step="500" data-setting="pageWaitMs"></label>
            </div>
          </details>
        </fieldset>
        <div class="actions">
          <button class="button primary" type="button" data-action="start">开始提取全部主机</button>
          <button class="button stop" type="button" data-action="stop" hidden>停止提取</button>
          <button class="button" type="button" data-action="copy" disabled>复制主机</button>
        </div>
        <div class="result-actions">
          <button class="button" type="button" data-action="csv" disabled>CSV</button>
          <button class="button" type="button" data-action="json" disabled>JSON</button>
          <button class="button" type="button" data-action="copy-filtered" disabled>复制筛选</button>
          <button class="button review-open" type="button" data-action="review" disabled>打开主机审核台</button>
        </div>
      </div>`;

    const resultOverlay = document.createElement('div');
    resultOverlay.className = 'result-overlay';
    resultOverlay.hidden = true;
    resultOverlay.innerHTML = `
      <section class="result-modal" role="dialog" aria-modal="true" aria-labelledby="fdx-result-title">
        <header class="result-head">
          <div><div class="result-eyebrow">MANUAL ASSET REVIEW / NO NETWORK PROBING</div><h2 class="result-title" id="fdx-result-title">FOFA 主机人工审核台</h2><div class="result-subtitle">先批量打开实际采集入口，再由你标记可用、不可用或待确认</div></div>
          <button class="result-close" type="button" data-result-close aria-label="关闭审核台">×</button>
        </header>
        <nav class="review-strip" aria-label="人工状态筛选">
          <button class="review-filter active" type="button" data-review-filter="all">全部主机<span>0</span></button>
          <button class="review-filter" type="button" data-review-filter="pending">待确认<span>0</span></button>
          <button class="review-filter" type="button" data-review-filter="usable">可用<span>0</span></button>
          <button class="review-filter" type="button" data-review-filter="unusable">不可用<span>0</span></button>
        </nav>
        <div class="result-tools">
          <label class="search-wrap"><span hidden>搜索主机</span><input class="result-search" type="search" placeholder="搜索主机、标题、URL、端口或页码…" autocomplete="off"></label>
          <select class="tool-select" data-result-page-size aria-label="每页数量"><option value="8">8 条/页</option><option value="12">12 条/页</option><option value="20">20 条/页</option><option value="50">50 条/页</option></select>
          <div class="mark-current"><select class="tool-select" data-mark-status aria-label="当前页目标状态"><option value="usable">可用</option><option value="unusable">不可用</option><option value="pending">待确认</option></select><button class="tool-button" type="button" data-mark-current>应用到当前页</button></div>
        </div>
        <div class="result-content"><div class="result-list"></div><div class="result-empty" hidden><div><strong>没有匹配的主机</strong>尝试清除搜索词或切换人工状态筛选</div></div></div>
        <footer class="result-footer">
          <div class="result-summary">当前显示 <strong data-result-range>0</strong>，筛选结果 <strong data-result-total>0</strong> 个主机</div>
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

    let isDragging = false;
    launcher.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging = false;
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = launcher.getBoundingClientRect();
      const startRight = window.innerWidth - rect.right;
      const startBottom = window.innerHeight - rect.bottom;

      const onMouseMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
          isDragging = true;
          launcher.style.transition = 'none';
        }
        if (isDragging) {
          launcher.style.right = `${Math.max(0, startRight - dx)}px`;
          launcher.style.bottom = `${Math.max(0, startBottom - dy)}px`;
        }
      };

      const onMouseUp = () => {
        launcher.style.transition = '';
        if (isDragging) {
          state.settings.launcherPosition = { right: launcher.style.right, bottom: launcher.style.bottom };
          writeStoredJson(SETTINGS_KEY, state.settings);
        }
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    launcher.addEventListener('click', (e) => {
      if (isDragging) {
        e.preventDefault();
        return;
      }
      
      const rect = launcher.getBoundingClientRect();
      const spaceRight = window.innerWidth - rect.right;
      const spaceBottom = window.innerHeight - rect.bottom;
      
      panel.style.top = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = 'auto';
      panel.style.right = 'auto';
      
      if (spaceRight + 340 > window.innerWidth) {
        panel.style.left = '12px';
      } else {
        panel.style.right = `${Math.max(12, spaceRight)}px`;
      }
      
      if (rect.top < window.innerHeight / 2) {
        panel.style.top = `${Math.max(12, rect.top)}px`;
      } else {
        panel.style.bottom = `${Math.max(12, spaceBottom)}px`;
      }
      
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
      GM_registerMenuCommand('打开 FOFA 主机提取面板', () => {
        state.ui.panel.hidden = false;
        state.ui.launcher.hidden = true;
      });
      GM_registerMenuCommand('开始提取全部主机', runExtraction);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

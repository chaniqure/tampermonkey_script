// ==UserScript==
// @name         微步关联资产提取器
// @namespace    local.codex.threatbook
// @version      1.4.0
// @description  提取微步 IP/域名情报页面中的关联域名和 IP，并导出 CSV/JSON。表格翻页默认随机间隔 1–3 秒。
// @author       Codex
// @match        https://x.threatbook.com/v5/ip/*
// @match        https://x.threatbook.com/v5/domain/*
// @grant        GM_openInTab
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const APP_ID = 'tb-asset-extractor-host';
  const REVIEW_STORAGE_KEY = 'tb-asset-extractor-domain-review-v1';
  const CONFIG_STORAGE_KEY = 'tb-asset-extractor-config-v1';
  const RESULT_PAGE_SIZE = 12;
  const MAX_PAGES = 150;
  const WAIT_TIMEOUT = 15000;
  const PAGE_SETTLE_MS = 250;
  const SEARCH_DEBOUNCE_MS = 180;
  const DEFAULT_CONFIG = Object.freeze({
    pageDelayMinMs: 1000,
    pageDelayMaxMs: 3000,
    launcherPosition: null,
  });
  const DOMAIN_PATH = /\/v5\/domain\/([^/?#]+)/i;
  const IP_PATH = /\/v5\/ip\/([^/?#]+)/i;
  const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
  const DATE_PATTERN = /\b\d{4}[-/]\d{2}[-/]\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?\b/;

  function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function randomPageDelayMs(minMs, maxMs, randomFn = Math.random) {
    const min = clampInt(minMs, DEFAULT_CONFIG.pageDelayMinMs, 0, 60000);
    const max = clampInt(maxMs, DEFAULT_CONFIG.pageDelayMaxMs, 0, 60000);
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    if (high <= low) return low;
    const span = high - low + 1;
    return Math.min(high, low + Math.floor(randomFn() * span));
  }

  function normalizeConfig(raw = {}) {
    let pageDelayMinMs = clampInt(raw.pageDelayMinMs, DEFAULT_CONFIG.pageDelayMinMs, 0, 60000);
    let pageDelayMaxMs = clampInt(raw.pageDelayMaxMs, DEFAULT_CONFIG.pageDelayMaxMs, 0, 60000);
    if (pageDelayMinMs > pageDelayMaxMs) {
      const swap = pageDelayMinMs;
      pageDelayMinMs = pageDelayMaxMs;
      pageDelayMaxMs = swap;
    }
    return {
      pageDelayMinMs,
      pageDelayMaxMs,
      launcherPosition: raw.launcherPosition || DEFAULT_CONFIG.launcherPosition,
    };
  }

  const state = {
    running: false,
    cancelled: false,
    rawRecords: [],
    rawRecordCount: 0,
    records: [],
    recordItems: [],
    domainAssets: [],
    ipAssets: [],
    domains: [],
    ips: [],
    prepared: false,
    preparing: false,
    errors: [],
    originalTab: '',
    query: readQuery(),
    ui: null,
    domainReviews: loadDomainReviews(),
    config: loadConfig(),
    resultView: {
      tab: 'domains',
      page: 1,
      pageSize: RESULT_PAGE_SIZE,
      query: '',
      review: 'all',
      pageItems: [],
      returnFocus: null,
    },
  };

  function readQuery() {
    const ipMatch = location.pathname.match(IP_PATH);
    const domainMatch = location.pathname.match(DOMAIN_PATH);
    if (ipMatch) return { type: 'ip', value: decodeURIComponent(ipMatch[1]) };
    if (domainMatch) return { type: 'domain', value: decodeURIComponent(domainMatch[1]).toLowerCase() };
    return { type: 'unknown', value: '' };
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function sleepCancellable(ms) {
    const startedAt = Date.now();
    while (!state.cancelled && Date.now() - startedAt < ms) {
      await sleep(Math.min(200, ms - (Date.now() - startedAt)));
    }
  }

  async function waitFor(predicate, timeout = WAIT_TIMEOUT, interval = 100) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (state.cancelled) throw new Error('用户已停止提取');
      const value = predicate();
      if (value) return value;
      await sleep(interval);
    }
    throw new Error('等待页面数据超时');
  }

  function isElementVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function decodeAssetFromHref(href, pattern) {
    const match = String(href || '').match(pattern);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]).toLowerCase();
    } catch {
      return match[1].toLowerCase();
    }
  }

  function assetsFrom(root, pattern) {
    return [...root.querySelectorAll('a[href]')]
      .map((anchor) => decodeAssetFromHref(anchor.getAttribute('href'), pattern))
      .filter(Boolean);
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function tableHeaders(table) {
    const headers = [...table.querySelectorAll('thead th')].map((cell) => normalizeText(cell.textContent));
    if (headers.some(Boolean)) return headers;
    const measureRow = table.querySelector('tbody tr[aria-hidden="true"]');
    return measureRow ? [...measureRow.querySelectorAll('th')].map((cell) => normalizeText(cell.textContent)) : [];
  }

  function dataRows(table) {
    return [...table.querySelectorAll('tbody tr')].filter((row) => row.querySelector('td'));
  }

  function headerValue(headers, cells, names) {
    const index = headers.findIndex((header) => names.some((name) => header.includes(name)));
    return index >= 0 && cells[index] ? normalizeText(cells[index].textContent) : '';
  }

  function classifyTable(headers, table) {
    const joined = headers.join('|');
    if (joined.includes('子域名') && joined.includes('解析IP')) return 'subdomain';
    if (joined.includes('解析域名') && joined.includes('域名解析时间')) return 'ip_recent_resolution';
    if (headers.includes('时间') && headers.includes('域名')) return 'ip_history_timeline';
    if (headers.length === 1 && headers[0] === '域名' && table.closest('.domain-detail.open')) return 'ip_history_detail';
    if (joined.includes('IP') && joined.includes('微步判定')) return 'domain_current_resolution';
    if (headers.includes('时间') && headers.includes('IP')) return 'domain_history_timeline';
    if (joined.includes('IP') && joined.includes('地理位置')) {
      return table.closest('.domain-detail.open') ? 'domain_history_detail' : 'domain_ip_history';
    }
    return '';
  }

  function sourceLabel(source) {
    const labels = {
      subdomain_active: '当前有效子域名',
      subdomain_inactive: '历史失效子域名',
      ip_recent_resolution: 'IP最近解析域名',
      ip_history_timeline: 'IP历史解析域名',
      ip_history_detail: 'IP历史解析详情',
      domain_current_resolution: '域名最近解析IP',
      domain_ip_history: '域名历史解析IP',
      domain_history_timeline: '域名历史解析记录',
      domain_history_detail: '域名历史解析详情',
    };
    return labels[source] || source;
  }

  function addRecord(input) {
    const record = {
      query: state.query.value,
      query_type: state.query.type,
      source: input.source,
      source_label: sourceLabel(input.source),
      domain: String(input.domain || '').toLowerCase(),
      ip: String(input.ip || ''),
      observed_at: input.observed_at || '',
      verdict: input.verdict || '',
      location: input.location || '',
      provider: input.provider || '',
      usage: input.usage || '',
      row_text: input.row_text || '',
    };
    if (!record.domain && !record.ip) return;
    state.rawRecords.push(record);
    state.rawRecordCount = state.rawRecords.length;
  }

  function extractRow(row, headers, source, observedAtOverride = '') {
    const cells = [...row.querySelectorAll(':scope > td')];
    if (!cells.length) return;
    let domains = unique(assetsFrom(row, DOMAIN_PATH));
    let ips = unique(assetsFrom(row, IP_PATH)).filter((value) => IPV4.test(value));

    const cellText = cells.map((cell) => normalizeText(cell.textContent));
    const rowText = cellText.join(' | ');
    const observedAt = observedAtOverride || rowText.match(DATE_PATTERN)?.[0] || '';
    const verdict = headerValue(headers, cells, ['微步判定', '判定', '状态']);
    const locationValue = headerValue(headers, cells, ['地理位置']);
    const provider = headerValue(headers, cells, ['运营商/服务商', '运营商', '服务商']);
    const usage = headerValue(headers, cells, ['使用场景']);

    if (state.query.type === 'ip' && !ips.length) ips = [state.query.value];
    if (state.query.type === 'domain' && !domains.length) domains = [state.query.value];

    if (!domains.length) domains = [''];
    if (!ips.length) ips = [''];

    for (const domain of domains) {
      for (const ip of ips) {
        addRecord({
          source,
          domain,
          ip,
          observed_at: observedAt,
          verdict,
          location: locationValue,
          provider,
          usage,
          row_text: rowText,
        });
      }
    }
  }

  function pageSignature(table) {
    return dataRows(table).map((row) => normalizeText(row.textContent)).join('\n');
  }

  function scopeTableSignature(scope) {
    return [...scope.querySelectorAll('table')]
      .filter((table) => dataRows(table).length > 0)
      .map((table) => `${tableHeaders(table).join('|')}\n${pageSignature(table)}`)
      .join('\n---\n');
  }

  function findPaginationScope(table) {
    let current = table;
    for (let depth = 0; depth < 12 && current; depth += 1, current = current.parentElement) {
      if (current.querySelector?.('.x-antd-comp-pagination')) return current;
    }
    return null;
  }

  function findLiveTable(scope, expectedHeaders) {
    const expected = expectedHeaders.filter(Boolean).join('|');
    return [...scope.querySelectorAll('table')].find((candidate) => {
      if (!dataRows(candidate).length) return false;
      return tableHeaders(candidate).filter(Boolean).join('|') === expected;
    });
  }

  function currentPageNumber(pagination) {
    const active = pagination?.querySelector('.x-antd-comp-pagination-item-active');
    return Number(active?.getAttribute('title') || normalizeText(active?.textContent) || 1);
  }

  async function restoreFirstPage(scope) {
    const pagination = scope?.querySelector('.x-antd-comp-pagination');
    const pageOne = pagination?.querySelector('.x-antd-comp-pagination-item[title="1"]');
    if (!pageOne || currentPageNumber(pagination) === 1) return;
    const before = scopeTableSignature(scope);
    pageOne.click();
    await waitFor(() => currentPageNumber(pagination) === 1 && scopeTableSignature(scope) !== before);
    await sleep(PAGE_SETTLE_MS);
  }

  async function expandHiddenRowDetails(table, source) {
    const dates = dataRows(table)
      .filter((row) => row.querySelector('.etc'))
      .map((row) => normalizeText(row.querySelector('td')?.textContent))
      .filter(Boolean);

    for (const date of dates) {
      if (state.cancelled) throw new Error('用户已停止提取');
      const liveTable = table.isConnected ? table : null;
      if (!liveTable) break;
      const row = dataRows(liveTable).find((candidate) => normalizeText(candidate.querySelector('td')?.textContent) === date);
      const trigger = row?.querySelector('.etc');
      if (!trigger) continue;

      setStatus(`展开 ${date} 的完整详情…`, 'working');
      trigger.click();
      const detail = await waitFor(() => {
        const open = document.querySelector('.domain-detail.open');
        return open && normalizeText(open.querySelector('.title')?.textContent) === date ? open : null;
      });
      await waitFor(() => {
        const candidate = detail.querySelector('table');
        return candidate && dataRows(candidate).length > 0;
      });
      const detailTable = detail.querySelector('table');
      const detailHeaders = tableHeaders(detailTable);
      const detailSource = source.includes('domain_') ? 'domain_history_detail' : 'ip_history_detail';
      for (const detailRow of dataRows(detailTable)) extractRow(detailRow, detailHeaders, detailSource, date);
      detail.querySelector('.close-btn')?.click();
      await waitFor(() => !document.querySelector('.domain-detail.open'));
    }
  }

  async function crawlTable(initialTable, sourceOverride = '') {
    const headers = tableHeaders(initialTable);
    const scope = findPaginationScope(initialTable);
    if (!scope) {
      const source = sourceOverride || classifyTable(headers, initialTable);
      for (const row of dataRows(initialTable)) extractRow(row, headers, source);
      return;
    }

    await restoreFirstPage(scope);
    let visited = 0;
    while (visited < MAX_PAGES) {
      const table = findLiveTable(scope, headers);
      if (!table) throw new Error(`无法重新定位表格：${headers.join(' / ')}`);
      const source = sourceOverride || classifyTable(headers, table);
      const page = currentPageNumber(scope.querySelector('.x-antd-comp-pagination'));
      setStatus(`正在提取 ${sourceLabel(source)} · 第 ${page} 页…`, 'working');
      for (const row of dataRows(table)) extractRow(row, headers, source);

      if (state.ui.expandHistory.checked && (source === 'ip_history_timeline' || source === 'domain_history_timeline')) {
        await expandHiddenRowDetails(table, source);
      }

      visited += 1;
      updateStats();
      if (state.cancelled) break;
      const pagination = scope.querySelector('.x-antd-comp-pagination');
      const next = pagination?.querySelector('.x-antd-comp-pagination-next');
      if (!next || next.getAttribute('aria-disabled') === 'true' || next.classList.contains('x-antd-comp-pagination-disabled')) break;

      const delayMs = randomPageDelayMs(state.config.pageDelayMinMs, state.config.pageDelayMaxMs);
      setStatus(`正在提取 ${sourceLabel(source)} · 第 ${page} 页完成，随机等待 ${(delayMs / 1000).toFixed(1)}s 后翻页…`, 'working');
      await sleepCancellable(delayMs);
      if (state.cancelled) break;

      const before = pageSignature(table);
      next.querySelector('button')?.click();
      await waitFor(() => {
        const updated = findLiveTable(scope, headers);
        return updated && pageSignature(updated) !== before;
      });
      await sleep(PAGE_SETTLE_MS);
    }

    if (visited >= MAX_PAGES) state.errors.push(`表格分页超过安全上限 ${MAX_PAGES} 页：${headers.join(' / ')}`);
    await restoreFirstPage(scope);
  }

  function relevantTables() {
    return [...document.querySelectorAll('table')].filter((table) => {
      if (!isElementVisible(table) || !dataRows(table).length) return false;
      return Boolean(classifyTable(tableHeaders(table), table));
    });
  }

  async function switchTab(tabName) {
    const tab = document.querySelector(`#analysisControllUl > li[data-tab-name="${tabName}"]`);
    if (!tab) throw new Error(`未找到微步标签：${tabName}`);
    if (!tab.classList.contains('active')) {
      tab.click();
      await waitFor(() => tab.classList.contains('active'));
      await waitFor(() => relevantTables().length > 0);
      await sleep(PAGE_SETTLE_MS);
    }
  }

  async function crawlCurrentTab(sourceOverrides = {}) {
    const seen = new Set();
    while (true) {
      const next = relevantTables().find((table) => {
        const classification = classifyTable(tableHeaders(table), table);
        return classification && !seen.has(classification);
      });
      if (!next) break;
      const classification = classifyTable(tableHeaders(next), next);
      seen.add(classification);
      await crawlTable(next, sourceOverrides[classification] || '');
    }
  }

  function findRelevantTable(classification) {
    return relevantTables().find((table) => classifyTable(tableHeaders(table), table) === classification);
  }

  function extractStaticTable(table, sourceOverride = '') {
    if (!table) return;
    const headers = tableHeaders(table);
    const source = sourceOverride || classifyTable(headers, table);
    setStatus(`正在提取 ${sourceLabel(source)}…`, 'working');
    for (const row of dataRows(table)) extractRow(row, headers, source);
  }

  function hasIsolatedPagination(table) {
    let current = table;
    for (let depth = 0; depth < 12 && current; depth += 1, current = current.parentElement) {
      if (current.querySelector?.('.x-antd-comp-pagination') && current.querySelectorAll('table').length === 1) return true;
    }
    return false;
  }

  async function waitForOptional(predicate, timeout = 1500, interval = 50) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (state.cancelled) throw new Error('用户已停止提取');
      const value = predicate();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  function dispatchPointerClick(element) {
    const common = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
    const events = [
      new PointerEvent('pointerdown', { ...common, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }),
      new MouseEvent('mousedown', { ...common, buttons: 1 }),
      new PointerEvent('pointerup', { ...common, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }),
      new MouseEvent('mouseup', { ...common, buttons: 0 }),
      new MouseEvent('click', { ...common, buttons: 0 }),
    ];
    for (const event of events) element.dispatchEvent(event);
  }

  async function activateDomainHistoryToggle(toggle, expectedText) {
    const target = toggle.querySelector('span') || toggle;
    target.click();
    const changed = () => normalizeText(toggle.textContent) === expectedText;
    if (await waitForOptional(changed)) return true;
    dispatchPointerClick(target);
    return Boolean(await waitForOptional(changed));
  }

  async function expandDomainIpHistory() {
    const container = document.querySelector('.history-resolve');
    const toggle = container?.querySelector(':scope > .show-more');
    if (!toggle || normalizeText(toggle.textContent) !== '查看更多') return null;

    const historyTable = findRelevantTable('domain_ip_history');
    if (!historyTable) return null;
    if (!await activateDomainHistoryToggle(toggle, '收起')) {
      state.errors.push('无法自动展开历史解析 IP，已继续提取页面当前可见数据');
      return null;
    }
    return true;
  }

  async function crawlDomainResolution() {
    await switchTab('domain');

    // 域名页的“最近解析 IP”和“历史解析 IP”没有自己的分页器。
    // 不能使用通用的向上查找分页逻辑，否则会误绑定下方“历史解析记录”的分页器。
    extractStaticTable(findRelevantTable('domain_current_resolution'));

    const historyExpanded = await expandDomainIpHistory();
    try {
      const ipHistory = findRelevantTable('domain_ip_history');
      if (ipHistory && hasIsolatedPagination(ipHistory)) await crawlTable(ipHistory);
      else extractStaticTable(ipHistory);
      const timeline = findRelevantTable('domain_history_timeline');
      if (timeline) await crawlTable(timeline);
    } finally {
      const toggle = document.querySelector('.history-resolve > .show-more');
      if (historyExpanded && toggle && normalizeText(toggle.textContent) === '收起') {
        await activateDomainHistoryToggle(toggle, '查看更多');
      }
    }
  }

  function subdomainRadios() {
    return [...document.querySelectorAll('[role="radio"]')].filter((radio) => /子域名/.test(normalizeText(radio.textContent)));
  }

  async function crawlSubdomains() {
    await switchTab('subDomain');
    const radios = subdomainRadios();
    if (!radios.length) {
      await crawlCurrentTab({ subdomain: 'subdomain_active' });
      return;
    }

    for (const radio of radios) {
      const label = normalizeText(radio.textContent);
      const isInactive = label.includes('历史失效');
      if (isInactive && !state.ui.includeInactive.checked) continue;
      const count = Number(label.match(/(\d+)/)?.[1] || 0);
      if (count === 0) continue;
      if (radio.getAttribute('aria-checked') !== 'true') {
        const before = relevantTables().map(pageSignature).join('\n');
        radio.click();
        await waitFor(() => radio.getAttribute('aria-checked') === 'true');
        await waitFor(() => relevantTables().map(pageSignature).join('\n') !== before);
      }
      await crawlCurrentTab({ subdomain: isInactive ? 'subdomain_inactive' : 'subdomain_active' });
    }
  }

  async function runExtraction() {
    if (state.running || state.preparing) return;
    saveDelaySettingsFromUi();
    state.query = readQuery();
    if (state.query.type === 'unknown') {
      setStatus('请先打开微步 IP 或域名详情页', 'error');
      return;
    }
    if ((state.rawRecordCount || state.records.length)
      && !window.confirm('开始新的采集会清空当前结果。是否继续？')) return;

    state.running = true;
    state.cancelled = false;
    state.rawRecords = [];
    state.rawRecordCount = 0;
    state.records = [];
    state.recordItems = [];
    state.domainAssets = [];
    state.ipAssets = [];
    state.domains = [];
    state.ips = [];
    state.prepared = false;
    state.errors = [];
    state.originalTab = document.querySelector('#analysisControllUl > li.active')?.getAttribute('data-tab-name') || '';
    state.ui.badge.textContent = state.query.type === 'ip' ? 'IP' : '域名';
    state.ui.queryValue.textContent = state.query.value || '未识别';
    setControlsRunning(true);
    updateStats();

    try {
      if (state.query.type === 'ip') {
        await switchTab('domain');
        await crawlCurrentTab();
      } else {
        await crawlDomainResolution();
        await crawlSubdomains();
      }
      setStatus(`采集完成，共 ${state.rawRecordCount} 条原始记录。请点击“整理结果”执行去重和排序`, state.errors.length ? 'warning' : 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (state.cancelled) setStatus(`已停止，保留 ${state.rawRecordCount} 条原始记录，可点击“整理结果”`, 'warning');
      else {
        state.errors.push(message);
        setStatus(`采集中断：${message}。已保留 ${state.rawRecordCount} 条原始记录，可点击“整理结果”`, 'error');
        console.error('[微步关联资产提取器]', error);
      }
    } finally {
      state.running = false;
      state.cancelled = false;
      document.querySelector('.domain-detail.open .close-btn')?.click();
      setControlsRunning(false);
      updateStats();
      if (state.originalTab) {
        try {
          await switchTab(state.originalTab);
        } catch (error) {
          console.warn('[微步关联资产提取器] 无法恢复原标签', error);
        }
      }
    }
  }

  function recordsArray() {
    return state.records;
  }

  function distinctAssets(field) {
    return field === 'domain' ? state.domains : state.ips;
  }

  function prepareCollectedRecords(rawRecords) {
    const recordsByKey = new Map();
    for (const record of rawRecords) {
      const key = [record.source, record.domain, record.ip, record.observed_at].join('|');
      const previous = recordsByKey.get(key);
      if (previous) {
        for (const field of ['verdict', 'location', 'provider', 'usage', 'row_text']) {
          if (!previous[field] && record[field]) previous[field] = record[field];
        }
      } else {
        recordsByKey.set(key, { ...record });
      }
    }
    return [...recordsByKey.values()].sort((a, b) => {
      return a.source.localeCompare(b.source) || a.domain.localeCompare(b.domain) || a.ip.localeCompare(b.ip) || b.observed_at.localeCompare(a.observed_at);
    });
  }

  async function prepareResults() {
    if (state.running || state.preparing || !state.rawRecords.length) {
      setStatus(state.running || state.preparing ? '请等待当前操作结束后再整理结果' : '暂无原始记录，请先开始采集', 'warning');
      return;
    }
    state.preparing = true;
    updateStats();
    setStatus(`正在整理 ${state.rawRecords.length} 条原始记录…`, 'working');
    try {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      state.records = prepareCollectedRecords(state.rawRecords);
      state.records.forEach((record, index) => {
        Object.defineProperties(record, {
          kind: { value: 'record', enumerable: false },
          resultIndex: { value: index, enumerable: false },
          searchText: { value: resultSearchText(record), enumerable: false },
        });
      });
      state.recordItems = state.records;
      state.domainAssets = aggregateAssets('domain');
      state.ipAssets = aggregateAssets('ip');
      state.domains = state.domainAssets.map((entry) => entry.value);
      state.ips = state.ipAssets.map((entry) => entry.value);
      state.rawRecordCount = state.rawRecords.length;
      state.rawRecords = [];
      state.prepared = true;
      setStatus(`整理完成：${state.rawRecordCount} 条原始记录去重为 ${state.records.length} 条，得到 ${state.domains.length} 个域名和 ${state.ips.length} 个 IP`, 'success');
      openResultView();
    } catch (error) {
      console.error('[微步关联资产提取器] 整理失败', error);
      setStatus(`整理失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      state.preparing = false;
      updateStats();
    }
  }

  function csvCell(value) {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function buildCsv() {
    const columns = ['query', 'query_type', 'source_label', 'source', 'domain', 'domain_review', 'ip', 'observed_at', 'verdict', 'location', 'provider', 'usage', 'row_text'];
    const lines = [columns.map(csvCell).join(',')];
    for (const record of recordsArray()) {
      lines.push(columns.map((column) => csvCell(column === 'domain_review' && record.domain ? domainReview(record.domain) : record[column])).join(','));
    }
    return `\uFEFF${lines.join('\r\n')}`;
  }

  function buildJson() {
    return JSON.stringify({
      query: state.query,
      page_url: location.href,
      generated_at: new Date().toISOString(),
      summary: {
        raw_records: state.rawRecordCount,
        records: state.records.length,
        domains: distinctAssets('domain').length,
        ips: distinctAssets('ip').length,
      },
      domains: distinctAssets('domain'),
      ips: distinctAssets('ip'),
      domain_reviews: Object.fromEntries(distinctAssets('domain').map((domain) => [domain, domainReview(domain)])),
      records: recordsArray(),
      warnings: state.errors,
    }, null, 2);
  }

  function buildRawJson() {
    return JSON.stringify({
      query: state.query,
      page_url: location.href,
      generated_at: new Date().toISOString(),
      raw_records: state.rawRecords,
      warnings: state.errors,
    }, null, 2);
  }

  function safeFilePart(value) {
    return String(value || 'result').replace(/[\\/:*?"<>|]/g, '_');
  }

  function download(content, extension, mimeType, requirePrepared = true) {
    if (requirePrepared && (!state.prepared || !state.records.length)) {
      setStatus('结果尚未整理，请先点击“整理结果”', 'warning');
      return;
    }
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `threatbook-assets-${safeFilePart(state.query.value)}-${new Date().toISOString().slice(0, 10)}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyAssets(field, label) {
    const values = distinctAssets(field);
    if (!values.length) {
      setStatus(`没有可复制的${label}`, 'warning');
      return;
    }
    const text = values.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement('textarea');
      input.value = text;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    setStatus(`已复制 ${values.length} 个${label}`, 'success');
  }

  function loadDomainReviews() {
    try {
      const value = JSON.parse(localStorage.getItem(REVIEW_STORAGE_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function saveDomainReviews() {
    try {
      localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(state.domainReviews));
    } catch (error) {
      console.warn('[微步关联资产提取器] 无法保存域名人工状态', error);
    }
  }

  function loadConfig() {
    try {
      const value = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || '{}');
      return normalizeConfig(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    } catch {
      return normalizeConfig({});
    }
  }

  function saveConfig() {
    try {
      state.config = normalizeConfig(state.config);
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(state.config));
    } catch (error) {
      console.warn('[微步关联资产提取器] 无法保存配置', error);
    }
  }

  function saveDelaySettingsFromUi() {
    if (!state.ui) return;
    state.config = normalizeConfig({
      ...state.config,
      pageDelayMinMs: state.ui.pageDelayMinMs.value,
      pageDelayMaxMs: state.ui.pageDelayMaxMs.value,
    });
    state.ui.pageDelayMinMs.value = String(state.config.pageDelayMinMs);
    state.ui.pageDelayMaxMs.value = String(state.config.pageDelayMaxMs);
    saveConfig();
  }

  function escapeHtml(value) {
    const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, (character) => replacements[character]);
  }

  function reviewMeta(status) {
    const values = {
      usable: { label: '可用', tone: 'usable' },
      unusable: { label: '不可用', tone: 'unusable' },
      pending: { label: '待确认', tone: 'pending' },
    };
    return values[status] || values.pending;
  }

  function domainReview(domain) {
    return state.domainReviews[String(domain || '').toLowerCase()] || 'pending';
  }

  function setDomainReview(domain, status) {
    const key = String(domain || '').toLowerCase();
    if (!key) return;
    state.domainReviews[key] = status;
    saveDomainReviews();
    renderResultView();
  }

  function threatMeta(verdicts) {
    const values = unique(verdicts.map(normalizeText));
    const find = (pattern) => values.find((value) => pattern.test(value));
    const dangerous = find(/恶意|高危|危险|失陷|木马|钓鱼|垃圾邮件/);
    if (dangerous) return { label: dangerous, tone: 'danger' };
    const suspicious = find(/可疑|中危|低危/);
    if (suspicious) return { label: suspicious, tone: 'warning' };
    const trusted = find(/安全|白名单|无风险|可信/);
    if (trusted) return { label: trusted, tone: 'safe' };
    const unknown = find(/未知/);
    if (unknown) return { label: unknown, tone: 'neutral' };
    return { label: values[0] || '未判定', tone: 'muted' };
  }

  function aggregateAssets(field) {
    const entries = new Map();
    for (const record of recordsArray()) {
      const value = String(record[field] || '').toLowerCase();
      if (!value) continue;
      if (!entries.has(value)) {
        entries.set(value, {
          kind: field === 'domain' ? 'domain' : 'ip',
          value,
          records: 0,
          domains: new Set(),
          ips: new Set(),
          sources: new Set(),
          verdicts: new Set(),
          locations: new Set(),
          providers: new Set(),
          usages: new Set(),
          latest: '',
        });
      }
      const entry = entries.get(value);
      entry.records += 1;
      if (record.domain) entry.domains.add(record.domain);
      if (record.ip) entry.ips.add(record.ip);
      if (record.source_label) entry.sources.add(record.source_label);
      if (record.verdict) entry.verdicts.add(record.verdict);
      if (record.location) entry.locations.add(record.location);
      if (record.provider) entry.providers.add(record.provider);
      if (record.usage) entry.usages.add(record.usage);
      if (record.observed_at > entry.latest) entry.latest = record.observed_at;
    }
    return [...entries.values()].map((entry) => {
      const result = {
        ...entry,
        domains: [...entry.domains].sort(),
        ips: [...entry.ips].sort(),
        sources: [...entry.sources].sort(),
        verdicts: [...entry.verdicts].sort(),
        locations: [...entry.locations].sort(),
        providers: [...entry.providers].sort(),
        usages: [...entry.usages].sort(),
      };
      Object.defineProperty(result, 'searchText', { value: resultSearchText(result), enumerable: false });
      return result;
    }).sort((a, b) => a.value.localeCompare(b.value));
  }

  function resultSearchText(item) {
    if (item.searchText) return item.searchText;
    if (item.kind === 'record') {
      return [item.domain, item.ip, item.source_label, item.observed_at, item.verdict, item.location, item.provider, item.usage, item.row_text].join(' ').toLowerCase();
    }
    return [item.value, ...item.domains, ...item.ips, ...item.sources, ...item.verdicts, ...item.locations, ...item.providers, ...item.usages].join(' ').toLowerCase();
  }

  function filteredResultItems() {
    const { tab, query, review } = state.resultView;
    let items;
    if (tab === 'domains') items = state.domainAssets;
    else if (tab === 'ips') items = state.ipAssets;
    else items = state.recordItems;

    const keyword = normalizeText(query).toLowerCase();
    return items.filter((item) => {
      if (keyword && !item.searchText.includes(keyword)) return false;
      if (tab === 'domains' && review !== 'all' && domainReview(item.value) !== review) return false;
      return true;
    });
  }

  function compactTags(values, limit = 3) {
    const shown = values.filter(Boolean).slice(0, limit);
    if (!shown.length) return '<span class="empty-value">暂无</span>';
    const tags = shown.map((value) => `<span class="mini-tag">${escapeHtml(value)}</span>`).join('');
    const remaining = values.length - shown.length;
    return `${tags}${remaining > 0 ? `<span class="mini-tag more">+${remaining}</span>` : ''}`;
  }

  function renderDomainItem(entry) {
    const review = reviewMeta(domainReview(entry.value));
    const threat = threatMeta(entry.verdicts);
    const domain = escapeHtml(entry.value);
    return `
      <article class="result-row domain-result">
        <div class="asset-primary">
          <div class="asset-kicker">DOMAIN · ${entry.records} 条关联记录</div>
          <div class="asset-value" title="${domain}">${domain}</div>
          <div class="tag-line">${compactTags(entry.ips)}</div>
        </div>
        <div class="asset-context">
          <div class="context-line"><span>来源</span><strong>${escapeHtml(entry.sources.slice(0, 2).join(' · ') || '未知')}</strong></div>
          <div class="context-line"><span>最近发现</span><strong>${escapeHtml(entry.latest || '未记录')}</strong></div>
        </div>
        <div class="asset-status">
          <span class="threat-badge" data-tone="${threat.tone}">${escapeHtml(threat.label)}</span>
          <span class="review-badge" data-tone="${review.tone}">${review.label}</span>
        </div>
        <div class="review-controls" aria-label="人工可用性标记">
          ${['pending', 'usable', 'unusable'].map((status) => {
            const meta = reviewMeta(status);
            const active = domainReview(entry.value) === status;
            return `<button type="button" data-review-domain="${domain}" data-review-status="${status}" aria-pressed="${active}" class="review-choice${active ? ' active' : ''}">${meta.label}</button>`;
          }).join('')}
        </div>
        <div class="row-actions">
          <button type="button" class="row-button" data-open-domain-site="${domain}">访问网站</button>
          <button type="button" class="row-button strong" data-open-domain-intel="${domain}">微步情报</button>
        </div>
      </article>`;
  }

  function renderIpItem(entry) {
    const threat = threatMeta(entry.verdicts);
    const ip = escapeHtml(entry.value);
    return `
      <article class="result-row ip-result">
        <div class="asset-primary">
          <div class="asset-kicker">IP · ${entry.records} 条关联记录</div>
          <div class="asset-value" title="${ip}">${ip}</div>
          <div class="tag-line">${compactTags(entry.domains)}</div>
        </div>
        <div class="asset-context">
          <div class="context-line"><span>位置</span><strong>${escapeHtml(entry.locations[0] || '未知')}</strong></div>
          <div class="context-line"><span>服务商</span><strong>${escapeHtml(entry.providers[0] || '未知')}</strong></div>
        </div>
        <div class="asset-status"><span class="threat-badge" data-tone="${threat.tone}">${escapeHtml(threat.label)}</span></div>
        <div class="row-actions"><button type="button" class="row-button strong" data-open-ip-intel="${ip}">查看微步情报</button></div>
      </article>`;
  }

  function renderRecordItem(record) {
    const threat = threatMeta([record.verdict]);
    const domain = escapeHtml(record.domain);
    const ip = escapeHtml(record.ip);
    return `
      <article class="result-row record-result">
        <div class="record-index">${String(record.resultIndex + 1).padStart(3, '0')}</div>
        <div class="record-main">
          <div class="record-assets">
            ${domain ? `<button type="button" class="asset-link" data-open-domain-intel="${domain}">${domain}</button>` : ''}
            ${ip ? `<button type="button" class="asset-link ip" data-open-ip-intel="${ip}">${ip}</button>` : ''}
          </div>
          <div class="record-meta">
            <span>${escapeHtml(record.source_label || record.source)}</span>
            <span>${escapeHtml(record.observed_at || '无时间')}</span>
            <span>${escapeHtml([record.location, record.provider, record.usage].filter(Boolean).join(' · ') || '无附加信息')}</span>
          </div>
          <div class="record-raw" title="${escapeHtml(record.row_text)}">${escapeHtml(record.row_text || '无原始行文本')}</div>
        </div>
        <div class="asset-status"><span class="threat-badge" data-tone="${threat.tone}">${escapeHtml(threat.label)}</span></div>
      </article>`;
  }

  function renderResultItem(item) {
    if (item.kind === 'domain') return renderDomainItem(item);
    if (item.kind === 'ip') return renderIpItem(item);
    return renderRecordItem(item);
  }

  function currentPageDomains() {
    const domains = [];
    for (const item of state.resultView.pageItems) {
      if (item.kind === 'domain') domains.push(item.value);
      else if (item.kind === 'ip') domains.push(...item.domains);
      else if (item.domain) domains.push(item.domain);
    }
    return unique(domains).sort();
  }

  function openBackgroundTab(url) {
    if (typeof GM_openInTab === 'function') {
      GM_openInTab(url, { active: false, insert: true, setParent: true });
      return true;
    }
    return Boolean(window.open(url, '_blank', 'noopener,noreferrer'));
  }

  function openDomainBatch(domains, mode) {
    const values = unique(domains);
    if (!values.length) {
      setStatus('当前页没有可打开的域名', 'warning');
      return;
    }
    const isSite = mode === 'site';
    const targetLabel = isSite ? '真实网站' : '微步情报页';
    const riskNotice = isSite ? '\n注意：提取结果可能包含恶意网站，请在隔离环境中谨慎访问。' : '';
    if (!window.confirm(`将在后台打开当前页的 ${values.length} 个${targetLabel}。是否继续？${riskNotice}`)) return;

    let opened = 0;
    for (const domain of values) {
      const url = isSite ? `https://${domain}` : `${location.origin}/v5/domain/${encodeURIComponent(domain)}`;
      if (openBackgroundTab(url)) opened += 1;
    }
    setStatus(`已在后台打开 ${opened}/${values.length} 个${targetLabel}`, opened === values.length ? 'success' : 'warning');
  }

  function openSingleAsset(type, value, mode = 'intel') {
    if (!value) return;
    if (type === 'domain' && mode === 'site') {
      if (!window.confirm(`即将访问 ${value}。该域名可能存在安全风险，是否继续？`)) return;
      openBackgroundTab(`https://${value}`);
      return;
    }
    const path = type === 'domain' ? 'domain' : 'ip';
    openBackgroundTab(`${location.origin}/v5/${path}/${encodeURIComponent(value)}`);
  }

  function renderResultView() {
    if (!state.ui?.resultOverlay) return;
    const items = filteredResultItems();
    const totalPages = Math.max(1, Math.ceil(items.length / state.resultView.pageSize));
    state.resultView.page = Math.min(Math.max(1, state.resultView.page), totalPages);
    const start = (state.resultView.page - 1) * state.resultView.pageSize;
    const pageItems = items.slice(start, start + state.resultView.pageSize);
    state.resultView.pageItems = pageItems;

    state.ui.resultList.innerHTML = pageItems.map(renderResultItem).join('');
    state.ui.resultEmpty.hidden = pageItems.length > 0;
    state.ui.resultTotal.textContent = String(items.length);
    state.ui.resultRange.textContent = items.length ? `${start + 1}–${start + pageItems.length}` : '0';
    state.ui.resultPage.textContent = `${state.resultView.page} / ${totalPages}`;
    state.ui.resultPrev.disabled = state.resultView.page <= 1;
    state.ui.resultNext.disabled = state.resultView.page >= totalPages;

    const counts = { domains: state.domains.length, ips: state.ips.length, records: state.records.length };
    for (const button of state.ui.resultTabs) {
      const active = button.dataset.resultTab === state.resultView.tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.querySelector('.tab-count').textContent = String(counts[button.dataset.resultTab]);
    }
    state.ui.reviewFilters.hidden = state.resultView.tab !== 'domains';
    for (const button of state.ui.reviewButtons) {
      button.classList.toggle('active', button.dataset.resultReview === state.resultView.review);
    }

    const pageDomains = currentPageDomains();
    state.ui.openPageSites.disabled = pageDomains.length === 0;
    state.ui.openPageIntel.disabled = pageDomains.length === 0;
    state.ui.openPageSites.textContent = `打开当前页网站 · ${pageDomains.length}`;
    state.ui.openPageIntel.textContent = `打开当前页情报 · ${pageDomains.length}`;
  }

  function openResultView() {
    if (!state.prepared || !state.records.length) {
      setStatus('结果尚未整理，请先点击“整理结果”', 'warning');
      return;
    }
    const active = state.ui.resultOverlay.getRootNode().activeElement;
    state.resultView.returnFocus = active && !active.disabled ? active : state.ui.resultOpen;
    state.ui.resultOverlay.hidden = false;
    state.resultView.page = 1;
    state.ui.resultSearch.value = state.resultView.query;
    renderResultView();
    requestAnimationFrame(() => state.ui.resultSearch.focus());
  }

  function closeResultView() {
    if (state.ui?.resultOverlay) state.ui.resultOverlay.hidden = true;
    if (state.resultView.returnFocus?.isConnected && !state.resultView.returnFocus.disabled) state.resultView.returnFocus.focus();
    state.resultView.returnFocus = null;
  }

  function trapDialogFocus(event) {
    if (event.key !== 'Tab' || state.ui.resultOverlay.hidden) return;
    const focusable = [...state.ui.resultOverlay.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const active = state.ui.resultOverlay.getRootNode().activeElement;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if ((event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  function updateStats() {
    if (!state.ui) return;
    state.ui.start.disabled = state.preparing;
    state.ui.recordCount.textContent = String(state.rawRecordCount);
    state.ui.domainCount.textContent = String(state.domains.length);
    state.ui.ipCount.textContent = String(state.ips.length);
    state.ui.prepare.disabled = state.running || state.preparing || !state.rawRecords.length;
    state.ui.rawExport.disabled = state.running || state.preparing || !state.rawRecords.length;
    const enabled = state.prepared && state.records.length > 0 && !state.running;
    for (const button of state.ui.resultButtons) button.disabled = !enabled;
    if (!state.ui.resultOverlay.hidden && !state.running) renderResultView();
  }

  function setStatus(message, tone = 'idle') {
    if (!state.ui) return;
    state.ui.status.textContent = message;
    state.ui.status.dataset.tone = tone;
  }

  function setControlsRunning(running) {
    state.ui.start.hidden = running;
    state.ui.stop.hidden = !running;
    state.ui.expandHistory.disabled = running;
    state.ui.includeInactive.disabled = running;
    state.ui.pageDelayMinMs.disabled = running;
    state.ui.pageDelayMaxMs.disabled = running;
    state.ui.prepare.disabled = running || !state.rawRecords.length;
    updateStats();
  }

  function mountUi() {
    if (document.getElementById(APP_ID)) return;
    const host = document.createElement('div');
    host.id = APP_ID;
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; --ink: #1a1e23; --ink-soft: #3f4753; --paper: #fff; --bg: #f4f6f8; --line: #d9dee3; --line-light: #eaeff4; --muted: #6e7985; --accent: #1677ff; --accent-hover: #0958d9; --accent-bg: #e6f4ff; --accent-border: #91caff; --red: #d9363e; --green: #16834a; --amber: #d97a00; --radius: 4px; --radius-sm: 3px; --shadow-sm: 0 1px 2px rgba(0,0,0,.04); --shadow-md: 0 4px 12px rgba(0,0,0,.08); --shadow-lg: 0 12px 36px rgba(0,0,0,.15); --font-sans: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; --font-mono: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; }
      * { box-sizing: border-box; letter-spacing: 0; }
      button, input, select { font: inherit; }
      .launcher { position: fixed; right: 22px; bottom: 22px; z-index: 2147483646; height: 44px; border: 0; border-radius: 6px; padding: 0 15px; background: var(--accent); color: var(--paper); box-shadow: var(--shadow-md); cursor: pointer; font: 600 14px/1 var(--font-sans); transition: background .15s, transform .15s; }
      .launcher:hover { background: var(--accent-hover); transform: translateY(-1px); }
      .panel { position: fixed; right: 22px; bottom: 22px; z-index: 2147483647; width: min(380px, calc(100vw - 24px)); border: 1px solid var(--line); border-top: 3px solid var(--accent); border-radius: 6px; background: var(--paper); color: var(--ink); box-shadow: var(--shadow-lg); font: 13px/1.5 var(--font-sans); }
      .panel[hidden], [hidden] { display: none !important; }
      .head { display: flex; align-items: center; justify-content: space-between; min-height: 48px; padding: 0 16px; border-bottom: 1px solid var(--line); }
      .title { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink); }
      .close { width: 32px; height: 32px; border: 0; background: transparent; color: var(--muted); font-size: 22px; cursor: pointer; transition: color .15s; }
      .close:hover { color: var(--ink); }
      .body { padding: 12px 16px 16px; }
      .query { display: flex; align-items: center; gap: 8px; min-width: 0; margin-bottom: 14px; }
      .badge { flex: none; border-radius: 4px; padding: 2px 7px; background: var(--line-light); color: var(--ink-soft); font-size: 11px; font-weight: 700; }
      .query-value { overflow: hidden; color: var(--ink); font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
      .stats { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line); border-radius: 5px; }
      .stat { min-width: 0; padding: 8px; text-align: center; }
      .stat + .stat { border-left: 1px solid var(--line); }
      .number { display: block; font: 700 18px/1.1 var(--font-mono); color: var(--ink); }
      .label { display: block; margin-top: 4px; color: var(--muted); font-size: 11px; }
      .status { min-height: 38px; margin: 12px 0; padding: 9px 10px; border-left: 3px solid var(--muted); background: var(--bg); color: var(--ink-soft); overflow-wrap: anywhere; font-size: 12px; }
      .status[data-tone="working"] { border-color: var(--accent); background: var(--accent-bg); color: var(--accent-hover); }
      .status[data-tone="success"] { border-color: var(--green); background: #eef9f3; color: #17643d; }
      .status[data-tone="warning"] { border-color: var(--amber); background: #fff8e8; color: #77500d; }
      .status[data-tone="error"] { border-color: var(--red); background: #fff1f1; color: #95161b; }
      .options { display: flex; flex-wrap: wrap; gap: 12px 18px; margin-bottom: 12px; color: var(--ink-soft); font-size: 12px; }
      .check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
      .setting-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; width: 100%; }
      .setting-field { display: grid; gap: 2px; color: var(--muted); font-size: 10px; }
      .setting-field input { width: 100%; height: 26px; border: 1px solid var(--line); border-radius: 3px; padding: 0 6px; background: var(--paper); color: var(--ink); font: 500 11px/1 var(--font-mono); outline: none; }
      .check input { width: 14px; height: 14px; accent-color: var(--accent); }
      .actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .button { min-height: 34px; border: 1px solid var(--line); border-radius: 4px; padding: 0 12px; background: var(--paper); color: var(--ink-soft); cursor: pointer; transition: all .15s; font-size: 12px; }
      .button:hover:not(:disabled) { border-color: var(--muted); background: var(--bg); color: var(--ink); }
      .button.primary { border-color: var(--accent); background: var(--accent); color: var(--paper); font-weight: 600; }
      .button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
      .button.danger { border-color: var(--red); background: var(--red); color: var(--paper); font-weight: 600; }
      .button:disabled { cursor: not-allowed; opacity: .42; }
      .results { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
      [data-action="view-results"] { grid-column: 1 / -1; min-height: 40px; border-color: var(--accent); background: var(--accent-bg); color: var(--accent-hover); font-weight: 600; }
      [data-action="view-results"]::before { content: "▦"; margin-right: 7px; font: 700 14px/1 var(--font-mono); }
      [data-action="view-results"]:hover:not(:disabled) { background: var(--accent); color: var(--paper); }

      .result-overlay { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px; background: rgba(0,0,0,.4); backdrop-filter: blur(2px); font: 13px/1.5 var(--font-sans); }
      .result-modal { display: grid; grid-template-rows: auto auto auto minmax(0,1fr) auto; width: min(1120px, calc(100vw - 32px)); height: min(780px, calc(100vh - 32px)); overflow: hidden; border: 1px solid var(--line); border-top: 4px solid var(--accent); border-radius: 8px; background: var(--bg); color: var(--ink); box-shadow: var(--shadow-lg); }
      .result-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-height: 64px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--paper); }
      .result-heading { min-width: 0; }
      .result-eyebrow { margin-bottom: 2px; color: var(--accent); font: 700 10px/1.2 var(--font-mono); letter-spacing: .12em; }
      .result-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.25; }
      .result-subtitle { margin-top: 2px; color: var(--muted); font-size: 12px; }
      .result-close { flex: none; width: 34px; height: 34px; border: 1px solid var(--line); border-radius: 4px; background: var(--paper); color: var(--muted); font-size: 20px; cursor: pointer; transition: all .15s; }
      .result-close:hover { border-color: var(--muted); color: var(--ink); }

      .result-tabs { display: flex; align-items: stretch; min-height: 48px; padding: 0 20px; border-bottom: 1px solid var(--line); background: var(--paper); }
      .result-tab { position: relative; min-width: 120px; border: 0; border-right: 1px solid var(--line-light); padding: 0 16px; background: transparent; color: var(--muted); text-align: left; cursor: pointer; font-size: 13px; }
      .result-tab:first-child { border-left: 1px solid var(--line-light); }
      .result-tab::after { content: ""; position: absolute; right: 16px; bottom: 0; left: 16px; height: 3px; background: transparent; transition: background .15s; }
      .result-tab.active { color: var(--ink); font-weight: 600; }
      .result-tab.active::after { background: var(--accent); }
      .tab-count { margin-left: 6px; border-radius: 10px; padding: 1px 6px; background: var(--line-light); color: var(--ink-soft); font: 600 11px/1.4 var(--font-mono); }

      .result-tools { display: grid; grid-template-columns: minmax(240px,1fr) auto; gap: 12px; padding: 10px 20px; border-bottom: 1px solid var(--line); background: #fdfdfd; }
      .result-search-wrap { position: relative; }
      .result-search-wrap::before { content: "⌕"; position: absolute; top: 50%; left: 12px; color: var(--muted); font: 700 16px/1 var(--font-mono); transform: translateY(-50%); }
      .result-search { width: 100%; height: 36px; border: 1px solid var(--line); border-radius: 4px; padding: 0 12px 0 32px; background: var(--paper); color: var(--ink); outline: none; transition: border-color .15s, box-shadow .15s; }
      .result-search:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-bg); }
      .review-filters { display: flex; align-items: center; gap: 4px; }
      .filter-button { height: 32px; border: 1px solid transparent; border-radius: 4px; padding: 0 10px; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; transition: all .15s; }
      .filter-button.active { border-color: var(--line); background: var(--paper); color: var(--ink); font-weight: 600; }

      .result-content { min-height: 0; overflow: auto; padding: 12px 20px; }
      .result-list { display: grid; gap: 8px; }
      
      .result-row { display: grid; grid-template-columns: minmax(240px,1.4fr) minmax(180px,1fr) 110px minmax(200px,auto) auto; align-items: center; gap: 12px; min-height: 64px; border: 1px solid var(--line); border-left: 3px solid var(--muted); border-radius: 4px; padding: 10px 12px; background: var(--paper); transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease; }
      .result-row:hover { border-color: var(--muted); box-shadow: var(--shadow-sm); transform: translateY(-1px); }
      .domain-result { border-left-color: var(--accent); }
      .ip-result { grid-template-columns: minmax(240px,1.4fr) minmax(200px,1fr) 110px auto; border-left-color: #08979c; }
      .record-result { grid-template-columns: 42px minmax(0,1fr) 110px; min-height: 56px; border-left-color: var(--muted); }
      
      .asset-primary, .record-main { min-width: 0; }
      .asset-kicker { margin-bottom: 3px; color: var(--muted); font: 600 10px/1.2 var(--font-mono); letter-spacing: .08em; }
      .asset-value { overflow: hidden; color: var(--ink); font: 600 14px/1.35 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
      .tag-line { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
      .mini-tag { max-width: 140px; overflow: hidden; border: 1px solid var(--line); border-radius: 3px; padding: 1px 5px; background: var(--bg); color: var(--ink-soft); font: 11px/1.4 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
      .mini-tag.more { color: var(--ink); font-weight: 600; }
      .empty-value { color: var(--muted); font-size: 11px; }
      
      .asset-context { display: grid; gap: 4px; min-width: 0; }
      .context-line { display: grid; grid-template-columns: 50px minmax(0,1fr); gap: 6px; min-width: 0; color: var(--muted); font-size: 11px; }
      .context-line strong { overflow: hidden; color: var(--ink-soft); font-size: 11px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
      
      .asset-status { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
      .threat-badge, .review-badge { display: inline-flex; align-items: center; min-height: 22px; border-radius: 3px; padding: 2px 6px; font-size: 11px; font-weight: 600; white-space: nowrap; }
      .threat-badge[data-tone="danger"] { background: #fff1f0; color: #cf1322; border: 1px solid #ffa39e; }
      .threat-badge[data-tone="warning"] { background: #fffbe6; color: #d46b08; border: 1px solid #ffe58f; }
      .threat-badge[data-tone="safe"] { background: #f6ffed; color: #389e0d; border: 1px solid #b7eb8f; }
      .threat-badge[data-tone="neutral"] { background: #f0f5ff; color: #1d39c4; border: 1px solid #adc6ff; }
      .threat-badge[data-tone="muted"] { background: #f5f5f5; color: #595959; border: 1px solid #d9d9d9; }
      .review-badge[data-tone="usable"] { background: #f6ffed; color: #389e0d; border: 1px solid #b7eb8f; }
      .review-badge[data-tone="unusable"] { background: #fff1f0; color: #cf1322; border: 1px solid #ffa39e; }
      .review-badge[data-tone="pending"] { background: #f5f5f5; color: #595959; border: 1px solid #d9d9d9; }
      
      .review-controls { display: grid; grid-template-columns: repeat(3,1fr); overflow: hidden; border: 1px solid var(--line); border-radius: 4px; }
      .review-choice { height: 26px; border: 0; border-right: 1px solid var(--line); padding: 0 6px; background: var(--paper); color: var(--muted); font-size: 11px; cursor: pointer; transition: all .1s; }
      .review-choice:last-child { border-right: 0; }
      .review-choice:hover { background: var(--bg); color: var(--ink); }
      .review-choice.active { background: var(--accent); color: var(--paper); font-weight: 600; }
      
      .row-actions { display: flex; align-items: center; gap: 6px; }
      .row-button { min-width: 68px; height: 26px; border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; background: var(--paper); color: var(--ink-soft); font-size: 11px; cursor: pointer; white-space: nowrap; transition: all .15s; }
      .row-button:hover { border-color: var(--muted); color: var(--ink); }
      .row-button.strong { border-color: var(--accent); background: var(--paper); color: var(--accent); font-weight: 600; }
      .row-button.strong:hover { background: var(--accent); color: var(--paper); }
      
      .record-index { color: var(--muted); font: 600 12px/1 var(--font-mono); }
      .record-assets { display: flex; flex-wrap: wrap; gap: 6px; }
      .asset-link { max-width: 380px; overflow: hidden; border: 0; padding: 0; background: transparent; color: var(--accent); font: 600 13px/1.4 var(--font-mono); text-align: left; text-decoration: underline; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
      .asset-link.ip { color: #08979c; }
      .record-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; color: var(--muted); font-size: 11px; }
      .record-raw { margin-top: 4px; overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; opacity: 0.8; }
      
      .result-empty { display: grid; min-height: 220px; place-items: center; border: 1px dashed var(--line); border-radius: 4px; background: var(--bg); color: var(--muted); text-align: center; }
      .result-empty strong { display: block; margin-bottom: 4px; color: var(--ink); font-size: 14px; }

      .result-footer { display: grid; grid-template-columns: minmax(0,1fr) auto auto; align-items: center; gap: 12px; min-height: 60px; padding: 10px 20px; border-top: 1px solid var(--line); background: var(--paper); }
      .result-summary { color: var(--muted); font-size: 12px; }
      .result-summary strong { color: var(--ink); font-family: var(--font-mono); font-weight: 600; }
      .page-controls { display: flex; align-items: center; gap: 6px; }
      .page-button { min-width: 32px; height: 32px; border: 1px solid var(--line); border-radius: 4px; background: var(--paper); color: var(--ink-soft); cursor: pointer; font-size: 14px; transition: all .15s; }
      .page-button:hover:not(:disabled) { border-color: var(--muted); color: var(--ink); }
      .page-button:disabled { cursor: not-allowed; opacity: .4; }
      .page-indicator { min-width: 60px; color: var(--ink-soft); font: 600 12px/1 var(--font-mono); text-align: center; }
      .page-size { height: 32px; border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; background: var(--paper); color: var(--ink-soft); font-size: 12px; cursor: pointer; }
      .batch-actions { display: flex; gap: 6px; }
      .batch-button { height: 34px; border: 1px solid var(--line); border-radius: 4px; padding: 0 12px; background: var(--paper); color: var(--ink-soft); font-size: 12px; font-weight: 600; cursor: pointer; transition: all .15s; }
      .batch-button:hover:not(:disabled) { border-color: var(--muted); color: var(--ink); }
      .batch-button.primary { background: var(--accent); border-color: var(--accent); color: var(--paper); }
      .batch-button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
      .batch-button:disabled { cursor: not-allowed; opacity: .4; }
      .launcher { touch-action: none; }
      button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
      }
      @media (pointer: coarse) {
        .launcher, .button, .result-tab, .filter-button, .review-choice, .row-button, .page-button, .batch-button, .result-close { min-height: 40px; }
      }

      @media (max-width: 900px) {
        .result-modal { width: calc(100vw - 16px); height: calc(100vh - 16px); }
        .result-overlay { padding: 8px; }
        .result-tabs { overflow-x: auto; padding: 0 12px; }
        .result-tab { min-width: 100px; }
        .result-tools { grid-template-columns: 1fr; padding: 10px 12px; }
        .result-content { padding: 10px 12px; }
        .result-row, .ip-result { grid-template-columns: minmax(0,1fr) auto; gap: 8px 12px; }
        .asset-context { grid-column: 1 / -1; }
        .review-controls { grid-column: 1 / -1; }
        .row-actions { flex-direction: row; }
        .record-result { grid-template-columns: 32px minmax(0,1fr); }
        .record-result .asset-status { grid-column: 2; }
        .result-footer { grid-template-columns: 1fr auto; padding: 10px 12px; }
        .batch-actions { grid-column: 1 / -1; }
        .batch-button { flex: 1; }
      }
      @media (max-width: 520px) {
        .panel, .launcher { right: 12px; bottom: 12px; }
        .panel { width: calc(100vw - 24px); }
        .result-head { min-height: 56px; padding: 10px 12px; }
        .result-title { font-size: 16px; }
        .result-subtitle { display: none; }
        .result-tab { min-width: 96px; padding: 0 10px; }
        .result-row, .ip-result { grid-template-columns: 1fr; }
        .asset-context, .review-controls, .record-result .asset-status { grid-column: 1; }
        .record-result { grid-template-columns: 1fr; }
        .record-index { display: none; }
        .row-actions { display: grid; grid-template-columns: 1fr 1fr; }
        .result-footer { grid-template-columns: 1fr; }
        .page-controls { justify-content: space-between; }
        .result-summary { display: none; }
      }
    `;

    const launcher = document.createElement('button');
    launcher.className = 'launcher';
    launcher.type = 'button';
    launcher.textContent = '↓ 提取关联资产';
    if (state.config.launcherPosition) {
      launcher.style.right = state.config.launcherPosition.right;
      launcher.style.bottom = state.config.launcherPosition.bottom;
    }

    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.hidden = true;
    panel.innerHTML = `
      <header class="head">
        <h2 class="title">关联资产提取器</h2>
        <button class="close" type="button" title="关闭" aria-label="关闭">×</button>
      </header>
      <div class="body">
        <div class="query"><span class="badge"></span><span class="query-value"></span></div>
        <div class="stats">
          <div class="stat"><strong class="number" data-stat="records">0</strong><span class="label">原始记录</span></div>
          <div class="stat"><strong class="number" data-stat="domains">0</strong><span class="label">整理域名</span></div>
          <div class="stat"><strong class="number" data-stat="ips">0</strong><span class="label">整理 IP</span></div>
        </div>
        <div class="status" role="status" aria-live="polite" aria-atomic="true" data-tone="idle">等待提取</div>
        <div class="options">
          <label class="check"><input data-option="history" type="checkbox" checked>展开历史详情</label>
          <label class="check"><input data-option="inactive" type="checkbox" checked>失效子域名</label>
          <div class="setting-grid">
            <label class="setting-field">翻页间隔最小 ms<input type="number" min="0" max="60000" step="100" data-setting="pageDelayMinMs"></label>
            <label class="setting-field">翻页间隔最大 ms<input type="number" min="0" max="60000" step="100" data-setting="pageDelayMaxMs"></label>
          </div>
        </div>
        <div class="actions">
          <button class="button primary" data-action="start" type="button">开始提取</button>
          <button class="button danger" data-action="stop" type="button" hidden>停止</button>
          <button class="button primary" data-action="prepare" type="button" disabled>整理结果</button>
          <button class="button" data-action="raw-json" type="button" disabled>原始 JSON</button>
          <button class="button" data-action="csv" type="button" disabled>CSV</button>
          <button class="button" data-action="json" type="button" disabled>JSON</button>
        </div>
        <div class="results">
          <button class="button" data-action="domains" type="button" disabled>复制域名</button>
          <button class="button" data-action="ips" type="button" disabled>复制 IP</button>
          <button class="button" data-action="view-results" type="button" disabled>查看全部提取结果</button>
        </div>
      </div>
    `;

    const resultOverlay = document.createElement('div');
    resultOverlay.className = 'result-overlay';
    resultOverlay.hidden = true;
    resultOverlay.innerHTML = `
      <section class="result-modal" role="dialog" aria-modal="true" aria-labelledby="tb-result-title" tabindex="-1">
        <header class="result-head">
          <div class="result-heading">
            <div class="result-eyebrow">ASSET REVIEW CONSOLE</div>
            <h2 class="result-title" id="tb-result-title">提取结果浏览器</h2>
            <div class="result-subtitle">聚合查看情报、人工标记可用性，并按当前页安全批量操作</div>
          </div>
          <button class="result-close" type="button" data-result-close aria-label="关闭结果浏览器">×</button>
        </header>
        <nav class="result-tabs" role="tablist" aria-label="结果类型">
          <button class="result-tab active" type="button" role="tab" data-result-tab="domains" aria-selected="true">域名<span class="tab-count">0</span></button>
          <button class="result-tab" type="button" role="tab" data-result-tab="ips" aria-selected="false">IP<span class="tab-count">0</span></button>
          <button class="result-tab" type="button" role="tab" data-result-tab="records" aria-selected="false">关联记录<span class="tab-count">0</span></button>
        </nav>
        <div class="result-tools">
          <label class="result-search-wrap">
            <span hidden>搜索结果</span>
            <input class="result-search" type="search" placeholder="搜索域名、IP、来源、判定、位置…" autocomplete="off">
          </label>
          <div class="review-filters" aria-label="人工可用性筛选">
            <button class="filter-button active" type="button" data-result-review="all">全部</button>
            <button class="filter-button" type="button" data-result-review="pending">待确认</button>
            <button class="filter-button" type="button" data-result-review="usable">可用</button>
            <button class="filter-button" type="button" data-result-review="unusable">不可用</button>
          </div>
        </div>
        <div class="result-content">
          <div class="result-list"></div>
          <div class="result-empty" hidden><div><strong>没有匹配结果</strong>尝试清除搜索词或切换筛选条件</div></div>
        </div>
        <footer class="result-footer">
          <div class="result-summary">当前显示 <strong data-result-range>0</strong>，共 <strong data-result-total>0</strong> 条</div>
          <div class="page-controls">
            <button class="page-button" type="button" data-result-page-action="prev" aria-label="上一页">←</button>
            <span class="page-indicator" data-result-page>1 / 1</span>
            <button class="page-button" type="button" data-result-page-action="next" aria-label="下一页">→</button>
            <select class="page-size" aria-label="每页数量">
              <option value="8">8 条/页</option>
              <option value="12" selected>12 条/页</option>
              <option value="20">20 条/页</option>
            </select>
          </div>
          <div class="batch-actions">
            <button class="batch-button" type="button" data-batch-open="site">打开当前页网站 · 0</button>
            <button class="batch-button primary" type="button" data-batch-open="intel">打开当前页情报 · 0</button>
          </div>
        </footer>
      </section>
    `;

    shadow.append(style, launcher, panel, resultOverlay);
    const get = (selector) => shadow.querySelector(selector);
    state.ui = {
      launcher,
      panel,
      start: get('[data-action="start"]'),
      stop: get('[data-action="stop"]'),
      prepare: get('[data-action="prepare"]'),
      rawExport: get('[data-action="raw-json"]'),
      resultOpen: get('[data-action="view-results"]'),
      status: get('.status'),
      badge: get('.badge'),
      queryValue: get('.query-value'),
      recordCount: get('[data-stat="records"]'),
      domainCount: get('[data-stat="domains"]'),
      ipCount: get('[data-stat="ips"]'),
      expandHistory: get('[data-option="history"]'),
      includeInactive: get('[data-option="inactive"]'),
      pageDelayMinMs: get('[data-setting="pageDelayMinMs"]'),
      pageDelayMaxMs: get('[data-setting="pageDelayMaxMs"]'),
      resultButtons: [...shadow.querySelectorAll('[data-action="csv"],[data-action="json"],[data-action="domains"],[data-action="ips"],[data-action="view-results"]')],
      resultOverlay,
      resultList: get('.result-list'),
      resultEmpty: get('.result-empty'),
      resultSearch: get('.result-search'),
      resultTabs: [...shadow.querySelectorAll('[data-result-tab]')],
      reviewFilters: get('.review-filters'),
      reviewButtons: [...shadow.querySelectorAll('[data-result-review]')],
      resultRange: get('[data-result-range]'),
      resultTotal: get('[data-result-total]'),
      resultPage: get('[data-result-page]'),
      resultPrev: get('[data-result-page-action="prev"]'),
      resultNext: get('[data-result-page-action="next"]'),
      resultPageSize: get('.page-size'),
      openPageSites: get('[data-batch-open="site"]'),
      openPageIntel: get('[data-batch-open="intel"]'),
    };

    get('.badge').textContent = state.query.type === 'ip' ? 'IP' : '域名';
    get('.query-value').textContent = state.query.value || '未识别';
    state.ui.pageDelayMinMs.value = String(state.config.pageDelayMinMs);
    state.ui.pageDelayMaxMs.value = String(state.config.pageDelayMaxMs);

    let isDragging = false;
    launcher.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
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
          state.config.launcherPosition = { right: launcher.style.right, bottom: launcher.style.bottom };
          saveConfig();
        }
        document.removeEventListener('pointermove', onMouseMove);
        document.removeEventListener('pointerup', onMouseUp);
        document.removeEventListener('pointercancel', onMouseUp);
      };

      document.addEventListener('pointermove', onMouseMove);
      document.addEventListener('pointerup', onMouseUp);
      document.addEventListener('pointercancel', onMouseUp);
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
      
      if (spaceRight + 380 > window.innerWidth) {
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

    get('.close').addEventListener('click', () => {
      panel.hidden = true;
      launcher.hidden = false;
    });
    state.ui.start.addEventListener('click', runExtraction);
    state.ui.prepare.addEventListener('click', prepareResults);
    state.ui.stop.addEventListener('click', () => {
      state.cancelled = true;
      setStatus('正在停止…', 'warning');
    });
    get('[data-action="raw-json"]').addEventListener('click', () => download(buildRawJson(), 'raw.json', 'application/json;charset=utf-8', false));
    get('[data-action="csv"]').addEventListener('click', () => download(buildCsv(), 'csv', 'text/csv;charset=utf-8'));
    get('[data-action="json"]').addEventListener('click', () => download(buildJson(), 'json', 'application/json;charset=utf-8'));
    get('[data-action="domains"]').addEventListener('click', () => copyAssets('domain', '域名'));
    get('[data-action="ips"]').addEventListener('click', () => copyAssets('ip', 'IP'));
    get('[data-action="view-results"]').addEventListener('click', openResultView);
    get('[data-result-close]').addEventListener('click', closeResultView);
    resultOverlay.addEventListener('click', (event) => {
      if (event.target === resultOverlay) closeResultView();
    });
    let searchTimer = 0;
    state.ui.resultSearch.addEventListener('input', (event) => {
      state.resultView.query = event.target.value;
      state.resultView.page = 1;
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(renderResultView, SEARCH_DEBOUNCE_MS);
    });
    state.ui.resultPageSize.addEventListener('change', (event) => {
      state.resultView.pageSize = Number(event.target.value) || RESULT_PAGE_SIZE;
      state.resultView.page = 1;
      renderResultView();
    });
    resultOverlay.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.resultTab) {
        state.resultView.tab = button.dataset.resultTab;
        state.resultView.page = 1;
        renderResultView();
      } else if (button.dataset.resultReview) {
        state.resultView.review = button.dataset.resultReview;
        state.resultView.page = 1;
        renderResultView();
      } else if (button.dataset.resultPageAction) {
        state.resultView.page += button.dataset.resultPageAction === 'next' ? 1 : -1;
        renderResultView();
      } else if (button.dataset.reviewDomain) {
        setDomainReview(button.dataset.reviewDomain, button.dataset.reviewStatus);
      } else if (button.dataset.openDomainSite) {
        openSingleAsset('domain', button.dataset.openDomainSite, 'site');
      } else if (button.dataset.openDomainIntel) {
        openSingleAsset('domain', button.dataset.openDomainIntel);
      } else if (button.dataset.openIpIntel) {
        openSingleAsset('ip', button.dataset.openIpIntel);
      } else if (button.dataset.batchOpen) {
        openDomainBatch(currentPageDomains(), button.dataset.batchOpen);
      }
    });
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !resultOverlay.hidden) closeResultView();
      else trapDialogFocus(event);
    });
  }

  function boot() {
    if (state.query.type === 'unknown') return;
    mountUi();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

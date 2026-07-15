// ==UserScript==
// @name         微步关联资产提取器
// @namespace    local.codex.threatbook
// @version      1.1.2
// @description  提取微步 IP/域名情报页面中的关联域名和 IP，并导出 CSV/JSON。
// @author       Codex
// @match        https://x.threatbook.com/v5/ip/*
// @match        https://x.threatbook.com/v5/domain/*
// @grant        GM_openInTab
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const APP_ID = 'tb-asset-extractor-host';
  const MAX_PAGES = 150;
  const WAIT_TIMEOUT = 15000;
  const PAGE_SETTLE_MS = 250;
  const DOMAIN_PATH = /\/v5\/domain\/([^/?#]+)/i;
  const IP_PATH = /\/v5\/ip\/([^/?#]+)/i;
  const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
  const DATE_PATTERN = /\b\d{4}[-/]\d{2}[-/]\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?\b/;

  const state = {
    running: false,
    cancelled: false,
    records: new Map(),
    errors: [],
    originalTab: '',
    query: readQuery(),
    ui: null,
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
    const key = [record.source, record.domain, record.ip, record.observed_at].join('|');
    const previous = state.records.get(key);
    if (previous) {
      for (const field of ['verdict', 'location', 'provider', 'usage', 'row_text']) {
        if (!previous[field] && record[field]) previous[field] = record[field];
      }
      return;
    }
    state.records.set(key, record);
    updateStats();
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
    const before = normalizeText(pagination.querySelector('.x-antd-comp-pagination-item-active')?.textContent);
    pageOne.click();
    await waitFor(() => normalizeText(pagination.querySelector('.x-antd-comp-pagination-item-active')?.textContent) !== before);
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
      const pagination = scope.querySelector('.x-antd-comp-pagination');
      const next = pagination?.querySelector('.x-antd-comp-pagination-next');
      if (!next || next.getAttribute('aria-disabled') === 'true' || next.classList.contains('x-antd-comp-pagination-disabled')) break;

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
    if (state.running) return;
    state.query = readQuery();
    if (state.query.type === 'unknown') {
      setStatus('请先打开微步 IP 或域名详情页', 'error');
      return;
    }

    state.running = true;
    state.cancelled = false;
    state.records.clear();
    state.errors = [];
    state.originalTab = document.querySelector('#analysisControllUl > li.active')?.getAttribute('data-tab-name') || '';
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
      setStatus(`提取完成，共 ${state.records.size} 条关联记录`, state.errors.length ? 'warning' : 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (state.cancelled) setStatus('已停止，当前结果仍可导出', 'warning');
      else {
        state.errors.push(message);
        setStatus(`提取中断：${message}`, 'error');
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
    return [...state.records.values()].sort((a, b) => {
      return a.source.localeCompare(b.source) || a.domain.localeCompare(b.domain) || a.ip.localeCompare(b.ip) || b.observed_at.localeCompare(a.observed_at);
    });
  }

  function distinctAssets(field) {
    return unique(recordsArray().map((record) => record[field])).sort();
  }

  function csvCell(value) {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function buildCsv() {
    const columns = ['query', 'query_type', 'source_label', 'source', 'domain', 'ip', 'observed_at', 'verdict', 'location', 'provider', 'usage', 'row_text'];
    const lines = [columns.map(csvCell).join(',')];
    for (const record of recordsArray()) lines.push(columns.map((column) => csvCell(record[column])).join(','));
    return `\uFEFF${lines.join('\r\n')}`;
  }

  function buildJson() {
    return JSON.stringify({
      query: state.query,
      page_url: location.href,
      generated_at: new Date().toISOString(),
      summary: {
        records: state.records.size,
        domains: distinctAssets('domain').length,
        ips: distinctAssets('ip').length,
      },
      domains: distinctAssets('domain'),
      ips: distinctAssets('ip'),
      records: recordsArray(),
      warnings: state.errors,
    }, null, 2);
  }

  function safeFilePart(value) {
    return String(value || 'result').replace(/[\\/:*?"<>|]/g, '_');
  }

  function download(content, extension, mimeType) {
    if (!state.records.size) {
      setStatus('暂无结果，请先开始提取', 'warning');
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

  function openAllDomains() {
    const domains = distinctAssets('domain');
    if (!domains.length) {
      setStatus('没有可打开的域名', 'warning');
      return;
    }
    const confirmed = window.confirm(`将在新标签页打开 ${domains.length} 个微步域名情报页。是否继续？`);
    if (!confirmed) return;

    let opened = 0;
    let blocked = 0;
    for (const domain of domains) {
      const url = `${location.origin}/v5/domain/${encodeURIComponent(domain)}`;
      if (typeof GM_openInTab === 'function') {
        GM_openInTab(url, { active: false, insert: true, setParent: true });
        opened += 1;
      } else {
        const tab = window.open(url, '_blank', 'noopener,noreferrer');
        if (tab) opened += 1;
        else blocked += 1;
      }
    }
    setStatus(
      blocked ? `已打开 ${opened} 个域名，另有 ${blocked} 个被浏览器拦截` : `已在后台打开 ${opened} 个微步域名情报页`,
      blocked ? 'warning' : 'success',
    );
  }

  function updateStats() {
    if (!state.ui) return;
    state.ui.recordCount.textContent = String(state.records.size);
    state.ui.domainCount.textContent = String(distinctAssets('domain').length);
    state.ui.ipCount.textContent = String(distinctAssets('ip').length);
    const enabled = state.records.size > 0 && !state.running;
    for (const button of state.ui.resultButtons) button.disabled = !enabled;
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
      :host { all: initial; }
      * { box-sizing: border-box; letter-spacing: 0; }
      button, input { font: inherit; }
      .launcher { position: fixed; right: 22px; bottom: 22px; z-index: 2147483646; height: 44px; border: 0; border-radius: 6px; padding: 0 15px; background: #17191c; color: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.22); cursor: pointer; font: 600 14px/1 "Microsoft YaHei", sans-serif; }
      .launcher:hover { background: #292d32; }
      .panel { position: fixed; right: 22px; bottom: 22px; z-index: 2147483647; width: min(380px, calc(100vw - 24px)); border: 1px solid #d9dde3; border-top: 3px solid #d71920; border-radius: 6px; background: #fff; color: #1d2229; box-shadow: 0 18px 48px rgba(0,0,0,.2); font: 13px/1.5 "Microsoft YaHei", sans-serif; }
      .panel[hidden], [hidden] { display: none !important; }
      .head { display: flex; align-items: center; justify-content: space-between; min-height: 52px; padding: 0 16px; border-bottom: 1px solid #eceef1; }
      .title { margin: 0; font-size: 15px; font-weight: 700; }
      .close { width: 32px; height: 32px; border: 0; background: transparent; color: #69717c; font-size: 22px; cursor: pointer; }
      .close:hover { color: #17191c; }
      .body { padding: 15px 16px 16px; }
      .query { display: flex; align-items: center; gap: 8px; min-width: 0; margin-bottom: 14px; }
      .badge { flex: none; border-radius: 4px; padding: 2px 7px; background: #f1f3f5; color: #4c5561; font-size: 11px; font-weight: 700; }
      .query-value { overflow: hidden; color: #252b32; font-family: Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
      .stats { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid #e1e4e8; border-radius: 5px; }
      .stat { min-width: 0; padding: 10px 8px; text-align: center; }
      .stat + .stat { border-left: 1px solid #e1e4e8; }
      .number { display: block; font: 700 19px/1.1 Consolas, monospace; }
      .label { display: block; margin-top: 4px; color: #727b86; font-size: 11px; }
      .status { min-height: 40px; margin: 12px 0; padding: 9px 10px; border-left: 3px solid #aab1ba; background: #f6f7f8; color: #4d5661; overflow-wrap: anywhere; }
      .status[data-tone="working"] { border-color: #1677ff; background: #f0f6ff; color: #174b86; }
      .status[data-tone="success"] { border-color: #16834a; background: #eef9f3; color: #17643d; }
      .status[data-tone="warning"] { border-color: #c17800; background: #fff8e8; color: #77500d; }
      .status[data-tone="error"] { border-color: #d71920; background: #fff1f1; color: #95161b; }
      .options { display: flex; flex-wrap: wrap; gap: 12px 18px; margin-bottom: 13px; color: #454d57; }
      .check { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
      .check input { width: 15px; height: 15px; accent-color: #d71920; }
      .actions { display: flex; gap: 8px; }
      .button { min-height: 36px; border: 1px solid #cfd4da; border-radius: 5px; padding: 0 12px; background: #fff; color: #252b32; cursor: pointer; }
      .button:hover:not(:disabled) { border-color: #7c858f; background: #f7f8f9; }
      .button.primary { flex: 1; border-color: #17191c; background: #17191c; color: #fff; font-weight: 700; }
      .button.primary:hover:not(:disabled) { background: #292d32; }
      .button.danger { flex: 1; border-color: #d71920; background: #d71920; color: #fff; font-weight: 700; }
      .button:disabled { cursor: not-allowed; opacity: .42; }
      .results { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
      [data-action="open-domains"] { grid-column: 1 / -1; }
      @media (max-width: 440px) { .panel, .launcher { right: 12px; bottom: 12px; } .panel { width: calc(100vw - 24px); } }
    `;

    const launcher = document.createElement('button');
    launcher.className = 'launcher';
    launcher.type = 'button';
    launcher.textContent = '↓ 提取关联资产';

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
          <div class="stat"><strong class="number" data-stat="records">0</strong><span class="label">关联记录</span></div>
          <div class="stat"><strong class="number" data-stat="domains">0</strong><span class="label">域名</span></div>
          <div class="stat"><strong class="number" data-stat="ips">0</strong><span class="label">IP</span></div>
        </div>
        <div class="status" data-tone="idle">等待提取</div>
        <div class="options">
          <label class="check"><input data-option="history" type="checkbox" checked>展开历史详情</label>
          <label class="check"><input data-option="inactive" type="checkbox" checked>失效子域名</label>
        </div>
        <div class="actions">
          <button class="button primary" data-action="start" type="button">开始提取</button>
          <button class="button danger" data-action="stop" type="button" hidden>停止</button>
          <button class="button" data-action="csv" type="button" disabled>CSV</button>
          <button class="button" data-action="json" type="button" disabled>JSON</button>
        </div>
        <div class="results">
          <button class="button" data-action="domains" type="button" disabled>复制域名</button>
          <button class="button" data-action="ips" type="button" disabled>复制 IP</button>
          <button class="button" data-action="open-domains" type="button" disabled>打开本次提取的全部域名</button>
        </div>
      </div>
    `;

    shadow.append(style, launcher, panel);
    const get = (selector) => shadow.querySelector(selector);
    state.ui = {
      launcher,
      panel,
      start: get('[data-action="start"]'),
      stop: get('[data-action="stop"]'),
      status: get('.status'),
      recordCount: get('[data-stat="records"]'),
      domainCount: get('[data-stat="domains"]'),
      ipCount: get('[data-stat="ips"]'),
      expandHistory: get('[data-option="history"]'),
      includeInactive: get('[data-option="inactive"]'),
      resultButtons: [...shadow.querySelectorAll('[data-action="csv"],[data-action="json"],[data-action="domains"],[data-action="ips"],[data-action="open-domains"]')],
    };

    get('.badge').textContent = state.query.type === 'ip' ? 'IP' : '域名';
    get('.query-value').textContent = state.query.value || '未识别';
    launcher.addEventListener('click', () => {
      panel.hidden = false;
      launcher.hidden = true;
    });
    get('.close').addEventListener('click', () => {
      panel.hidden = true;
      launcher.hidden = false;
    });
    state.ui.start.addEventListener('click', runExtraction);
    state.ui.stop.addEventListener('click', () => {
      state.cancelled = true;
      setStatus('正在停止…', 'warning');
    });
    get('[data-action="csv"]').addEventListener('click', () => download(buildCsv(), 'csv', 'text/csv;charset=utf-8'));
    get('[data-action="json"]').addEventListener('click', () => download(buildJson(), 'json', 'application/json;charset=utf-8'));
    get('[data-action="domains"]').addEventListener('click', () => copyAssets('domain', '域名'));
    get('[data-action="ips"]').addEventListener('click', () => copyAssets('ip', 'IP'));
    get('[data-action="open-domains"]').addEventListener('click', openAllDomains);
  }

  function boot() {
    if (state.query.type === 'unknown') return;
    mountUi();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

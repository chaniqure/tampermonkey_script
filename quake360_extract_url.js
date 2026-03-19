// ==UserScript==
// @name         Quake360 结果 URL 提取与过滤
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  提取 quake 搜索结果中的标题与 URL，支持多页抓取、可用性检测与表格导出
// @author       you
// @match        *://quake.360.net/*
// @match        *://quake.360.cn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============== 常量定义 ==============
    const TABLE_COLUMN_DEFS = {
        idx: { key: 'idx', text: '#', width: '60px' },
        page: { key: 'page', text: '页码', width: '70px' },
        title: { key: 'title', text: '标题', width: '260px' },
        url: { key: 'url', text: 'URL', width: '420px' },
        host: { key: 'host', text: 'Host', width: '180px' },
        protocol: { key: 'protocol', text: '协议', width: '90px' },
        checkStatus: { key: 'checkStatus', text: '校验结果', width: '100px' },
        checkReason: { key: 'checkReason', text: '说明', width: '260px' }
    };
    const TABLE_COLUMN_ORDER = Object.keys(TABLE_COLUMN_DEFS);
    const DEFAULT_VISIBLE_COLUMNS = ['idx', 'page', 'title', 'url', 'host', 'checkStatus', 'checkReason'];
    const DEFAULT_COPY_COLUMNS = ['idx', 'page', 'title', 'url', 'host', 'protocol', 'checkStatus', 'checkReason'];

    const DEFAULT_RULES = {
        includeRegex: '',
        excludeRegex: '(?:^$)',
        allowProtocols: ['http:', 'https:'],
        dedupeByHost: false,

        resultLinkSelector: 'a[rel~="noreferrer"][rel~="noopener"][rel~="nofollow"][href]',
        autoPaginate: false,
        nextPageSelector: '.ant-pagination-next, .next, button.next, [aria-label*="下一页"], [title*="下一页"]',
        maxPages: 1,
        targetCount: 100,
        pageWaitMs: 2000,

        // 校验触发方式: auto=提取时自动校验, manual=弹窗后手动点按钮校验
        checkTrigger: 'manual',
        onlyKeepAvailable: false,
        checkMode: 'concurrent',
        availabilityTimeoutMs: 5000,
        maxCheckCount: 80,
        checkConcurrency: 4,
        visibleColumns: DEFAULT_VISIBLE_COLUMNS,
        copyColumns: DEFAULT_COPY_COLUMNS,
        unavailableKeywords: [
            '404', 'not found', '502 bad gateway', '403 forbidden',
            '无法访问', '连接超时', 'err_name_not_resolved', 'timeout'
        ]
    };

    const STORAGE_KEY = 'quake_url_filter_rules_v2';

    // ============== 工具函数 ==============
    const clampInt = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
        const n = Number.parseInt(String(value), 10);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };

    const normalizeColumnKeys = (input, fallback) => {
        const arr = (Array.isArray(input) ? input : fallback)
            .map(x => String(x).trim())
            .filter(x => TABLE_COLUMN_DEFS[x]);
        return arr.length ? [...new Set(arr)] : [...fallback];
    };

    const getColumnsByKeys = keys => normalizeColumnKeys(keys, DEFAULT_VISIBLE_COLUMNS).map(k => TABLE_COLUMN_DEFS[k]);

    const getColumnCellValue = (key, row, idx) => key === 'idx' ? idx + 1 : (row[key] ?? '');

    const normalizeRules = raw => {
        const r = { ...DEFAULT_RULES, ...(raw || {}) };
        r.allowProtocols = Array.isArray(r.allowProtocols) ? r.allowProtocols.filter(Boolean) : [...DEFAULT_RULES.allowProtocols];
        r.unavailableKeywords = Array.isArray(r.unavailableKeywords) ? r.unavailableKeywords.filter(Boolean) : [...DEFAULT_RULES.unavailableKeywords];

        r.maxPages = clampInt(r.maxPages, DEFAULT_RULES.maxPages, 1, 999);
        r.targetCount = clampInt(r.targetCount, DEFAULT_RULES.targetCount, 0, 100000);
        r.pageWaitMs = clampInt(r.pageWaitMs, DEFAULT_RULES.pageWaitMs, 500, 15000);
        r.availabilityTimeoutMs = clampInt(r.availabilityTimeoutMs, DEFAULT_RULES.availabilityTimeoutMs, 500, 20000);
        r.maxCheckCount = clampInt(r.maxCheckCount, DEFAULT_RULES.maxCheckCount, 0, 100000);
        r.checkConcurrency = clampInt(r.checkConcurrency, DEFAULT_RULES.checkConcurrency, 1, 20);
        r.checkMode = r.checkMode === 'sequential' ? 'sequential' : 'concurrent';
        r.checkTrigger = r.checkTrigger === 'auto' ? 'auto' : 'manual';
        r.visibleColumns = normalizeColumnKeys(r.visibleColumns, DEFAULT_VISIBLE_COLUMNS);
        // 确保 page 列始终存在（必要时追加到末尾）
        if (!r.visibleColumns.includes('page')) {
            r.visibleColumns.push('page');
        }
        r.copyColumns = normalizeColumnKeys(r.copyColumns, DEFAULT_COPY_COLUMNS);
        // 确保 page 列始终存在（必要时追加到末尾）
        if (!r.copyColumns.includes('page')) {
            r.copyColumns.push('page');
        }
        r.includeRegex = String(r.includeRegex || '');
        r.excludeRegex = String(r.excludeRegex || '');
        r.resultLinkSelector = String(r.resultLinkSelector || DEFAULT_RULES.resultLinkSelector).trim() || DEFAULT_RULES.resultLinkSelector;
        r.nextPageSelector = String(r.nextPageSelector || DEFAULT_RULES.nextPageSelector).trim() || DEFAULT_RULES.nextPageSelector;

        return r;
    };

    const getRules = () => {
        try {
            const saved = GM_getValue(STORAGE_KEY, null);
            return saved ? normalizeRules(JSON.parse(saved)) : normalizeRules(DEFAULT_RULES);
        } catch {
            return normalizeRules(DEFAULT_RULES);
        }
    };

    const saveRules = rules => GM_setValue(STORAGE_KEY, JSON.stringify(normalizeRules(rules)));

    let rules = getRules();

    // 安全正则，不弹 alert
    const safeRegex = pattern => {
        if (!pattern) return null;
        try {
            return new RegExp(pattern, 'i');
        } catch {
            return null;
        }
    };

    const normalizeUrl = raw => {
        if (!raw) return null;
        const txt = raw.trim();
        if (!txt) return null;
        try {
            return new URL(txt, location.href).toString();
        } catch {
            return null;
        }
    };

    const cleanTitleText = raw => {
        if (!raw) return '';
        let s = String(raw).replace(/\s+/g, ' ').trim()
            .replace(/\bBody相同网页\b/gi, '')
            .replace(/\bFavicon相同网页\b/gi, '')
            .replace(/\s+/g, ' ').trim();
        // 压缩末尾重复中文片段
        s = s.replace(/([\u4e00-\u9fa5]{2,4})\1+$/g, '$1');
        const parts = s.split(' ').filter(Boolean);
        if (parts.length >= 2 && parts[0] === parts[1]) parts.shift();
        return parts.join(' ');
    };

    const parseHost = url => {
        try {
            return new URL(url).host.toLowerCase();
        } catch {
            return '';
        }
    };

    const parseProtocol = url => {
        try {
            return new URL(url).protocol;
        } catch {
            return '';
        }
    };

    const escapeCsvCell = v => {
        const text = String(v ?? '');
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const toCsv = (records, columnKeys = DEFAULT_COPY_COLUMNS) => {
        const cols = getColumnsByKeys(columnKeys);
        const header = cols.map(c => c.text);
        const rows = records.map((r, idx) => cols.map(c => getColumnCellValue(c.key, r, idx)));
        return [header, ...rows].map(row => row.map(escapeCsvCell).join(',')).join('\r\n');
    };

    const toTsv = (records, columnKeys = DEFAULT_COPY_COLUMNS) => {
        const cols = getColumnsByKeys(columnKeys);
        const header = cols.map(c => c.text);
        const rows = records.map((r, idx) => cols.map(c => getColumnCellValue(c.key, r, idx)));
        return [header, ...rows].map(row => row.map(v => String(v ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
    };

    const copyToClipboard = text => navigator.clipboard.writeText(text);

    const downloadAsTextFile = (text, filename, mime = 'text/plain;charset=utf-8') => {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // ============== UI 样式 ==============
    const STYLES = {
        modalMask: {
            position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.45)',
            zIndex: 1000000, display: 'flex', alignItems: 'center',
            justifyContent: 'center'
        },
        modalPanel: (width = 'min(1200px, 96vw)') => ({
            width, maxHeight: '90vh', background: '#fff', borderRadius: '10px',
            boxShadow: '0 10px 30px rgba(0,0,0,0.25)', display: 'flex',
            flexDirection: 'column', overflow: 'hidden'
        }),
        header: {
            padding: '12px 16px', fontSize: '16px', fontWeight: '600',
            borderBottom: '1px solid #eee'
        },
        summary: {
            padding: '10px 16px', fontSize: '13px', color: '#444',
            background: '#fafafa', borderBottom: '1px solid #eee'
        },
        toolbar: {
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            gap: '8px', padding: '8px 16px', borderBottom: '1px solid #eee',
            background: '#fff'
        },
        footer: {
            display: 'flex', gap: '8px', justifyContent: 'flex-end',
            padding: '12px 16px', borderTop: '1px solid #eee', background: '#fff'
        },
        tableWrap: {
            overflow: 'auto', maxHeight: '62vh', borderBottom: '1px solid #eee'
        },
        table: {
            width: '100%', borderCollapse: 'collapse', fontSize: '12px',
            tableLayout: 'fixed'
        },
        th: {
            position: 'sticky', top: '0', zIndex: '1', background: '#f7f9fb',
            borderBottom: '1px solid #ddd', borderRight: '1px solid #eee',
            padding: '8px', textAlign: 'left', fontWeight: '600'
        },
        td: {
            padding: '8px', borderRight: '1px solid #f7f7f7',
            borderBottom: '1px solid #f1f1f1', wordBreak: 'break-all'
        }
    };

    const makeBtn = (text, color = '#16a085', bg = '#fff') => {
        const btn = document.createElement('button');
        btn.textContent = text;
        Object.assign(btn.style, {
            padding: '8px 12px', borderRadius: '6px', border: `1px solid ${color}`,
            background: bg, color, cursor: 'pointer', fontSize: '13px', lineHeight: '1.2'
        });
        return btn;
    };

    const createModalShell = id => {
        const old = document.getElementById(id);
        if (old) old.remove();

        const mask = document.createElement('div');
        Object.assign(mask.style, STYLES.modalMask);
        mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });

        const panel = document.createElement('div');
        Object.assign(panel.style, STYLES.modalPanel());
        mask.appendChild(panel);
        return { mask, panel };
    };

    const createModal = (id, width) => {
        const old = document.getElementById(id);
        if (old) old.remove();

        const mask = document.createElement('div');
        Object.assign(mask.style, STYLES.modalMask);
        mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });

        const panel = document.createElement('div');
        Object.assign(panel.style, STYLES.modalPanel(width));
        mask.appendChild(panel);
        return { mask, panel };
    };

    // ============== 核心功能 ==============
    function getNodeTitle(anchor) {
        // 1. 先尝试 title 属性
        const attrTitle = cleanTitleText(anchor.getAttribute('title') || '');
        if (attrTitle) return attrTitle;

        // 2. 直接取锚点文本内容，去除首尾空白后检查是否有效
        const directText = anchor.textContent?.trim() || '';
        if (directText && !/^(https?:|www\.)/i.test(directText) && directText.length > 2) {
            return cleanTitleText(directText);
        }

        // 3. 尝试从父级容器中提取标题
        // 常见结构: td > a 或者 li > a 或者 div > a
        let parent = anchor.parentElement;
        let maxDepth = 5;
        while (parent && maxDepth-- > 0) {
            const tagName = parent.tagName?.toUpperCase();
            // td/th 是常见表格结构，直接取其文本
            if (tagName === 'TD' || tagName === 'TH') {
                // 获取 td 内第一个直系文本节点（忽略 a 及其后的文本）
                let titleText = '';
                for (const node of parent.childNodes) {
                    if (node.nodeType === Node.TEXT_NODE) {
                        const t = node.textContent?.trim() || '';
                        if (t) { titleText = t; break; }
                    }
                    if (node === anchor) break;
                }
                if (!titleText) titleText = parent.textContent?.replace(anchor.textContent || '', '').trim() || '';
                if (titleText) return cleanTitleText(titleText);
            }
            // 对于列表或卡片结构
            if (tagName === 'LI' || tagName === 'ARTICLE' || tagName === 'DIV') {
                // 取父元素的文本，但排除链接自身的文本
                const siblings = Array.from(parent.childNodes);
                const anchorIdx = siblings.indexOf(anchor);
                let titleText = '';
                // 取链接之前的文本
                for (let i = 0; i < anchorIdx; i++) {
                    if (siblings[i].nodeType === Node.TEXT_NODE) {
                        const t = siblings[i].textContent?.trim() || '';
                        if (t) { titleText = t; break; }
                    }
                }
                // 如果链接前没有文本，尝试整个父元素文本（去除链接文本）
                if (!titleText) {
                    titleText = parent.textContent?.replace(anchor.textContent || '').trim() || '';
                }
                if (titleText && titleText.length > 2) return cleanTitleText(titleText);
            }
            parent = parent.parentElement;
        }

        // 4. 最后 fallback 到链接文本
        const textTitle = cleanTitleText(anchor.textContent || '');
        if (textTitle) return textTitle;

        return '(无标题)';
    }

    function getPageSignature(selector) {
        return Array.from(document.querySelectorAll(selector)).slice(0, 20)
            .map(a => a.getAttribute('href') || '').join('|');
    }

    function isNextButtonDisabled(btn) {
        if (!btn) return true;
        if (btn.hasAttribute('disabled')) return true;
        if (btn.getAttribute('aria-disabled') === 'true') return true;
        return String(btn.className || '').toLowerCase().includes('disabled');
    }

    function extractRecordsFromPage(pageIndex, r) {
        let anchors = [];
        try {
            anchors = Array.from(document.querySelectorAll(r.resultLinkSelector));
        } catch {
            anchors = [];
        }

        const seen = new Set();
        return anchors.reduce((out, a) => {
            const url = normalizeUrl(a.getAttribute('href'));
            if (!url || seen.has(url)) return out;
            seen.add(url);
            out.push({
                page: pageIndex, title: getNodeTitle(a), url,
                host: parseHost(url), protocol: parseProtocol(url),
                checkOk: null, checkStatus: '未校验', checkReason: ''
            });
            return out;
        }, []);
    }

    function applyRules(records, r) {
        const includeRe = safeRegex(r.includeRegex);
        const excludeRe = safeRegex(r.excludeRegex);
        if (r.includeRegex && !includeRe) return [];
        if (r.excludeRegex && !excludeRe) return [];

        const seen = new Set();
        const dedupe = rec => {
            const key = r.dedupeByHost ? rec.host : rec.url;
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        };

        return records.filter(rec => {
            if (!r.allowProtocols.includes(rec.protocol)) return false;
            const target = `${rec.title} ${rec.url}`;
            if (includeRe && !includeRe.test(target)) return false;
            if (excludeRe && excludeRe.test(target)) return false;
            return dedupe(rec);
        });
    }

    async function gotoNextPage(r) {
        const prev = getPageSignature(r.resultLinkSelector);
        let btn = null;
        try {
            btn = document.querySelector(r.nextPageSelector);
        } catch {
            return false;
        }

        if (!btn || isNextButtonDisabled(btn)) return false;

        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(120);
        btn.click();

        const changed = await waitForPageChange(r.resultLinkSelector, prev, r.pageWaitMs);
        if (!changed) await sleep(r.pageWaitMs);
        return true;
    }

    async function waitForPageChange(selector, prevSignature, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const now = getPageSignature(selector);
            if (now && now !== prevSignature) return true;
            await sleep(200);
        }
        return false;
    }

    async function collectRecords(r) {
        const all = [];
        const maxPages = r.autoPaginate ? r.maxPages : 1;

        for (let page = 1; page <= maxPages; page++) {
            const onePage = extractRecordsFromPage(page, r);
            all.push(...onePage);

            if (r.targetCount > 0 && all.length >= r.targetCount) break;
            if (!r.autoPaginate || page >= maxPages) break;

            GM_notification({ text: `正在翻页采集：第 ${page} 页完成，准备下一页...`, title: 'Quake URL 提取' });
            const ok = await gotoNextPage(r);
            if (!ok) break;
        }

        return r.targetCount > 0 ? all.slice(0, r.targetCount) : all;
    }

    // ============== URL 校验 ==============
    // 从 HTML 内容中提取 <title> 标签
    function extractTitleFromHtml(html) {
        if (!html) return '';
        const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        if (match && match[1]) {
            return cleanTitleText(match[1].trim());
        }
        return '';
    }

    function gmRequestAvailable(url, timeoutMs, fetchTitle) {
        return new Promise(resolve => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                resolve({ supported: false, ok: false, reason: 'gm-unavailable', title: '' });
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: timeoutMs,
                headers: { 'Cache-Control': 'no-cache' },
                onload: resp => {
                    const status = Number(resp?.status ?? 0);
                    let title = '';
                    if (fetchTitle && resp.responseText) {
                        title = extractTitleFromHtml(resp.responseText);
                    }
                    resolve({
                        supported: true,
                        ok: (status >= 200 && status < 400) || status === 0,
                        reason: `http:${status || 0}`,
                        title
                    });
                },
                ontimeout: () => resolve({ supported: true, ok: false, reason: 'timeout', title: '' }),
                onabort: () => resolve({ supported: true, ok: false, reason: 'aborted', title: '' }),
                onerror: err => resolve({ supported: true, ok: false, reason: `error:${err?.error ?? err?.message ?? 'network'}`, title: '' })
            });
        });
    }

    async function checkUrlAvailable(url, timeoutMs, unavailableKeywords, fetchTitle = false) {
        const gmRes = await gmRequestAvailable(url, timeoutMs, fetchTitle);
        if (gmRes.supported) return { url, ok: gmRes.ok, reason: gmRes.reason, title: gmRes.title };

        if (location.protocol === 'https:' && url.toLowerCase().startsWith('http://')) {
            return { url, ok: false, reason: 'blocked:mixed-content(http-on-https)', title: '' };
        }

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            await fetch(url, { method: 'GET', mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' });
            clearTimeout(timer);
            return { url, ok: true, reason: 'reachable(no-cors)', title: '' };
        } catch (e) {
            clearTimeout(timer);

            // 尝试 favicon 检测
            const okByFavicon = await new Promise(resolve => {
                const img = new Image();
                const t = setTimeout(() => { img.src = ''; resolve(false); }, timeoutMs);
                img.onload = () => { clearTimeout(t); resolve(true); };
                img.onerror = () => { clearTimeout(t); resolve(false); };
                try {
                    img.src = `${new URL(url).origin}/favicon.ico?_=${Date.now()}`;
                } catch {
                    resolve(false);
                }
            });

            if (okByFavicon) return { url, ok: true, reason: 'reachable(favicon)', title: '' };

            const msg = String(e?.message ?? '').toLowerCase()
                .replace('failed to fetch', '网络请求失败')
                .replace('networkerror when attempting to fetch resource', '网络请求失败')
                .replace('err_cert_authority_invalid', '证书无效')
                .replace('err_ssl_protocol_error', 'SSL协议错误')
                .replace('err_connection_closed', '连接被关闭');

            const hitKeyword = unavailableKeywords.some(k => msg.includes(String(k).toLowerCase()));
            return { url, ok: false, reason: hitKeyword ? `blocked:${msg}` : `failed:${msg}`, title: '' };
        }
    }

    // 校验批次，支持取消，支持逐行更新回调，支持从响应提取标题
    async function checkBatch(records, r, mode = 'concurrent', onProgress = null, onRowResult = null, onCancel = null, fetchTitle = false) {
        const limit = r.maxCheckCount > 0 ? Math.min(records.length, r.maxCheckCount) : records.length;
        const target = records.slice(0, limit);
        const resultMap = new Map();
        let done = 0;
        let cancelled = false;

        const checkOne = async rec => {
            if (cancelled) return null;
            const res = await checkUrlAvailable(rec.url, r.availabilityTimeoutMs, r.unavailableKeywords, fetchTitle);
            if (cancelled) return null;
            done++;
            // 立即触发行更新回调
            if (typeof onRowResult === 'function' && res) {
                onRowResult(rec.url, res);
            }
            if (typeof onProgress === 'function') onProgress(done, target.length);
            return res;
        };

        if (mode === 'sequential') {
            for (let i = 0; i < target.length; i++) {
                if (cancelled) break;
                const res = await checkOne(target[i]);
                if (res) resultMap.set(target[i].url, res);
            }
        } else {
            let cursor = 0;
            const worker = async () => {
                while (!cancelled) {
                    const i = cursor;
                    cursor++;
                    if (i >= target.length) break;
                    const res = await checkOne(target[i]);
                    if (res) resultMap.set(target[i].url, res);
                }
            };
            const workers = Array.from({ length: r.checkConcurrency }, () => worker());
            await Promise.all(workers);
        }

        if (typeof onCancel === 'function') onCancel(() => { cancelled = true; });

        return { resultMap, checkedCount: target.length, isCancelled: cancelled };
    }

    function applyCheckResultToRecords(records, resultMap, useResponseTitle = false) {
        return records.map(rec => {
            const hit = resultMap.get(rec.url);
            if (!hit) return { ...rec, checkOk: null, checkStatus: '未校验', checkReason: '超过校验上限或未执行' };
            // 如果配置了从响应提取标题，且校验返回了标题，则更新标题
            const newTitle = useResponseTitle && hit.title ? hit.title : rec.title;
            return { ...rec, title: newTitle, checkOk: hit.ok, checkStatus: hit.ok ? '可用' : '不可用', checkReason: hit.reason };
        });
    }

    // ============== 表格渲染（性能优化） ==============
    // 获取或创建 tbody 引用（避免重复查询）
    function getTbody(table) {
        return table.querySelector('tbody') || null;
    }

    // 渲染表头（只渲染一次）
    function renderThead(table, visibleColumns) {
        const columns = getColumnsByKeys(visibleColumns);
        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        columns.forEach(c => {
            const th = document.createElement('th');
            th.textContent = c.text;
            Object.assign(th.style, { ...STYLES.th, width: c.width, minWidth: c.width });
            trh.appendChild(th);
        });
        thead.appendChild(trh);
        return thead;
    }

    // 渲染单行
    function createRow(columns, row, idx) {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #f1f1f1';
        tr.dataset.url = row.url; // 用于定位行

        columns.forEach(c => {
            const td = document.createElement('td');
            Object.assign(td.style, STYLES.td);
            const value = getColumnCellValue(c.key, row, idx);

            if (c.key === 'url') {
                const a = document.createElement('a');
                a.href = row.url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = String(value || '');
                a.style.color = '#2d7df6';
                td.appendChild(a);
            } else {
                td.textContent = String(value ?? '');
            }

            // checkStatus 列根据状态设置颜色
            if (c.key === 'checkStatus') {
                td.style.color = value === '可用' ? '#16a085' : (value === '不可用' ? '#dc2626' : '#999');
            }

            tr.appendChild(td);
        });
        return tr;
    }

    // 更新单行数据
    function updateRow(table, url, checkResult, columns, records) {
        const tbody = getTbody(table);
        if (!tbody) return;

        const idx = records.findIndex(r => r.url === url);
        if (idx === -1) return;

        records[idx] = {
            ...records[idx],
            checkOk: checkResult.ok,
            checkStatus: checkResult.ok ? '可用' : '不可用',
            checkReason: checkResult.reason
        };

        const rowIndex = idx; // tbody rows are indexed directly
        const tr = tbody.rows[rowIndex];
        if (!tr) return;

        // 更新 checkStatus 和 checkReason 列
        columns.forEach((c, colIdx) => {
            if (c.key === 'checkStatus' || c.key === 'checkReason') {
                const td = tr.cells[colIdx];
                if (td) {
                    const value = getColumnCellValue(c.key, records[idx], idx);
                    td.textContent = String(value ?? '');
                    // 根据状态设置颜色
                    if (c.key === 'checkStatus') {
                        td.style.color = value === '可用' ? '#16a085' : (value === '不可用' ? '#dc2626' : '#999');
                    }
                }
            }
        });
    }

    // 渲染所有行
    function renderRows(table, state, columns) {
        const cols = columns || getColumnsByKeys(state.visibleColumns);

        // 每次都重建整个表格内容（因为列配置可能改变）
        table.innerHTML = '';

        // thead
        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        cols.forEach(c => {
            const th = document.createElement('th');
            th.textContent = c.text;
            Object.assign(th.style, { ...STYLES.th, width: c.width, minWidth: c.width });
            trh.appendChild(th);
        });
        thead.appendChild(trh);
        table.appendChild(thead);

        // tbody
        const tbody = document.createElement('tbody');
        state.records.forEach((row, idx) => {
            tbody.appendChild(createRow(cols, row, idx));
        });
        table.appendChild(tbody);
    }

    // 初始化表格（创建空 tbody 占位）
    function initTable(table, visibleColumns) {
        const cols = getColumnsByKeys(visibleColumns);
        const fragment = document.createDocumentFragment();
        fragment.appendChild(renderThead(table, visibleColumns));
        const tbody = document.createElement('tbody');
        fragment.appendChild(tbody);
        table.appendChild(fragment);
    }

    // ============== 结果弹窗 ==============
    function showResultModal({ allCount, filteredCount, finalRecords, checkedCount, availableCount, unavailableCount, pagesCollected, autoCheckDone = false }) {
        const { mask, panel } = createModal('quake-url-result-mask');
        const state = {
            records: finalRecords.map(x => ({ ...x })),
            checkedCount: checkedCount || 0,
            availableCount: availableCount || 0,
            unavailableCount: unavailableCount || 0,
            mode: rules.checkMode === 'sequential' ? 'sequential' : 'concurrent',
            checkTrigger: rules.checkTrigger === 'auto' ? 'auto' : 'manual',
            visibleColumns: normalizeColumnKeys(rules.visibleColumns, DEFAULT_VISIBLE_COLUMNS),
            copyColumns: normalizeColumnKeys(rules.copyColumns, DEFAULT_COPY_COLUMNS),
            checking: false,
            cancelFn: null
        };
        const columns = getColumnsByKeys(state.visibleColumns);

        // Header
        const header = document.createElement('div');
        header.textContent = 'Quake URL 提取结果（表格）';
        Object.assign(header.style, STYLES.header);

        // Summary
        const summary = document.createElement('div');
        Object.assign(summary.style, STYLES.summary);
        const renderSummary = () => {
            summary.textContent = `采集: ${allCount} | 过滤后: ${filteredCount} | 最终: ${state.records.length} | 页数: ${pagesCollected} | 校验: ${state.checkedCount}/${filteredCount} | 可用: ${state.availableCount} | 不可用: ${state.unavailableCount}`;
        };

        // 进度条容器
        const progressWrap = document.createElement('div');
        Object.assign(progressWrap.style, {
            padding: '8px 16px', background: '#fafafa', borderBottom: '1px solid #eee', display: 'none'
        });
        const progressBarOuter = document.createElement('div');
        Object.assign(progressBarOuter.style, {
            width: '100%', height: '8px', background: '#e5e7eb', borderRadius: '4px', overflow: 'hidden'
        });
        const progressBarInner = document.createElement('div');
        Object.assign(progressBarInner.style, {
            width: '0%', height: '100%', background: 'linear-gradient(90deg, #16a085, #2d7df6)',
            borderRadius: '4px', transition: 'width 0.2s ease'
        });
        const progressText = document.createElement('div');
        Object.assign(progressText.style, {
            marginTop: '4px', fontSize: '12px', color: '#666', textAlign: 'center'
        });
        progressBarOuter.appendChild(progressBarInner);
        progressWrap.append(progressBarOuter, progressText);

        const showProgress = (done, total, show) => {
            if (show) {
                progressWrap.style.display = 'block';
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                progressBarInner.style.width = pct + '%';
                progressText.textContent = `校验进度: ${done}/${total} (${pct}%)`;
            } else {
                progressWrap.style.display = 'none';
            }
        };

        // Toolbar
        const toolbar = document.createElement('div');
        Object.assign(toolbar.style, STYLES.toolbar);

        const colBtn = makeBtn('列设置', '#0f766e', '#fff');
        const checkBtn = makeBtn(state.checkTrigger === 'auto' ? '自动校验中...' : '开始校验', '#b45309', '#fff');
        if (state.checkTrigger === 'auto' && !autoCheckDone) {
            checkBtn.disabled = true;
        }

        const actionWrap = document.createElement('div');
        Object.assign(actionWrap.style, { display: 'inline-flex', gap: '8px' });
        actionWrap.append(colBtn, checkBtn);
        toolbar.appendChild(actionWrap);

        // Table
        const wrap = document.createElement('div');
        Object.assign(wrap.style, STYLES.tableWrap);

        const table = document.createElement('table');
        Object.assign(table.style, STYLES.table);
        wrap.appendChild(table);

        // 初始化表格
        initTable(table, state.visibleColumns);
        renderRows(table, state, columns);

        // Footer
        const footer = document.createElement('div');
        Object.assign(footer.style, STYLES.footer);

        const copyBtn = makeBtn('复制为 TSV', '#16a085', '#fff');
        copyBtn.addEventListener('click', async () => {
            try {
                await copyToClipboard(toTsv(state.records, state.copyColumns));
                GM_notification({ text: `已复制 ${state.records.length} 条数据，可直接粘贴到 Excel。`, title: 'Quake URL 提取' });
            } catch {
                GM_notification({ text: '复制失败', title: 'Quake URL 提取' });
            }
        });

        const csvBtn = makeBtn('下载 CSV', '#2d7df6', '#fff');
        csvBtn.addEventListener('click', () => {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            downloadAsTextFile(toCsv(state.records, state.copyColumns), `quake-urls-${ts}.csv`, 'text/csv;charset=utf-8');
        });

        const txtBtn = makeBtn('下载 URL 列表', '#5b6b7b', '#fff');
        txtBtn.addEventListener('click', () => {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            downloadAsTextFile(state.records.map(x => x.url).join('\n'), `quake-urls-${ts}.txt`);
        });

        const closeBtn = makeBtn('关闭', '#999', '#fff');
        closeBtn.addEventListener('click', () => mask.remove());

        const openAvailableBtn = makeBtn('打开可用链接', '#16a085', '#fff');
        openAvailableBtn.addEventListener('click', () => {
            const availableUrls = state.records
                .filter(r => r.checkStatus === '可用' && r.url)
                .map(r => r.url);
            if (!availableUrls.length) {
                GM_notification({ text: '没有可用的链接', title: 'Quake URL 提取' });
                return;
            }
            // 逐个打开链接（使用延迟避免被浏览器阻止）
            availableUrls.forEach((url, i) => {
                setTimeout(() => window.open(url, '_blank', 'noopener,noreferrer'), i * 100);
            });
            GM_notification({ text: `已打开 ${availableUrls.length} 个可用链接`, title: 'Quake URL 提取' });
        });

        const openAllBtn = makeBtn('打开全部链接', '#2d7df6', '#fff');
        openAllBtn.addEventListener('click', () => {
            const allUrls = state.records.filter(r => r.url).map(r => r.url);
            if (!allUrls.length) {
                GM_notification({ text: '没有链接', title: 'Quake URL 提取' });
                return;
            }
            allUrls.forEach((url, i) => {
                setTimeout(() => window.open(url, '_blank', 'noopener,noreferrer'), i * 100);
            });
            GM_notification({ text: `已打开 ${allUrls.length} 个链接`, title: 'Quake URL 提取' });
        });

        footer.append(copyBtn, csvBtn, txtBtn, openAllBtn, openAvailableBtn, closeBtn);

        // 列设置
        colBtn.addEventListener('click', () => {
            const { mask: cmask, panel: cpanel } = createModal('quake-url-column-mask', 'min(640px, 92vw)');
            const cheader = document.createElement('div');
            cheader.textContent = '列设置';
            Object.assign(cheader.style, STYLES.header);

            const cbody = document.createElement('div');
            Object.assign(cbody.style, { padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' });

            const buildColumnGroup = (title, selectedKeys) => {
                const box = document.createElement('div');
                const t = document.createElement('div');
                t.textContent = title;
                Object.assign(t.style, { fontWeight: '600', marginBottom: '8px' });
                box.appendChild(t);

                const checks = [];
                TABLE_COLUMN_ORDER.forEach(key => {
                    const def = TABLE_COLUMN_DEFS[key];
                    const line = document.createElement('label');
                    Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' });
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = selectedKeys.includes(key);
                    const span = document.createElement('span');
                    span.textContent = `${def.text} (${key})`;
                    line.append(cb, span);
                    box.appendChild(line);
                    checks.push({ key, cb });
                });
                return { box, checks };
            };

            const displayGroup = buildColumnGroup('显示列', state.visibleColumns);
            const copyGroup = buildColumnGroup('复制/CSV列', state.copyColumns);
            cbody.append(displayGroup.box, copyGroup.box);

            const cfooter = document.createElement('div');
            Object.assign(cfooter.style, STYLES.footer);

            const csave = makeBtn('保存', '#16a085', '#fff');
            const cclose = makeBtn('关闭', '#999', '#fff');
            cclose.addEventListener('click', () => cmask.remove());

            csave.addEventListener('click', () => {
                const selectedDisplay = displayGroup.checks.filter(x => x.cb.checked).map(x => x.key);
                const selectedCopy = copyGroup.checks.filter(x => x.cb.checked).map(x => x.key);
                if (!selectedDisplay.length || !selectedCopy.length) {
                    GM_notification({ text: '显示列和复制列至少各选择一列', title: 'Quake URL 提取' });
                    return;
                }
                state.visibleColumns = normalizeColumnKeys(selectedDisplay, DEFAULT_VISIBLE_COLUMNS);
                state.copyColumns = normalizeColumnKeys(selectedCopy, DEFAULT_COPY_COLUMNS);
                const runtimeRules = getRules();
                runtimeRules.visibleColumns = state.visibleColumns;
                runtimeRules.copyColumns = state.copyColumns;
                saveRules(runtimeRules);
                rules = runtimeRules;
                // 重新渲染整个表格（因为列配置改变了）
                renderRows(table, state);
                cmask.remove();
            });

            cfooter.append(csave, cclose);
            cpanel.append(cheader, cbody, cfooter);
            document.body.appendChild(cmask);
        });

        // 实时更新单行的回调（同时更新标题和校验状态）
        const onRowResult = (url, result) => {
            const idx = state.records.findIndex(r => r.url === url);
            if (idx !== -1) {
                // 如果响应中有标题且更优，则更新标题
                if (result.title && result.title.length > 2 && state.records[idx].title !== result.title) {
                    state.records[idx].title = result.title;
                }
                state.records[idx].checkOk = result.ok;
                state.records[idx].checkStatus = result.ok ? '可用' : '不可用';
                state.records[idx].checkReason = result.reason;
                // 更新表格中的该行
                updateRow(table, url, result, columns, state.records);
            }
        };

        // 校验
        const runCheck = async () => {
            if (!state.records.length) {
                GM_notification({ text: '当前没有可校验的数据', title: 'Quake URL 提取' });
                return;
            }

            state.checking = true;
            colBtn.disabled = true;
            checkBtn.disabled = true;

            const runtimeRules = getRules();
            const total = runtimeRules.maxCheckCount > 0
                ? Math.min(state.records.length, runtimeRules.maxCheckCount)
                : state.records.length;
            checkBtn.textContent = `校验中 0/${total} (点此取消)`;

            showProgress(0, total, true);

            try {
                const { resultMap, checkedCount: c, isCancelled } = await checkBatch(
                    state.records,
                    runtimeRules,
                    runtimeRules.checkMode,
                    (done, all) => {
                        showProgress(done, all, true);
                        checkBtn.textContent = `校验中 ${done}/${all} (点此取消)`;
                    },
                    onRowResult,
                    cancel => { state.cancelFn = cancel; },
                    true // fetchTitle: 从响应中提取标题
                );

                state.checkedCount = isCancelled ? state.checkedCount : c;
                state.records = applyCheckResultToRecords(state.records, resultMap, true);
                state.availableCount = state.records.filter(x => x.checkStatus === '可用').length;
                state.unavailableCount = state.records.filter(x => x.checkStatus === '不可用').length;
                renderRows(table, state, columns);
                renderSummary();
            } finally {
                state.checking = false;
                state.cancelFn = null;
                colBtn.disabled = false;
                checkBtn.disabled = false;
                checkBtn.textContent = '开始校验';
                showProgress(0, 0, false);
            }
        };

        checkBtn.addEventListener('click', async () => {
            if (state.checking) {
                if (typeof state.cancelFn === 'function') {
                    state.cancelFn();
                }
                return;
            }
            await runCheck();
        });

        // 如果是自动校验模式且尚未完成，则自动开始校验
        if (state.checkTrigger === 'auto' && !autoCheckDone && state.records.length > 0) {
            setTimeout(() => { runCheck(); }, 300);
        }

        renderSummary();
        panel.append(header, summary, progressWrap, toolbar, wrap, footer);
        document.body.appendChild(mask);
    }

    // ============== 配置面板 ==============
    function showConfigModal() {
        const cur = getRules();
        const { mask, panel } = createModal('quake-url-config-mask', 'min(980px, 95vw)');

        const header = document.createElement('div');
        header.textContent = 'Quake URL 提取配置';
        Object.assign(header.style, STYLES.header);

        const body = document.createElement('div');
        Object.assign(body.style, {
            padding: '14px 16px', overflow: 'auto', maxHeight: '70vh',
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px'
        });

        const makeField = (label, node) => {
            const box = document.createElement('label');
            Object.assign(box.style, { display: 'flex', flexDirection: 'column', gap: '6px' });
            const title = document.createElement('span');
            title.textContent = label;
            Object.assign(title.style, { fontSize: '13px', color: '#333' });
            box.append(title, node);
            return box;
        };

        const makeInput = (value, placeholder = '') => {
            const input = document.createElement('input');
            input.type = 'text';
            input.value = value;
            input.placeholder = placeholder;
            Object.assign(input.style, {
                width: '100%', boxSizing: 'border-box', border: '1px solid #d9d9d9',
                borderRadius: '6px', padding: '8px 10px', fontSize: '13px'
            });
            return input;
        };

        const makeNum = value => {
            const input = makeInput(String(value));
            input.inputMode = 'numeric';
            return input;
        };

        const makeTextarea = (value, placeholder = '') => {
            const ta = document.createElement('textarea');
            ta.value = value;
            ta.placeholder = placeholder;
            Object.assign(ta.style, {
                width: '100%', minHeight: '90px', boxSizing: 'border-box',
                border: '1px solid #d9d9d9', borderRadius: '6px', padding: '8px 10px',
                fontSize: '13px', resize: 'vertical'
            });
            return ta;
        };

        const makeCheckLine = (node, text) => {
            const label = document.createElement('label');
            Object.assign(label.style, { display: 'inline-flex', gap: '8px', alignItems: 'center' });
            label.append(node, document.createTextNode(text));
            return label;
        };

        // 字段
        const includeRegex = makeInput(cur.includeRegex, '例如：edu|gov');
        const excludeRegex = makeInput(cur.excludeRegex, '例如：login|signup');
        const allowProtocols = makeInput(cur.allowProtocols.join(','), 'http:,https:');
        const resultLinkSelector = makeInput(cur.resultLinkSelector, '结果链接选择器');
        const nextPageSelector = makeInput(cur.nextPageSelector, '下一页按钮选择器');
        const maxPages = makeNum(cur.maxPages);
        const targetCount = makeNum(cur.targetCount);
        const pageWaitMs = makeNum(cur.pageWaitMs);
        const availabilityTimeoutMs = makeNum(cur.availabilityTimeoutMs);
        const maxCheckCount = makeNum(cur.maxCheckCount);
        const checkConcurrency = makeNum(cur.checkConcurrency);
        const unavailableKeywords = makeTextarea(cur.unavailableKeywords.join('\n'), '每行一个关键字');

        const dedupeByHost = Object.assign(document.createElement('input'), { type: 'checkbox', checked: cur.dedupeByHost });
        const autoPaginate = Object.assign(document.createElement('input'), { type: 'checkbox', checked: cur.autoPaginate });
        const onlyKeepAvailable = Object.assign(document.createElement('input'), { type: 'checkbox', checked: cur.onlyKeepAvailable });

        // 校验触发方式：radio
        const checkTriggerWrap = document.createElement('div');
        Object.assign(checkTriggerWrap.style, { display: 'flex', gap: '16px', flexWrap: 'wrap' });
        const autoRadio = Object.assign(document.createElement('input'), { type: 'radio', name: 'checkTrigger', value: 'auto', checked: cur.checkTrigger === 'auto' });
        const manualRadio = Object.assign(document.createElement('input'), { type: 'radio', name: 'checkTrigger', value: 'manual', checked: cur.checkTrigger === 'manual' });
        checkTriggerWrap.append(
            makeCheckLine(autoRadio, '自动校验'),
            makeCheckLine(manualRadio, '手动校验')
        );

        // 校验模式：radio
        const checkModeWrap = document.createElement('div');
        Object.assign(checkModeWrap.style, { display: 'flex', gap: '16px', flexWrap: 'wrap' });
        const seqRadio = Object.assign(document.createElement('input'), { type: 'radio', name: 'checkMode', value: 'sequential', checked: cur.checkMode === 'sequential' });
        const conRadio = Object.assign(document.createElement('input'), { type: 'radio', name: 'checkMode', value: 'concurrent', checked: cur.checkMode === 'concurrent' });
        checkModeWrap.append(
            makeCheckLine(seqRadio, '顺序校验'),
            makeCheckLine(conRadio, '并发校验')
        );

        body.append(
            makeField('包含正则（匹配 标题+URL）', includeRegex),
            makeField('排除正则（匹配 标题+URL）', excludeRegex),
            makeField('允许协议（逗号分隔）', allowProtocols),
            makeField('结果链接选择器', resultLinkSelector),
            makeField('下一页按钮选择器', nextPageSelector),
            makeField('最大采集页数（自动翻页时生效）', maxPages),
            makeField('目标采集条数（0=不限）', targetCount),
            makeField('翻页等待毫秒', pageWaitMs),
            makeField('校验超时毫秒', availabilityTimeoutMs),
            makeField('最多校验条数（0=全部）', maxCheckCount),
            makeField('并发校验数', checkConcurrency)
        );

        const kwField = makeField('不可用关键字（每行一个）', unavailableKeywords);
        kwField.style.gridColumn = '1 / span 2';
        body.appendChild(kwField);

        const checkRow = document.createElement('div');
        Object.assign(checkRow.style, { gridColumn: '1 / span 2', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' });
        checkRow.append(
            makeCheckLine(dedupeByHost, '按 Host 去重'),
            makeCheckLine(autoPaginate, '自动翻页采集'),
            makeCheckLine(onlyKeepAvailable, '仅保留可用 URL')
        );
        body.appendChild(checkRow);

        // 校验触发方式单独一行
        const triggerRow = document.createElement('div');
        Object.assign(triggerRow.style, { gridColumn: '1 / span 2' });
        const triggerLabel = document.createElement('div');
        triggerLabel.textContent = '校验触发方式：';
        Object.assign(triggerLabel.style, { fontSize: '13px', color: '#333', marginBottom: '6px' });
        triggerRow.append(triggerLabel, checkTriggerWrap);
        body.appendChild(triggerRow);

        // 校验模式单独一行
        const modeRow = document.createElement('div');
        Object.assign(modeRow.style, { gridColumn: '1 / span 2' });
        const modeLabel = document.createElement('div');
        modeLabel.textContent = '校验模式：';
        Object.assign(modeLabel.style, { fontSize: '13px', color: '#333', marginBottom: '6px' });
        modeRow.append(modeLabel, checkModeWrap);
        body.appendChild(modeRow);

        const footer = document.createElement('div');
        Object.assign(footer.style, STYLES.footer);

        const resetBtn = makeBtn('恢复默认', '#a56a00', '#fff');
        resetBtn.addEventListener('click', () => {
            saveRules(DEFAULT_RULES);
            rules = getRules();
            mask.remove();
            GM_notification({ text: '已恢复默认配置', title: 'Quake URL 提取' });
        });

        const saveBtn = makeBtn('保存配置', '#16a085', '#fff');
        saveBtn.addEventListener('click', () => {
            const next = normalizeRules({
                includeRegex: includeRegex.value.trim(),
                excludeRegex: excludeRegex.value.trim(),
                allowProtocols: allowProtocols.value.split(',').map(x => x.trim()).filter(Boolean),
                dedupeByHost: dedupeByHost.checked,
                resultLinkSelector: resultLinkSelector.value.trim(),
                autoPaginate: autoPaginate.checked,
                nextPageSelector: nextPageSelector.value.trim(),
                maxPages: maxPages.value,
                targetCount: targetCount.value,
                pageWaitMs: pageWaitMs.value,
                checkTrigger: autoRadio.checked ? 'auto' : 'manual',
                checkMode: seqRadio.checked ? 'sequential' : 'concurrent',
                onlyKeepAvailable: onlyKeepAvailable.checked,
                availabilityTimeoutMs: availabilityTimeoutMs.value,
                maxCheckCount: maxCheckCount.value,
                checkConcurrency: checkConcurrency.value,
                unavailableKeywords: unavailableKeywords.value.split(/[,\r?\n]/).map(x => x.trim()).filter(Boolean)
            });

            if (next.includeRegex && !safeRegex(next.includeRegex)) return;
            if (next.excludeRegex && !safeRegex(next.excludeRegex)) return;

            saveRules(next);
            rules = next;
            GM_notification({ text: '配置已保存', title: 'Quake URL 提取' });
            mask.remove();
        });

        const closeBtn = makeBtn('关闭', '#999', '#fff');
        closeBtn.addEventListener('click', () => mask.remove());

        footer.append(resetBtn, saveBtn, closeBtn);
        panel.append(header, body, footer);
        document.body.appendChild(mask);
    }

    // ============== 导入导出 ==============
    function exportRules() {
        const text = JSON.stringify(getRules(), null, 2);
        copyToClipboard(text).then(() => {
            GM_notification({ text: '规则 JSON 已复制到剪贴板', title: 'Quake URL 提取' });
        }).catch(() => {
            console.log(text);
            GM_notification({ text: '复制失败，已输出到控制台', title: 'Quake URL 提取' });
        });
    }

    function importRules() {
        const raw = prompt('粘贴规则 JSON');
        if (!raw) return;
        try {
            const next = normalizeRules(JSON.parse(raw));
            saveRules(next);
            rules = next;
            GM_notification({ text: '导入成功', title: 'Quake URL 提取' });
        } catch (e) {
            GM_notification({ text: `JSON 格式错误：${e.message}`, title: 'Quake URL 提取' });
        }
    }

    // ============== 主流程 ==============
    async function runExtractFlow() {
        rules = getRules();

        const collected = await collectRecords(rules);
        const filtered = applyRules(collected, rules);

        let finalRecords = filtered.map(x => ({ ...x }));
        let checkedCount = 0;
        let availableCount = 0;
        let unavailableCount = 0;
        let autoCheckDone = false;

        // 自动校验模式：先弹窗显示URL，用户在弹窗中触发校验
        // 注意：不再在提取时做校验，校验完全在弹窗中进行

        const pagesCollected = finalRecords.length > 0
            ? Math.max(...finalRecords.map(x => x.page))
            : (collected.length > 0 ? Math.max(...collected.map(x => x.page)) : 0);

        showResultModal({
            allCount: collected.length,
            filteredCount: filtered.length,
            finalRecords,
            checkedCount,
            availableCount,
            unavailableCount,
            pagesCollected,
            autoCheckDone
        });
    }

    // ============== 初始化 ==============
    function addFloatingButtons() {
        const wrap = document.createElement('div');
        Object.assign(wrap.style, {
            position: 'fixed', right: '20px', bottom: '120px', zIndex: 999999,
            display: 'flex', flexDirection: 'column', gap: '8px'
        });

        const runBtn = document.createElement('button');
        runBtn.textContent = '提取URL';
        Object.assign(runBtn.style, {
            padding: '10px 14px', borderRadius: '8px', border: '1px solid #16a085',
            background: '#16a085', color: '#fff', cursor: 'pointer', fontSize: '14px'
        });
        runBtn.addEventListener('click', runExtractFlow);

        const cfgBtn = document.createElement('button');
        cfgBtn.textContent = '配置';
        Object.assign(cfgBtn.style, {
            padding: '8px 14px', borderRadius: '8px', border: '1px solid #2d7df6',
            background: '#fff', color: '#2d7df6', cursor: 'pointer', fontSize: '13px'
        });
        cfgBtn.addEventListener('click', showConfigModal);

        wrap.append(runBtn, cfgBtn);
        document.body.appendChild(wrap);
    }

    function initMenu() {
        GM_registerMenuCommand('打开配置面板', showConfigModal);
        GM_registerMenuCommand('导出规则(JSON)', exportRules);
        GM_registerMenuCommand('导入规则(JSON)', importRules);
        GM_registerMenuCommand('立即提取 URL', runExtractFlow);
    }

    // 全局错误处理
    window.addEventListener('error', e => {
        console.error('[Quake URL 提取]', e.error);
    });
    window.addEventListener('unhandledrejection', e => {
        console.error('[Quake URL 提取] 未处理的 Promise 错误', e.reason);
    });

    function init() {
        initMenu();
        addFloatingButtons();
    }

    init();
})();

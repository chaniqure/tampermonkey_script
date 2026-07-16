# FOFA Host Review Console Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 新增 FOFA Tampermonkey 脚本，跨页提取搜索结果主机（域名与 IP），聚合展示、批量打开，并由用户人工标记可用性；不发起网络探活请求。

**Architecture:** 对齐 `quake360-domain-extractor.user.js` 的单文件 IIFE：采集层读取 FOFA `hsxa-host` 结果与 Element 翻页；领域层把 host URL 聚合为资产；Shadow DOM 提供提取面板与全屏审核台。设置与审核状态用 `GM_getValue` / `GM_setValue` 持久化。

**Tech Stack:** Vanilla JavaScript、Tampermonkey GM API、Shadow DOM、Node.js 内置 `node:test`。

---

### Task 1: Add FOFA host parsing tests

**Files:**
- Create: `tests/fofa-domain-extractor.test.js`
- Create: `fofa-domain-extractor.user.js`

**Step 1:** 覆盖协议缺失 host、IP 保留、跨页聚合、HTTPS 优先、qbase64 解码、人工状态过滤。

**Step 2:** 在 `__FDX_TEST_MODE__` 下暴露纯函数 API。

**Step 3:** 运行 `node --test tests/fofa-domain-extractor.test.js`。

### Task 2: Implement FOFA page extraction and pagination

**Files:**
- Modify: `fofa-domain-extractor.user.js`

**Step 1:** 使用 `span.hsxa-host a[href]` 等选择器提取 host、标题、端口。

**Step 2:** 使用 `.hsxa-pagination button.btn-next` 翻页，并兼容 Element/Ant 备用选择器。

**Step 3:** 翻页后轮询页码与结果签名，连续两次稳定后再继续。

**Step 4:** 禁止 `fetch` / `GM_xmlhttpRequest` 可用性探测。

### Task 3: Build review UI and persistence

**Files:**
- Modify: `fofa-domain-extractor.user.js`

**Step 1:** Shadow DOM 启动器、提取面板、全屏审核台。

**Step 2:** 搜索、人工状态筛选、分页、批量打开、CSV/JSON 导出。

**Step 3:** 持久化设置与按主机键保存人工状态。

### Task 4: Validate

**Step 1:** `node --check fofa-domain-extractor.user.js`

**Step 2:** `node --test tests/fofa-domain-extractor.test.js`

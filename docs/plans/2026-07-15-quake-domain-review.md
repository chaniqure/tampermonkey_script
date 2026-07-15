# Quake Domain Review Console Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 保留仓库中的旧版 Quake URL 提取器，并新增一个不发起网络可用性请求、支持跨页域名聚合、批量打开和人工可用性标记的 Tampermonkey 脚本。

**Architecture:** 新脚本使用单文件 IIFE，采集层只负责读取当前 Quake 结果页和稳定翻页；领域层把 URL 聚合为域名资产；Shadow DOM 负责紧凑的提取面板与全屏人工审核台。人工状态和采集设置使用 `GM_getValue` / `GM_setValue` 持久化，批量访问使用 `GM_openInTab`，不使用 `fetch` 或 `GM_xmlhttpRequest`。

**Tech Stack:** Vanilla JavaScript、Tampermonkey GM API、Shadow DOM、Node.js 内置 `node:test`。

---

### Task 1: Restore the legacy script

**Files:**
- Restore: `quake360_extract_url.js`

**Step 1:** 确认该文件是当前唯一已修改的旧脚本。

**Step 2:** 从 `HEAD` 恢复 `quake360_extract_url.js`，不改动 `threatbook-asset-extractor.user.js`。

**Step 3:** 运行 `git diff -- quake360_extract_url.js`，预期无输出。

### Task 2: Add domain parsing and aggregation tests

**Files:**
- Create: `tests/quake360-domain-extractor.test.js`
- Create: `quake360-domain-extractor.user.js`

**Step 1:** 编写失败测试，覆盖：域名 URL 解析、纯 IP 排除、同域名多 URL 聚合、HTTPS 优先 URL、人工状态过滤。

**Step 2:** 运行 `node --test tests/quake360-domain-extractor.test.js`，预期在新脚本尚未暴露测试 API 时失败。

**Step 3:** 在新脚本中实现纯函数，并在 `__QDX_TEST_MODE__` 下暴露测试 API、跳过浏览器启动。

**Step 4:** 再次运行测试，预期全部通过。

### Task 3: Implement stable cross-page extraction

**Files:**
- Modify: `quake360-domain-extractor.user.js`

**Step 1:** 使用 Quake 当前结果链接选择器提取 URL、标题、页码、协议和端口。

**Step 2:** 使用 `.siem-pagination button.btn-next` 定位下一页，并兼容 Element/Ant 的备用选择器。

**Step 3:** 点击后轮询页码、结果数量和前 20 个 URL 的签名；仅在结果非空且连续两次稳定后进入下一页。

**Step 4:** 在采集阶段禁止任何 URL 可用性请求；达到最大页数、目标域名数、末页或用户停止时结束。

### Task 4: Build the manual review UI

**Files:**
- Modify: `quake360-domain-extractor.user.js`

**Step 1:** 创建 Shadow DOM 浮动入口和紧凑提取面板，显示页数、记录数、域名数与实时状态。

**Step 2:** 创建全屏域名审核台，提供搜索、人工状态筛选、分页和每页数量。

**Step 3:** 每个域名展示来源页、标题、协议/端口和关联 URL，并提供“打开网站”“待确认/可用/不可用”。

**Step 4:** 提供当前页、当前筛选结果的批量打开；打开前明确提示潜在恶意网站风险，随后用 `GM_openInTab` 后台打开实际采集 URL。

**Step 5:** 提供复制域名、CSV、JSON 导出，导出人工状态与关联信息。

### Task 5: Persist settings and reviews

**Files:**
- Modify: `quake360-domain-extractor.user.js`

**Step 1:** 持久化自动翻页、最大页数、目标域名数、翻页等待时间和结果页大小。

**Step 2:** 以小写域名为键持久化人工状态，并支持一键把当前筛选结果标记为可用、不可用或待确认。

### Task 6: Validate the implementation

**Files:**
- Validate: `quake360-domain-extractor.user.js`
- Validate: `quake360_extract_url.js`
- Validate: `tests/quake360-domain-extractor.test.js`

**Step 1:** 运行 `node --check` 检查三个 JavaScript 文件。

**Step 2:** 运行 `node --test tests/quake360-domain-extractor.test.js`。

**Step 3:** 运行 `git diff --check`。

**Step 4:** 检查新脚本不包含 `fetch`、`GM_xmlhttpRequest` 或逐条可用性校验逻辑。


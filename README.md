# Tampermonkey 资产提取脚本

面向情报 / 资产测绘平台的浏览器用户脚本集合，用于在页面内跨页采集主机、域名、IP 与 URL，支持聚合浏览、人工可用性标记、批量打开与 CSV / JSON 导出。

## 脚本一览

| 脚本 | 目标站点 | 说明 | 版本 |
|------|----------|------|------|
| [`fofa-domain-extractor.user.js`](./fofa-domain-extractor.user.js) | FOFA | 跨页采集主机（域名 + IP），采集后手动整理与审核，**不做网络探活** | 1.2.0 |
| [`quake360-domain-extractor.user.js`](./quake360-domain-extractor.user.js) | Quake 360 | 跨页提取域名，采集后手动整理与审核，**不做网络探活**（推荐） | 1.2.0 |
| [`quake360_extract_url.js`](./quake360_extract_url.js) | Quake 360 | 旧版：按 URL 采集，手动整理后可执行可用性检测 | 1.5.0 |
| [`threatbook-asset-extractor.user.js`](./threatbook-asset-extractor.user.js) | 微步 ThreatBook | 从 IP / 域名情报页采集关联资产，采集后手动整理 | 1.4.0 |

Quake 建议优先使用新版域名审核脚本；旧版 URL 脚本仍保留，适合需要自动探活的场景。

## 环境要求

- 浏览器扩展：[Tampermonkey](https://www.tampermonkey.net/)（或兼容的用户脚本管理器）
- 已登录对应平台账号，并能正常打开搜索结果 / 情报详情页

## 安装

1. 安装 Tampermonkey
2. 打开对应的 `.user.js` / `.js` 文件，或在 Tampermonkey 中新建脚本并粘贴内容
3. 保存并启用脚本
4. 打开匹配站点页面，右下角会出现悬浮入口（或通过 Tampermonkey 菜单打开）

### 匹配范围

- **FOFA**：`fofa.info` / `fofa.so`
- **Quake**：`quake.360.net` / `quake.360.cn`
- **微步**：`x.threatbook.com/v5/ip/*`、`x.threatbook.com/v5/domain/*`

## 通用能力

多数脚本共享相近工作流：

- 自动翻页采集（可配置最大页数、目标数量）
- 翻页前默认随机间隔 **1–3 秒**，降低触发限流的风险（可在设置中调整）
- 结果聚合、搜索、筛选、分页浏览
- 人工标记：待确认 / 可用 / 不可用（本地持久化）
- 批量打开站点（`GM_openInTab`，打开前有风险提示）
- 复制列表、导出 CSV / JSON
- 整理前可导出原始 JSON，便于备份或排查采集结果
- 悬浮启动器可拖动，位置本地保存

### 探活策略差异

| 脚本 | 探活方式 |
|------|----------|
| FOFA / Quake 域名审核 / 微步 | **不主动请求目标站点**，可用性由人工标记 |
| Quake 旧版 URL 提取 | 可用 `GM_xmlhttpRequest` 做可用性检测 |

## 使用提示

1. 先在目标平台完成检索或打开情报页，再点「开始提取」
2. 四个脚本在采集阶段只保存原始记录；采集结束后点击「整理结果」执行过滤、去重、聚合和排序
3. 采集过程中可随时停止；已采集的原始记录会保留，仍可手动整理
4. 大批量开页会限制单次数量（最多 30 个），避免浏览器瞬间创建过多标签页
5. 若站点改版导致选择器失效，需要同步更新脚本中的 DOM 选择器

### 大数据量优化

- 翻页必须等待结果内容变化并持续稳定，避免“页码已变、列表仍是上一页”的竞态
- 采集期不执行去重、排序、聚合或整表渲染，采集条数增加时页面负担近似线性
- 整理阶段预建搜索文本；搜索输入采用短延迟刷新，避免每个按键重复扫描和渲染
- 旧版 Quake 结果表固定每页渲染 100 行，校验结果通过 URL 索引直接更新
- CSV 导出会中和电子表格公式前缀，降低打开不可信数据时的公式注入风险

## 开发与测试

仓库为「脚本即产品」结构，无构建步骤。推荐在 `main` 分支直接开发与提交。

```bash
# 语法检查
node --check fofa-domain-extractor.user.js
node --check quake360-domain-extractor.user.js
node --check quake360_extract_url.js
node --check threatbook-asset-extractor.user.js

# 单测（纯函数）
node --test tests/fofa-domain-extractor.test.js
node --test tests/quake360-domain-extractor.test.js
```

FOFA / Quake 新版脚本在 `__FDX_TEST_MODE__` / `__QDX_TEST_MODE__` 下会暴露纯函数 API，供 Node 测试加载。

实现计划文档见 [`docs/plans/`](./docs/plans/)。

## 目录结构

```text
.
├── fofa-domain-extractor.user.js          # FOFA 主机提取与审核
├── quake360-domain-extractor.user.js      # Quake 域名提取与审核（新版）
├── quake360_extract_url.js                # Quake URL 提取与探活（旧版）
├── threatbook-asset-extractor.user.js     # 微步关联资产提取
├── tests/                                 # Node 单测
└── docs/plans/                            # 实现计划
```

## 免责声明

本仓库脚本仅供安全研究、授权资产盘点等合法用途。请遵守目标平台服务条款与当地法律法规；请勿用于未授权扫描或攻击。批量访问提取结果时，请在隔离环境中操作，并自行承担相关风险。

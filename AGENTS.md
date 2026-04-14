# AGENTS.md

## 项目定位

LiteTrace 是一个基于 Chrome Manifest V3 的浏览器扩展，目标是为英文网页提供两类翻译体验：

- 沉浸式双语阅读：扫描页面中的英文段落块，在原文后插入中文译文。
- 划词翻译：用户选中文本后弹出浮层，展示局部翻译结果。

当前主要面向简体中文用户，支持两类翻译提供商：

- Google Translate API
- OpenAI 兼容接口

## 技术栈

- TypeScript
- Vite 7
- Vitest
- Chrome Extension Manifest V3

## 常用命令

```bash
npm run build
npm run typecheck
npm test
```

开发期使用：

```bash
npm run dev
```

它会通过 `vite build --watch` 持续输出到 `dist/`，然后在 Chrome 扩展页面加载 `dist/` 目录进行调试。

## 目录说明

```text
public/
  manifest.json            Chrome 扩展清单
  icons/                   扩展图标
  brand/                   品牌资源

src/
  background.ts            Service Worker，处理消息、翻译请求、菜单、配置校验
  background-runtime.ts    当前标签页检测、content script 注入与恢复逻辑
  content.ts               页面内交互、沉浸式注入、划词弹窗、toast
  popup.ts                 扩展弹窗入口
  popup-state.ts           弹窗状态推导
  options.ts               设置页逻辑
  shared/
    types.ts               核心类型与默认配置
    settings.ts            设置清洗、校验、权限 origin 推导
    storage.ts             chrome.storage.local 读写
    providers.ts           Google / OpenAI 请求构造、解析、缓存整合
    translation-cache.ts   翻译缓存
    translation-runtime.ts 并发映射与文本归一化
    batching.ts            文本分批策略
    immersive.ts           双语阅读 DOM 注入与清理
    content-helpers.ts     页面文本块识别与分组
```

## 关键运行链路

### 1. 设置与权限

- 设置页由 `src/options.ts` 驱动。
- 配置保存前会调用 `validateSettings()` 校验。
- 不同 provider 需要不同 host 权限，统一由 `getPermissionOriginsForProvider()` 推导。
- OpenAI 兼容接口地址会经过 `normalizeOpenAIBaseUrl()` 归一化，输入可能是根地址，也可能误填到 `/chat/completions`。

### 2. 翻译请求

- 页面或划词翻译都通过 `background.ts` 统一收口。
- `providers.ts` 负责构造远程请求、解析返回值、处理异常和缓存命中。
- OpenAI 兼容接口优先要求 JSON 结构返回；解析时同时兼容 fenced code block、纯文本列表和单条文本回退。

### 3. 沉浸式阅读

- `content.ts` 负责收集页面可翻译区块。
- `shared/content-helpers.ts` 会过滤不可见、可编辑或不适合翻译的节点。
- `shared/immersive.ts` 在原文后插入译文，并支持关闭时清理。
- popup 点击后经 `background-runtime.ts` 与当前标签页通信，必要时自动补注入 content script。

### 4. 划词翻译

- 由 `content.ts` 监听选区与交互状态。
- 结果展示在页面内浮层，不走浏览器原生 tooltip。
- 失败态可能提示用户去设置页补齐 provider 配置。

## AI 修改项目时的工作约定

### 优先阅读这些文件

- 新增翻译能力或接入新 provider：先看 `src/shared/providers.ts`、`src/shared/settings.ts`、`src/shared/types.ts`
- 修改页面注入或沉浸式阅读：先看 `src/content.ts`、`src/shared/content-helpers.ts`、`src/shared/immersive.ts`
- 修改弹窗或设置页：先看 `src/popup.ts`、`src/popup-state.ts`、`src/options.ts`
- 修改当前页状态判断或注入恢复：先看 `src/background-runtime.ts`

### 修改原则

- 保持 UI 文案以中文为主，风格保持简洁直接。
- 保持 Manifest V3 兼容，不要引入依赖后台常驻页面的实现。
- 修改 provider 配置结构时，必须同步更新：
  - `src/shared/types.ts`
  - `src/shared/settings.ts`
  - `src/options.ts`
  - 必要的测试
- 修改消息类型时，必须同步更新：
  - `src/shared/types.ts`
  - 消息发送端
  - 消息接收端
- 修改构建入口时，必须同步检查：
  - `vite.config.ts`
  - `public/manifest.json`
  - 对应 HTML/TS 入口文件
- `content.js` 必须保持为可直接注入页面的单文件 classic script；不要让它依赖额外 runtime chunk，也不要让产物出现顶层 `import` / `export`。
  - 原因：Manifest `content_scripts` 与 `chrome.scripting.executeScript()` 注入的 `content.js` 会按经典脚本执行，一旦被 Vite / Rollup 抽出共享 chunk，就会在页面报 `Cannot use import statement outside a module`，随后表现成“当前页面没有成功连接 LiteTrace”。
  - 涉及 `src/content.ts`、共享工具抽取、构建拆包策略时，宁可保留少量重复实现，也优先保证 `dist/content.js` 独立可执行。

### 测试约定

- 改动共享逻辑时，优先补或改 `src/shared/*.test.ts`
- 改动后台注入、弹窗状态等逻辑时，检查：
  - `src/background-runtime.test.ts`
  - `src/popup-state.test.ts`
  - `src/shared/providers.test.ts`
- 提交前至少执行：
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - 构建后检查 `dist/content.js` 开头不含顶层 `import` / `export`

## 已知约束与注意事项

- `preferences.targetLang` 当前固定为 `zh-CN`，不少文案和流程默认是“英译中”。
- `content-helpers.ts` 对可翻译文本有长度和英文占比阈值，改动会直接影响整页命中率。
- `translation-cache.ts` 使用 `chrome.storage.local` 做缓存，存在 TTL 和最大条目数限制。
- `providers.ts` 对 LLM 返回结果做了较强的容错清洗，改动时要避免破坏已有兼容性。
- `node_modules/`、`dist/`、本地系统文件不应纳入版本管理。
- API Key 属于用户本地配置，不应写入仓库、示例代码或测试快照。

## 建议提交策略

- 小步提交，提交信息聚焦单一主题。
- 若同时改动“配置结构 + UI + provider 逻辑”，优先拆为两到三个提交。
- 提交前先确认测试通过，再提交源码与文档，不提交构建产物。

## Definition Of Done

一个改动可以认为完成，至少应满足：

- 相关源码、类型、消息链路已经同步更新
- 相关测试通过，或明确说明缺失的测试覆盖
- `typecheck`、`test`、`build` 通过
- `dist/content.js` 仍然是单文件可执行 content script，没有顶层 `import` / `export`
- 没有把 `dist/`、`node_modules/`、密钥或本地垃圾文件提交进仓库

# LiteTrace

LiteTrace 是一个基于 Chrome Manifest V3 的英文网页翻译扩展，提供两种体验：

- 沉浸式双语阅读：扫描页面中的英文正文块，在原文后插入中文译文
- 划词翻译：选中文本后，在页面内弹出中文结果

当前主要面向简体中文用户，支持两类翻译提供商：

- Google Translate API
- OpenAI 兼容接口

## 特性

- 沉浸式段落级双语阅读
- 页内划词翻译，不依赖浏览器原生 tooltip
- Google / OpenAI 兼容 provider 切换
- 翻译缓存、失败重试、兼容模式回退
- Chrome Manifest V3 兼容

## 本地开发

```bash
npm install
npm run dev
```

开发时会持续输出到 `dist/`，然后在 Chrome 扩展管理页加载 `dist/` 目录调试。

常用命令：

```bash
npm run typecheck
npm test
npm run build
```

## 发布前检查

推荐直接执行：

```bash
npm run release:check
```

它会依次执行：

- `npm run typecheck`
- `npm test`
- `npm run build`
- 构建产物校验

当前构建产物校验会重点检查：

- `package.json` 与 `public/manifest.json` 版本号一致
- `dist/background.js`、`dist/content.js`、`dist/popup.html`、`dist/options.html` 存在
- `public/manifest.json` 仍然声明 `content.js` 为 content script
- `dist/content.js` 不包含顶层 `import` / `export`

最后一条是发布红线：Chrome 会把 content script 按 classic script 执行。如果 `dist/content.js` 被打成模块脚本，就会直接报 `Cannot use import statement outside a module`，随后表现成“当前页面没有成功连接 LiteTrace”。

## 配置说明

- Google 模式需要用户自己的 Google Translate API Key
- OpenAI 兼容模式需要 Base URL、模型名和 API Key
- 配置保存在用户本地的 `chrome.storage.local`

## 隐私说明

- LiteTrace 不在仓库中存储用户 API Key
- 用户选中的文本或页面中待翻译的英文内容，只会发送到用户自己配置的翻译提供商
- 详细说明见 [PRIVACY.md](./PRIVACY.md)

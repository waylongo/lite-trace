# LiteTrace Privacy

LiteTrace 本身不提供云端账户系统，也不在项目仓库中收集用户 API Key。

## 我们处理什么数据

- 用户在设置页填写的翻译接口配置
  - Google Translate API Key
  - OpenAI 兼容接口 Base URL
  - 模型名
  - API Key
- 用户主动触发翻译时的文本
  - 当前页面中被识别出的英文正文块
  - 用户手动选中的英文文本

## 数据存储在哪里

- 配置和翻译缓存保存在用户本地浏览器的 `chrome.storage.local`
- 仓库代码和默认配置中不会写入任何用户密钥

## 数据发送给谁

- 翻译请求只会发送到用户自己选择并配置的翻译提供商
- 当前支持：
  - Google Translate API
  - OpenAI 兼容接口

## LiteTrace 不做什么

- 不把用户 API Key 上传到 LiteTrace 自有服务器
- 不建立 LiteTrace 平台账号体系
- 不把翻译内容写入仓库、示例代码或测试快照

## 使用前请注意

- 当用户开启沉浸式阅读或划词翻译时，待翻译文本会发送到所选 provider 进行处理
- 不同 provider 可能有各自独立的日志、保留、合规和隐私策略，使用前应自行确认

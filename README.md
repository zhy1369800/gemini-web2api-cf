# gemini-web2api
[Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api/) 的 cf wokers 版本

# gemini-web2api

将 Google Gemini 网页端转换为 OpenAI 兼容 API. 零认证, 零成本, 跨平台.

## 特性

- **可选密钥**: `api_keys` 为空时免密, 填入密钥后按 OpenAI Bearer Key 校验
- **OpenAI 兼容**: 直接替换 `/v1/chat/completions` 和 `/v1/models`
- **工具调用**: 完整的 Function Calling 支持 (OpenAI 格式)
- **多模型**: Flash, Flash Thinking (2万字+输出), Pro, Auto, Lite
- **思考深度**: 通过 `@think=N` 后缀调节 (0=最深, 4=最浅)
- **联网搜索**: 内置互联网访问 (Gemini 原生搜索能力)
- **跨平台**: 纯 Python, 无外部依赖
- **流式输出**: SSE Streaming 支持
- **Codex CLI**: Responses API (`/v1/responses`) 兼容 OpenAI Codex
- **Gemini CLI**: Google 原生 API (`/v1beta/models`) 兼容 Gemini CLI

## 快速开始

复制 worker.js 内容 直接部署

其他特性请参考原项目


## 已知限制

- **不支持图片/多模态输入**: Gemini 的图片上传需要专有的 WIZ streaming RPC 协议 (ProcessFile), 无法在标准 HTTP 代理中实现. 发送图片会被忽略并返回提示.
- **Pro/Ultra 非真实路由**: 无付费订阅 cookie 时, `gemini-3.1-pro` 实际路由到 Flash 模型. "Pro" 只是 UI 偏好标签.
- **单轮对话**: 每次请求是独立对话, 多轮上下文通过在 prompt 中包含历史消息模拟.
- **频率限制**: Google 可能限制高频请求, server 会自动重试但持续高负载可能被封.

## 系统要求

- Python 3.8+
- 无外部依赖 (仅标准库)
- 需要能访问 `gemini.google.com` (部分地区需代理)

## 工作原理

逆向 Google Gemini 网页端的 StreamGenerate 协议, 将 OpenAI API 格式与 Gemini 内部 protobuf-like 格式互转. 模型选择通过请求 payload 的 `[79]` 字段控制, 映射自 Gemini 前端 JS 源码中的 `MODE_CATEGORY` 枚举.

## 致谢
- [Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api/)
- [linux.do](https://linux.do) 社区
- 开源 API 代理生态

## License

MIT

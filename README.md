# Custom GPT Web

一个模块化 TypeScript 全栈项目：前端是 ChatGPT 风格聊天窗口，后端可选择代理 OpenAI/OpenAI 兼容 API，或通过 Codex CLI app-server 适配层处理文本对话，支持上传附件、图片生成、文件下载和本地数据整理。

## 功能

- TypeScript 前端与 TypeScript Node/Express 后端。
- 用户可在网页中和 GPT 对话，并直接看到回复。
- 支持本地账号密码注册和登录，登录保活默认 7 天。
- 支持按用户隔离的历史对话记忆，左侧栏可选择历史会话。
- 支持上传图片、PDF、文本、Markdown、CSV、JSON 和常见代码文件给 AI 分析。
- 支持对最新新闻、体育赛果、价格、天气等时间敏感问题自动联网搜索，并把来源交给模型整理回答。
- 当用户要求生成图片时，后端调用图片生成接口并把 PNG/JPG/WebP 图片保存到本地，前端直接预览并提供下载。
- 当用户要求生成文件时，后端生成 Markdown 文档并提供下载链接。
- 三套主题：白色、宝石蓝、黑色。用户气泡、助手气泡、输入框和面板颜色都有显式区分。
- 输入框右下角提供模型选择和暂停/继续控件。
- 复杂数据任务会让模型生成受限 JavaScript 代码，并在本地沙箱中执行整理/统计，结果可下载。

## 快速开始

```bash
npm install
npm run dev
```

默认地址：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:8787`

默认只监听 `127.0.0.1`，避免开发环境暴露到局域网。

## 环境变量

复制 `.env.example` 为 `.env`，并配置：

```ini
OPENAI_BASE_URL=https://www.ai-dingyue.com
AI_TEXT_RUNTIME=openai
OPENAI_TEXT_API=responses
OPENAI_DEFAULT_MODEL=gpt-5.5
OPENAI_MODELS=gpt-5.5,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna
OPENAI_REASONING_EFFORT=xhigh

CODEX_COMMAND=codex
CODEX_AUTH_MODE=user-api-key
CODEX_CONFIG_TEMPLATE=
CODEX_MODEL_PROVIDER=OpenAI
CODEX_PROVIDER_BASE_URL=https://www.ai-dingyue.com
CODEX_API_KEY_ENV=OPENAI_API_KEY
CODEX_WIRE_API=responses
CODEX_SUPPORTS_WEBSOCKETS=false
CODEX_RESPONSES_WEBSOCKETS_V2=false
CODEX_REQUIRES_OPENAI_AUTH=false
CODEX_DISABLE_RESPONSE_STORAGE=true
CODEX_NETWORK_ACCESS=enabled
CODEX_FEATURE_GOALS=true
CODEX_DEFAULT_MODEL=gpt-5.5
CODEX_MODELS=gpt-5.5,gpt-5-codex,gpt-5.1,gpt-5
CODEX_REASONING_EFFORT=xhigh
CODEX_TIMEOUT_MS=300000
CODEX_WORKING_DIR=.
CODEX_SANDBOX=read-only
CODEX_APPROVAL_POLICY=on-request

OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_SIZE=1024x1024
OPENAI_IMAGE_EDIT_SIZE=1024x1536
OPENAI_IMAGE_QUALITY=high
OPENAI_IMAGE_FORMAT=png

REQUEST_BODY_LIMIT=35mb
SERVER_TIMEOUT_MS=600000
SERVER_HEADERS_TIMEOUT_MS=630000
SERVER_KEEP_ALIVE_TIMEOUT_MS=65000
MAX_UPLOAD_FILES=5
MAX_UPLOAD_BYTES=10485760
MAX_EXTRACTED_TEXT_CHARS=12000
MAX_RAW_EXTRACTED_TEXT_CHARS=300000
MAX_ATTACHMENT_CONTEXT_CHARS=80000
ATTACHMENT_CONTEXT_CHUNK_CHARS=2800
ATTACHMENT_CONTEXT_OVERLAP_CHARS=180
UPLOAD_IMAGE_MODE=ocr
IMAGE_OCR_COMMAND=tesseract
IMAGE_OCR_LANG=chi_sim+eng
IMAGE_OCR_TIMEOUT_MS=30000
IMAGE_OCR_SLICE_TIMEOUT_MS=15000
IMAGE_OCR_PSM=6
IMAGE_OCR_CONCURRENCY=1
IMAGE_OCR_PYTHON_COMMANDS=python3,python
IMAGE_OCR_SCALE=3
IMAGE_OCR_SLICE_HEIGHT=1800
IMAGE_OCR_MAX_SLICES=12
PDF_RENDER_COMMAND=pdftoppm
PDF_OCR_DPI=180
PDF_OCR_MAX_PAGES=16
PDF_OCR_RENDER_TIMEOUT_MS=60000
AUTH_TOKEN_TTL_HOURS=168
AUTH_MODE=free
DOMINANT_USERS_FILE=a.json

ENABLE_WEB_SEARCH=true
WEB_SEARCH_PROVIDER=auto
WEB_SEARCH_MAX_RESULTS=5
OPENAI_WEB_SEARCH_TOOL=false
SERPER_API_KEY=
BRAVE_SEARCH_API_KEY=
TAVILY_API_KEY=
```

OpenAI API key 不再配置在 `.env` 中，而是按登录模式保存：`AUTH_MODE=dominant` 时读写根目录 `a.json`，`AUTH_MODE=free` 时读写 `storage/auth/users.json`。如果当前用户记录里没有 `openaiApiKey`，登录后页面会要求输入；用户可重复输入并覆盖旧 key。
每个用户都会有独立 `uid`，格式是 `u` 加 6 位随机数字，例如 `u123456`。后端会确保它不和 `a.json`、`storage/auth/users.json` 中已有 uid 重复，并优先按 uid 检索该用户的账号、密码信息和 `openaiApiKey`。

`AI_TEXT_RUNTIME=openai` 时，文本对话走 `OPENAI_BASE_URL`，适合官方 OpenAI 或 OpenAI-compatible 第三方代理。`AI_TEXT_RUNTIME=codex` 时，普通文本对话、生成文件和复杂数据代码生成会走本机 `codex app-server --listen stdio://`，网页模型下拉会显示 `CODEX_MODELS`。Codex 模式下的 provider 由 `CODEX_PROVIDER_BASE_URL`、`CODEX_WIRE_API`、`CODEX_SUPPORTS_WEBSOCKETS` 等变量生成到每个用户自己的 `storage/users/<user>/codex-home/config.toml`；如果设置了 `CODEX_CONFIG_TEMPLATE`，则直接复制该模板文件。

默认 `CODEX_AUTH_MODE=user-api-key`：每个网页登录用户都必须在页面配置自己的 API key；后端会为不同用户启动独立 Codex app-server 子进程，并把该用户的 key 注入为 `OPENAI_API_KEY`，同时在用户专属 `config.toml` 中写入 `env_key = "OPENAI_API_KEY"` 和 `requires_openai_auth = false`，避免 Codex 去查找服务器登录态。这个 key 需要和 `CODEX_PROVIDER_BASE_URL` 指向的服务匹配：官方 OpenAI base URL 用官方 key，第三方 Codex-compatible 中转站 base URL 用该中转站的 key。生成图片、上传图片/PDF/文件也会继续使用该用户自己的 OpenAI API key。

如果你确实想让所有用户共用服务器上的 `codex login` 状态，可以改成 `CODEX_AUTH_MODE=server-login`。这种模式运维简单，但不适合按用户分账或隔离。

使用 Codex 文本运行时前，先在服务器确认：

```bash
codex --version
codex app-server --help
```

如果这两个命令不能运行，请先安装 Codex CLI。默认用户 API key 模式不需要在服务器执行 `codex login`，但每个网页用户需要在页面保存自己的 API key。然后把 `.env` 中设置为：

```ini
AI_TEXT_RUNTIME=codex
CODEX_COMMAND=codex
CODEX_AUTH_MODE=user-api-key
CODEX_MODEL_PROVIDER=OpenAI
CODEX_PROVIDER_BASE_URL=https://www.ai-dingyue.com
CODEX_API_KEY_ENV=OPENAI_API_KEY
CODEX_WIRE_API=responses
CODEX_SUPPORTS_WEBSOCKETS=true
CODEX_RESPONSES_WEBSOCKETS_V2=true
CODEX_REQUIRES_OPENAI_AUTH=false
CODEX_DEFAULT_MODEL=gpt-5.5
CODEX_REASONING_EFFORT=xhigh
CODEX_SANDBOX=read-only
CODEX_APPROVAL_POLICY=on-request
```

`OPENAI_BASE_URL` 要填写完整 API 根地址，例如官方 OpenAI 是 `https://api.openai.com/v1`。想获得最佳回答质量、官方联网搜索和 reasoning 能力，推荐使用官方 OpenAI API 并保持 `OPENAI_TEXT_API=responses`。如果你接入的是只兼容 Chat Completions 的第三方服务，可改为 `chat`，但上传图片、PDF 或文件给 AI 时必须使用 `OPENAI_TEXT_API=responses`，且上游服务需要支持 `input_image` / `input_file`。

如果上传后返回 `Upstream request failed`，通常是第三方转发服务不支持 Responses 文件输入、模型不支持视觉/文件能力，或 `OPENAI_BASE_URL` 缺少 `/v1` 这类路径。

联网搜索默认会在问题包含“最新、今天、现在、新闻、赛程、赛果、比分、世界杯”等时间敏感词时触发。`WEB_SEARCH_PROVIDER=auto` 会优先使用已配置 API key 的搜索服务，然后尝试 DuckDuckGo 兜底。生产环境更推荐配置 `SERPER_API_KEY`、`BRAVE_SEARCH_API_KEY` 或 `TAVILY_API_KEY` 中的一个；如果使用官方 OpenAI Responses API，可保留 `OPENAI_WEB_SEARCH_TOOL=true` 让模型同时使用 OpenAI 托管搜索工具。第三方 OpenAI 代理不支持该工具时，把它改为 `false`。

## 登录模式

`AUTH_MODE=free` 是默认模式，用户可以在网页自行注册和登录，账号信息保存在 `storage/auth/users.json`。该文件支持旧数组格式，也支持 uid-keyed map 格式；写回时会统一为 uid-keyed map，例如：

```json
{
  "u123456": {
    "id": "u123456",
    "username": "alice",
    "passwordHash": "...",
    "salt": "...",
    "createdAt": "2026-08-03T00:00:00.000Z",
    "openaiApiKey": "",
    "openaiBaseUrl": "https://www.ai-dingyue.com"
  }
}
```

`AUTH_MODE=dominant` 是白名单模式，网页会隐藏注册入口，只有项目根目录 `a.json` 中配置的账号密码可以登录。`a.json` 已加入 `.gitignore`，不会被提交到 GitHub。可先复制示例文件：

```bash
cp a.example.json a.json
```

`a.json` 使用 uid-keyed map 格式：

```json
{
  "u000001": {
    "username": "admin",
    "password": "your-strong-password",
    "openaiApiKey": "",
    "openaiBaseUrl": "https://www.ai-dingyue.com"
  }
}
```

旧数组格式或 `{ "users": [...] }` 对象格式仍可读取，但后端写回时会统一迁移为 uid-keyed map：

```json
{
  "u000001": {
    "username": "admin",
    "password": "your-strong-password",
    "openaiApiKey": "",
    "openaiBaseUrl": "https://www.ai-dingyue.com"
  }
}
```

每个 dominant 账号仍会按用户隔离保存历史对话。默认用户目录现在使用 `uid`，例如 `storage/users/u123456/`；如果旧账号没有 `uid`，后端会自动补一个不重复的 uid。

`openaiApiKey` 可以为空。为空时，用户登录后在网页中输入自己的 key；`dominant` 模式会写回 `a.json`，`free` 模式会写回 `storage/auth/users.json`，再次输入会覆盖旧 key。若某个用户需要单独使用第三方中转地址，可在该 uid 下添加 `openaiBaseUrl`（也兼容 `baseUrl` / `apiBaseUrl`），例如 `"openaiBaseUrl": "https://www.ai-dingyue.com"`；未配置时回退 `.env` 的 `OPENAI_BASE_URL`。
`AUTH_MODE=free` 下用户自行注册时，后端会在 `storage/auth/users.json` 里生成唯一 uid，并保存账号名、密码哈希、salt、`openaiApiKey` 和 `openaiBaseUrl`。free 模式不会再把用户配置同步到 `a.json`；`a.json` 和 `storage/auth/users.json` 中的 uid 仍共享同一个唯一命名空间，不能重复。

## Ubuntu 运行

安装 Node.js 20+：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
```

安装上传解析依赖：

```bash
sudo apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng python3-pil
```

部署项目：

```bash
cd /opt
sudo git clone <your-repo-url> custom-gpt-web
sudo chown -R $USER:$USER /opt/custom-gpt-web
cd /opt/custom-gpt-web
npm install
cp .env.example .env
nano .env
```

生产构建和启动：

```bash
npm run build
NODE_ENV=production HOST=0.0.0.0 PORT=8787 npm start
```

访问：

```text
http://服务器公网IP:8787
```

如果云服务器有安全组或防火墙，需要放行 `8787` 端口。更正式的生产环境建议用 Nginx 反向代理到 `127.0.0.1:8787`，并用 PM2 或 systemd 保持进程常驻。

## PM2 常驻运行

```bash
sudo npm install -g pm2
pm2 start npm --name custom-gpt-web -- start
pm2 save
pm2 startup
```

如果使用 PM2，建议在 `.env` 中设置：

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
```

## 生产构建

```bash
npm run build
npm start
```

生产模式下，Express 会同时托管 `dist/client` 静态资源和 `/api`、`/downloads` 接口。

## 项目结构

```text
src/
  client/          # 前端界面、状态、API 调用、主题
  server/          # Express 服务、路由和业务模块
  shared/          # 前后端共享类型
storage/generated/ # 运行时生成的图片、文件和数据结果
storage/auth/      # 本地账号哈希
storage/users/     # 按用户隔离的 gzip 压缩历史对话
```

## 安全说明

本地数据任务执行器运行在 Node `vm` 沙箱里，并阻止 `require`、`import`、`process`、`fs`、`child_process` 等危险入口。它适合轻量数据整理/统计，不适合执行不可信的复杂程序。可通过 `ENABLE_LOCAL_CODE_EXECUTION=false` 关闭。

账号密码和历史对话都存储在本机 `storage/` 下，`storage/` 已加入 `.gitignore`，不会被提交到远程仓库。

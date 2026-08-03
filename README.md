# Custom GPT Web

一个模块化 TypeScript 全栈项目：前端是 ChatGPT 风格聊天窗口，后端代理 OpenAI 或 OpenAI 兼容 API，支持文字对话、上传附件、图片生成、文件下载和本地数据整理。

## 功能

- TypeScript 前端与 TypeScript Node/Express 后端。
- 用户可在网页中和 GPT 对话，并直接看到回复。
- 支持本地账号密码注册和登录，登录保活默认 120 小时。
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
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_TEXT_API=responses
OPENAI_DEFAULT_MODEL=gpt-5.6-sol
OPENAI_MODELS=gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna
OPENAI_REASONING_EFFORT=high

OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_SIZE=1024x1024
OPENAI_IMAGE_QUALITY=auto
OPENAI_IMAGE_FORMAT=png

REQUEST_BODY_LIMIT=35mb
MAX_UPLOAD_FILES=5
MAX_UPLOAD_BYTES=10485760
AUTH_TOKEN_TTL_HOURS=120
AUTH_MODE=free
DOMINANT_USERS_FILE=a.json

ENABLE_WEB_SEARCH=true
WEB_SEARCH_PROVIDER=auto
WEB_SEARCH_MAX_RESULTS=5
OPENAI_WEB_SEARCH_TOOL=true
SERPER_API_KEY=
BRAVE_SEARCH_API_KEY=
TAVILY_API_KEY=
```

OpenAI API key 不再配置在 `.env` 中，而是按用户保存在根目录 `a.json`。如果 `a.json` 中没有某个用户的 `openaiApiKey`，该用户登录后页面会要求输入；用户可重复输入并覆盖旧 key。

`OPENAI_BASE_URL` 要填写完整 API 根地址，例如官方 OpenAI 是 `https://api.openai.com/v1`。想获得最佳回答质量、官方联网搜索和 reasoning 能力，推荐使用官方 OpenAI API 并保持 `OPENAI_TEXT_API=responses`。如果你接入的是只兼容 Chat Completions 的第三方服务，可改为 `chat`，但上传图片、PDF 或文件给 AI 时必须使用 `OPENAI_TEXT_API=responses`，且上游服务需要支持 `input_image` / `input_file`。

如果上传后返回 `Upstream request failed`，通常是第三方转发服务不支持 Responses 文件输入、模型不支持视觉/文件能力，或 `OPENAI_BASE_URL` 缺少 `/v1` 这类路径。

联网搜索默认会在问题包含“最新、今天、现在、新闻、赛程、赛果、比分、世界杯”等时间敏感词时触发。`WEB_SEARCH_PROVIDER=auto` 会优先使用已配置 API key 的搜索服务，然后尝试 DuckDuckGo 兜底。生产环境更推荐配置 `SERPER_API_KEY`、`BRAVE_SEARCH_API_KEY` 或 `TAVILY_API_KEY` 中的一个；如果使用官方 OpenAI Responses API，可保留 `OPENAI_WEB_SEARCH_TOOL=true` 让模型同时使用 OpenAI 托管搜索工具。第三方 OpenAI 代理不支持该工具时，把它改为 `false`。

## 登录模式

`AUTH_MODE=free` 是默认模式，用户可以在网页自行注册和登录，账号信息保存在 `storage/auth/users.json`。

`AUTH_MODE=dominant` 是白名单模式，网页会隐藏注册入口，只有项目根目录 `a.json` 中配置的账号密码可以登录。`a.json` 已加入 `.gitignore`，不会被提交到 GitHub。可先复制示例文件：

```bash
cp a.example.json a.json
```

`a.json` 支持数组格式：

```json
[
  {
    "username": "admin",
    "password": "your-strong-password",
    "openaiApiKey": ""
  }
]
```

也支持对象格式：

```json
{
  "users": [
    {
      "username": "admin",
      "password": "your-strong-password",
      "openaiApiKey": ""
    }
  ]
}
```

每个 dominant 账号仍会按用户隔离保存历史对话。默认用户目录由账号名稳定生成，例如 `storage/users/dominant_xxx/`；如果你想固定历史目录，也可以给账号显式设置 `"id"`，之后只要这个 `id` 不变，历史会话就会继续归入同一目录。

`openaiApiKey` 可以为空。为空时，用户登录后在网页中输入自己的 key，后端会写回 `a.json`；再次输入会覆盖旧 key。

## Ubuntu 运行

安装 Node.js 20+：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
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

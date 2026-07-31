# Custom GPT Web

一个模块化 TypeScript 全栈项目：前端是 ChatGPT 风格聊天窗口，后端代理 OpenAI 或 OpenAI 兼容 API，支持文字对话、上传附件、图片生成、文件下载和本地数据整理。

## 功能

- TypeScript 前端与 TypeScript Node/Express 后端。
- 用户可在网页中和 GPT 对话，并直接看到回复。
- 支持本地账号密码登录；新账号会自动创建。
- 支持按用户隔离的历史对话记忆，左侧栏可选择历史会话。
- 支持上传图片、PDF、文本、Markdown、CSV、JSON 和常见代码文件给 AI 分析。
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
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_TEXT_API=responses
OPENAI_DEFAULT_MODEL=gpt-5.6-sol
OPENAI_MODELS=gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna

OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_SIZE=1024x1024
OPENAI_IMAGE_QUALITY=auto
OPENAI_IMAGE_FORMAT=png

REQUEST_BODY_LIMIT=35mb
MAX_UPLOAD_FILES=5
MAX_UPLOAD_BYTES=10485760
```

`OPENAI_TEXT_API` 默认使用 Responses API；如果你接入的是只兼容 Chat Completions 的第三方服务，可改为 `chat`。上传图片、PDF 或文件给 AI 时必须使用 `OPENAI_TEXT_API=responses`。

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

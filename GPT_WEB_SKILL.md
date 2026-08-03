---
name: gpt-web-builder
description: Use this skill when building, maintaining, deploying, or debugging this TypeScript AI Web project: ChatGPT-like web UI, per-user login and API keys, image/file generation, uploads, conversation history, themes, and Codex CLI app-server integration for high-quality web-enabled answers.
---

# GPT Web Builder Skill

Use this file as the first context document in a fresh ChatGPT/Codex session when continuing this project.

## Project Goal

Build and maintain a modular TypeScript AI web app with:

- ChatGPT-style chat UI where users can send messages and see assistant replies.
- Image generation shown inline as PNG/JPG/WebP.
- File generation with clickable downloads.
- Upload support for images, PDFs, and text-like files.
- White, sapphire, and black themes with visibly distinct user/assistant bubbles.
- Model selector and pause/resume controls near the composer.
- Login/register, 7-day session keepalive, per-user identity.
- Per-user compressed conversation history shown in the left sidebar.
- Per-user API key storage, with keys loaded from local config instead of `.env`.
- Optional Codex CLI `app-server` runtime for higher-quality reasoning, web access, code execution planning, and source-grounded answers.

## Repository Shape

Expected layout:

```text
src/client/                 Frontend TypeScript, state, render, CSS, API client
src/server/                 Express backend, routes, config, services
src/shared/                 Shared request/response/user/message types
storage/auth/users.json     Free-mode registered users, uid-keyed map
storage/auth/sessions.json  Hashed auth sessions
storage/users/<uid>/        Per-user history and Codex home
storage/generated/          Generated downloadable files/images
a.json                      Root local user/API-key file, uid-keyed map, ignored by git
.env                        Runtime config, ignored by git
.env.example                Documented config template
```

Important commands:

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm start
```

On Windows PowerShell, if `npm run dev` is blocked by execution policy, use:

```powershell
npm.cmd run dev
```

## Core Configuration

Keep secrets out of git. Store them in `.env` and `a.json`.

Recommended high-quality text mode:

```ini
AI_TEXT_RUNTIME=codex
CODEX_COMMAND=codex
CODEX_AUTH_MODE=user-api-key
CODEX_MODEL_PROVIDER=OpenAI
CODEX_PROVIDER_BASE_URL=https://api.openai.com/v1
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
```

For third-party Codex-compatible providers, set `CODEX_PROVIDER_BASE_URL` to the provider base URL and make sure each user's saved key matches that provider.

For file/image upload through the direct OpenAI-compatible client:

```ini
OPENAI_TEXT_API=responses
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_FORMAT=png
```

Third-party providers may not support Responses `web_search`, `input_image`, or `input_file`; keep error messages explicit when those features fail.

## Auth And User Storage

Support two login modes:

- `AUTH_MODE=free`: users register themselves.
- `AUTH_MODE=dominant`: only accounts in root `a.json` can log in; hide registration in the UI.

Both `a.json` and `storage/auth/users.json` should use uid-keyed maps:

```json
{
  "u123456": {
    "username": "alice",
    "passwordHash": "...",
    "salt": "...",
    "openaiApiKey": ""
  }
}
```

Rules:

- Every user has a stable `uid`.
- UID format is `u` plus six digits, for example `u123456`.
- New registrations generate a UID that is unique across both `a.json` and `users.json`.
- Prefer UID lookups over username/id lookups.
- Free users should sync into `a.json` without storing plaintext passwords.
- Dominant users may have plaintext `password` for local bootstrap, but prefer hashes when possible.
- Sessions should store token hashes, not raw tokens, and default to 7 days / 168 hours.

## Per-User API Keys

Do not put user API keys in `.env`.

Implement this flow:

1. User logs in.
2. Backend checks whether that user's `a.json` entry has `openaiApiKey`.
3. If empty, frontend shows an API-key panel and requires the user to save a key.
4. User can save again to overwrite the old key.
5. Backend retrieves keys by UID.
6. For Codex runtime, spawn/use Codex app-server with that user's key injected as `OPENAI_API_KEY`.

Never log raw keys. If logging is needed, log only a short hash fingerprint.

## Codex CLI App-Server Adapter

Use Codex app-server for text tasks when `AI_TEXT_RUNTIME=codex` and there are no uploaded attachments.

Adapter behavior:

- Spawn `codex app-server --listen stdio://`.
- In `user-api-key` mode, prepare a per-user `CODEX_HOME` under `storage/users/<uid>/codex-home`.
- Generate `config.toml` per user unless `CODEX_CONFIG_TEMPLATE` is set.
- In generated `config.toml`, set:
  - `model_provider`
  - `model`
  - `review_model`
  - `model_reasoning_effort = "xhigh"`
  - `disable_response_storage = true`
  - `network_access = "enabled"`
  - `[model_providers.<provider>]`
  - `base_url`
  - `wire_api = "responses"`
  - `requires_openai_auth = false` in user-api-key mode
  - `env_key = "OPENAI_API_KEY"` in user-api-key mode
  - `supports_websockets = true` only when the provider supports it
  - `[features] responses_websockets_v2 = true` only when needed
- Spawn env must include:
  - `OPENAI_API_KEY=<current user's key>`
  - the configured `CODEX_API_KEY_ENV=<current user's key>`
  - `CODEX_HOME=<per-user codex home>`
- Pool clients by `uid + key fingerprint`.
- If a user updates their API key, stop the old process and start a new client.

Critical quality fix:

- `turn/start.sandboxPolicy.networkAccess` must follow `CODEX_NETWORK_ACCESS`.
- Do not hardcode `networkAccess: false`.
- When Codex network is enabled, do not inject local web-search snippets into the prompt. Let Codex inspect primary sources directly.
- Only use local search-context injection as a fallback when Codex network is disabled or the direct OpenAI runtime is in use.

Good Codex system addendum:

```text
For current, time-sensitive, or source-dependent questions, use available network access to inspect authoritative primary sources directly before answering.
Do not treat search snippets or page metadata as complete evidence when the user asks for complete results, tables, prices, laws, schedules, or other detailed facts.
If an official source is dynamic, continue by fetching structured page data, linked report pages, public APIs, or other authoritative pages that contain the actual data.
Answer with the best complete result you can verify, include source links, and clearly separate verified facts from uncertainty.
```

This prevents low-quality answers such as "the snippets do not contain the data" when Codex could open FIFA, official docs, APIs, reports, or structured page data itself.

## Direct OpenAI-Compatible Runtime

Use the direct client for:

- Uploaded images/PDF/files.
- Image generation.
- Text mode when `AI_TEXT_RUNTIME=openai`.
- Fallback cases where Codex cannot process the request.

Responses API is required for uploads. Chat Completions mode cannot process `input_image` / `input_file`.

When `OPENAI_WEB_SEARCH_TOOL=true`, hosted web search may fail on third-party providers. Catch upstream `web_search` failures and retry with local search context rather than crashing or truncating HTTP responses.

## Conversation History

Store history per user:

```text
storage/users/<uid>/conversations/index.json
storage/users/<uid>/conversations/<conversationId>.json.gz
```

Use compact storage:

- Strip uploaded file `dataUrl` payloads before saving.
- Keep generated file/image URLs and descriptions.
- Gzip each conversation JSON with high compression.
- Keep a small `index.json` for sidebar summaries.
- Sort sidebar by `updatedAt` descending.

All history access must require auth and resolve user directory by UID.

## Complex Data Questions

Default behavior for complex data questions:

- First answer with web research and source-grounded reasoning.
- Do not auto-run local code just because the user mentions statistics, highest/lowest price, volatility, CSV, table, or analysis.
- Enter local code/data mode only when the user explicitly asks for code execution, API retrieval, exact calculation, saved code, or a precise value after being dissatisfied with a research answer.
- Keep the intent detector narrow. Good triggers include `用代码`, `运行代码`, `精确计算`, `精确值`, `调用接口`, `拉取数据`, `fetch data`, `run code`, `execute code`, and API phrases tied to retrieval/calculation. Avoid broad triggers such as bare `api`, `统计`, or `计算`.
- If local code mode runs, allow HTTPS-only `fetch` in the sandbox for public APIs, keep blocked tokens such as `import`, `require`, `process`, `fs`, `child_process`, `eval`, and `Function`, and wrap generated code in an async function so `await fetch(...)` works.
- Save generated code and output under:

```text
storage/users/<uid>/code-runs/<conversationId>/
```

Do not delete generated code after answering. Include the saved path in the assistant response and in the downloadable data-result attachment.

Frontend API parsing should read response text first, then parse JSON when present. This prevents empty 503/502 responses from surfacing as misleading `Unexpected end of JSON input` errors.

## Uploads And Mobile UI

Upload support should cover:

- `image/*`
- `.pdf`
- `.txt`, `.md`, `.csv`, `.json`, code/text-like files

Frontend requirements:

- Show pending uploads before sending.
- Show image thumbnails where possible.
- Show clear PDF/file chips for non-images.
- Allow removing pending uploads.
- Keep upload controls responsive on narrow mobile screens.
- Do not let composer controls overflow.

Backend requirements:

- Validate file count and size.
- Validate supported MIME/extension.
- Normalize attachment kind as `image`, `pdf`, or `file`.
- Reject uploads when `OPENAI_TEXT_API` is not `responses`.

## Frontend Product Requirements

Build the actual app as the first screen, not a landing page.

Required UI:

- Left conversation sidebar.
- Main chat window.
- Login page and register page separated.
- In `dominant` mode, hide register.
- Theme buttons for white, sapphire, black.
- Visibly distinct user and assistant bubbles in every theme.
- Account balance display removed.
- Top/right or composer-adjacent user/API-key controls.
- Bottom composer with upload button, model selector, pause/resume, and send.
- Generated images render inline.
- Generated files render as download links.

Use stable dimensions for toolbar buttons, upload chips, and composer controls so mobile layout does not jump.

## Deployment On Ubuntu

Check Node/npm:

```bash
node -v
npm -v
```

Install dependencies and build:

```bash
npm install
npm run build
npm start
```

If `tsc: not found`, dependencies were not installed or dev dependencies were omitted. Run:

```bash
npm install
npm run build
```

For public server access:

```ini
HOST=0.0.0.0
PORT=5000
CORS_ORIGIN=http://<server-ip>:5000
```

Then browse:

```text
http://<server-ip>:5000/
```

If using PM2:

```bash
npm install -g pm2
npm run build
pm2 start npm --name my-agent-web -- start
pm2 save
```

After changing Codex config or API-key handling, restart the whole Node process so old Codex app-server children exit.

## Ubuntu Codex CLI Notes

Install and verify Codex CLI before using `AI_TEXT_RUNTIME=codex`:

```bash
codex --version
codex app-server --help
```

If Codex reports missing bubblewrap:

```bash
sudo apt update
sudo apt install -y bubblewrap
```

In `CODEX_AUTH_MODE=user-api-key`, the server does not need `codex login` for each web user. Each user's saved key is injected into their own Codex process.

If app-server returns `401 API_KEY_REQUIRED`:

- Confirm the logged-in web user has `openaiApiKey` in `a.json`.
- Confirm lookup uses UID, not username.
- Confirm spawned env includes `OPENAI_API_KEY`.
- Confirm generated `config.toml` contains `env_key = "OPENAI_API_KEY"` and `requires_openai_auth = false`.
- Confirm the key matches `CODEX_PROVIDER_BASE_URL`.

## Common Debugging Checklist

`crypto.randomUUID is not a function`:

- Add a frontend fallback ID generator instead of relying only on `crypto.randomUUID`, because some browsers/webviews do not support it.

`fetch failed` or HTTP 500:

- Check backend logs first.
- Verify `.env` base URLs.
- Verify user API key exists.
- Verify CORS origin and server port.
- Make sure response helpers remove stale `Content-Length` before sending JSON errors.

`ERR_CONTENT_LENGTH_MISMATCH`:

- Avoid streaming partial JSON.
- Remove `Content-Length` before custom JSON response writes.
- Always use a single JSON response path for errors.

`spawn EINVAL` on Windows dev script:

- Spawn npm through `npm.cmd`.
- Avoid invalid shell/cmd combinations.
- Use a dev script that finds free ports and spawns client/server with Windows-safe commands.

`EADDRINUSE`:

- Pick the next free client/server port or stop the existing process.

Poor current-events answers in Codex mode:

- Confirm `AI_TEXT_RUNTIME=codex`.
- Confirm `CODEX_NETWORK_ACCESS=enabled`.
- Confirm `turn/start.sandboxPolicy.networkAccess` is actually true.
- Confirm the Codex path is not injecting local search snippets when network is enabled.
- Restart the Node server to kill old app-server child processes.

Upload returns upstream `input_file` or non-JSON errors:

- Confirm `OPENAI_TEXT_API=responses`.
- Confirm the selected model/provider supports file inputs.
- If using a third-party provider, test the same upload capability directly against that provider.

## Validation Before Finishing Changes

Always run:

```bash
npm run typecheck
npm run build
```

If build succeeds locally but server is stale, redeploy:

```bash
git pull
npm install
npm run build
pm2 restart my-agent-web
```

or:

```bash
git pull
npm install
npm run build
npm start
```

## GitHub Sync Notes

If remote has a README created on GitHub:

```bash
git pull --rebase origin main
git push -u origin main
```

If local branch is not named `main`:

```bash
git branch
git branch -M main
git push -u origin main
```

Never commit `.env`, `a.json`, storage secrets, or generated user data.

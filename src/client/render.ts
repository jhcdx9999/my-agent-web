import type { AppState } from "./state";
import { renderMarkdown } from "./markdown";
import type { ChatAttachment, ChatMessage, ConversationSummary, ThemeName } from "../shared/types";

const formatTime = (iso: string): string =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(iso));

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const hasDownloadableAttachment = (message: ChatMessage): boolean =>
  Boolean(message.attachments?.some((attachment) => attachment.url));

const renderAttachment = (attachment: ChatAttachment): string => {
  if (attachment.kind === "image" && attachment.previewUrl) {
    return `
      <figure class="attachment attachment-image">
        <img src="${attachment.previewUrl}" alt="${escapeHtml(attachment.filename)}" />
        <figcaption>
          <span>${escapeHtml(attachment.filename)}</span>
          ${
            attachment.url
              ? `<a href="${attachment.url}" download>下载图片</a>`
              : `<span>${attachment.source === "uploaded" ? "已上传" : "图片"}</span>`
          }
        </figcaption>
      </figure>
    `;
  }

  const label =
    attachment.kind === "data"
      ? "下载数据结果"
      : attachment.source === "uploaded"
        ? attachment.kind === "pdf"
          ? "已上传 PDF"
          : "已上传文件"
        : "下载文件";
  const icon = attachment.kind === "pdf" ? "PDF" : attachment.kind === "data" ? "DATA" : "FILE";
  const inner = `
      <span class="file-icon">${icon}</span>
      <span>
        <strong>${label}</strong>
        <small>${escapeHtml(attachment.filename)}</small>
      </span>
  `;

  return attachment.url
    ? `<a class="attachment attachment-file" href="${attachment.url}" download>${inner}</a>`
    : `<div class="attachment attachment-file">${inner}</div>`;
};

const renderPendingUpload = (attachment: ChatAttachment): string => `
  <div class="pending-upload" data-upload-id="${attachment.id}">
    ${
      attachment.kind === "image" && attachment.previewUrl
        ? `<img src="${attachment.previewUrl}" alt="${escapeHtml(attachment.filename)}" />`
        : `<span class="pending-upload-icon">${attachment.kind === "pdf" ? "PDF" : "FILE"}</span>`
    }
    <span class="pending-upload-name">${escapeHtml(attachment.filename)}</span>
    <button type="button" class="remove-upload" data-remove-upload="${attachment.id}" aria-label="移除 ${escapeHtml(
      attachment.filename
    )}">×</button>
  </div>
`;

const renderMessageActions = (message: ChatMessage, state: AppState): string => {
  if (state.editingMessageId === message.id) {
    return "";
  }

  if (message.role === "user") {
    return `
      <div class="message-actions">
        <button class="message-action-button" type="button" data-edit-message="${message.id}" ${
          state.pending || state.paused ? "disabled" : ""
        }>重新编辑</button>
      </div>
    `;
  }

  return `
    <div class="message-actions">
      <button class="message-action-button" type="button" data-copy-message="${message.id}">复制</button>
      ${
        hasDownloadableAttachment(message)
          ? `<button class="message-action-button" type="button" data-download-message="${message.id}">下载</button>`
          : ""
      }
    </div>
  `;
};

const renderMessage = (message: ChatMessage, state: AppState): string => {
  const attachments = message.attachments?.map(renderAttachment).join("") ?? "";
  const isEditing = state.editingMessageId === message.id;

  return `
    <article class="message message-${message.role}" data-message-id="${message.id}">
      <div class="message-meta">
        <span>${message.role === "user" ? "你" : "GPT"}</span>
        <time datetime="${message.createdAt}">${formatTime(message.createdAt)}</time>
      </div>
      <div class="message-bubble">
        ${
          isEditing
            ? `<form class="message-edit-form" data-edit-form="${message.id}">
                <textarea name="content" rows="4">${escapeHtml(state.editingContent)}</textarea>
                <div class="message-actions message-edit-actions">
                  <button class="message-action-button primary" type="submit" ${
                    state.pending ? "disabled" : ""
                  }>提交修改</button>
                  <button class="message-action-button" type="button" data-cancel-edit>取消</button>
                </div>
              </form>`
            : `<div class="message-markdown">${
                message.role === "assistant"
                  ? renderMarkdown(message.content)
                  : `<p>${escapeHtml(message.content).replaceAll("\n", "<br />")}</p>`
              }</div>
              ${attachments ? `<div class="attachments">${attachments}</div>` : ""}`
        }
      </div>
      ${renderMessageActions(message, state)}
    </article>
  `;
};

const renderThinkingMessage = (state: AppState): string => `
  <article class="message message-assistant message-waiting" aria-live="polite">
    <div class="message-meta"><span>GPT</span><time>处理中</time></div>
    <div class="message-bubble thinking">
      <div class="thinking-head">
        <span class="thinking-pulse"></span>
        <strong>${escapeHtml(state.waitingTitle || "正在思考中")}</strong>
      </div>
      <p>${escapeHtml(state.waitingDetail || "正在拆解问题、整理上下文，并准备生成最终回答。")}</p>
      <div class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></div>
    </div>
  </article>
`;

const renderThemeButton = (theme: ThemeName, activeTheme: ThemeName): string => {
  const labels: Record<ThemeName, string> = {
    white: "白色",
    sapphire: "宝石蓝",
    black: "黑色"
  };

  return `
    <button class="theme-button ${theme === activeTheme ? "is-active" : ""}" data-theme-choice="${theme}" type="button">
      <span class="theme-swatch theme-swatch-${theme}"></span>
      ${labels[theme]}
    </button>
  `;
};

const renderConversation = (
  conversation: ConversationSummary,
  activeConversationId: string | undefined,
  pending: boolean,
  menuConversationId: string | undefined
): string => `
  <div class="conversation-row ${conversation.id === activeConversationId ? "is-active" : ""} ${conversation.id === menuConversationId ? "has-open-menu" : ""}">
    <button
      class="conversation-item"
      type="button"
      data-conversation-id="${conversation.id}"
      ${pending ? "disabled" : ""}
    >
      <span>${escapeHtml(conversation.title)}</span>
      <small>${conversation.messageCount} 条 · ${formatTime(conversation.updatedAt)}</small>
    </button>
    <button
      class="conversation-menu-button"
      type="button"
      data-conversation-menu="${conversation.id}"
      aria-label="更多操作：${escapeHtml(conversation.title)}"
      aria-expanded="${conversation.id === menuConversationId ? "true" : "false"}"
      ${pending ? "disabled" : ""}
    >...</button>
    ${
      conversation.id === menuConversationId
        ? `<div class="conversation-menu" role="menu">
            <button type="button" data-rename-conversation="${conversation.id}" role="menuitem">重命名</button>
            <button type="button" data-delete-conversation="${conversation.id}" role="menuitem" class="danger">删除</button>
          </div>`
        : ""
    }
  </div>
`;

const renderRenameModal = (state: AppState): string => {
  const conversation = state.conversations.find((item) => item.id === state.renamingConversationId);
  if (!conversation) {
    return "";
  }

  return `
    <div class="modal-backdrop" role="presentation">
      <form class="rename-modal" id="renameConversationForm" role="dialog" aria-modal="true" aria-labelledby="renameConversationTitle">
        <div>
          <h2 id="renameConversationTitle">重命名对话</h2>
          <p>为左侧历史窗口设置一个更容易识别的名称。</p>
        </div>
        <label>
          <span>新名称</span>
          <input name="title" value="${escapeHtml(state.renamingTitle || conversation.title)}" maxlength="80" required autofocus />
        </label>
        ${state.renamingError ? `<small class="rename-error">${escapeHtml(state.renamingError)}</small>` : ""}
        <div class="rename-actions">
          <button class="modal-secondary-button" type="button" id="cancelRenameConversation">取消</button>
          <button class="send-button" type="submit" ${state.renamingSaving ? "disabled" : ""}>
            ${state.renamingSaving ? "保存中" : "保存"}
          </button>
        </div>
      </form>
    </div>
  `;
};

const renderLogin = (state: AppState): string => {
  const isDominant = state.authLoginMode === "dominant";
  const isRegister = !isDominant && state.authMode === "register";
  const description = isDominant
    ? "请输入管理员分配的账号密码进入。"
    : isRegister
      ? "创建一个本地账号，之后历史对话会归入这个账号。"
      : "输入已注册账号密码进入你的个人对话空间。";

  return `
    <main class="login-shell">
      <form class="login-panel" id="authForm">
        <h1>${isRegister ? "注册账号" : "登录账号"}</h1>
        <p>${description}</p>
        <label>
          <span>账号</span>
          <input id="usernameInput" name="username" autocomplete="username" required minlength="${isDominant ? "1" : "3"}" />
        </label>
        <label>
          <span>密码</span>
          <input id="passwordInput" name="password" type="password" autocomplete="${isRegister ? "new-password" : "current-password"}" required minlength="${isDominant ? "1" : "6"}" />
        </label>
        ${state.authError ? `<div class="login-error">${escapeHtml(state.authError)}</div>` : ""}
        <button class="send-button" type="submit" ${state.pending ? "disabled" : ""}>${isRegister ? "注册并进入" : "登录"}</button>
        ${
          isDominant
            ? ""
            : `<button class="auth-link-button" type="button" id="switchAuthMode">
                ${isRegister ? "已有账号？去登录" : "没有账号？去注册"}
              </button>`
        }
      </form>
    </main>
  `;
};

export const renderApp = (state: AppState): string => {
  if (!state.user) {
    return renderLogin(state);
  }

  return `
    <main class="app-shell">
      <aside class="sidebar" aria-label="历史对话">
        <div class="sidebar-head">
          <div>
            <strong>${escapeHtml(state.user.username)}</strong>
            <span>${state.authExpiresAt ? `保活至 ${formatTime(state.authExpiresAt)}` : "历史对话"}</span>
          </div>
          <button id="logoutButton" type="button">退出</button>
        </div>
        <button class="api-key-button ${state.user.hasOpenAiApiKey ? "is-ready" : "needs-key"}" id="toggleApiKeyPanel" type="button">
          ${
            state.user.hasOpenAiApiKey
              ? "OpenAI Key 已配置"
              : state.requiresOpenAiApiKeyForText
                ? "配置 OpenAI Key"
                : "OpenAI Key 可选"
          }
        </button>
        <button class="new-chat-button" id="newConversationButton" type="button" ${state.pending ? "disabled" : ""}>新建对话</button>
        <div class="conversation-list">
          ${
            state.conversations.length
              ? state.conversations
                  .map((conversation) =>
                    renderConversation(
                      conversation,
                      state.activeConversationId,
                      state.pending,
                      state.conversationMenuId
                    )
                  )
                  .join("")
              : `<div class="conversation-empty">暂无历史</div>`
          }
        </div>
      </aside>

      <section class="main-column">
        <header class="topbar">
          <section class="brand-block" aria-label="应用信息">
            <h1>My AI Web</h1>
            <p>${state.paused ? "对话暂停中" : state.statusText}</p>
          </section>
          <section class="topbar-actions" aria-label="主题">
            <div class="theme-switcher" role="group" aria-label="主题选择">
              ${(["white", "sapphire", "black"] as ThemeName[])
                .map((theme) => renderThemeButton(theme, state.theme))
                .join("")}
            </div>
          </section>
        </header>

        <section class="chat-panel ${
          state.apiKeyPanelOpen || (state.requiresOpenAiApiKeyForText && !state.user.hasOpenAiApiKey)
            ? "has-api-key-panel"
            : ""
        }" aria-label="聊天窗口">
          ${
            state.apiKeyPanelOpen || (state.requiresOpenAiApiKeyForText && !state.user.hasOpenAiApiKey)
              ? `<form class="api-key-panel" id="apiKeyForm">
                  <div>
                    <strong>${state.user.hasOpenAiApiKey ? "更新 OpenAI API key" : "配置 OpenAI API key"}</strong>
                    <span>${
                      state.textRuntime === "codex" && state.requiresOpenAiApiKeyForText
                        ? "Codex 文本模式会按服务器的 provider 配置使用该密钥；可填官方或兼容代理对应的 key。"
                        : state.requiresOpenAiApiKeyForText
                          ? "文本对话、图片和上传能力会使用该密钥。"
                          : "Codex 文本模式下可选；生成图片或分析图片/PDF/文件时仍会使用。"
                    }密钥只保存在服务器根目录 a.json。</span>
                  </div>
                  <input
                    id="openAiApiKeyInput"
                    name="apiKey"
                    type="password"
                    autocomplete="off"
                    placeholder="sk-..."
                    required
                  />
                  <button class="send-button" type="submit" ${state.apiKeySaving ? "disabled" : ""}>
                    ${state.apiKeySaving ? "保存中" : "保存"}
                  </button>
                  ${state.apiKeyError ? `<small class="api-key-error">${escapeHtml(state.apiKeyError)}</small>` : ""}
                </form>`
              : ""
          }
          <div class="message-list" id="messageList">
            ${
              state.messages.length
                ? state.messages.map((message) => renderMessage(message, state)).join("")
                : `<div class="empty-state">
                    <h2>开始和 GPT 对话</h2>
                    <p>可以聊天、上传附件、生成图片、生成文件，或让它整理统计一段数据。</p>
                  </div>`
            }
            ${state.pending ? renderThinkingMessage(state) : ""}
          </div>

          <form class="composer" id="chatForm">
            ${
              state.pendingUploads.length
                ? `<div class="pending-uploads" aria-label="待发送附件">
                    ${state.pendingUploads.map(renderPendingUpload).join("")}
                  </div>`
                : ""
            }
            <textarea
              id="promptInput"
              name="prompt"
              rows="1"
              placeholder="${state.paused ? "当前已暂停，点击继续后再发送" : "输入消息，或要求生成图片/文件/数据统计"}"
              ${state.pending || state.paused ? "disabled" : ""}
            ></textarea>
            <div class="composer-footer">
              <div class="upload-controls">
                <input
                  id="fileInput"
                  type="file"
                  multiple
                  accept="${escapeHtml(state.uploadAccept)}"
                  ${state.pending || state.paused ? "disabled" : ""}
                />
                <label class="upload-button" for="fileInput">上传文件</label>
              </div>
              <div class="composer-controls">
                <select id="modelSelect" aria-label="选择模型" ${state.pending ? "disabled" : ""}>
                  ${state.availableModels
                    .map(
                      (model) =>
                        `<option value="${escapeHtml(model)}" ${
                          model === state.selectedModel ? "selected" : ""
                        }>${escapeHtml(model)}</option>`
                    )
                    .join("")}
                </select>
                <span class="runtime-pill">${state.textRuntime === "codex" ? "AI" : "OpenAI"}</span>
                <button class="pause-button" id="pauseButton" type="button" aria-pressed="${state.paused}">
                  ${state.paused ? "继续" : "暂停"}
                </button>
              </div>
              <button class="send-button" type="submit" ${state.pending || state.paused ? "disabled" : ""}>
                发送
              </button>
            </div>
          </form>
        </section>
      </section>
      ${renderRenameModal(state)}
    </main>
  `;
};

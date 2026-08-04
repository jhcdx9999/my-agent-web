import "./styles.css";
import {
  clearAuthToken,
  createConversation,
  deleteConversation as deleteConversationRequest,
  fetchAppConfig,
  fetchConversation,
  fetchConversations,
  fetchSession,
  getAuthToken,
  login,
  logout,
  renameConversation as renameConversationRequest,
  register,
  saveOpenAiApiKey,
  sendChat,
  sendChatStream,
  setAuthToken
} from "./api";
import { applyTheme, readStoredTheme } from "./theme";
import { createInitialState, createUserMessage, type AppState } from "./state";
import { renderApp } from "./render";
import { createClientId } from "./id";
import type { AuthResponse, AuthUser, ChatAttachment, ChatMessage, ChatProgressEvent, ConversationSummary } from "../shared/types";

const root = document.querySelector<HTMLDivElement>("#app");
const storedUser = localStorage.getItem("custom-gpt-user");
const storedExpiresAt = localStorage.getItem("custom-gpt-expires-at") ?? undefined;

if (!root) {
  throw new Error("App root was not found.");
}

const appRoot = root;

const readAuthMode = (loginMode: AppState["authLoginMode"] = "free"): AppState["authMode"] =>
  loginMode === "dominant" ? "login" : location.hash === "#/register" ? "register" : "login";

let state: AppState = {
  ...createInitialState(),
  authMode: readAuthMode(),
  authToken: getAuthToken(),
  authExpiresAt: storedExpiresAt,
  user: storedUser ? (JSON.parse(storedUser) as AuthUser) : undefined,
  theme: readStoredTheme()
};

let activeRequestId = 0;

const draw = (scrollToBottom = true): void => {
  applyTheme(state.theme);
  appRoot.innerHTML = renderApp(state);
  bindEvents();
  if (scrollToBottom) {
    scrollMessagesToBottom();
  }
};

const updateState = (patch: Partial<AppState>, options: { scroll?: boolean } = {}): void => {
  state = {
    ...state,
    ...patch
  };
  draw(options.scroll ?? true);
};

const rememberAuth = (response: AuthResponse): void => {
  setAuthToken(response.token);
  localStorage.setItem("custom-gpt-user", JSON.stringify(response.user));
  localStorage.setItem("custom-gpt-expires-at", response.expiresAt);
};

const forgetAuth = (): void => {
  localStorage.removeItem("custom-gpt-user");
  localStorage.removeItem("custom-gpt-expires-at");
  clearAuthToken();
};

const updateRememberedUser = (patch: Partial<AuthUser>): void => {
  if (!state.user) {
    return;
  }

  const user = {
    ...state.user,
    ...patch
  };

  localStorage.setItem("custom-gpt-user", JSON.stringify(user));
  updateState({ user });
};

const inferMimeType = (file: File): string => {
  if (file.type) {
    return file.type;
  }

  const extension = file.name.toLowerCase().split(".").pop();
  const byExtension: Record<string, string> = {
    css: "text/css",
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    gif: "image/gif",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "application/javascript",
    json: "application/json",
    log: "text/plain",
    md: "text/markdown",
    odt: "application/vnd.oasis.opendocument.text",
    pdf: "application/pdf",
    png: "image/png",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rtf: "application/rtf",
    ts: "text/plain",
    tsx: "text/plain",
    txt: "text/plain",
    webp: "image/webp",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xml: "application/xml",
    yaml: "application/x-yaml",
    yml: "application/x-yaml"
  };

  return extension ? byExtension[extension] ?? "application/octet-stream" : "application/octet-stream";
};

const dataUrlWithMimeType = (dataUrl: string, mimeType: string): string => {
  const match = /^data:([^;,]*)(;base64,.*)$/i.exec(dataUrl);
  if (!match || !mimeType || mimeType === "application/octet-stream") {
    return dataUrl;
  }

  const currentMimeType = match[1];
  return currentMimeType ? dataUrl : `data:${mimeType}${match[2]}`;
};

const scrollMessagesToBottom = (): void => {
  requestAnimationFrame(() => {
    const list = document.querySelector<HTMLDivElement>("#messageList");
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  });
};

const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("文件读取失败")));
    reader.readAsDataURL(file);
  });

const getUploadKind = (file: File): ChatAttachment["kind"] => {
  const mimeType = inferMimeType(file);

  if (mimeType.startsWith("image/")) {
    return "image";
  }

  if (mimeType === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return "pdf";
  }

  return "file";
};

const createUploadAttachment = async (file: File): Promise<ChatAttachment> => {
  const mimeType = inferMimeType(file);
  const dataUrl = dataUrlWithMimeType(await fileToDataUrl(file), mimeType);
  const kind = getUploadKind(file);

  return {
    id: createClientId("att"),
    kind,
    source: "uploaded",
    filename: file.name,
    mimeType,
    dataUrl,
    previewUrl: kind === "image" ? dataUrl : undefined,
    sizeBytes: file.size
  };
};

const addUploads = async (files: FileList | null): Promise<void> => {
  if (!files?.length) {
    return;
  }

  const currentUploads = [...state.pendingUploads];
  const incoming = Array.from(files);

  if (currentUploads.length + incoming.length > state.uploadMaxFiles) {
    updateState({ statusText: `最多一次上传 ${state.uploadMaxFiles} 个文件` });
    return;
  }

  const oversized = incoming.find((file) => file.size > state.uploadMaxBytesPerFile);
  if (oversized) {
    updateState({ statusText: `文件过大：${oversized.name}` });
    return;
  }

  try {
    const attachments = await Promise.all(incoming.map(createUploadAttachment));
    updateState({
      pendingUploads: [...currentUploads, ...attachments],
      statusText: `${attachments.length} 个附件待发送`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateState({ statusText: `文件读取失败：${message}` });
  }
};

const loadConversations = async (): Promise<void> => {
  if (!state.user) {
    return;
  }

  try {
    updateState({ conversations: await fetchConversations() }, { scroll: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("401")) {
      forgetAuth();
      updateState({ user: undefined, authToken: "", authError: "登录已过期，请重新登录。" });
      return;
    }
    updateState({ statusText: `历史加载失败：${message}` });
  }
};

const restoreSession = async (): Promise<void> => {
  if (!getAuthToken()) {
    return;
  }

  try {
    const session = await fetchSession();
    rememberAuth(session);
    updateState(
      {
        user: session.user,
        authToken: session.token,
        authExpiresAt: session.expiresAt,
        authError: ""
      },
      { scroll: false }
    );
    void loadConversations();
  } catch {
    forgetAuth();
    updateState({
      user: undefined,
      authToken: "",
      authExpiresAt: undefined,
      authError: "登录已过期，请重新登录。"
    });
  }
};

const selectConversation = async (conversationId: string): Promise<void> => {
  try {
    const conversation = await fetchConversation(conversationId);
    updateState({
      activeConversationId: conversation.id,
      messages: compactMessagesForState(conversation.messages),
      pendingUploads: [],
      editingMessageId: undefined,
      editingContent: "",
      statusText: "历史对话已加载"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateState({ statusText: `历史加载失败：${message}` });
  }
};

const upsertConversation = (conversation: ConversationSummary): ConversationSummary[] => [
  conversation,
  ...state.conversations.filter((item) => item.id !== conversation.id)
];

const removeConversationFromState = (conversationId: string): ConversationSummary[] =>
  state.conversations.filter((conversation) => conversation.id !== conversationId);

const replaceConversationInState = (conversation: ConversationSummary): ConversationSummary[] =>
  [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );

const handleAuthSuccess = (response: AuthResponse, statusText: string): void => {
  rememberAuth(response);
  if (location.hash === "#/login" || location.hash === "#/register") {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  updateState({
    user: response.user,
    authToken: response.token,
    authExpiresAt: response.expiresAt,
    apiKeyPanelOpen: !response.user.hasOpenAiApiKey,
    apiKeyError: "",
    pending: false,
    messages: [],
    conversations: [],
    activeConversationId: undefined,
    editingMessageId: undefined,
    editingContent: "",
    authError: "",
    statusText
  });
  void loadConversations();
};

const getLatestUserPrompt = (messages: ChatMessage[]): string =>
  [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

const promptNeedsImage = (prompt: string): boolean =>
  /(生成|画|绘制|做一张|来一张|create|generate|draw|image|picture|photo|海报|插画|图片)/i.test(prompt);

const promptNeedsFile = (prompt: string): boolean =>
  /(生成|创建|导出|保存|下载|文件|文档|表格|csv|xlsx|json|txt|md|markdown|report|download|file)/i.test(prompt);

const promptNeedsSearch = (prompt: string): boolean =>
  /(最新|现在|目前|今天|昨日|昨天|明天|本周|本月|今年|实时|联网|搜索|查询|查一下|新闻|赛程|赛果|比分|排名|积分榜|世界杯|current|latest|today|news|score|schedule|standing|price|weather)/i.test(prompt);

const hasNewUploads = (messages: ChatMessage[]): boolean =>
  messages.some((message) =>
    message.attachments?.some((attachment) => attachment.source === "uploaded" && Boolean(attachment.dataUrl))
  );

const hasNewImageUploads = (messages: ChatMessage[]): boolean =>
  messages.some((message) =>
    message.attachments?.some(
      (attachment) =>
        attachment.source === "uploaded" &&
        Boolean(attachment.dataUrl) &&
        (attachment.kind === "image" || attachment.mimeType.startsWith("image/"))
    )
  );

const compactAttachmentForState = (attachment: ChatAttachment): ChatAttachment => {
  if (attachment.source !== "uploaded") {
    return attachment;
  }

  return {
    id: attachment.id,
    kind: attachment.kind,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    source: attachment.source,
    url: attachment.url,
    textContent: attachment.textContent,
    description: attachment.description,
    sizeBytes: attachment.sizeBytes
  };
};

const compactMessagesForState = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map(compactAttachmentForState)
  }));

const waitingStagesFor = (prompt: string, messages: ChatMessage[]): Array<{ title: string; detail: string }> => {
  const stages = [
    {
      title: "正在思考中",
      detail: "正在理解你的目标、上下文和约束，准备组织回答路径。"
    }
  ];

  if (hasNewUploads(messages)) {
    stages.push({
      title: "正在读取附件",
      detail: "正在整理上传内容，并判断哪些信息需要进入本次回答。"
    });
  }

  if (promptNeedsSearch(prompt)) {
    stages.push({
      title: "正在搜索中",
      detail: "正在优先检查权威来源，避免只依赖不完整的搜索摘要。"
    });
  }

  if (promptNeedsImage(prompt)) {
    stages.push({
      title: "正在生成图片",
      detail: "正在解析画面要求、尺寸和格式，生成后会直接展示在对话中。"
    });
  } else if (promptNeedsFile(prompt)) {
    stages.push({
      title: "正在生成文件",
      detail: "正在整理内容结构，完成后会提供可点击下载的文件。"
    });
  }

  stages.push(
    {
      title: "正在整理答案",
      detail: "正在把结论、依据和来源组织成更清晰的回复。"
    },
    {
      title: "正在检查格式",
      detail: "正在检查表格、链接、下载项和最终排版。"
    }
  );

  return stages;
};

const applyProgressEvent = (event: ChatProgressEvent): void => {
  updateState(
    {
      waitingTitle: event.title,
      waitingDetail: event.detail,
      statusText: event.title
    },
    { scroll: true }
  );
};

const submitMessages = async (nextMessages: ChatMessage[]): Promise<void> => {
  const requestId = activeRequestId + 1;
  activeRequestId = requestId;
  const latestPrompt = getLatestUserPrompt(nextMessages);
  const requiresOpenAiApiKey =
    state.requiresOpenAiApiKeyForText || hasNewImageUploads(nextMessages) || promptNeedsImage(latestPrompt);

  if (requiresOpenAiApiKey && !state.user?.hasOpenAiApiKey) {
    updateState({
      apiKeyPanelOpen: true,
      apiKeyError:
        state.textRuntime === "codex" && !state.requiresOpenAiApiKeyForText
          ? "当前文本由 Codex 处理，但上传附件或生成图片仍需要 API Key。"
          : "请先配置你的 API Key。",
      statusText: "等待配置 API Key"
    });
    return;
  }

  const stages = waitingStagesFor(latestPrompt, nextMessages);
  const firstStage = stages[0];
  updateState({
    messages: nextMessages,
    pendingUploads: [],
    pending: true,
    editingMessageId: undefined,
    editingContent: "",
    waitingTitle: firstStage.title,
    waitingDetail: firstStage.detail,
    statusText: firstStage.title
  });

  try {
    const payload = {
      messages: nextMessages,
      model: state.selectedModel,
      conversationId: state.activeConversationId,
      paused: false
    };
    const response = await sendChatStream(payload, {
      onProgress: (event) => {
        if (requestId === activeRequestId) {
          applyProgressEvent(event);
        }
      }
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/stream|ReadableStream|text\/event-stream|流式/i.test(message)) {
        return sendChat(payload);
      }

      throw error;
    });

    if (requestId !== activeRequestId) {
      return;
    }

    updateState({
      messages: [...compactMessagesForState(nextMessages), response.message],
      activeConversationId: response.conversation?.id ?? state.activeConversationId,
      conversations: response.conversation ? upsertConversation(response.conversation) : state.conversations,
      pending: false,
      waitingTitle: "",
      waitingDetail: "",
      statusText: response.intent === "chat" ? "准备就绪" : "任务已完成"
    });
  } catch (error) {
    if (requestId !== activeRequestId) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    updateState({
      messages: [
        ...nextMessages,
        {
          id: createClientId("msg"),
          role: "assistant",
          content: `请求失败：${message}`,
          createdAt: new Date().toISOString()
        }
      ],
      pending: false,
      waitingTitle: "",
      waitingDetail: "",
      statusText: "请求失败"
    });
  }
};

const copyText = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
};

const downloadUrl = (url: string, filename: string): void => {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
};

const bindAuthEvents = (): void => {
  const authForm = document.querySelector<HTMLFormElement>("#authForm");
  authForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(authForm);
    const username = String(formData.get("username") ?? "");
    const password = String(formData.get("password") ?? "");

    updateState({ pending: true, authError: "" });

    try {
      const shouldRegister = state.authLoginMode === "free" && state.authMode === "register";
      const response = shouldRegister ? await register({ username, password }) : await login({ username, password });
      handleAuthSuccess(response, shouldRegister ? "注册成功" : "登录成功");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateState({ pending: false, authError: message });
    }
  });

  document.querySelector<HTMLButtonElement>("#switchAuthMode")?.addEventListener("click", () => {
    if (state.authLoginMode === "dominant") {
      return;
    }

    const authMode = state.authMode === "login" ? "register" : "login";
    history.replaceState(null, "", `${location.pathname}${location.search}#/${authMode}`);
    updateState(
      {
        authMode,
        authError: ""
      },
      { scroll: false }
    );
  });
};

function bindEvents(): void {
  bindAuthEvents();

  appRoot.addEventListener("click", (event) => {
    const target = event.target as Element | null;

    const shouldCloseConversationMenu =
      state.conversationMenuId && !target?.closest("[data-conversation-menu], .conversation-menu");
    const shouldCloseMobileMenu =
      state.mobileMenuOpen && !target?.closest("[data-mobile-menu-toggle], .mobile-menu-panel");

    if (shouldCloseConversationMenu || shouldCloseMobileMenu) {
      updateState(
        {
          conversationMenuId: shouldCloseConversationMenu ? undefined : state.conversationMenuId,
          mobileMenuOpen: shouldCloseMobileMenu ? false : state.mobileMenuOpen
        },
        { scroll: false }
      );
      return;
    }
  });

  document.querySelector<HTMLButtonElement>("[data-mobile-menu-toggle]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    updateState(
      {
        mobileMenuOpen: !state.mobileMenuOpen,
        conversationMenuId: undefined
      },
      { scroll: false }
    );
  });

  document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const theme = button.dataset.themeChoice as AppState["theme"];
      applyTheme(theme);
      updateState({ theme, mobileMenuOpen: false }, { scroll: false });
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-conversation-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const conversationId = button.dataset.conversationId;
      if (conversationId && !state.pending) {
        updateState({ conversationMenuId: undefined, mobileMenuOpen: false }, { scroll: false });
        void selectConversation(conversationId);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-conversation-menu]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const conversationId = button.dataset.conversationMenu;
      if (!conversationId || state.pending) {
        return;
      }

      updateState(
        {
          conversationMenuId: state.conversationMenuId === conversationId ? undefined : conversationId,
          mobileMenuOpen: Boolean(button.closest(".mobile-menu-panel")),
          renamingConversationId: undefined,
          renamingError: ""
        },
        { scroll: false }
      );
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-rename-conversation]").forEach((button) => {
    button.addEventListener("click", () => {
      const conversationId = button.dataset.renameConversation;
      const conversation = state.conversations.find((item) => item.id === conversationId);
      if (!conversation || state.pending) {
        return;
      }

      updateState(
        {
          conversationMenuId: undefined,
          mobileMenuOpen: false,
          renamingConversationId: conversation.id,
          renamingTitle: conversation.title,
          renamingError: ""
        },
        { scroll: false }
      );
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-delete-conversation]").forEach((button) => {
    button.addEventListener("click", async () => {
      const conversationId = button.dataset.deleteConversation;
      if (!conversationId || state.pending) {
        return;
      }

      try {
        await deleteConversationRequest(conversationId);
        const isActive = state.activeConversationId === conversationId;
        updateState(
          {
            conversations: removeConversationFromState(conversationId),
            activeConversationId: isActive ? undefined : state.activeConversationId,
            messages: isActive ? [] : state.messages,
            editingMessageId: undefined,
            editingContent: "",
            conversationMenuId: undefined,
            mobileMenuOpen: false,
            renamingConversationId: state.renamingConversationId === conversationId ? undefined : state.renamingConversationId,
            renamingTitle: state.renamingConversationId === conversationId ? "" : state.renamingTitle,
            renamingError: "",
            renamingSaving: false,
            statusText: "历史对话已删除"
          },
          { scroll: false }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateState({ statusText: `删除失败：${message}` }, { scroll: false });
      }
    });
  });

  document.querySelector<HTMLButtonElement>("#cancelRenameConversation")?.addEventListener("click", () => {
    updateState(
      {
        renamingConversationId: undefined,
        renamingTitle: "",
        renamingError: "",
        renamingSaving: false
      },
      { scroll: false }
    );
  });

  document.querySelector<HTMLFormElement>("#renameConversationForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const conversationId = state.renamingConversationId;
    const title = String(new FormData(form).get("title") ?? "").trim();
    if (!conversationId) {
      return;
    }

    if (!title) {
      updateState({ renamingError: "请输入新的对话名称。" }, { scroll: false });
      return;
    }

    updateState({ renamingSaving: true, renamingError: "" }, { scroll: false });

    try {
      const conversation = await renameConversationRequest(conversationId, title);
      updateState(
        {
          renamingSaving: false,
          conversations: replaceConversationInState(conversation),
          renamingConversationId: undefined,
          renamingTitle: "",
          renamingError: "",
          statusText: "对话已重命名"
        },
        { scroll: false }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateState({ renamingSaving: false, renamingError: message }, { scroll: false });
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-new-conversation]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (state.pending) {
        return;
      }

      try {
        const conversation = await createConversation();
        updateState({
          activeConversationId: conversation.id,
          conversations: upsertConversation(conversation),
          messages: [],
          pendingUploads: [],
          editingMessageId: undefined,
          editingContent: "",
          conversationMenuId: undefined,
          mobileMenuOpen: false,
          statusText: "新对话已创建"
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateState({ statusText: `新建失败：${message}` });
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>("#logoutButton, [data-logout]").forEach((button) => {
    button.addEventListener("click", async () => {
      activeRequestId += 1;
      await logout().catch(() => undefined);
      forgetAuth();
      updateState({
        user: undefined,
        authToken: "",
        authExpiresAt: undefined,
        messages: [],
        conversations: [],
        activeConversationId: undefined,
        pendingUploads: [],
        apiKeyPanelOpen: false,
        mobileMenuOpen: false,
        apiKeyError: "",
        editingMessageId: undefined,
        editingContent: "",
        conversationMenuId: undefined,
        renamingConversationId: undefined,
        renamingTitle: "",
        renamingError: "",
        renamingSaving: false,
        authError: ""
      });
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-toggle-api-key-panel]").forEach((button) => {
    button.addEventListener("click", () => {
      updateState(
        {
          apiKeyPanelOpen: !state.apiKeyPanelOpen,
          mobileMenuOpen: false,
          apiKeyError: ""
        },
        { scroll: false }
      );
    });
  });

  document.querySelector<HTMLFormElement>("#apiKeyForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const apiKey = String(formData.get("apiKey") ?? "");

    updateState({ apiKeySaving: true, apiKeyError: "" }, { scroll: false });

    try {
      const result = await saveOpenAiApiKey(apiKey);
      updateRememberedUser({ hasOpenAiApiKey: result.hasOpenAiApiKey });
      updateState({
        apiKeySaving: false,
        apiKeyPanelOpen: false,
        mobileMenuOpen: false,
        apiKeyError: "",
        statusText: "API Key 已保存"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateState({ apiKeySaving: false, apiKeyError: message }, { scroll: false });
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-copy-message]").forEach((button) => {
    button.addEventListener("click", async () => {
      const message = state.messages.find((item) => item.id === button.dataset.copyMessage);
      if (!message) {
        return;
      }

      try {
        await copyText(message.content);
        updateState({ statusText: "回复已复制" }, { scroll: false });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        updateState({ statusText: `复制失败：${errorMessage}` }, { scroll: false });
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-download-message]").forEach((button) => {
    button.addEventListener("click", () => {
      const message = state.messages.find((item) => item.id === button.dataset.downloadMessage);
      const attachments = message?.attachments?.filter((attachment) => attachment.url) ?? [];
      attachments.forEach((attachment) => {
        window.setTimeout(() => downloadUrl(attachment.url!, attachment.filename), 0);
      });
      updateState({ statusText: attachments.length ? "下载已开始" : "没有可下载附件" }, { scroll: false });
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-edit-message]").forEach((button) => {
    button.addEventListener("click", () => {
      const message = state.messages.find((item) => item.id === button.dataset.editMessage);
      if (!message || message.role !== "user") {
        return;
      }

      updateState(
        {
          editingMessageId: message.id,
          editingContent: message.content,
          statusText: "正在编辑历史消息"
        },
        { scroll: false }
      );
    });
  });

  document.querySelector<HTMLButtonElement>("[data-cancel-edit]")?.addEventListener("click", () => {
    updateState(
      {
        editingMessageId: undefined,
        editingContent: "",
        statusText: "准备就绪"
      },
      { scroll: false }
    );
  });

  document.querySelectorAll<HTMLFormElement>("[data-edit-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const messageId = form.dataset.editForm;
      const index = state.messages.findIndex((message) => message.id === messageId);
      const content = String(new FormData(form).get("content") ?? "").trim();

      if (index < 0 || !content || state.messages[index].role !== "user") {
        return;
      }

      const currentMessages = compactMessagesForState(state.messages);
      const editedMessage: ChatMessage = {
        ...currentMessages[index],
        content,
        createdAt: new Date().toISOString()
      };
      const nextMessages = [...currentMessages.slice(0, index), editedMessage];
      void submitMessages(nextMessages);
    });
  });

  const pauseButton = document.querySelector<HTMLButtonElement>("#pauseButton");
  pauseButton?.addEventListener("click", () => {
    updateState({
      paused: !state.paused,
      statusText: !state.paused ? "对话已暂停" : "准备就绪"
    });
  });

  const modelSelect = document.querySelector<HTMLSelectElement>("#modelSelect");
  modelSelect?.addEventListener("change", () => {
    updateState({ selectedModel: modelSelect.value }, { scroll: false });
  });

  const fileInput = document.querySelector<HTMLInputElement>("#fileInput");
  fileInput?.addEventListener("change", () => {
    void addUploads(fileInput.files).then(() => {
      fileInput.value = "";
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-remove-upload]").forEach((button) => {
    button.addEventListener("click", () => {
      const uploadId = button.dataset.removeUpload;
      updateState({
        pendingUploads: state.pendingUploads.filter((attachment) => attachment.id !== uploadId)
      });
    });
  });

  const textarea = document.querySelector<HTMLTextAreaElement>("#promptInput");
  textarea?.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  });
  textarea?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      document.querySelector<HTMLFormElement>("#chatForm")?.requestSubmit();
    }
  });

  const form = document.querySelector<HTMLFormElement>("#chatForm");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const prompt = textarea?.value.trim() ?? "";
    if ((!prompt && state.pendingUploads.length === 0) || state.pending || state.paused) {
      return;
    }

    const userMessage = createUserMessage(prompt || "请分析我上传的附件。", state.pendingUploads);
    const nextMessages = [...compactMessagesForState(state.messages), userMessage];
    void submitMessages(nextMessages);
  });
}

const loadConfig = async (): Promise<void> => {
  try {
    const config = await fetchAppConfig();
    updateState(
      {
        authLoginMode: config.auth.mode,
        authMode: readAuthMode(config.auth.mode),
        availableModels: config.models,
        selectedModel: config.defaultModel || config.models[0] || "",
        textRuntime: config.textRuntime,
        requiresOpenAiApiKeyForText: config.requiresOpenAiApiKeyForText,
        uploadAccept: config.upload.accept,
        uploadMaxFiles: config.upload.maxFiles,
        uploadMaxBytesPerFile: config.upload.maxBytesPerFile,
        statusText: "准备就绪"
      },
      { scroll: false }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateState({
      availableModels: ["gpt-5.5"],
      selectedModel: "gpt-5.5",
      statusText: `配置加载失败：${message}`
    });
  }
};

draw();
void loadConfig();
void restoreSession();

window.addEventListener("hashchange", () => {
  if (!state.user) {
    updateState(
      {
        authMode: readAuthMode(state.authLoginMode),
        authError: ""
      },
      { scroll: false }
    );
  }
});

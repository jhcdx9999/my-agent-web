import "./styles.css";
import {
  clearAuthToken,
  createConversation,
  fetchAppConfig,
  fetchConversation,
  fetchConversations,
  fetchSession,
  getAuthToken,
  login,
  logout,
  register,
  sendChat,
  setAuthToken
} from "./api";
import { applyTheme, readStoredTheme } from "./theme";
import { createInitialState, createUserMessage, type AppState } from "./state";
import { renderApp } from "./render";
import { createClientId } from "./id";
import type { AuthResponse, AuthUser, ChatAttachment, ConversationSummary } from "../shared/types";

const root = document.querySelector<HTMLDivElement>("#app");
const storedUser = localStorage.getItem("custom-gpt-user");
const storedExpiresAt = localStorage.getItem("custom-gpt-expires-at") ?? undefined;

if (!root) {
  throw new Error("App root was not found.");
}

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

const updateState = (patch: Partial<AppState>): void => {
  state = {
    ...state,
    ...patch
  };
  draw();
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
    updateState({ conversations: await fetchConversations() });
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
    updateState({
      user: session.user,
      authToken: session.token,
      authExpiresAt: session.expiresAt,
      authError: ""
    });
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
      messages: conversation.messages,
      pendingUploads: [],
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

const handleAuthSuccess = (response: AuthResponse, statusText: string): void => {
  rememberAuth(response);
  if (location.hash === "#/login" || location.hash === "#/register") {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  updateState({
    user: response.user,
    authToken: response.token,
    authExpiresAt: response.expiresAt,
    pending: false,
    messages: [],
    conversations: [],
    activeConversationId: undefined,
    authError: "",
    statusText
  });
  void loadConversations();
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
      const response =
        shouldRegister
          ? await register({ username, password })
          : await login({ username, password });
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
    updateState({
      authMode,
      authError: ""
    });
  });
};

const bindEvents = (): void => {
  bindAuthEvents();

  document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const theme = button.dataset.themeChoice as AppState["theme"];
      applyTheme(theme);
      updateState({ theme });
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-conversation-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const conversationId = button.dataset.conversationId;
      if (conversationId) {
        void selectConversation(conversationId);
      }
    });
  });

  document.querySelector<HTMLButtonElement>("#newConversationButton")?.addEventListener("click", async () => {
    try {
      const conversation = await createConversation();
      updateState({
        activeConversationId: conversation.id,
        conversations: upsertConversation(conversation),
        messages: [],
        pendingUploads: [],
        statusText: "新对话已创建"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateState({ statusText: `新建失败：${message}` });
    }
  });

  document.querySelector<HTMLButtonElement>("#logoutButton")?.addEventListener("click", async () => {
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
      authError: ""
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
    updateState({ selectedModel: modelSelect.value });
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
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = textarea?.value.trim() ?? "";
    if ((!prompt && state.pendingUploads.length === 0) || state.pending || state.paused) {
      return;
    }

    const userMessage = createUserMessage(prompt || "请分析我上传的附件。", state.pendingUploads);
    const nextMessages = [...state.messages, userMessage];
    updateState({
      messages: nextMessages,
      pendingUploads: [],
      pending: true,
      statusText: "GPT 正在处理"
    });

    try {
      const response = await sendChat({
        messages: nextMessages,
        model: state.selectedModel,
        conversationId: state.activeConversationId,
        paused: false
      });

      updateState({
        messages: [...nextMessages, response.message],
        activeConversationId: response.conversation?.id ?? state.activeConversationId,
        conversations: response.conversation
          ? upsertConversation(response.conversation)
          : state.conversations,
        pending: false,
        statusText: response.intent === "chat" ? "准备就绪" : "任务已完成"
      });
    } catch (error) {
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
        statusText: "请求失败"
      });
    }
  });
};

const draw = (): void => {
  applyTheme(state.theme);
  root.innerHTML = renderApp(state);
  bindEvents();
  scrollMessagesToBottom();
};

const loadConfig = async (): Promise<void> => {
  try {
    const config = await fetchAppConfig();
    updateState({
      authLoginMode: config.auth.mode,
      authMode: readAuthMode(config.auth.mode),
      availableModels: config.models,
      selectedModel: config.defaultModel || config.models[0] || "",
      uploadAccept: config.upload.accept,
      uploadMaxFiles: config.upload.maxFiles,
      uploadMaxBytesPerFile: config.upload.maxBytesPerFile,
      statusText: "准备就绪"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateState({
      availableModels: ["gpt-5.6-sol"],
      selectedModel: "gpt-5.6-sol",
      statusText: `配置加载失败：${message}`
    });
  }
};

draw();
void loadConfig();
void restoreSession();

window.addEventListener("hashchange", () => {
  if (!state.user) {
    updateState({
      authMode: readAuthMode(state.authLoginMode),
      authError: ""
    });
  }
});

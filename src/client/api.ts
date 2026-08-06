import type {
  AppConfigResponse,
  AuthRequest,
  AuthResponse,
  ChatRequest,
  ChatResponse,
  ConversationDetail,
  ConversationSummary,
  ChatProgressEvent,
  OpenAiApiKeyResponse
} from "../shared/types";

const parseJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  let data: (T & { error?: string }) | undefined;

  if (text.trim()) {
    try {
      data = JSON.parse(text) as T & { error?: string };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const preview = text.trim().slice(0, 240);
      throw new Error(
        `响应不是有效 JSON：${message}。HTTP ${response.status} ${response.statusText || ""}${
          preview ? `，响应片段：${preview}` : ""
        }`
      );
    }
  }

  if (!response.ok) {
    throw new Error(data?.error ?? `请求失败：HTTP ${response.status} ${response.statusText || "上游无响应"}`);
  }

  if (!data) {
    throw new Error(`响应为空：HTTP ${response.status} ${response.statusText || ""}`);
  }

  return data;
};

export const fetchAppConfig = async (): Promise<AppConfigResponse> =>
  parseJson<AppConfigResponse>(await fetch("/api/config"));

let authToken = localStorage.getItem("custom-gpt-token") ?? "";

export const setAuthToken = (token: string): void => {
  authToken = token;
  localStorage.setItem("custom-gpt-token", token);
};

export const clearAuthToken = (): void => {
  authToken = "";
  localStorage.removeItem("custom-gpt-token");
};

export const getAuthToken = (): string => authToken;

const authHeaders = (): Record<string, string> =>
  authToken
    ? {
        Authorization: `Bearer ${authToken}`
      }
    : {};

export const login = async (payload: AuthRequest): Promise<AuthResponse> =>
  parseJson<AuthResponse>(
    await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    })
  );

export const register = async (payload: AuthRequest): Promise<AuthResponse> =>
  parseJson<AuthResponse>(
    await fetch("/api/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    })
  );

export const fetchSession = async (): Promise<AuthResponse> =>
  parseJson<AuthResponse>(
    await fetch("/api/auth/session", {
      headers: authHeaders()
    })
  );

export const logout = async (): Promise<void> => {
  if (!authToken) {
    return;
  }

  await fetch("/api/auth/logout", {
    method: "POST",
    headers: authHeaders()
  });
  clearAuthToken();
};

export const saveOpenAiApiKey = async (apiKey: string): Promise<OpenAiApiKeyResponse> =>
  parseJson<OpenAiApiKeyResponse>(
    await fetch("/api/user/openai-key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders()
      },
      body: JSON.stringify({ apiKey })
    })
  );

export const fetchConversations = async (): Promise<ConversationSummary[]> =>
  parseJson<ConversationSummary[]>(
    await fetch("/api/conversations", {
      headers: authHeaders()
    })
  );

export const createConversation = async (): Promise<ConversationDetail> =>
  parseJson<ConversationDetail>(
    await fetch("/api/conversations", {
      method: "POST",
      headers: authHeaders()
    })
  );

export const fetchConversation = async (conversationId: string): Promise<ConversationDetail> =>
  parseJson<ConversationDetail>(
    await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      headers: authHeaders()
    })
  );

export const deleteConversation = async (conversationId: string): Promise<void> => {
  await parseJson<{ ok: boolean }>(
    await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
      headers: authHeaders()
    })
  );
};

export const renameConversation = async (conversationId: string, title: string): Promise<ConversationSummary> =>
  parseJson<ConversationSummary>(
    await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders()
      },
      body: JSON.stringify({ title })
    })
  );

export const sendChat = async (payload: ChatRequest): Promise<ChatResponse> =>
  parseJson<ChatResponse>(
    await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders()
      },
      body: JSON.stringify(payload)
    })
  );

export const sendChatStream = async (
  payload: ChatRequest,
  handlers: {
    onProgress?: (event: ChatProgressEvent) => void;
  } = {}
): Promise<ChatResponse> => {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...authHeaders()
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    if (text.trim()) {
      try {
        const data = JSON.parse(text) as { error?: string };
        if (data.error) {
          throw new Error(data.error);
        }
      } catch {
        // Fall through to the HTTP error below when the body is not JSON.
      }
    }
    throw new Error(
      `请求失败：HTTP ${response.status} ${response.statusText || "上游无响应"}${
        text.trim() ? `，响应片段：${text.trim().slice(0, 180)}` : ""
      }`
    );
  }

  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("服务器没有建立流式响应通道，请刷新页面后重试。");
  }

  if (!response.body) {
    throw new Error("浏览器没有收到可读取的流式响应体，请刷新页面后重试。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeEvent = (raw: string): ChatResponse | undefined => {
    const lines = raw.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() || "message";
    const dataText = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");

    if (!dataText) {
      return undefined;
    }

    const data = JSON.parse(dataText) as unknown;
    if (event === "progress") {
      handlers.onProgress?.(data as ChatProgressEvent);
      return undefined;
    }

    if (event === "error") {
      const error = data as { error?: string; statusCode?: number };
      throw new Error(error.error ?? `请求失败：HTTP ${error.statusCode ?? response.status}`);
    }

    if (event === "done") {
      return data as ChatResponse;
    }

    return undefined;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

      let separator = buffer.search(/\r?\n\r?\n/);
      while (separator >= 0) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(buffer[separator] === "\r" ? separator + 4 : separator + 2);
        const result = consumeEvent(raw);
        if (result) {
          await reader.cancel().catch(() => undefined);
          return result;
        }
        separator = buffer.search(/\r?\n\r?\n/);
      }

      if (done) {
        break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`流式连接中断：${message}。长附件 OCR 可能仍在服务器处理，请稍后重试或降低 OCR 页数/切片数。`);
  }

  throw new Error("流式响应结束，但没有收到最终结果。");
};

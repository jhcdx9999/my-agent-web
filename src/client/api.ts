import type {
  AppConfigResponse,
  AuthRequest,
  AuthResponse,
  ChatRequest,
  ChatResponse,
  ConversationDetail,
  ConversationSummary,
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

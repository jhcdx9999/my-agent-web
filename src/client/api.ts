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
  const data = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? `Request failed with ${response.status}.`);
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

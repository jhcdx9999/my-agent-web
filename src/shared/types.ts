export type ChatRole = "user" | "assistant";

export type AssistantIntent = "chat" | "image" | "file" | "data";

export type AttachmentKind = "image" | "pdf" | "file" | "data";

export type ThemeName = "white" | "sapphire" | "black";

export type AuthLoginMode = "free" | "dominant";

export interface ChatAttachment {
  id: string;
  kind: AttachmentKind;
  filename: string;
  mimeType: string;
  source?: "uploaded" | "generated";
  url?: string;
  previewUrl?: string;
  dataUrl?: string;
  textContent?: string;
  description?: string;
  sizeBytes?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  attachments?: ChatAttachment[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  conversationId?: string;
  paused?: boolean;
}

export interface UsageSummary {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResponse {
  intent: AssistantIntent;
  message: ChatMessage;
  usage?: UsageSummary;
  conversation?: ConversationSummary;
}

export interface AppConfigResponse {
  defaultModel: string;
  models: string[];
  themes: ThemeName[];
  auth: {
    mode: AuthLoginMode;
  };
  upload: {
    maxFiles: number;
    maxBytesPerFile: number;
    accept: string;
  };
}

export interface AuthUser {
  id: string;
  username: string;
}

export interface AuthRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  user: AuthUser;
  token: string;
  expiresAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ChatMessage[];
}

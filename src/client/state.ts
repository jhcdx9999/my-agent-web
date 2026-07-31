import type {
  AuthUser,
  ChatAttachment,
  ChatMessage,
  ConversationSummary,
  ThemeName
} from "../shared/types";

export interface AppState {
  user?: AuthUser;
  authToken: string;
  authMode: "login" | "register";
  authError: string;
  authExpiresAt?: string;
  messages: ChatMessage[];
  conversations: ConversationSummary[];
  activeConversationId?: string;
  selectedModel: string;
  availableModels: string[];
  pendingUploads: ChatAttachment[];
  uploadAccept: string;
  uploadMaxFiles: number;
  uploadMaxBytesPerFile: number;
  theme: ThemeName;
  paused: boolean;
  pending: boolean;
  statusText: string;
}

export const createInitialState = (): AppState => ({
  authToken: "",
  authMode: "login",
  authError: "",
  messages: [],
  conversations: [],
  selectedModel: "",
  availableModels: [],
  pendingUploads: [],
  uploadAccept: "image/*,.pdf,.txt,.md,.csv,.json",
  uploadMaxFiles: 5,
  uploadMaxBytesPerFile: 10 * 1024 * 1024,
  theme: "white",
  paused: false,
  pending: false,
  statusText: "准备就绪"
});

export const createUserMessage = (
  content: string,
  attachments: ChatAttachment[] = []
): ChatMessage => ({
  id: `msg_${crypto.randomUUID()}`,
  role: "user",
  content,
  createdAt: new Date().toISOString(),
  attachments
});

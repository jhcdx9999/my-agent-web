import "dotenv/config";
import path from "node:path";
import type { AuthLoginMode } from "../shared/types";

const boolFromEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

const intFromEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const csvFromEnv = (value: string | undefined, fallback: string[]): string[] => {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return items && items.length > 0 ? items : fallback;
};

const defaultModel = process.env.OPENAI_DEFAULT_MODEL ?? "gpt-5.6-sol";
const openaiBaseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
const authMode: AuthLoginMode = process.env.AUTH_MODE === "dominant" ? "dominant" : "free";
const reasoningEffort = ["minimal", "low", "medium", "high"].includes(process.env.OPENAI_REASONING_EFFORT ?? "")
  ? process.env.OPENAI_REASONING_EFFORT!
  : "high";
const configuredModels = csvFromEnv(process.env.OPENAI_MODELS, [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna"
]);

export const appConfig = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: intFromEnv(process.env.PORT, 8787),
  host: process.env.HOST ?? "127.0.0.1",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  requestBodyLimit: process.env.REQUEST_BODY_LIMIT ?? "35mb",
  storageDir: path.resolve(process.cwd(), "storage", "generated"),
  authDir: path.resolve(process.cwd(), "storage", "auth"),
  usersDir: path.resolve(process.cwd(), "storage", "users"),
  dominantUsersFile: path.resolve(process.cwd(), process.env.DOMINANT_USERS_FILE ?? "a.json"),
  tokenTtlMs: intFromEnv(process.env.AUTH_TOKEN_TTL_HOURS, 120) * 60 * 60 * 1000,
  auth: {
    mode: authMode
  },
  openai: {
    baseUrl: openaiBaseUrl,
    textApi: process.env.OPENAI_TEXT_API === "chat" ? "chat" : "responses",
    defaultModel,
    models: configuredModels.includes(defaultModel)
      ? configuredModels
      : [defaultModel, ...configuredModels],
    systemPrompt:
      process.env.OPENAI_SYSTEM_PROMPT ??
      "你是一个高质量中文 AI 助手。回答前要先在内部充分分析用户目标、约束、时效性和潜在风险；需要最新事实、赛果、价格、法规、版本或其他可能变化的信息时，优先使用联网工具和权威来源核验。输出只展示结论、依据、步骤和来源，不展示隐藏推理链；不确定时明确说明不确定点，并给出可验证的下一步。",
    reasoningEffort,
    imageModel: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2",
    imageSize: process.env.OPENAI_IMAGE_SIZE ?? "1024x1024",
    imageQuality: process.env.OPENAI_IMAGE_QUALITY ?? "auto",
    imageFormat: process.env.OPENAI_IMAGE_FORMAT ?? "png"
  },
  search: {
    enabled: boolFromEnv(process.env.ENABLE_WEB_SEARCH, true),
    provider: process.env.WEB_SEARCH_PROVIDER ?? "auto",
    maxResults: intFromEnv(process.env.WEB_SEARCH_MAX_RESULTS, 5),
    timeoutMs: intFromEnv(process.env.WEB_SEARCH_TIMEOUT_MS, 10000),
    fetchPages: boolFromEnv(process.env.WEB_SEARCH_FETCH_PAGES, true),
    maxFetchPages: intFromEnv(process.env.WEB_SEARCH_MAX_FETCH_PAGES, 2),
    maxPageChars: intFromEnv(process.env.WEB_SEARCH_MAX_PAGE_CHARS, 2500),
    maxContextChars: intFromEnv(process.env.WEB_SEARCH_MAX_CONTEXT_CHARS, 8000),
    userAgent: process.env.WEB_SEARCH_USER_AGENT ?? "CustomGPTWeb/0.1",
    serperApiKey: process.env.SERPER_API_KEY ?? "",
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY ?? "",
    tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
    openaiHostedTool: boolFromEnv(
      process.env.OPENAI_WEB_SEARCH_TOOL,
      openaiBaseUrl.includes("api.openai.com")
    )
  },
  safety: {
    enableLocalCodeExecution: boolFromEnv(process.env.ENABLE_LOCAL_CODE_EXECUTION, true),
    localCodeTimeoutMs: intFromEnv(process.env.LOCAL_CODE_TIMEOUT_MS, 2500),
    maxHistoryMessages: intFromEnv(process.env.MAX_HISTORY_MESSAGES, 16),
    maxMessageChars: intFromEnv(process.env.MAX_MESSAGE_CHARS, 12000)
  },
  upload: {
    maxFiles: intFromEnv(process.env.MAX_UPLOAD_FILES, 5),
    maxBytesPerFile: intFromEnv(process.env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024),
    accept:
      "image/*,.pdf,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.html,.css,.xml,.yaml,.yml,.log"
  }
};

export type ServerConfig = typeof appConfig;

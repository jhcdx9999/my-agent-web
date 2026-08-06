import "dotenv/config";
import os from "node:os";
import path from "node:path";
import type { AuthLoginMode, TextRuntime } from "../shared/types";

const stringFromEnv = (value: string | undefined, fallback: string): string => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
};

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

const pathFromEnv = (value: string | undefined): string => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }

  const expanded =
    trimmed === "~"
      ? os.homedir()
      : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;
  return path.resolve(process.cwd(), expanded);
};

const defaultModel = "gpt-5.5";
const openaiBaseUrl = (process.env.OPENAI_BASE_URL ?? "https://www.ai-dingyue.com").replace(/\/$/, "");
const authMode: AuthLoginMode = process.env.AUTH_MODE === "dominant" ? "dominant" : "free";
const textRuntime: TextRuntime = process.env.AI_TEXT_RUNTIME === "codex" ? "codex" : "openai";
const codexAuthMode = process.env.CODEX_AUTH_MODE === "server-login" ? "server-login" : "user-api-key";
const codexModelProvider = stringFromEnv(process.env.CODEX_MODEL_PROVIDER, "OpenAI");
const codexProviderBaseUrl = stringFromEnv(process.env.CODEX_PROVIDER_BASE_URL, openaiBaseUrl).replace(/\/$/, "");
const codexApiKeyEnv = stringFromEnv(process.env.CODEX_API_KEY_ENV, "OPENAI_API_KEY");
const codexSupportsWebsockets = boolFromEnv(
  process.env.CODEX_SUPPORTS_WEBSOCKETS,
  boolFromEnv(process.env.CODEX_RESPONSES_WEBSOCKETS_V2, false)
);
const codexRequiresOpenAiAuth =
  codexAuthMode === "user-api-key"
    ? false
    : boolFromEnv(process.env.CODEX_REQUIRES_OPENAI_AUTH, true);
const reasoningEffort = ["minimal", "low", "medium", "high", "xhigh"].includes(process.env.OPENAI_REASONING_EFFORT ?? "")
  ? process.env.OPENAI_REASONING_EFFORT!
  : "xhigh";
const codexReasoningEffort = ["none", "minimal", "low", "medium", "high", "xhigh"].includes(
  process.env.CODEX_REASONING_EFFORT ?? ""
)
  ? process.env.CODEX_REASONING_EFFORT!
  : "xhigh";
const configuredModels = csvFromEnv(process.env.OPENAI_MODELS, [
  "gpt-5.5"
]);
const configuredCodexModels = csvFromEnv(process.env.CODEX_MODELS, [
  "gpt-5.5"
]);
const defaultPdfPythonCommands = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
const pdfPythonCommands = csvFromEnv(
  process.env.PDF_PYTHON_COMMANDS ?? process.env.PDF_PYTHON_COMMAND,
  defaultPdfPythonCommands
);

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
  tokenTtlMs: intFromEnv(process.env.AUTH_TOKEN_TTL_HOURS, 168) * 60 * 60 * 1000,
  auth: {
    mode: authMode
  },
  ai: {
    textRuntime
  },
  openai: {
    baseUrl: openaiBaseUrl,
    textApi: process.env.OPENAI_TEXT_API === "chat" ? "chat" : "responses",
    defaultModel,
    models: ["gpt-5.5"],
    systemPrompt:
      process.env.OPENAI_SYSTEM_PROMPT ??
      "你是一个高质量中文 AI 助手。回答前要先在内部充分分析用户目标、约束、时效性和潜在风险；需要最新事实、赛果、价格、法规、版本或其他可能变化的信息时，优先使用联网工具和权威来源核验。输出只展示结论、依据、步骤和来源，不展示隐藏推理链；不确定时明确说明不确定点，并给出可验证的下一步。",
    reasoningEffort,
    imageModel: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2",
    imageSize: process.env.OPENAI_IMAGE_SIZE ?? "1024x1024",
    imageEditSize: process.env.OPENAI_IMAGE_EDIT_SIZE ?? "1024x1536",
    imageQuality: process.env.OPENAI_IMAGE_QUALITY ?? "high",
    imageFormat: process.env.OPENAI_IMAGE_FORMAT ?? "png"
  },
  codex: {
    command: stringFromEnv(process.env.CODEX_COMMAND, "codex"),
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5"],
    reasoningEffort: codexReasoningEffort,
    timeoutMs: intFromEnv(process.env.CODEX_TIMEOUT_MS, 300000),
    workingDirectory: path.resolve(process.cwd(), process.env.CODEX_WORKING_DIR ?? "."),
    sandbox: process.env.CODEX_SANDBOX === "workspace-write" ? "workspace-write" : "read-only",
    approvalPolicy: process.env.CODEX_APPROVAL_POLICY ?? "on-request",
    authMode: codexAuthMode,
    configTemplate: pathFromEnv(process.env.CODEX_CONFIG_TEMPLATE),
    modelProvider: codexModelProvider,
    providerBaseUrl: codexProviderBaseUrl,
    apiKeyEnv: codexApiKeyEnv,
    wireApi: process.env.CODEX_WIRE_API === "chat" ? "chat" : "responses",
    supportsWebsockets: codexSupportsWebsockets,
    requiresOpenAiAuth: codexRequiresOpenAiAuth,
    disableResponseStorage: boolFromEnv(process.env.CODEX_DISABLE_RESPONSE_STORAGE, true),
    networkAccess: stringFromEnv(process.env.CODEX_NETWORK_ACCESS, "enabled"),
    features: {
      goals: boolFromEnv(process.env.CODEX_FEATURE_GOALS ?? process.env.CODEX_GOALS, true),
      responsesWebsocketsV2: boolFromEnv(process.env.CODEX_RESPONSES_WEBSOCKETS_V2, codexSupportsWebsockets)
    }
  },
  search: {
    enabled: boolFromEnv(process.env.ENABLE_WEB_SEARCH, true),
    provider: process.env.WEB_SEARCH_PROVIDER ?? "auto",
    maxResults: intFromEnv(process.env.WEB_SEARCH_MAX_RESULTS, 5),
    maxQueries: intFromEnv(process.env.WEB_SEARCH_MAX_QUERIES, 4),
    timeoutMs: intFromEnv(process.env.WEB_SEARCH_TIMEOUT_MS, 10000),
    fetchPages: boolFromEnv(process.env.WEB_SEARCH_FETCH_PAGES, true),
    maxFetchPages: intFromEnv(process.env.WEB_SEARCH_MAX_FETCH_PAGES, 4),
    maxPageChars: intFromEnv(process.env.WEB_SEARCH_MAX_PAGE_CHARS, 12000),
    maxContextChars: intFromEnv(process.env.WEB_SEARCH_MAX_CONTEXT_CHARS, 20000),
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
    maxMessageChars: intFromEnv(process.env.MAX_MESSAGE_CHARS, 12000),
    maxContextChars: intFromEnv(process.env.MAX_CONTEXT_CHARS, 200000)
  },
  upload: {
    maxFiles: intFromEnv(process.env.MAX_UPLOAD_FILES, 5),
    maxBytesPerFile: intFromEnv(process.env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024),
    maxExtractedTextChars: intFromEnv(process.env.MAX_EXTRACTED_TEXT_CHARS, 12000),
    pdfTextCommand: stringFromEnv(process.env.PDF_TEXT_COMMAND, "pdftotext"),
    pdfPythonCommands,
    accept:
      "image/*,.pdf,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.html,.css,.xml,.yaml,.yml,.log"
  }
};

export type ServerConfig = typeof appConfig;

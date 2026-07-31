import "dotenv/config";
import path from "node:path";

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
  tokenTtlMs: intFromEnv(process.env.AUTH_TOKEN_TTL_HOURS, 120) * 60 * 60 * 1000,
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
    textApi: process.env.OPENAI_TEXT_API === "chat" ? "chat" : "responses",
    defaultModel,
    models: configuredModels.includes(defaultModel)
      ? configuredModels
      : [defaultModel, ...configuredModels],
    systemPrompt:
      process.env.OPENAI_SYSTEM_PROMPT ??
      "\u4f60\u662f\u4e00\u4e2a\u9ad8\u6548\u3001\u6e05\u6670\u3001\u53ef\u9760\u7684\u4e2d\u6587 GPT \u52a9\u624b\u3002",
    imageModel: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2",
    imageSize: process.env.OPENAI_IMAGE_SIZE ?? "1024x1024",
    imageQuality: process.env.OPENAI_IMAGE_QUALITY ?? "auto",
    imageFormat: process.env.OPENAI_IMAGE_FORMAT ?? "png"
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

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config";
import { HttpError } from "../errors";
import { ensureDirectory } from "../utils/fs";

type JsonRpcId = number | string;

type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type ChatApiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type CodexCompletion = {
  content: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ActiveTurn = {
  start: number;
  fullText: string;
  finalText: string;
  deltaText: string;
  threadId: string | null;
  turnId: string | null;
  timeout: NodeJS.Timeout;
  settled: boolean;
  resolve: (value: CodexCompletion) => void;
  reject: (error: Error) => void;
};

const normalizeReasoning = (value: string): string =>
  value === "extra-high" ? "xhigh" : value;

const tomlString = (value: string): string =>
  JSON.stringify(value);

const isCodexNetworkEnabled = (): boolean =>
  ["1", "true", "yes", "on", "enabled"].includes(appConfig.codex.networkAccess.trim().toLowerCase());

const buildCodexConfigToml = (): string => {
  const lines = [
    `model_provider = ${tomlString(appConfig.codex.modelProvider)}`,
    `model = ${tomlString(appConfig.codex.defaultModel)}`,
    `review_model = ${tomlString(appConfig.codex.defaultModel)}`,
    `model_reasoning_effort = ${tomlString(normalizeReasoning(appConfig.codex.reasoningEffort))}`,
    `disable_response_storage = ${appConfig.codex.disableResponseStorage}`,
    `network_access = ${tomlString(appConfig.codex.networkAccess)}`,
    "windows_wsl_setup_acknowledged = true",
    "",
    `[model_providers.${tomlString(appConfig.codex.modelProvider)}]`,
    `name = ${tomlString(appConfig.codex.modelProvider)}`,
    `base_url = ${tomlString(appConfig.codex.providerBaseUrl)}`,
    `wire_api = ${tomlString(appConfig.codex.wireApi)}`,
    `requires_openai_auth = ${appConfig.codex.requiresOpenAiAuth}`
  ];

  if (appConfig.codex.authMode === "user-api-key") {
    lines.push(`env_key = ${tomlString(appConfig.codex.apiKeyEnv)}`);
  }

  if (appConfig.codex.supportsWebsockets) {
    lines.push("supports_websockets = true");
  }

  lines.push("", "[features]");
  if (appConfig.codex.features.responsesWebsocketsV2) {
    lines.push("responses_websockets_v2 = true");
  }
  if (appConfig.codex.features.goals) {
    lines.push("goals = true");
  }

  return `${lines.join("\n")}\n`;
};

const prepareUserCodexHome = async (userId: string): Promise<string> => {
  const codexHome = path.join(appConfig.usersDir, userId, "codex-home");
  await ensureDirectory(codexHome);

  const configPath = path.join(codexHome, "config.toml");
  if (appConfig.codex.configTemplate) {
    await fs.copyFile(appConfig.codex.configTemplate, configPath);
  } else {
    await fs.writeFile(configPath, buildCodexConfigToml(), "utf8");
  }

  return codexHome;
};

const promptFromMessages = (messages: ChatApiMessage[]): string => {
  const system = messages.find((message) => message.role === "system")?.content.trim();
  const turns = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const label = message.role === "assistant" ? "Assistant" : "User";
      return `${label}:\n${message.content.trim()}`;
    })
    .join("\n\n");

  return [
    system ? `System instructions:\n${system}` : undefined,
    turns,
    "Please answer the latest user message directly."
  ]
    .filter(Boolean)
    .join("\n\n");
};

const parseTokenUsage = (
  value: unknown
): CodexCompletion["usage"] | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const total = record.total;
  const last = record.last;
  const source =
    total && typeof total === "object"
      ? (total as Record<string, unknown>)
      : last && typeof last === "object"
        ? (last as Record<string, unknown>)
        : record;

  const input = source.inputTokens ?? source.input_tokens;
  const output = source.outputTokens ?? source.output_tokens;
  const totalTokens = source.totalTokens ?? source.total_tokens;

  return {
    prompt_tokens: typeof input === "number" ? input : undefined,
    completion_tokens: typeof output === "number" ? output : undefined,
    total_tokens: typeof totalTokens === "number" ? totalTokens : undefined
  };
};

const stringifyCompact = (value: unknown, maxLength = 1000): string | undefined => {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) {
      return undefined;
    }
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  } catch {
    return undefined;
  }
};

const messageFromRecord = (record: Record<string, unknown>): string | undefined => {
  const message = record.message;
  const detail = record.detail ?? record.details;
  const code = record.code ?? record.type;

  const messageText =
    typeof message === "string" && message.trim()
      ? message.trim()
      : detail && typeof detail === "string" && detail.trim()
        ? detail.trim()
        : undefined;

  if (!messageText) {
    return undefined;
  }

  return typeof code === "string" && code.trim() ? `${messageText} (${code.trim()})` : messageText;
};

const codexNotificationErrorMessage = (params: Record<string, unknown>): string => {
  const direct = messageFromRecord(params);
  if (direct) {
    return direct;
  }

  for (const key of ["error", "data", "details", "cause"]) {
    const nested = params[key];
    if (nested && typeof nested === "object") {
      const nestedMessage = messageFromRecord(nested as Record<string, unknown>);
      if (nestedMessage) {
        return nestedMessage;
      }
    }
    if (typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
  }

  return stringifyCompact(params) ?? "Codex app-server error.";
};

const isTransientCodexStatus = (message: string): boolean =>
  /^reconnecting(?:\.\.\.)?\s+\d+\/\d+$/i.test(message.trim()) ||
  /^retrying(?:\.\.\.)?\s+\d+\/\d+$/i.test(message.trim()) ||
  /^connection lost/i.test(message.trim());

class CodexAppServerClient {
  private child: ChildProcess | null = null;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private startPromise: Promise<void> | null = null;
  private activeTurn: ActiveTurn | null = null;
  private lastUsage: CodexCompletion["usage"];

  constructor(
    private readonly userId: string,
    private readonly apiKey: string
  ) {}

  stop(): void {
    this.rejectPendingRequests(new Error("Codex app-server client stopped."));
    this.finishTurnWithError(this.activeTurn, new Error("Codex app-server client stopped."));

    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
  }

  async complete(messages: ChatApiMessage[], model: string): Promise<CodexCompletion> {
    try {
      await this.ensureStarted();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(
        502,
        `Codex app-server 启动失败：${message}。请确认服务器已安装 Codex CLI，codex app-server --help 可以正常运行，并且 CODEX_PROVIDER_BASE_URL / CODEX_CONFIG_TEMPLATE 与用户 API key 匹配。`
      );
    }

    if (this.activeTurn) {
      throw new HttpError(409, "Codex app-server 正在处理上一条消息，请稍后再试。");
    }

    const turn = this.createTurn();
    this.activeTurn = turn;

    const completion = new Promise<CodexCompletion>((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });

    void this.startTurn(turn, promptFromMessages(messages), model).catch((error) => {
      this.finishTurnWithError(turn, error);
    });

    return completion;
  }

  private createTurn(): ActiveTurn {
    const timeout = setTimeout(() => {
      const turn = this.activeTurn;
      if (!turn || turn.settled) {
        return;
      }

      this.interruptTurn(turn);
      this.finishTurnWithError(
        turn,
        new HttpError(504, `Codex app-server 响应超时（${appConfig.codex.timeoutMs}ms）。`)
      );
    }, appConfig.codex.timeoutMs);

    return {
      start: Date.now(),
      fullText: "",
      finalText: "",
      deltaText: "",
      threadId: null,
      turnId: null,
      timeout,
      settled: false,
      resolve: () => undefined,
      reject: () => undefined
    };
  }

  private async startTurn(turn: ActiveTurn, prompt: string, model: string): Promise<void> {
    const cwd = appConfig.codex.workingDirectory;
    const normalizedModel = model || appConfig.codex.defaultModel;
    const networkAccess = isCodexNetworkEnabled();
    const threadResult = await this.request("thread/start", {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: appConfig.codex.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: appConfig.codex.sandbox,
      model: normalizedModel
    });
    const thread = threadResult && typeof threadResult === "object"
      ? (threadResult as Record<string, unknown>).thread
      : null;
    const threadId = thread && typeof thread === "object"
      ? (thread as Record<string, unknown>).id
      : undefined;

    if (typeof threadId !== "string" || !threadId) {
      throw new Error("Codex app-server did not return a thread id.");
    }

    turn.threadId = threadId;

    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: appConfig.codex.approvalPolicy,
      approvalsReviewer: "user",
      sandboxPolicy:
        appConfig.codex.sandbox === "workspace-write"
          ? {
              type: "workspaceWrite",
              writableRoots: [cwd],
              networkAccess,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false
            }
          : { type: "readOnly", networkAccess },
      model: normalizedModel,
      effort: normalizeReasoning(appConfig.codex.reasoningEffort)
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) {
      return;
    }

    if (!this.startPromise) {
      this.startPromise = this.start();
    }

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async start(): Promise<void> {
    const codexHome = appConfig.codex.authMode === "user-api-key"
      ? await prepareUserCodexHome(this.userId)
      : "";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(appConfig.codex.authMode === "user-api-key"
        ? {
            OPENAI_API_KEY: this.apiKey,
            [appConfig.codex.apiKeyEnv]: this.apiKey,
            CODEX_HOME: codexHome
          }
        : {})
    };

    this.child = spawn(appConfig.codex.command, ["app-server", "--listen", "stdio://"], {
      cwd: appConfig.codex.workingDirectory,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf8");
      let index: number;
      while ((index = this.stdoutBuffer.indexOf("\n")) >= 0) {
        const line = this.stdoutBuffer.slice(0, index).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
        if (!line) {
          continue;
        }

        try {
          this.handleMessage(JSON.parse(line) as JsonRpcMessage);
        } catch (error) {
          this.finishTurnWithError(
            this.activeTurn,
            new Error(`Failed to parse Codex app-server message: ${error instanceof Error ? error.message : String(error)}`)
          );
        }
      }
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.warn(`[codex-app-server] ${text}`);
      }
    });

    this.child.on("error", (error) => {
      this.rejectPendingRequests(error);
      this.finishTurnWithError(this.activeTurn, error);
      this.child = null;
    });

    this.child.on("close", (code) => {
      const error = new Error(`Codex app-server exited${code === null ? "" : ` (${code})`}.`);
      this.rejectPendingRequests(error);
      this.finishTurnWithError(this.activeTurn, error);
      this.child = null;
    });

    await this.request("initialize", {
      clientInfo: {
        name: "custom-gpt-web",
        title: "Custom GPT Web",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
    this.send({ method: "initialized", params: {} });
  }

  private send(message: JsonRpcMessage): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new HttpError(502, "Codex app-server stdin 不可用。");
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, appConfig.codex.timeoutMs);
      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex app-server request failed."));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message.id, message.method);
      return;
    }

    if (message.method) {
      this.handleNotification(message.method, message.params ?? {});
    }
  }

  private handleServerRequest(id: JsonRpcId, method: string): void {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval"
    ) {
      this.send({
        id,
        error: {
          code: -32000,
          message: "Custom GPT Web does not support interactive Codex approvals yet."
        }
      });
      return;
    }

    this.send({
      id,
      error: {
        code: -32601,
        message: `Unsupported Codex server request: ${method}`
      }
    });
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const turn = this.activeTurn;
    if (!turn || turn.settled) {
      return;
    }

    switch (method) {
      case "turn/started": {
        const turnInfo = params.turn;
        const threadId = params.threadId;
        if (typeof threadId === "string") {
          turn.threadId = threadId;
        }
        if (turnInfo && typeof turnInfo === "object") {
          const turnId = (turnInfo as Record<string, unknown>).id;
          if (typeof turnId === "string") {
            turn.turnId = turnId;
          }
        }
        break;
      }
      case "item/agentMessage/delta": {
        const delta = params.delta;
        if (typeof delta === "string") {
          turn.deltaText += delta;
          turn.fullText = turn.deltaText;
        }
        break;
      }
      case "item/completed": {
        const item = params.item;
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          if (record.type === "agentMessage" && typeof record.text === "string") {
            turn.finalText = record.text;
            turn.fullText = record.text;
          }
        }
        break;
      }
      case "thread/tokenUsage/updated":
        this.lastUsage = parseTokenUsage(params.tokenUsage);
        break;
      case "token_count":
        this.lastUsage = parseTokenUsage(params.info);
        break;
      case "turn/completed": {
        const content = (turn.finalText || turn.deltaText || turn.fullText).trim();
        this.finishTurn(turn, {
          content: content || "Codex 没有返回可展示的回复。",
          usage: this.lastUsage
        });
        break;
      }
      case "error":
        {
          const message = codexNotificationErrorMessage(params);
          if (isTransientCodexStatus(message)) {
            console.warn(`[codex-app-server] transient status: ${message}`);
            break;
          }
          this.finishTurnWithError(turn, new Error(message));
        }
        break;
      default:
        break;
    }
  }

  private interruptTurn(turn: ActiveTurn): void {
    if (!turn.threadId || !turn.turnId) {
      return;
    }

    void this.request("turn/interrupt", {
      threadId: turn.threadId,
      turnId: turn.turnId
    }).catch(() => undefined);
  }

  private finishTurn(turn: ActiveTurn | null, value: CodexCompletion): void {
    if (!turn || turn.settled) {
      return;
    }

    turn.settled = true;
    clearTimeout(turn.timeout);
    this.activeTurn = null;
    turn.resolve(value);
  }

  private finishTurnWithError(turn: ActiveTurn | null, error: unknown): void {
    if (!turn || turn.settled) {
      return;
    }

    turn.settled = true;
    clearTimeout(turn.timeout);
    this.activeTurn = null;
    const message = error instanceof Error ? error.message : String(error);
    turn.reject(error instanceof HttpError ? error : new HttpError(502, `Codex app-server 调用失败：${message}`));
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

const clients = new Map<string, CodexAppServerClient>();
const activeClientKeyByUser = new Map<string, string>();

const keyFingerprint = (apiKey: string): string =>
  apiKey ? crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16) : "server-login";

const clientFor = (userId: string, apiKey: string): CodexAppServerClient => {
  const fingerprint = keyFingerprint(apiKey);
  const key = `${userId}:${fingerprint}`;
  const existing = clients.get(key);
  if (existing) {
    return existing;
  }

  const previousKey = activeClientKeyByUser.get(userId);
  if (previousKey && previousKey !== key) {
    clients.get(previousKey)?.stop();
    clients.delete(previousKey);
  }

  const client = new CodexAppServerClient(userId, apiKey);
  clients.set(key, client);
  activeClientKeyByUser.set(userId, key);
  console.info(`[codex-app-server] starting client for user=${userId} key=${fingerprint}`);
  return client;
};

export const createCodexCompletion = (
  messages: ChatApiMessage[],
  model: string,
  options: { apiKey: string; userId: string }
): Promise<CodexCompletion> => {
  const apiKey = options.apiKey.trim();
  if (appConfig.codex.authMode === "user-api-key" && !apiKey) {
    throw new HttpError(400, "请先在页面中配置你的 OpenAI API key，Codex 文本模式会使用该用户自己的 key。");
  }

  return clientFor(options.userId, apiKey).complete(messages, model);
};

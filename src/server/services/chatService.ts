import { appConfig } from "../config";
import { createId } from "../utils/id";
import { createTextCompletion, generateImage } from "./openaiClient";
import { createCodexCompletion } from "./codexAppServerClient";
import { detectIntent } from "./intent";
import { runLocalDataCode } from "./dataRunner";
import { saveCodeRun } from "./codeRunStore";
import { writeGeneratedFile } from "./fileStore";
import { formatSearchContext, searchWeb, shouldUseWebSearch } from "./webSearchService";
import { getUserOpenAiApiKey } from "./userConfigService";
import { HttpError } from "../errors";
import type { AuthUser, ChatAttachment, ChatMessage, ChatRequest, ChatResponse } from "../../shared/types";

const getLatestPrompt = (messages: ChatMessage[]): string => messages[messages.length - 1]?.content ?? "";

const supportedTextMimeTypes = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/html",
  "text/css",
  "text/javascript",
  "application/javascript",
  "application/x-yaml",
  "text/yaml"
]);

const isSupportedUpload = (attachment: ChatAttachment): boolean =>
  attachment.mimeType.startsWith("image/") ||
  attachment.mimeType === "application/pdf" ||
  supportedTextMimeTypes.has(attachment.mimeType) ||
  /\.(txt|md|csv|json|ts|tsx|js|jsx|html|css|xml|yaml|yml|log)$/i.test(attachment.filename);

const kindFromUpload = (attachment: ChatAttachment): ChatAttachment["kind"] => {
  if (attachment.mimeType.startsWith("image/")) {
    return "image";
  }

  if (attachment.mimeType === "application/pdf" || /\.pdf$/i.test(attachment.filename)) {
    return "pdf";
  }

  return "file";
};

const normalizeUploads = (messages: ChatMessage[]): ChatMessage[] => {
  const uploadCount = messages.reduce(
    (count, message) =>
      count + (message.attachments?.filter((item) => item.source === "uploaded" && item.dataUrl).length ?? 0),
    0
  );

  if (uploadCount > appConfig.upload.maxFiles) {
    throw new HttpError(400, `最多一次上传 ${appConfig.upload.maxFiles} 个文件。`);
  }

  return messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map((attachment) => {
      if (attachment.source !== "uploaded") {
        return attachment;
      }

      if (!attachment.dataUrl) {
        return attachment;
      }

      if ((attachment.sizeBytes ?? 0) > appConfig.upload.maxBytesPerFile) {
        throw new HttpError(400, `文件过大：${attachment.filename}`);
      }

      if (!isSupportedUpload(attachment)) {
        throw new HttpError(400, `暂不支持该文件类型：${attachment.filename}`);
      }

      return {
        ...attachment,
        kind: kindFromUpload(attachment)
      };
    })
  }));
};

const toApiMessages = (messages: ChatMessage[]) => {
  const bounded = messages
    .slice(-appConfig.safety.maxHistoryMessages)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, appConfig.safety.maxMessageChars),
      attachments: message.attachments?.filter((attachment) => attachment.source === "uploaded" && attachment.dataUrl)
    }));

  return [
    {
      role: "system" as const,
      content: appConfig.openai.systemPrompt
    },
    ...bounded
  ];
};

const codexSystemAddendum = [
  "Codex runtime guidance:",
  "- For current, time-sensitive, or source-dependent questions, use available network access to inspect authoritative primary sources directly before answering.",
  "- Do not treat search snippets or page metadata as complete evidence when the user asks for complete results, tables, prices, laws, schedules, or other detailed facts.",
  "- If an official source is dynamic, continue by fetching structured page data, linked report pages, public APIs, or other authoritative pages that contain the actual data.",
  "- Answer with the best complete result you can verify, include source links, and clearly separate verified facts from uncertainty."
].join("\n");

const toCodexMessages = (messages: ChatMessage[]) => {
  const apiMessages = toApiMessages(messages).map((message) => ({
    role: message.role,
    content: message.content
  }));
  const systemMessage = apiMessages.find((message) => message.role === "system");

  if (systemMessage) {
    systemMessage.content = `${systemMessage.content}\n\n${codexSystemAddendum}`;
  }

  return apiMessages;
};

const createAssistantMessage = (
  content: string,
  attachments: ChatMessage["attachments"] = []
): ChatMessage => ({
  id: createId("msg"),
  role: "assistant",
  content,
  createdAt: new Date().toISOString(),
  attachments
});

const buildFilePrompt = (userPrompt: string): string => `
请根据用户要求生成一个可以保存为 Markdown 文档的完整内容。

要求：
- 直接输出文件正文。
- 不要包裹三反引号。
- 内容应结构清晰，适合用户下载后继续编辑。

用户要求：
${userPrompt}
`.trim();

const buildDataPlanPrompt = (userPrompt: string): string => `
Generate JavaScript for a local data-analysis sandbox.
Rules:
- Output JavaScript only. Do not wrap it in Markdown fences.
- Do not use import, require, process, fs, child_process, eval, Function, while, or infinite loops.
- You may use Array, Object, Map, Set, Math, JSON, Date, Number, String, Boolean, and fetch.
- fetch may only call HTTPS URLs. For market prices, klines, public statistics, or other public data, prefer authoritative public APIs and print the source URL.
- Use console.log to print the final computed answer and key assumptions.
- If the user did not explicitly ask for precise calculation, API retrieval, code execution, or saved code, print:
  console.log("This request should be answered with web research first. Run local code only after the user explicitly asks for precise calculation, API retrieval, or saved code.");

User task:
${userPrompt}
`.trim();

const stripMarkdownFence = (value: string): string =>
  value
    .replace(/^```(?:js|javascript|ts|typescript)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

const withWebSearchContext = async (prompt: string): Promise<string> => {
  if (!shouldUseWebSearch(prompt)) {
    return prompt;
  }

  const results = await searchWeb(prompt);
  return `${formatSearchContext(prompt, results)}\n\n用户原始问题：\n${prompt}`;
};

const needsWebSearch = (prompt: string): boolean => shouldUseWebSearch(prompt);

const shouldUseCodexTextRuntime = (messages: ChatMessage[]): boolean =>
  appConfig.ai.textRuntime === "codex" &&
  !messages.some((message) =>
    message.attachments?.some((attachment) => attachment.source === "uploaded" && attachment.dataUrl)
  );

const shouldUseCodexNetwork = (): boolean =>
  ["1", "true", "yes", "on", "enabled"].includes(appConfig.codex.networkAccess.trim().toLowerCase());

const shouldTryHostedWebSearch = (shouldSearch: boolean): boolean =>
  shouldSearch && appConfig.openai.textApi === "responses" && appConfig.search.openaiHostedTool;

const isHostedWebSearchFailure = (error: unknown): boolean => {
  if (!(error instanceof HttpError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.statusCode >= 500 &&
    (message.includes("upstream request failed") ||
      message.includes("web_search") ||
      message.includes("tool") ||
      message.includes("non-json response"))
  );
};

const createTextCompletionWithSearchFallback = async (
  messages: ChatMessage[],
  model: string,
  options: { apiKey?: string; shouldSearch: boolean; user: AuthUser }
) => {
  if (shouldUseCodexTextRuntime(messages)) {
    if (!options.apiKey) {
      throw new HttpError(400, "请先在页面中配置你的 OpenAI API key，Codex 文本模式会使用你的 key。");
    }

    const codexMessages = shouldUseCodexNetwork() ? messages : await messagesWithWebSearchContext(messages);

    return createCodexCompletion(toCodexMessages(codexMessages), model, {
      apiKey: options.apiKey,
      userId: options.user.uid
    });
  }

  if (!options.apiKey) {
    throw new HttpError(400, "请先在页面中配置你的 OpenAI API key。");
  }

  if (!options.shouldSearch) {
    return createTextCompletion(toApiMessages(messages), model, { apiKey: options.apiKey, webSearch: false });
  }

  if (shouldTryHostedWebSearch(true)) {
    try {
      return await createTextCompletion(toApiMessages(messages), model, {
        apiKey: options.apiKey,
        webSearch: true
      });
    } catch (error) {
      if (!isHostedWebSearchFailure(error)) {
        throw error;
      }

      console.warn(
        `Hosted web_search failed; retrying with local search context: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return createTextCompletion(toApiMessages(await messagesWithWebSearchContext(messages)), model, {
    apiKey: options.apiKey,
    webSearch: false
  });
};

const messagesWithWebSearchContext = async (messages: ChatMessage[]): Promise<ChatMessage[]> => {
  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== "user" || !shouldUseWebSearch(latest.content)) {
    return messages;
  }

  const content = await withWebSearchContext(latest.content);
  return [
    ...messages.slice(0, -1),
    {
      ...latest,
      content
    }
  ];
};

export const processChat = async (request: ChatRequest, user: AuthUser): Promise<ChatResponse> => {
  const normalizedMessages = normalizeUploads(request.messages);

  if (request.paused) {
    return {
      intent: "chat",
      message: createAssistantMessage("对话已暂停。点击继续后，我会接着处理你的下一条消息。")
    };
  }

  const openAiModel = appConfig.openai.models.includes(request.model)
    ? request.model
    : appConfig.openai.defaultModel;
  const codexModel = appConfig.codex.models.includes(request.model)
    ? request.model
    : appConfig.codex.defaultModel;
  const apiKey = await getUserOpenAiApiKey(user);
  const intent = detectIntent(normalizedMessages);
  const latestPrompt = getLatestPrompt(normalizedMessages);
  const latestMessage = normalizedMessages[normalizedMessages.length - 1];
  const latestHasUploadedAttachments = Boolean(
    latestMessage?.attachments?.some((attachment) => attachment.source === "uploaded" && attachment.dataUrl)
  );
  const hasUploadedAttachments = normalizedMessages.some((message) =>
    message.attachments?.some((attachment) => attachment.source === "uploaded" && attachment.dataUrl)
  );
  const textModel = appConfig.ai.textRuntime === "codex" && !hasUploadedAttachments ? codexModel : openAiModel;
  const requiresOpenAiApiKey =
    intent === "image" ||
    hasUploadedAttachments ||
    appConfig.ai.textRuntime !== "codex" ||
    appConfig.codex.authMode === "user-api-key";

  if (requiresOpenAiApiKey && !apiKey) {
    throw new HttpError(400, "请先在页面中配置你的 OpenAI API key。");
  }

  if (hasUploadedAttachments && appConfig.openai.textApi === "chat") {
    throw new HttpError(400, "上传图片、PDF 或文件需要 OPENAI_TEXT_API=responses。");
  }

  if (intent === "image" && !latestHasUploadedAttachments) {
    const image = await generateImage(latestPrompt, apiKey!);
    const attachment = await writeGeneratedFile(
      `${Date.now()}-generated-image.${image.extension}`,
      image.buffer,
      image.mimeType
    );

    return {
      intent,
      message: createAssistantMessage("图片已经生成，可以在下方直接预览，也可以右键保存。", [
        {
          ...attachment,
          kind: "image"
        }
      ])
    };
  }

  if (intent === "file") {
    const shouldSearch = needsWebSearch(latestPrompt);
    const fileMessages: ChatMessage[] = [{
      id: createId("msg"),
      role: "user",
      content: buildFilePrompt(latestPrompt),
      createdAt: new Date().toISOString()
    }];
    const completion = await createTextCompletionWithSearchFallback(fileMessages, textModel, {
      apiKey,
      shouldSearch,
      user
    });
    const attachment = await writeGeneratedFile(
      `${Date.now()}-generated-document.md`,
      completion.content,
      "text/markdown; charset=utf-8"
    );

    return {
      intent,
      usage: {
        promptTokens: completion.usage?.prompt_tokens,
        completionTokens: completion.usage?.completion_tokens,
        totalTokens: completion.usage?.total_tokens
      },
      message: createAssistantMessage("文件已经生成，点击下方按钮即可下载。", [attachment])
    };
  }

  if (intent === "data") {
    const shouldSearch = needsWebSearch(latestPrompt);
    const dataMessages: ChatMessage[] = [{
      id: createId("msg"),
      role: "user",
      content: buildDataPlanPrompt(latestPrompt),
      createdAt: new Date().toISOString()
    }];
    const codeCompletion = await createTextCompletionWithSearchFallback(dataMessages, textModel, {
      apiKey,
      shouldSearch,
      user
    });
    const code = stripMarkdownFence(codeCompletion.content);
    const result = await runLocalDataCode(code);
    const output = result.output || JSON.stringify(result.returned, null, 2) || "本地数据任务已执行。";
    const codeRun = await saveCodeRun(user, request.conversationId, code, output);
    const attachment = await writeGeneratedFile(
      `${Date.now()}-data-result.txt`,
      `Generated code:\n${code}\n\nOutput:\n${output}\n\nSaved code:\n${codeRun.codePath}\nSaved output:\n${codeRun.outputPath}\n`,
      "text/plain; charset=utf-8"
    );

    return {
      intent,
      usage: {
        promptTokens: codeCompletion.usage?.prompt_tokens,
        completionTokens: codeCompletion.usage?.completion_tokens,
        totalTokens: codeCompletion.usage?.total_tokens
      },
      message: createAssistantMessage(`本地数据任务已完成：\n\n${output}\n\n代码已保存：${codeRun.codePath}`, [
        {
          ...attachment,
          kind: "data"
        }
      ])
    };
  }

  const shouldSearch = needsWebSearch(latestPrompt);
  const completion = await createTextCompletionWithSearchFallback(normalizedMessages, textModel, {
    apiKey,
    shouldSearch,
    user
  });

  return {
    intent,
    usage: {
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
      totalTokens: completion.usage?.total_tokens
    },
    message: createAssistantMessage(completion.content)
  };
};

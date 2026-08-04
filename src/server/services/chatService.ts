import { appConfig } from "../config";
import { createId } from "../utils/id";
import { createTextCompletion, editImage, generateImage } from "./openaiClient";
import { createCodexCompletion } from "./codexAppServerClient";
import { detectIntent } from "./intent";
import { runLocalDataCode } from "./dataRunner";
import { saveCodeRun } from "./codeRunStore";
import { writeGeneratedFile } from "./fileStore";
import { formatSearchContext, searchWeb, shouldUseWebSearch } from "./webSearchService";
import { getUserOpenAiApiKey } from "./userConfigService";
import {
  attachmentTextForModel,
  hasBinaryUploadedAttachment,
  isSupportedUpload,
  kindFromUpload,
  materializeUploadedAttachmentText
} from "./attachmentContentService";
import { HttpError } from "../errors";
import type { AuthUser, ChatAttachment, ChatMessage, ChatProgressEvent, ChatRequest, ChatResponse } from "../../shared/types";

type ChatProgressReporter = (event: ChatProgressEvent) => void;

const progressEvent = (
  title: string,
  detail: string,
  kind: ChatProgressEvent["kind"] = "thinking"
): ChatProgressEvent => ({
  title,
  detail,
  kind,
  createdAt: new Date().toISOString()
});

const getLatestPrompt = (messages: ChatMessage[]): string => messages[messages.length - 1]?.content ?? "";

const uploadedImagesForImageTask = (messages: ChatMessage[]): ChatAttachment[] =>
  messages.flatMap((message) =>
    message.attachments?.filter(
      (attachment) =>
        attachment.source === "uploaded" &&
        Boolean(attachment.dataUrl) &&
        (attachment.kind === "image" || attachment.mimeType.startsWith("image/"))
    ) ?? []
  );

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

const contentWithAttachmentText = (message: Pick<ChatMessage, "content" | "attachments">): string => {
  const attachmentText = message.attachments
    ?.map(attachmentTextForModel)
    .filter(Boolean)
    .join("\n\n");

  return attachmentText ? `${message.content}\n\n${attachmentText}` : message.content;
};

const compactMessagesForContext = (messages: ChatMessage[]) => {
  const selected: Array<{
    role: ChatMessage["role"];
    content: string;
    attachments?: ChatAttachment[];
  }> = [];
  let used = 0;
  let compactedCount = 0;
  const maxMessages = appConfig.safety.maxHistoryMessages;
  const maxContextChars = appConfig.safety.maxContextChars;

  for (const message of [...messages].reverse()) {
    if (selected.length >= maxMessages) {
      compactedCount += 1;
      continue;
    }

    const fullContent = contentWithAttachmentText(message);
    const content = fullContent.slice(0, appConfig.safety.maxMessageChars);
    const attachments = message.attachments?.filter(
      (attachment) => attachment.source === "uploaded" && attachment.dataUrl
    );
    const attachmentBudget =
      attachments?.reduce((sum, attachment) => sum + attachment.filename.length + attachment.mimeType.length, 0) ?? 0;
    const cost = content.length + attachmentBudget;

    if (selected.length > 0 && used + cost > maxContextChars) {
      compactedCount += 1;
      continue;
    }

    used += cost;
    selected.push({
      role: message.role,
      content,
      attachments
    });
  }

  const bounded = selected.reverse();
  if (compactedCount > 0) {
    bounded.unshift({
      role: "assistant",
      content: `[上下文已自动压缩：有 ${compactedCount} 条较早消息因超过 ${maxContextChars} 字符预算未放入本次模型上下文。请优先依据当前保留的最新对话回答。]`
    });
  }

  return bounded;
};

const toApiMessages = (messages: ChatMessage[]) => {
  const bounded = compactMessagesForContext(messages);

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

const withWebSearchContext = async (prompt: string, onProgress?: ChatProgressReporter): Promise<string> => {
  if (!shouldUseWebSearch(prompt)) {
    return prompt;
  }

  const results = await searchWeb(prompt, (title, detail, kind) =>
    onProgress?.(progressEvent(title, detail, kind === "search" ? "search" : "network"))
  );
  return `${formatSearchContext(prompt, results)}\n\n用户原始问题：\n${prompt}`;
};

const needsWebSearch = (prompt: string): boolean => shouldUseWebSearch(prompt);

const shouldUseCodexTextRuntime = (messages: ChatMessage[]): boolean =>
  appConfig.ai.textRuntime === "codex" && !hasBinaryUploadedAttachment(messages);

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
  options: { apiKey?: string; shouldSearch: boolean; user: AuthUser; onProgress?: ChatProgressReporter }
) => {
  if (shouldUseCodexTextRuntime(messages)) {
    if (!options.apiKey) {
      throw new HttpError(400, "请先在页面中配置你的 API Key，Codex 文本模式会使用你的 key。");
    }

    const codexMessages = shouldUseCodexNetwork() ? messages : await messagesWithWebSearchContext(messages, options.onProgress);

    return createCodexCompletion(toCodexMessages(codexMessages), model, {
      apiKey: options.apiKey,
      userId: options.user.uid,
      onProgress: (title, detail, kind) =>
        options.onProgress?.(
          progressEvent(title, detail, kind === "search" ? "search" : kind === "network" ? "network" : "thinking")
        )
    });
  }

  if (!options.apiKey) {
    throw new HttpError(400, "请先在页面中配置你的 API Key。");
  }

  if (!options.shouldSearch) {
    options.onProgress?.(progressEvent("正在请求模型", `正在调用 ${model} 生成回复。`, "thinking"));
    return createTextCompletion(toApiMessages(messages), model, { apiKey: options.apiKey, webSearch: false });
  }

  if (shouldTryHostedWebSearch(true)) {
    try {
      options.onProgress?.(progressEvent("正在联网搜索", "正在使用模型内置 web_search 工具。", "search"));
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

  options.onProgress?.(progressEvent("正在整理搜索结果", "正在把检索到的来源放入回答上下文。", "search"));
  return createTextCompletion(toApiMessages(await messagesWithWebSearchContext(messages, options.onProgress)), model, {
    apiKey: options.apiKey,
    webSearch: false
  });
};

const messagesWithWebSearchContext = async (
  messages: ChatMessage[],
  onProgress?: ChatProgressReporter
): Promise<ChatMessage[]> => {
  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== "user" || !shouldUseWebSearch(latest.content)) {
    return messages;
  }

  const content = await withWebSearchContext(latest.content, onProgress);
  return [
    ...messages.slice(0, -1),
    {
      ...latest,
      content
    }
  ];
};

export type ProcessChatResponse = ChatResponse & {
  historyMessages: ChatMessage[];
};

export const processChat = async (
  request: ChatRequest,
  user: AuthUser,
  onProgress?: ChatProgressReporter
): Promise<ProcessChatResponse> => {
  const normalizedMessages = normalizeUploads(request.messages);
  onProgress?.(progressEvent("正在分析请求", "正在识别任务类型、模型、附件和会话上下文。", "thinking"));

  if (request.paused) {
    return {
      intent: "chat",
      historyMessages: normalizedMessages,
      message: createAssistantMessage("对话已暂停。点击继续后，我会接着处理你的下一条消息。")
    };
  }

  const hasAnyUploadedAttachments = normalizedMessages.some((message) =>
    message.attachments?.some((attachment) => attachment.source === "uploaded")
  );
  if (hasAnyUploadedAttachments) {
    onProgress?.(progressEvent("正在读取附件", "正在整理上传的图片、PDF 或文件内容。", "file"));
  }

  const materializedMessages = await materializeUploadedAttachmentText(normalizedMessages, (title, detail, kind) =>
    onProgress?.(progressEvent(title, detail, kind ?? "file"))
  );

  const openAiModel = appConfig.openai.models.includes(request.model)
    ? request.model
    : appConfig.openai.defaultModel;
  const codexModel = appConfig.codex.models.includes(request.model)
    ? request.model
    : appConfig.codex.defaultModel;
  const apiKey = await getUserOpenAiApiKey(user);
  const intent = detectIntent(materializedMessages);
  const latestPrompt = getLatestPrompt(materializedMessages);
  const imageReferences = uploadedImagesForImageTask(materializedMessages);
  const hasUploadedAttachments = hasBinaryUploadedAttachment(materializedMessages);
  const textModel = appConfig.ai.textRuntime === "codex" && !hasUploadedAttachments ? codexModel : openAiModel;
  const requiresOpenAiApiKey =
    intent === "image" ||
    hasUploadedAttachments ||
    appConfig.ai.textRuntime !== "codex" ||
    appConfig.codex.authMode === "user-api-key";

  if (requiresOpenAiApiKey && !apiKey) {
    throw new HttpError(400, "请先在页面中配置你的 API Key。");
  }

  if (hasUploadedAttachments && intent !== "image" && appConfig.openai.textApi === "chat") {
    throw new HttpError(400, "上传图片、PDF 或文件需要 OPENAI_TEXT_API=responses。");
  }

  if (intent === "image") {
    onProgress?.(
      progressEvent(
        imageReferences.length > 0 ? "正在根据参考图生成图片" : "正在生成图片",
        imageReferences.length > 0
          ? `正在用 ${appConfig.openai.imageModel} 读取上传图片并生成新图。`
          : `正在用 ${appConfig.openai.imageModel} 生成图片。`,
        "image"
      )
    );
    const image =
      imageReferences.length > 0
        ? await editImage(latestPrompt, imageReferences, apiKey!)
        : await generateImage(latestPrompt, apiKey!);
    onProgress?.(progressEvent("正在保存图片", "图片已生成，正在写入可下载文件。", "image"));
    const attachment = await writeGeneratedFile(
      `${Date.now()}-generated-image.${image.extension}`,
      image.buffer,
      image.mimeType
    );

    return {
      intent,
      historyMessages: materializedMessages,
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
    onProgress?.(progressEvent("正在生成文件内容", "正在组织可下载文档的正文结构。", "file"));
    const fileMessages: ChatMessage[] = [{
      id: createId("msg"),
      role: "user",
      content: buildFilePrompt(latestPrompt),
      createdAt: new Date().toISOString()
    }];
    const completion = await createTextCompletionWithSearchFallback(fileMessages, textModel, {
      apiKey,
      shouldSearch,
      user,
      onProgress
    });
    onProgress?.(progressEvent("正在保存文件", "文档正文已生成，正在写入可下载文件。", "file"));
    const attachment = await writeGeneratedFile(
      `${Date.now()}-generated-document.md`,
      completion.content,
      "text/markdown; charset=utf-8"
    );

    return {
      intent,
      historyMessages: materializedMessages,
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
    onProgress?.(progressEvent("正在生成代码", "该任务需要代码进行数据获取或分析，正在生成本地数据处理脚本。", "data"));
    const dataMessages: ChatMessage[] = [{
      id: createId("msg"),
      role: "user",
      content: buildDataPlanPrompt(latestPrompt),
      createdAt: new Date().toISOString()
    }];
    const codeCompletion = await createTextCompletionWithSearchFallback(dataMessages, textModel, {
      apiKey,
      shouldSearch,
      user,
      onProgress
    });
    const code = stripMarkdownFence(codeCompletion.content);
    onProgress?.(progressEvent("正在执行代码", "正在本地沙箱中运行生成的 HTTPS-only 数据获取或分析代码。", "data"));
    const result = await runLocalDataCode(code);
    const output = result.output || JSON.stringify(result.returned, null, 2) || "本地数据任务已执行。";
    onProgress?.(progressEvent("正在保存代码和结果", "正在按用户和会话保存代码、输出和下载附件。", "data"));
    const codeRun = await saveCodeRun(user, request.conversationId, code, output);
    const attachment = await writeGeneratedFile(
      `${Date.now()}-data-result.txt`,
      `Generated code:\n${code}\n\nOutput:\n${output}\n\nSaved code:\n${codeRun.codePath}\nSaved output:\n${codeRun.outputPath}\n`,
      "text/plain; charset=utf-8"
    );

    return {
      intent,
      historyMessages: materializedMessages,
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
  const completion = await createTextCompletionWithSearchFallback(materializedMessages, textModel, {
    apiKey,
    shouldSearch,
    user,
    onProgress
  });

  return {
    intent,
    historyMessages: materializedMessages,
    usage: {
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
      totalTokens: completion.usage?.total_tokens
    },
    message: createAssistantMessage(completion.content)
  };
};

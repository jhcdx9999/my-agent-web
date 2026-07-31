import { appConfig } from "../config";
import { createId } from "../utils/id";
import { createTextCompletion, generateImage } from "./openaiClient";
import { detectIntent } from "./intent";
import { runLocalDataCode } from "./dataRunner";
import { writeGeneratedFile } from "./fileStore";
import { HttpError } from "../errors";
import type { ChatAttachment, ChatMessage, ChatRequest, ChatResponse } from "../../shared/types";

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
    (count, message) => count + (message.attachments?.filter((item) => item.source === "uploaded").length ?? 0),
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
        throw new HttpError(400, `上传文件缺少内容：${attachment.filename}`);
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
      attachments: message.attachments?.filter((attachment) => attachment.source === "uploaded")
    }));

  return [
    {
      role: "system" as const,
      content: appConfig.openai.systemPrompt
    },
    ...bounded
  ];
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
你需要为一个本地 JavaScript 数据整理沙箱生成代码。

限制：
- 只输出 JavaScript 代码。
- 不要使用 import、require、process、fs、child_process、eval、Function、while 或无限循环。
- 可以使用 Array/Object/Map/Set/Math/JSON/Date。
- 用 console.log 输出整理、统计或计算结果。
- 如果用户没有给出明确数据，请输出 console.log("需要用户提供可统计的数据。");

用户任务：
${userPrompt}
`.trim();

const stripMarkdownFence = (value: string): string =>
  value
    .replace(/^```(?:js|javascript|ts|typescript)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

export const processChat = async (request: ChatRequest): Promise<ChatResponse> => {
  const normalizedMessages = normalizeUploads(request.messages);

  if (request.paused) {
    return {
      intent: "chat",
      message: createAssistantMessage("对话已暂停。点击继续后，我会接着处理你的下一条消息。")
    };
  }

  const model = appConfig.openai.models.includes(request.model)
    ? request.model
    : appConfig.openai.defaultModel;
  const intent = detectIntent(normalizedMessages);
  const latestPrompt = getLatestPrompt(normalizedMessages);
  const hasUploadedAttachments = normalizedMessages.some((message) =>
    message.attachments?.some((attachment) => attachment.source === "uploaded")
  );

  if (hasUploadedAttachments && appConfig.openai.textApi === "chat") {
    throw new HttpError(400, "上传图片、PDF 或文件需要 OPENAI_TEXT_API=responses。");
  }

  if (intent === "image" && !hasUploadedAttachments) {
    const image = await generateImage(latestPrompt);
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
    const completion = await createTextCompletion(toApiMessages([{
      id: createId("msg"),
      role: "user",
      content: buildFilePrompt(latestPrompt),
      createdAt: new Date().toISOString()
    }]), model);
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
    const codeCompletion = await createTextCompletion(toApiMessages([{
      id: createId("msg"),
      role: "user",
      content: buildDataPlanPrompt(latestPrompt),
      createdAt: new Date().toISOString()
    }]), model);
    const code = stripMarkdownFence(codeCompletion.content);
    const result = await runLocalDataCode(code);
    const output = result.output || JSON.stringify(result.returned, null, 2) || "本地数据任务已执行。";
    const attachment = await writeGeneratedFile(
      `${Date.now()}-data-result.txt`,
      `Generated code:\n${code}\n\nOutput:\n${output}\n`,
      "text/plain; charset=utf-8"
    );

    return {
      intent,
      usage: {
        promptTokens: codeCompletion.usage?.prompt_tokens,
        completionTokens: codeCompletion.usage?.completion_tokens,
        totalTokens: codeCompletion.usage?.total_tokens
      },
      message: createAssistantMessage(`本地数据任务已完成：\n\n${output}`, [
        {
          ...attachment,
          kind: "data"
        }
      ])
    };
  }

  const completion = await createTextCompletion(toApiMessages(normalizedMessages), model);

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

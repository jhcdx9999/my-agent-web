import { appConfig } from "../config";
import { HttpError } from "../errors";
import type { ChatAttachment } from "../../shared/types";

type ChatApiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  attachments?: ChatAttachment[];
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string; type?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

type ResponsesApiResponse = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

type ResponsesInputContent =
  | {
      type: "input_text";
      text: string;
    }
  | {
      type: "output_text";
      text: string;
    }
  | {
      type: "input_image";
      image_url: string;
      detail: "auto";
    }
  | {
      type: "input_file";
      filename: string;
      file_data?: string;
      file_url?: string;
    };

type ResponsesTool = {
  type: "web_search_preview";
};

type ImageResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
  error?: {
    message?: string;
  };
};

const requireApiKey = (): string => {
  if (!appConfig.openai.apiKey) {
    throw new HttpError(500, "OPENAI_API_KEY is not configured.");
  }

  return appConfig.openai.apiKey;
};

const parseResponseJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  let parsed = {} as T;

  try {
    parsed = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    throw new HttpError(response.ok ? 502 : response.status, parseNonJsonOpenAiError(text));
  }

  if (!response.ok) {
    const maybeError = parsed as { error?: { message?: string } };
    throw new HttpError(
      response.status,
      formatOpenAiErrorMessage(
        maybeError.error?.message ?? `OpenAI API request failed with ${response.status}.`
      ),
      parsed
    );
  }

  return parsed;
};

const formatOpenAiErrorMessage = (message: string): string =>
  /upstream request failed/i.test(message)
    ? `${message}。如果这是上传图片、PDF 或文件时出现，请确认 OPENAI_BASE_URL 对应的服务和当前模型支持 Responses API 的 input_image/input_file。`
    : message;

const parseNonJsonOpenAiError = (text: string): string => {
  const jsonFragments = [
    ...text.matchAll(/data:\s*(\{.*\})/g),
    ...text.matchAll(/(\{"error".*\})/g)
  ];

  for (const match of jsonFragments) {
    try {
      const parsed = JSON.parse(match[1]) as {
        error?: { message?: string; type?: string };
        response?: {
          error?: { message?: string; type?: string };
          status?: string;
        };
      };
      const message = parsed.error?.message ?? parsed.response?.error?.message;
      const type = parsed.error?.type ?? parsed.response?.error?.type ?? parsed.response?.status;
      if (message) {
        return `OpenAI 上游请求失败：${formatOpenAiErrorMessage(message)}${type ? ` (${type})` : ""}`;
      }
    } catch {
      // Keep looking for the next fragment.
    }
  }

  return `OpenAI API returned non-JSON response: ${text.slice(0, 180)}`;
};

const callOpenAi = async (path: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(`${appConfig.openai.baseUrl}${path}`, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(
      502,
      `无法连接 OpenAI 上游：${message}。请检查 OPENAI_BASE_URL、网络代理、防火墙和 API 服务可用性。`
    );
  }
};

const dataUrlToText = (dataUrl: string): string | undefined => {
  const marker = ";base64,";
  const markerIndex = dataUrl.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }

  try {
    return Buffer.from(dataUrl.slice(markerIndex + marker.length), "base64").toString("utf8");
  } catch {
    return undefined;
  }
};

const dataUrlWithMimeType = (dataUrl: string, mimeType: string): string => {
  const match = /^data:([^;,]*)(;base64,.*)$/i.exec(dataUrl);
  if (!match || !mimeType || mimeType === "application/octet-stream") {
    return dataUrl;
  }

  return match[1] ? dataUrl : `data:${mimeType}${match[2]}`;
};

const isTextAttachment = (attachment: ChatAttachment): boolean =>
  attachment.mimeType.startsWith("text/") ||
  [
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-yaml"
  ].includes(attachment.mimeType) ||
  /\.(txt|md|csv|json|ts|tsx|js|jsx|html|css|xml|yaml|yml|log)$/i.test(attachment.filename);

const attachmentToContent = (attachment: ChatAttachment): ResponsesInputContent | undefined => {
  if (!attachment.dataUrl) {
    return undefined;
  }

  if (attachment.kind === "image" || attachment.mimeType.startsWith("image/")) {
    return {
      type: "input_image",
      image_url: dataUrlWithMimeType(attachment.dataUrl, attachment.mimeType),
      detail: "auto"
    };
  }

  if (isTextAttachment(attachment)) {
    const text = dataUrlToText(attachment.dataUrl);
    return {
      type: "input_text",
      text: `\n\n[上传文件: ${attachment.filename}]\n${text ?? "文件内容无法按 UTF-8 文本读取。"}`
    };
  }

  return {
    type: "input_file",
    filename: attachment.filename,
    file_data: dataUrlWithMimeType(attachment.dataUrl, attachment.mimeType)
  };
};

const normalizeTextContent = (
  content: string | Array<{ text?: string; type?: string }> | undefined
): string => {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((item) => item.text ?? "").join("\n").trim();
  }

  return "";
};

const createChatCompletion = async (
  messages: ChatApiMessage[],
  model: string
): Promise<{ content: string; usage?: ChatCompletionResponse["usage"] }> => {
  if (messages.some((message) => message.attachments?.length)) {
    throw new HttpError(
      400,
      "Uploaded files require OPENAI_TEXT_API=responses. Chat Completions mode cannot process file attachments."
    );
  }

  const response = await callOpenAi("/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages
    })
  });

  const data = await parseResponseJson<ChatCompletionResponse>(response);
  const content = normalizeTextContent(data.choices?.[0]?.message?.content).trim();

  return {
    content: content || "我没有收到可展示的模型回复。",
    usage: data.usage
  };
};

const createResponsesCompletion = async (
  messages: ChatApiMessage[],
  model: string,
  options: { webSearch?: boolean } = {}
): Promise<{ content: string; usage?: ChatCompletionResponse["usage"] }> => {
  const system = messages.find((message) => message.role === "system")?.content;
  const hasAttachments = messages.some((message) => message.attachments?.length);
  const input = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (!message.attachments?.length) {
        return {
          role: message.role,
          content: message.content
        };
      }

      const content: ResponsesInputContent[] = [
        {
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: message.content
        }
      ];

      for (const attachment of message.attachments) {
        const item = attachmentToContent(attachment);
        if (item) {
          content.push(item);
        }
      }

      return {
        role: message.role,
        content
      };
    });

  const response = await callOpenAi("/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions: system,
      input,
      ...(options.webSearch && appConfig.search.openaiHostedTool
        ? { tools: [{ type: "web_search_preview" } satisfies ResponsesTool] }
        : {}),
      ...(hasAttachments ? { truncation: "auto" } : {})
    })
  });

  const data = await parseResponseJson<ResponsesApiResponse>(response);
  const content =
    data.output_text ??
    data.output
      ?.flatMap((item) => item.content ?? [])
      .map((item) => item.text ?? "")
      .join("\n")
      .trim() ??
    "";

  return {
    content: content || "我没有收到可展示的模型回复。",
    usage: {
      prompt_tokens: data.usage?.input_tokens,
      completion_tokens: data.usage?.output_tokens,
      total_tokens: data.usage?.total_tokens
    }
  };
};

export const createTextCompletion = async (
  messages: ChatApiMessage[],
  model: string,
  options: { webSearch?: boolean } = {}
): Promise<{ content: string; usage?: ChatCompletionResponse["usage"] }> => {
  if (appConfig.openai.textApi === "chat") {
    return createChatCompletion(messages, model);
  }

  return createResponsesCompletion(messages, model, options);
};

export const generateImage = async (
  prompt: string
): Promise<{ buffer: Buffer; mimeType: string; extension: "png" | "jpg" | "webp" }> => {
  const outputFormat = appConfig.openai.imageFormat === "jpeg" ? "jpg" : appConfig.openai.imageFormat;
  const extension = outputFormat === "jpg" ? "jpg" : outputFormat === "webp" ? "webp" : "png";
  const mimeType = extension === "jpg" ? "image/jpeg" : `image/${extension}`;

  const response = await callOpenAi("/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: appConfig.openai.imageModel,
      prompt,
      size: appConfig.openai.imageSize,
      quality: appConfig.openai.imageQuality,
      response_format: "b64_json",
      output_format: extension === "jpg" ? "jpeg" : extension
    })
  });

  const data = await parseResponseJson<ImageResponse>(response);
  const item = data.data?.[0];

  if (item?.b64_json) {
    return {
      buffer: Buffer.from(item.b64_json, "base64"),
      mimeType,
      extension
    };
  }

  if (item?.url) {
    const imageResponse = await fetch(item.url);
    if (!imageResponse.ok) {
      throw new HttpError(imageResponse.status, "Generated image URL could not be downloaded.");
    }
    return {
      buffer: Buffer.from(await imageResponse.arrayBuffer()),
      mimeType: imageResponse.headers.get("content-type") ?? mimeType,
      extension
    };
  }

  throw new HttpError(502, "Image generation returned no image data.", data);
};

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

type OpenAiRequestOptions = {
  apiKey: string;
  baseUrl?: string;
  webSearch?: boolean;
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

const isGptImage2Model = (): boolean => appConfig.openai.imageModel.trim().toLowerCase() === "gpt-image-2";

const requireApiKey = (apiKey: string): string => {
  const key = apiKey.trim();
  if (!key) {
    throw new HttpError(400, "请先配置你的 API Key。");
  }

  return key;
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
    ? `${message}。如果这是联网搜索或文件理解任务，请确认当前用户 baseUrl/OPENAI_BASE_URL 对应服务支持 Responses API 的 web_search/input_image/input_file；如果这是图片生成或改图，请确认该服务支持 /images/generations、/images/edits 和当前 OPENAI_IMAGE_MODEL。若提示包含撞击、爆炸、恐袭、真实建筑灾难等内容，上游安全策略也可能直接拒绝并隐藏真实错误。`
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

const isUnsafeImageEditPrompt = (prompt: string): boolean =>
  /(撞毁|撞击|爆炸|炸毁|坠毁|恐袭|袭击|燃烧|起火|倒塌|直升机.*撞|飞机.*撞|crash|collision|explode|explosion|terror|attack|burning|destroy)/i.test(prompt);

const openAiBaseUrl = (baseUrl?: string): string => (baseUrl?.trim() || appConfig.openai.baseUrl).replace(/\/$/, "");

const callOpenAi = async (path: string, init: RequestInit, baseUrl?: string): Promise<Response> => {
  try {
    return await fetch(`${openAiBaseUrl(baseUrl)}${path}`, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(
      502,
      `无法连接 OpenAI 上游：${message}。请检查当前用户 baseUrl/OPENAI_BASE_URL、网络代理、防火墙和 API 服务可用性。`
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

const dataUrlToBuffer = (dataUrl: string): Buffer | undefined => {
  const marker = ";base64,";
  const markerIndex = dataUrl.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }

  try {
    return Buffer.from(dataUrl.slice(markerIndex + marker.length), "base64");
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
  model: string,
  options: OpenAiRequestOptions
): Promise<{ content: string; usage?: ChatCompletionResponse["usage"] }> => {
  if (messages.some((message) => message.attachments?.length)) {
    throw new HttpError(
      400,
      "上传文件需要 OPENAI_TEXT_API=responses。Chat Completions 模式不能处理文件附件。"
    );
  }

  const response = await callOpenAi("/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey(options.apiKey)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2
    })
  }, options.baseUrl);

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
  options: OpenAiRequestOptions
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
      Authorization: `Bearer ${requireApiKey(options.apiKey)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions: system,
      input,
      reasoning: {
        effort: appConfig.openai.reasoningEffort
      },
      ...(options.webSearch && appConfig.search.openaiHostedTool
        ? { tools: [{ type: "web_search_preview" } satisfies ResponsesTool] }
        : {}),
      ...(hasAttachments ? { truncation: "auto" } : {})
    })
  }, options.baseUrl);

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
  options: OpenAiRequestOptions
): Promise<{ content: string; usage?: ChatCompletionResponse["usage"] }> => {
  if (appConfig.openai.textApi === "chat") {
    return createChatCompletion(messages, model, options);
  }

  return createResponsesCompletion(messages, model, options);
};

export const generateImage = async (
  prompt: string,
  options: { apiKey: string; baseUrl?: string } | string
): Promise<{ buffer: Buffer; mimeType: string; extension: "png" | "jpg" | "webp" }> => {
  const apiKey = typeof options === "string" ? options : options.apiKey;
  const baseUrl = typeof options === "string" ? undefined : options.baseUrl;
  const outputFormat = appConfig.openai.imageFormat === "jpeg" ? "jpg" : appConfig.openai.imageFormat;
  const extension = outputFormat === "jpg" ? "jpg" : outputFormat === "webp" ? "webp" : "png";
  const mimeType = extension === "jpg" ? "image/jpeg" : `image/${extension}`;

  const body: Record<string, string> = {
    model: appConfig.openai.imageModel,
    prompt,
    size: appConfig.openai.imageSize,
    quality: appConfig.openai.imageQuality
  };

  // ai-dingyue's verified gpt-image-2 path follows the SDK payload and rejects extra image-format fields.
  if (!isGptImage2Model()) {
    body.response_format = "b64_json";
    body.output_format = extension === "jpg" ? "jpeg" : extension;
  }

  const response = await callOpenAi("/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey(apiKey)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }, baseUrl);

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

  throw new HttpError(
    502,
    "Image generation returned no image data. 上游没有返回 b64_json 或 url，通常表示图片服务中途失败、内容策略拒绝后隐藏了真实错误，或当前中转站没有完整支持该图片响应格式。",
    data
  );
};

export const editImage = async (
  prompt: string,
  images: ChatAttachment[],
  options: { apiKey: string; baseUrl?: string } | string
): Promise<{ buffer: Buffer; mimeType: string; extension: "png" | "jpg" | "webp" }> => {
  const apiKey = typeof options === "string" ? options : options.apiKey;
  const baseUrl = typeof options === "string" ? undefined : options.baseUrl;
  const outputFormat = appConfig.openai.imageFormat === "jpeg" ? "jpg" : appConfig.openai.imageFormat;
  const extension = outputFormat === "jpg" ? "jpg" : outputFormat === "webp" ? "webp" : "png";
  const mimeType = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
  const form = new FormData();
  const imageAttachments = images.filter(
    (attachment) =>
      attachment.source === "uploaded" &&
      Boolean(attachment.dataUrl) &&
      (attachment.kind === "image" || attachment.mimeType.startsWith("image/"))
  );

  if (imageAttachments.length === 0) {
    return generateImage(prompt, { apiKey, baseUrl });
  }

  form.set("model", appConfig.openai.imageModel);
  form.set("prompt", prompt);
  form.set("size", appConfig.openai.imageEditSize);
  form.set("quality", appConfig.openai.imageQuality);

  // Keep gpt-image-2 edits aligned with the SDK payload: model, image, prompt, size, quality.
  if (!isGptImage2Model()) {
    form.set("response_format", "b64_json");
    form.set("output_format", extension === "jpg" ? "jpeg" : extension);
  }

  for (const attachment of imageAttachments) {
    const buffer = attachment.dataUrl ? dataUrlToBuffer(attachment.dataUrl) : undefined;
    if (!buffer) {
      continue;
    }

    form.append(
      "image",
      new Blob([buffer], { type: attachment.mimeType || "image/png" }),
      attachment.filename || `image.${extension}`
    );
  }

  let response: Response;
  try {
    response = await callOpenAi("/images/edits", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireApiKey(apiKey)}`
      },
      body: form
    }, baseUrl);
  } catch (error) {
    if (isUnsafeImageEditPrompt(prompt) && error instanceof HttpError) {
      throw new HttpError(
        error.statusCode,
        `${error.message}。这次提示包含撞击/毁坏类灾难画面，图像上游可能被安全策略拒绝。可以改成非真实伤亡灾难的安全表述，例如“添加两架直升机在远处盘旋，画面有电影感烟雾但不发生撞击”。`,
        error.details
      );
    }
    throw error;
  }

  let data: ImageResponse;
  try {
    data = await parseResponseJson<ImageResponse>(response);
  } catch (error) {
    if (isUnsafeImageEditPrompt(prompt) && error instanceof HttpError) {
      throw new HttpError(
        error.statusCode,
        `${error.message}。这次提示包含撞击/毁坏类灾难画面，图像上游可能被安全策略拒绝。可以改成非真实伤亡灾难的安全表述，例如“添加两架直升机在远处盘旋，画面有电影感烟雾但不发生撞击”。`,
        error.details
      );
    }
    throw error;
  }
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
      throw new HttpError(imageResponse.status, "Edited image URL could not be downloaded.");
    }
    return {
      buffer: Buffer.from(await imageResponse.arrayBuffer()),
      mimeType: imageResponse.headers.get("content-type") ?? mimeType,
      extension
    };
  }

  throw new HttpError(
    502,
    "Image editing returned no image data. 上游没有返回 b64_json 或 url，通常表示图片服务中途失败、内容策略拒绝后隐藏了真实错误，或当前中转站没有完整支持该图片响应格式。",
    data
  );
};

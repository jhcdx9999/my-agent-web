import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { appConfig } from "../config";
import { HttpError } from "../errors";
import type { ChatAttachment, ChatMessage, ChatProgressEvent } from "../../shared/types";

type AttachmentProgressReporter = (
  title: string,
  detail: string,
  kind?: ChatProgressEvent["kind"]
) => void;

const execFileAsync = promisify(execFile);

const textMimeTypes = new Set([
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

const isPdfAttachment = (attachment: ChatAttachment): boolean =>
  attachment.mimeType === "application/pdf" || /\.pdf$/i.test(attachment.filename);

export const isTextAttachment = (attachment: ChatAttachment): boolean =>
  attachment.mimeType.startsWith("text/") ||
  textMimeTypes.has(attachment.mimeType) ||
  /\.(txt|md|csv|json|ts|tsx|js|jsx|html|css|xml|yaml|yml|log)$/i.test(attachment.filename);

export const isSupportedUpload = (attachment: ChatAttachment): boolean =>
  attachment.mimeType.startsWith("image/") ||
  isPdfAttachment(attachment) ||
  isTextAttachment(attachment);

export const kindFromUpload = (attachment: ChatAttachment): ChatAttachment["kind"] => {
  if (attachment.mimeType.startsWith("image/")) {
    return "image";
  }

  if (isPdfAttachment(attachment)) {
    return "pdf";
  }

  return "file";
};

const dataUrlToBuffer = (dataUrl: string): Buffer => {
  const marker = ";base64,";
  const markerIndex = dataUrl.indexOf(marker);
  if (markerIndex < 0) {
    throw new HttpError(400, "上传文件内容格式不正确。");
  }

  return Buffer.from(dataUrl.slice(markerIndex + marker.length), "base64");
};

const decodeUtf16Be = (buffer: Buffer): string => {
  let output = "";
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    output += String.fromCharCode(buffer.readUInt16BE(index));
  }
  return output;
};

const decodeTextBuffer = (buffer: Buffer): string => {
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return decodeUtf16Be(buffer.subarray(2));
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }

  const utf8 = buffer.toString("utf8");
  const replacementCount = (utf8.match(/\uFFFD/g) ?? []).length;
  return replacementCount > Math.max(8, utf8.length * 0.02) ? buffer.toString("latin1") : utf8;
};

const cleanExtractedText = (text: string): string =>
  text
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const limitExtractedText = (text: string, filename: string): string => {
  const cleaned = cleanExtractedText(text);
  if (cleaned.length <= appConfig.upload.maxExtractedTextChars) {
    return cleaned;
  }

  return `${cleaned.slice(0, appConfig.upload.maxExtractedTextChars)}\n\n[${filename} 内容较长，已截断到 ${appConfig.upload.maxExtractedTextChars} 字符。]`;
};

const decodePdfLiteralString = (value: string): string => {
  let output = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      output += char;
      continue;
    }

    index += 1;
    const escaped = value[index];
    if (!escaped) {
      break;
    }

    if (escaped === "n") output += "\n";
    else if (escaped === "r") output += "\r";
    else if (escaped === "t") output += "\t";
    else if (escaped === "b") output += "\b";
    else if (escaped === "f") output += "\f";
    else if (escaped === "(" || escaped === ")" || escaped === "\\") output += escaped;
    else if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      for (let count = 0; count < 2 && /[0-7]/.test(value[index + 1] ?? ""); count += 1) {
        index += 1;
        octal += value[index];
      }
      output += String.fromCharCode(Number.parseInt(octal, 8));
    } else {
      output += escaped;
    }
  }

  return output;
};

const decodePdfHexString = (value: string): string => {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized) {
    return "";
  }

  const padded = normalized.length % 2 === 0 ? normalized : `${normalized}0`;
  const buffer = Buffer.from(padded, "hex");
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return decodeUtf16Be(buffer.subarray(2));
  }

  if (buffer.length >= 4 && buffer.every((byte, index) => index % 2 === 0 || byte < 0x80)) {
    const everyOtherZero = buffer.filter((_, index) => index % 2 === 0).every((byte) => byte === 0);
    if (everyOtherZero) {
      return decodeUtf16Be(buffer);
    }
  }

  return decodeTextBuffer(buffer);
};

const isUsefulTextPiece = (text: string): boolean => {
  const cleaned = cleanExtractedText(text);
  return cleaned.length > 1 && /[\p{L}\p{N}\u4e00-\u9fff]/u.test(cleaned);
};

const extractPdfTextPieces = (content: string): string[] => {
  const pieces: string[] = [];
  const tokenPattern = /\((?:\\.|[^\\)])*\)|<([0-9a-fA-F\s]{4,})>/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(content)) !== null) {
    const token = match[0];
    const previousChar = content[Math.max(0, match.index - 1)];
    const nextChar = content[match.index + token.length];
    if (token.startsWith("<") && (previousChar === "<" || nextChar === ">")) {
      continue;
    }

    const decoded = token.startsWith("(")
      ? decodePdfLiteralString(token.slice(1, -1))
      : decodePdfHexString(token.slice(1, -1));
    const cleaned = cleanExtractedText(decoded);
    if (isUsefulTextPiece(cleaned) && pieces[pieces.length - 1] !== cleaned) {
      pieces.push(cleaned);
    }
  }

  return pieces;
};

const inflatePdfStream = (dictionary: string, stream: string): string => {
  const raw = stream.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  const buffer = Buffer.from(raw, "latin1");
  if (!/FlateDecode/i.test(dictionary)) {
    return buffer.toString("latin1");
  }

  try {
    return zlib.inflateSync(buffer).toString("latin1");
  } catch {
    try {
      return zlib.inflateRawSync(buffer).toString("latin1");
    } catch {
      return "";
    }
  }
};

const extractPdfTextFallback = (buffer: Buffer): string => {
  const pdf = buffer.toString("latin1");
  const pieces: string[] = [];
  const streamPattern = /\bstream\r?\n?/g;
  let match: RegExpExecArray | null;

  while ((match = streamPattern.exec(pdf)) !== null) {
    const bodyStart = streamPattern.lastIndex;
    const bodyEnd = pdf.indexOf("endstream", bodyStart);
    if (bodyEnd < 0) {
      break;
    }

    const dictionary = pdf.slice(Math.max(0, match.index - 1500), match.index);
    const streamText = inflatePdfStream(dictionary, pdf.slice(bodyStart, bodyEnd));
    if (streamText) {
      pieces.push(...extractPdfTextPieces(streamText));
    }

    streamPattern.lastIndex = bodyEnd + "endstream".length;
  }

  if (pieces.length === 0) {
    pieces.push(...extractPdfTextPieces(pdf));
  }

  return cleanExtractedText(pieces.join(" "));
};

const tryExtractPdfWithPoppler = async (buffer: Buffer): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-web-pdf-"));
  const pdfPath = path.join(tempDir, "upload.pdf");

  try {
    await fs.writeFile(pdfPath, buffer);
    const { stdout } = await execFileAsync("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
      encoding: "utf8",
      maxBuffer: appConfig.upload.maxExtractedTextChars * 4,
      timeout: 15000,
      windowsHide: true
    });
    return cleanExtractedText(stdout);
  } catch {
    return "";
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

const extractPdfText = async (buffer: Buffer): Promise<string> => {
  const popplerText = await tryExtractPdfWithPoppler(buffer);
  if (popplerText) {
    return popplerText;
  }

  return extractPdfTextFallback(buffer);
};

const attachmentTextBlock = (attachment: ChatAttachment, text: string): string =>
  [
    `[上传附件: ${attachment.filename}]`,
    `类型: ${attachment.mimeType || attachment.kind}`,
    text
  ].join("\n");

const materializeUploadedAttachment = async (
  attachment: ChatAttachment,
  onProgress?: AttachmentProgressReporter
): Promise<ChatAttachment> => {
  if (attachment.source !== "uploaded" || !attachment.dataUrl) {
    return attachment;
  }

  if (attachment.mimeType.startsWith("image/")) {
    return attachment;
  }

  const buffer = dataUrlToBuffer(attachment.dataUrl);

  if (isPdfAttachment(attachment)) {
    onProgress?.("正在解析 PDF", `正在从 ${attachment.filename} 提取可分析的文字内容。`, "file");
    const extracted = await extractPdfText(buffer);
    const text = extracted
      ? limitExtractedText(extracted, attachment.filename)
      : "未能从该 PDF 直接提取文字。它可能是扫描件、加密文件，或使用了无法映射的嵌入字体；请改传可复制文字的 PDF，或先进行 OCR 后再上传。";

    return {
      ...attachment,
      kind: "pdf",
      dataUrl: undefined,
      previewUrl: undefined,
      textContent: attachmentTextBlock(attachment, text),
      description: extracted ? "PDF 已在服务器端解析为文本上下文。" : "PDF 未能提取到可分析文本。"
    };
  }

  if (isTextAttachment(attachment)) {
    onProgress?.("正在读取文件", `正在按文本读取 ${attachment.filename}。`, "file");
    return {
      ...attachment,
      kind: "file",
      dataUrl: undefined,
      previewUrl: undefined,
      textContent: attachmentTextBlock(
        attachment,
        limitExtractedText(decodeTextBuffer(buffer), attachment.filename)
      ),
      description: "文件已在服务器端解析为文本上下文。"
    };
  }

  return attachment;
};

export const materializeUploadedAttachmentText = async (
  messages: ChatMessage[],
  onProgress?: AttachmentProgressReporter
): Promise<ChatMessage[]> =>
  Promise.all(
    messages.map(async (message) => ({
      ...message,
      attachments: message.attachments
        ? await Promise.all(
            message.attachments.map((attachment) => materializeUploadedAttachment(attachment, onProgress))
          )
        : undefined
    }))
  );

export const attachmentTextForModel = (attachment: ChatAttachment): string | undefined => {
  const text = attachment.textContent?.trim();
  if (!text) {
    return undefined;
  }

  return text;
};

export const hasBinaryUploadedAttachment = (messages: ChatMessage[]): boolean =>
  messages.some((message) =>
    message.attachments?.some((attachment) => attachment.source === "uploaded" && Boolean(attachment.dataUrl))
  );

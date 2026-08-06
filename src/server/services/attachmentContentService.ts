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

const isCjkChar = (char: string): boolean => /[\u3400-\u9fff\uf900-\ufaff]/u.test(char);
const isAsciiTextChar = (char: string): boolean => /[A-Za-z0-9]/.test(char);
const isCommonReadableChar = (char: string): boolean =>
  isCjkChar(char) ||
  isAsciiTextChar(char) ||
  /[\s.,;:!?()[\]{}'"@#%&*+=/_|<>~`$^，。；：！？（）【】《》“”‘’、·・-]/u.test(char);

const textStats = (text: string) => {
  const chars = [...cleanExtractedText(text)];
  const cjkChars = chars.filter(isCjkChar).length;
  const asciiTextChars = chars.filter(isAsciiTextChar).length;
  const readableChars = chars.filter(isCommonReadableChar).length;
  const replacementChars = chars.filter((char) => char === "\uFFFD").length;
  const suspiciousChars = chars.filter((char) => !isCommonReadableChar(char)).length;

  return {
    length: chars.length,
    cjkChars,
    asciiTextChars,
    readableChars,
    replacementChars,
    suspiciousChars
  };
};

const textQualityScore = (text: string): number => {
  const cleaned = cleanExtractedText(text);
  if (!cleaned) {
    return 0;
  }

  const stats = textStats(cleaned);
  const readableRatio = stats.readableChars / Math.max(stats.length, 1);
  const suspiciousRatio = stats.suspiciousChars / Math.max(stats.length, 1);
  const resumeKeywordBonus = /(简历|出生年月|手机号码|电子邮箱|教育|本科|硕士|工作|项目|成果|集团|经理|负责)/u.test(cleaned)
    ? 800
    : 0;

  return (
    stats.cjkChars * 6 +
    stats.asciiTextChars * 2 +
    readableRatio * 500 +
    resumeKeywordBonus -
    stats.replacementChars * 80 -
    stats.suspiciousChars * 8 -
    suspiciousRatio * 1200
  );
};

const isReadableExtractedText = (text: string): boolean => {
  const cleaned = cleanExtractedText(text);
  if (cleaned.length < 20) {
    return false;
  }

  const stats = textStats(cleaned);
  const meaningfulChars = stats.cjkChars + stats.asciiTextChars;
  const readableRatio = stats.readableChars / Math.max(stats.length, 1);
  const suspiciousRatio = stats.suspiciousChars / Math.max(stats.length, 1);

  return (
    meaningfulChars >= 12 &&
    readableRatio >= 0.72 &&
    suspiciousRatio <= 0.18 &&
    stats.replacementChars <= 2
  );
};

const dedupeLines = (text: string): string => {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const line of cleanExtractedText(text).split(/\r?\n/)) {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (!normalized) {
      if (lines[lines.length - 1] !== "") {
        lines.push("");
      }
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    lines.push(line.trim());
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

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

const tryExtractPdfWithPoppler = async (pdfPath: string): Promise<string> => {
  if (!appConfig.upload.pdfTextCommand) {
    return "";
  }

  try {
    const { stdout } = await execFileAsync(
      appConfig.upload.pdfTextCommand,
      ["-layout", "-enc", "UTF-8", pdfPath, "-"],
      {
        encoding: "utf8",
        maxBuffer: appConfig.upload.maxExtractedTextChars * 8,
        timeout: 15000,
        windowsHide: true
      }
    );
    return cleanExtractedText(stdout);
  } catch {
    return "";
  }
};

const pdfPythonExtractorScript = `
import sys
path = sys.argv[1]
texts = []
def stats(text):
    chars = list(text.strip())
    if not chars:
        return 0
    cjk = sum(1 for ch in chars if "\\u3400" <= ch <= "\\u9fff")
    ascii_text = sum(1 for ch in chars if ch.isascii() and ch.isalnum())
    readable = sum(1 for ch in chars if ("\\u3400" <= ch <= "\\u9fff") or (ch.isascii() and (ch.isalnum() or ch.isspace() or ch in ".,;:!?()[]{}'\\\"@#%&*+=/_|<>~$^-")) or ch in "，。；：！？（）【】《》“”‘’、·・")
    suspicious = len(chars) - readable
    bonus = 800 if any(word in text for word in ["简历", "出生年月", "手机号码", "电子邮箱", "教育", "本科", "硕士", "工作", "成果", "经理", "负责"]) else 0
    return cjk * 6 + ascii_text * 2 + readable / max(len(chars), 1) * 500 + bonus - suspicious * 8
try:
    from pypdf import PdfReader
    reader = PdfReader(path)
    texts.append("\\n".join((page.extract_text() or "") for page in reader.pages))
except Exception:
    pass
try:
    import pdfplumber
    with pdfplumber.open(path) as pdf:
        texts.append("\\n".join((page.extract_text() or "") for page in pdf.pages))
except Exception:
    pass
print(max((text for text in texts if text), key=stats, default=""))
`.trim();

const tryExtractPdfWithPython = async (pdfPath: string): Promise<string> => {
  const commands = appConfig.upload.pdfPythonCommands;

  for (const command of commands) {
    try {
      const { stdout } = await execFileAsync(command, ["-c", pdfPythonExtractorScript, pdfPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8"
        },
        maxBuffer: appConfig.upload.maxExtractedTextChars * 8,
        timeout: 20000,
        windowsHide: true
      });
      const text = cleanExtractedText(stdout);
      if (isReadableExtractedText(text)) {
        return text;
      }
    } catch {
      // Try the next configured Python command.
    }
  }

  return "";
};

const extractPdfText = async (buffer: Buffer): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-web-pdf-"));
  const pdfPath = path.join(tempDir, "upload.pdf");

  try {
    await fs.writeFile(pdfPath, buffer);
    const candidates = [
      await tryExtractPdfWithPoppler(pdfPath),
      dedupeLines(await tryExtractPdfWithPython(pdfPath)),
      extractPdfTextFallback(buffer)
    ]
      .map(cleanExtractedText)
      .filter(Boolean)
      .sort((left, right) => textQualityScore(right) - textQualityScore(left));
    const best = candidates[0] ?? "";

    return isReadableExtractedText(best) ? best : "";
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

const imageDimensions = (buffer: Buffer): { width?: number; height?: number; format?: string } => {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      format: "png"
    };
  }

  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) {
        break;
      }
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
          format: "jpeg"
        };
      }
      offset += 2 + length;
    }
  }

  if (buffer.length >= 30 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = buffer.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
        format: "webp"
      };
    }
    return { format: "webp" };
  }

  return {};
};

const tryExtractImageTextWithOcr = async (imagePath: string): Promise<string> => {
  if (!appConfig.upload.imageOcrCommand) {
    return "";
  }

  try {
    const { stdout } = await execFileAsync(
      appConfig.upload.imageOcrCommand,
      [imagePath, "stdout", "-l", appConfig.upload.imageOcrLang],
      {
        encoding: "utf8",
        maxBuffer: appConfig.upload.maxExtractedTextChars * 8,
        timeout: appConfig.upload.imageOcrTimeoutMs,
        windowsHide: true
      }
    );
    return cleanExtractedText(stdout);
  } catch {
    return "";
  }
};

const extractImageText = async (buffer: Buffer, filename: string): Promise<{ text: string; description: string }> => {
  const dimensions = imageDimensions(buffer);
  const dimensionText = dimensions.width && dimensions.height
    ? `${dimensions.width}x${dimensions.height}`
    : "unknown";
  const info = [
    `文件名: ${filename}`,
    `图片格式: ${dimensions.format ?? "unknown"}`,
    `图片尺寸: ${dimensionText}`,
    `文件大小: ${buffer.length} bytes`
  ].join("\n");

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-web-image-"));
  const imagePath = path.join(tempDir, filename.replace(/[^\w.-]+/g, "_") || "upload-image");

  try {
    await fs.writeFile(imagePath, buffer);
    const ocrText = await tryExtractImageTextWithOcr(imagePath);
    const limitedText = ocrText ? limitExtractedText(ocrText, filename) : "";
    return {
      text: [
        info,
        limitedText
          ? `OCR 提取文字:\n${limitedText}`
          : "OCR 提取文字: 未提取到可读文字；请基于图片文件信息说明能力限制，或建议用户粘贴原文/安装 OCR。"
      ].join("\n"),
      description: limitedText
        ? "图片已在服务器端 OCR 为文本上下文。"
        : "图片已转换为文件信息；OCR 未提取到可读文字。"
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

const attachmentTextBlock = (attachment: ChatAttachment, text: string): string =>
  [
    `[上传附件: ${attachment.filename}]`,
    `类型: ${attachment.mimeType || attachment.kind}`,
    text
  ].join("\n");

const materializeUploadedAttachment = async (
  attachment: ChatAttachment,
  onProgress?: AttachmentProgressReporter,
  options: { preserveImageData?: boolean } = {}
): Promise<ChatAttachment> => {
  if (attachment.source !== "uploaded" || !attachment.dataUrl) {
    return attachment;
  }

  const buffer = dataUrlToBuffer(attachment.dataUrl);

  if (attachment.mimeType.startsWith("image/")) {
    if (options.preserveImageData || appConfig.upload.imageMode === "vision") {
      return attachment;
    }

    onProgress?.("正在分析图片", `正在从 ${attachment.filename} 提取图片信息和可读文字。`, "file");
    const extracted = await extractImageText(buffer, attachment.filename);

    return {
      ...attachment,
      kind: "image",
      dataUrl: undefined,
      previewUrl: undefined,
      textContent: attachmentTextBlock(attachment, extracted.text),
      description: extracted.description
    };
  }

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
  onProgress?: AttachmentProgressReporter,
  options: { preserveImageData?: boolean } = {}
): Promise<ChatMessage[]> =>
  Promise.all(
    messages.map(async (message) => ({
      ...message,
      attachments: message.attachments
        ? await Promise.all(
            message.attachments.map((attachment) => materializeUploadedAttachment(attachment, onProgress, options))
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

import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config";
import { ensureDirectory, safeGeneratedPath } from "../utils/fs";
import { createId } from "../utils/id";
import type { ChatAttachment } from "../../shared/types";

const mimeFromExtension = (extension: string): string => {
  switch (extension.toLowerCase()) {
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pdf":
      return "application/pdf";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
};

export const writeGeneratedFile = async (
  basename: string,
  data: Buffer | string,
  mimeType?: string
): Promise<ChatAttachment> => {
  await ensureDirectory(appConfig.storageDir);

  const filename = basename.replace(/[^\w.-]+/g, "_");
  const filePath = safeGeneratedPath(appConfig.storageDir, filename);
  await fs.writeFile(filePath, data);

  const stats = await fs.stat(filePath);
  const extension = path.extname(filename);

  return {
    id: createId("att"),
    kind: mimeFromExtension(extension).startsWith("image/") ? "image" : "file",
    source: "generated",
    filename,
    mimeType: mimeType ?? mimeFromExtension(extension),
    url: `/downloads/${encodeURIComponent(filename)}`,
    previewUrl: mimeFromExtension(extension).startsWith("image/")
      ? `/downloads/${encodeURIComponent(filename)}`
      : undefined,
    sizeBytes: stats.size
  };
};

export const getGeneratedFilePath = (filename: string): string =>
  safeGeneratedPath(appConfig.storageDir, filename);

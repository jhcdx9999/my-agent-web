import fs from "node:fs/promises";
import path from "node:path";

export const ensureDirectory = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

export const safeGeneratedPath = (baseDir: string, filename: string): string => {
  const normalized = filename.replace(/[^\w.-]+/g, "_");
  const targetPath = path.resolve(baseDir, normalized);
  const resolvedBase = path.resolve(baseDir);

  if (!targetPath.startsWith(resolvedBase + path.sep) && targetPath !== resolvedBase) {
    throw new Error("Invalid generated file path.");
  }

  return targetPath;
};

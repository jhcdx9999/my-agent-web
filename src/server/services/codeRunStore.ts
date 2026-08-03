import fs from "node:fs/promises";
import path from "node:path";
import { ensureDirectory, safeGeneratedPath } from "../utils/fs";
import { userStorageDir } from "./authService";
import type { AuthUser } from "../../shared/types";

type SavedCodeRun = {
  codePath: string;
  outputPath: string;
};

const safeSegment = (value: string): string => value.replace(/[^\w.-]+/g, "_").slice(0, 80) || "default";

export const saveCodeRun = async (
  user: AuthUser,
  conversationId: string | undefined,
  code: string,
  output: string
): Promise<SavedCodeRun> => {
  const runDir = path.join(userStorageDir(user.uid), "code-runs", safeSegment(conversationId ?? "no-conversation"));
  await ensureDirectory(runDir);

  const stamp = new Date().toISOString().replace(/[^\d]+/g, "").slice(0, 14);
  const basename = `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
  const codePath = safeGeneratedPath(runDir, `${basename}.js`);
  const outputPath = safeGeneratedPath(runDir, `${basename}.output.txt`);

  await fs.writeFile(codePath, code, "utf8");
  await fs.writeFile(outputPath, output, "utf8");

  return {
    codePath,
    outputPath
  };
};

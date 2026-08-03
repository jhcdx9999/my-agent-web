import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config";
import { HttpError } from "../errors";
import { ensureDirectory } from "../utils/fs";
import type { AuthUser } from "../../shared/types";

export type DominantUserRecord = {
  id?: string;
  username?: string;
  account?: string;
  password?: string;
  openaiApiKey?: string;
  apiKey?: string;
};

type UserConfigFile =
  | DominantUserRecord[]
  | {
      users?: DominantUserRecord[];
      accounts?: DominantUserRecord[];
    };

const normalizeUsername = (username: string): string => username.trim().toLowerCase();

const normalizeConfig = (value: UserConfigFile): { wrapper: "array" | "users" | "accounts"; users: DominantUserRecord[] } => {
  if (Array.isArray(value)) {
    return { wrapper: "array", users: value };
  }

  if (Array.isArray(value.users)) {
    return { wrapper: "users", users: value.users };
  }

  if (Array.isArray(value.accounts)) {
    return { wrapper: "accounts", users: value.accounts };
  }

  return { wrapper: "users", users: [] };
};

const readRawUserConfig = async (): Promise<{ wrapper: "array" | "users" | "accounts"; users: DominantUserRecord[] }> => {
  try {
    const raw = await fs.readFile(appConfig.dominantUsersFile, "utf8");
    const cleaned = raw.replace(/^\uFEFF/, "").trim();
    return cleaned ? normalizeConfig(JSON.parse(cleaned) as UserConfigFile) : { wrapper: "users", users: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { wrapper: "users", users: [] };
    }

    throw error;
  }
};

const writeRawUserConfig = async (config: {
  wrapper: "array" | "users" | "accounts";
  users: DominantUserRecord[];
}): Promise<void> => {
  await ensureDirectory(path.dirname(appConfig.dominantUsersFile));
  const value =
    config.wrapper === "array"
      ? config.users
      : {
          [config.wrapper]: config.users
        };

  await fs.writeFile(appConfig.dominantUsersFile, `${JSON.stringify(value, null, 2)}\n`);
};

export const readDominantUserRecords = async (options: { requireFile?: boolean } = {}): Promise<DominantUserRecord[]> => {
  const config = await readRawUserConfig();
  if (options.requireFile && config.users.length === 0) {
    try {
      await fs.access(appConfig.dominantUsersFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HttpError(
          500,
          `dominant 登录模式已启用，但根目录缺少 ${path.basename(appConfig.dominantUsersFile)}。`
        );
      }
    }
  }

  return config.users;
};

const entryMatchesUser = (entry: DominantUserRecord, user: AuthUser): boolean => {
  const username = normalizeUsername(entry.username ?? entry.account ?? "");
  return Boolean(entry.id && entry.id === user.id) || Boolean(username && username === user.username);
};

export const getUserOpenAiApiKey = async (user: AuthUser): Promise<string> => {
  const config = await readRawUserConfig();
  const entry = config.users.find((item) => entryMatchesUser(item, user));
  return (entry?.openaiApiKey ?? entry?.apiKey ?? "").trim();
};

export const userHasOpenAiApiKey = async (user: AuthUser): Promise<boolean> =>
  Boolean(await getUserOpenAiApiKey(user));

export const saveUserOpenAiApiKey = async (user: AuthUser, apiKey: string): Promise<void> => {
  const key = apiKey.trim();
  if (key.length < 20 || /\s/.test(key)) {
    throw new HttpError(400, "请输入有效的 OpenAI API key。");
  }

  const config = await readRawUserConfig();
  const existing = config.users.find((item) => entryMatchesUser(item, user));

  if (existing) {
    existing.openaiApiKey = key;
    delete existing.apiKey;
  } else {
    config.users.push({
      id: user.id,
      username: user.username,
      openaiApiKey: key
    });
  }

  await writeRawUserConfig(config);
};

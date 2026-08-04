import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { appConfig } from "../config";
import { HttpError } from "../errors";
import { ensureDirectory } from "../utils/fs";
import type { AuthUser } from "../../shared/types";

export type DominantUserRecord = {
  uid?: string;
  id?: string;
  username?: string;
  account?: string;
  authMode?: "free" | "dominant";
  password?: string;
  passwordHash?: string;
  salt?: string;
  createdAt?: string;
  openaiApiKey?: string;
  apiKey?: string;
};

const normalizeUsername = (username: string): string => username.trim().toLowerCase();
const uidPattern = /^u\d{6}$/;

export const isValidUserUid = (uid: string | undefined): uid is string =>
  Boolean(uid && uidPattern.test(uid.trim()));

const normalizeUid = (uid: string | undefined): string | undefined => {
  const trimmed = uid?.trim();
  return isValidUserUid(trimmed) ? trimmed : undefined;
};

export const normalizedUserUid = normalizeUid;

const randomUid = (): string => `u${crypto.randomInt(0, 1_000_000).toString().padStart(6, "0")}`;

const generateUniqueUid = (used: Set<string>): string => {
  for (let attempt = 0; attempt < 1_000_000; attempt += 1) {
    const uid = randomUid();
    if (!used.has(uid)) {
      used.add(uid);
      return uid;
    }
  }

  throw new HttpError(500, "无法生成唯一用户 uid，请稍后重试。");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const recordsFromUidMap = (record: Record<string, unknown>): DominantUserRecord[] =>
  Object.entries(record)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([uid, user]) => ({
      ...(user as DominantUserRecord),
      uid: normalizeUid(String(user.uid ?? "")) ?? normalizeUid(uid) ?? String(user.uid ?? uid)
    }));

const normalizeConfig = (value: unknown): { wrapper: "uid-map" | "array" | "users" | "accounts"; users: DominantUserRecord[] } => {
  if (Array.isArray(value)) {
    return { wrapper: "array", users: value.filter(isRecord) as DominantUserRecord[] };
  }

  if (!isRecord(value)) {
    return { wrapper: "uid-map", users: [] };
  }

  if (Object.prototype.hasOwnProperty.call(value, "users")) {
    const users = value.users;
    return {
      wrapper: "users",
      users: Array.isArray(users)
        ? (users.filter(isRecord) as DominantUserRecord[])
        : isRecord(users)
          ? recordsFromUidMap(users)
          : []
    };
  }

  if (Object.prototype.hasOwnProperty.call(value, "accounts")) {
    const accounts = value.accounts;
    return {
      wrapper: "accounts",
      users: Array.isArray(accounts)
        ? (accounts.filter(isRecord) as DominantUserRecord[])
        : isRecord(accounts)
          ? recordsFromUidMap(accounts)
          : []
    };
  }

  return { wrapper: "uid-map", users: recordsFromUidMap(value) };
};

const readRawUserConfig = async (): Promise<{ wrapper: "uid-map" | "array" | "users" | "accounts"; users: DominantUserRecord[] }> => {
  try {
    const raw = await fs.readFile(appConfig.dominantUsersFile, "utf8");
    const cleaned = raw.replace(/^\uFEFF/, "").trim();
    return cleaned ? normalizeConfig(JSON.parse(cleaned) as unknown) : { wrapper: "uid-map", users: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { wrapper: "uid-map", users: [] };
    }

    throw error;
  }
};

const writeRawUserConfig = async (config: {
  wrapper: "uid-map" | "array" | "users" | "accounts";
  users: DominantUserRecord[];
}): Promise<void> => {
  await ensureDirectory(path.dirname(appConfig.dominantUsersFile));
  const value = Object.fromEntries(
    config.users.map((user) => {
      const uid = normalizeUid(user.uid) ?? allocateUidForConfig(config);
      user.uid = uid;
      const { uid: _uid, ...rest } = user;
      return [uid, rest];
    })
  );

  await fs.writeFile(appConfig.dominantUsersFile, `${JSON.stringify(value, null, 2)}\n`);
};

const ensureConfigUids = (config: {
  wrapper: "uid-map" | "array" | "users" | "accounts";
  users: DominantUserRecord[];
}): boolean => {
  const used = new Set<string>();
  let changed = false;

  for (const user of config.users) {
    const existing = normalizeUid(user.uid) ?? normalizeUid(user.id);
    if (existing && !used.has(existing)) {
      if (user.uid !== existing) {
        user.uid = existing;
        changed = true;
      }
      used.add(existing);
      continue;
    }

    user.uid = generateUniqueUid(used);
    changed = true;
  }

  return changed;
};

const readUserConfig = async (options: { ensureUids?: boolean } = {}): Promise<{
  wrapper: "uid-map" | "array" | "users" | "accounts";
  users: DominantUserRecord[];
}> => {
  const config = await readRawUserConfig();
  if (options.ensureUids && ensureConfigUids(config)) {
    await writeRawUserConfig(config);
  }

  return config;
};

export const readDominantUserRecords = async (options: { requireFile?: boolean } = {}): Promise<DominantUserRecord[]> => {
  const config = await readUserConfig({ ensureUids: true });
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
  const uid = normalizeUid(user.uid);
  const entryUid = normalizeUid(entry.uid);
  const username = normalizeUsername(entry.username ?? entry.account ?? "");

  if (uid && entryUid) {
    return uid === entryUid;
  }

  return (
    Boolean(entry.id && entry.id === user.id) ||
    Boolean(entry.id && uid && entry.id === uid) ||
    Boolean(username && username === user.username)
  );
};

export const allocateUserUid = async (reserved: Iterable<string | undefined> = []): Promise<string> => {
  const config = await readUserConfig({ ensureUids: true });
  const used = new Set(config.users.map((user) => normalizeUid(user.uid)).filter((uid): uid is string => Boolean(uid)));

  for (const uid of reserved) {
    const normalized = normalizeUid(uid);
    if (normalized) {
      used.add(normalized);
    }
  }

  return generateUniqueUid(used);
};

export const collectConfiguredUserUids = async (): Promise<Set<string>> => {
  const config = await readUserConfig({ ensureUids: true });
  return new Set(config.users.map((user) => normalizeUid(user.uid)).filter((uid): uid is string => Boolean(uid)));
};

export const getUserConfigByUid = async (uid: string): Promise<DominantUserRecord | undefined> => {
  const normalized = normalizeUid(uid);
  if (!normalized) {
    throw new HttpError(400, "请输入有效的用户 uid。");
  }

  const config = await readUserConfig({ ensureUids: true });
  return config.users.find((entry) => normalizeUid(entry.uid) === normalized);
};

export const getUserOpenAiApiKey = async (user: AuthUser): Promise<string> => {
  const config = await readUserConfig({ ensureUids: true });
  const entry = config.users.find((item) => entryMatchesUser(item, user));
  return (entry?.openaiApiKey ?? entry?.apiKey ?? "").trim();
};

export const userHasOpenAiApiKey = async (user: AuthUser): Promise<boolean> =>
  Boolean(await getUserOpenAiApiKey(user));

export const saveUserOpenAiApiKey = async (user: AuthUser, apiKey: string): Promise<void> => {
  const key = apiKey.trim();
  if (key.length < 20 || /\s/.test(key)) {
    throw new HttpError(400, "请输入有效的 API Key。");
  }

  const config = await readUserConfig({ ensureUids: true });
  const existing = config.users.find((item) => entryMatchesUser(item, user));

  if (existing) {
    existing.uid = normalizeUid(existing.uid) ?? normalizeUid(user.uid) ?? allocateUidForConfig(config);
    existing.openaiApiKey = key;
    delete existing.apiKey;
  } else {
    config.users.push({
      uid: normalizeUid(user.uid) ?? allocateUidForConfig(config),
      id: user.id,
      username: user.username,
      openaiApiKey: key
    });
  }

  await writeRawUserConfig(config);
};

const allocateUidForConfig = (config: {
  wrapper: "uid-map" | "array" | "users" | "accounts";
  users: DominantUserRecord[];
}): string => {
  const used = new Set(config.users.map((user) => normalizeUid(user.uid)).filter((uid): uid is string => Boolean(uid)));
  return generateUniqueUid(used);
};

export const upsertRegisteredUserConfig = async (user: {
  id: string;
  uid: string;
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: string;
}): Promise<void> => {
  const config = await readUserConfig({ ensureUids: true });
  const username = normalizeUsername(user.username);
  const uid = normalizeUid(user.uid) ?? allocateUidForConfig(config);
  const existing = config.users.find(
    (entry) =>
      normalizeUid(entry.uid) === uid ||
      entry.id === user.id ||
      ((entry.authMode === "free" || entry.passwordHash) &&
        normalizeUsername(entry.username ?? entry.account ?? "") === username)
  );

  if (existing) {
    existing.uid = uid;
    existing.id = user.id;
    existing.username = username;
    existing.authMode = "free";
    existing.passwordHash = user.passwordHash;
    existing.salt = user.salt;
    existing.createdAt = user.createdAt;
    existing.openaiApiKey = existing.openaiApiKey ?? existing.apiKey ?? "";
    delete existing.account;
    delete existing.password;
    delete existing.apiKey;
  } else {
    config.users.push({
      uid,
      id: user.id,
      username,
      authMode: "free",
      passwordHash: user.passwordHash,
      salt: user.salt,
      createdAt: user.createdAt,
      openaiApiKey: ""
    });
  }

  await writeRawUserConfig(config);
};

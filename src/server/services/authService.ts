import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config";
import { HttpError } from "../errors";
import { ensureDirectory, safeGeneratedPath } from "../utils/fs";
import { createId } from "../utils/id";
import {
  collectConfiguredUserUids,
  isValidUserUid,
  normalizedUserUid,
  readDominantUserRecords,
  upsertRegisteredUserConfig,
  userHasOpenAiApiKey
} from "./userConfigService";
import type { AuthRequest, AuthResponse, AuthUser } from "../../shared/types";

type StoredUser = {
  id: string;
  uid: string;
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: string;
  openaiApiKey?: string;
  apiKey?: string;
  openaiBaseUrl?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
};

type StoredUsersFile =
  | StoredUser[]
  | Record<string, Omit<StoredUser, "uid"> & { uid?: string }>
  | {
      users: StoredUser[] | Record<string, Omit<StoredUser, "uid"> & { uid?: string }>;
    };

type SessionRecord = {
  tokenHash: string;
  user: AuthUser;
  authMode?: "free" | "dominant";
  expiresAt: string;
};

const usersFile = path.join(appConfig.authDir, "users.json");
const sessionsFile = path.join(appConfig.authDir, "sessions.json");

const normalizeUsername = (username: string): string => username.trim().toLowerCase();

const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

const stableDominantUserId = (username: string): string => {
  const digest = crypto.createHash("sha256").update(`dominant:${username}`).digest("hex").slice(0, 16);
  return `dominant_${digest}`;
};

const plainPasswordMatches = (input: string, expected: string): boolean => {
  const inputBuffer = Buffer.from(input);
  const expectedBuffer = Buffer.from(expected);

  return inputBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(inputBuffer, expectedBuffer);
};

const validateAuthRequest = (
  request: AuthRequest,
  options: { enforceFreeRules?: boolean } = { enforceFreeRules: true }
): { username: string; password: string } => {
  const username = normalizeUsername(request.username);
  const password = request.password ?? "";

  if (options.enforceFreeRules) {
    if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
      throw new HttpError(400, "账号只能包含 3-32 位小写字母、数字、下划线或短横线。");
    }

    if (password.length < 6) {
      throw new HttpError(400, "密码至少需要 6 位。");
    }

    return { username, password };
  }

  if (!username || username.length > 128) {
    throw new HttpError(400, "请输入有效账号。");
  }

  if (!password) {
    throw new HttpError(400, "请输入密码。");
  }

  return { username, password };
};

const scrypt = (password: string, salt: string): Promise<string> =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(key.toString("hex"));
    });
  });

const readJsonFile = async <T>(filePath: string, fallback: T): Promise<T> => {
  await ensureDirectory(appConfig.authDir);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const cleaned = raw.replace(/^\uFEFF/, "").trim();
    return cleaned ? (JSON.parse(cleaned) as T) : fallback;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
};

const randomUid = (): string => `u${crypto.randomInt(0, 1_000_000).toString().padStart(6, "0")}`;

const allocateUid = (used: Set<string>): string => {
  for (let attempt = 0; attempt < 1_000_000; attempt += 1) {
    const uid = randomUid();
    if (!used.has(uid)) {
      used.add(uid);
      return uid;
    }
  }

  throw new HttpError(500, "无法生成唯一用户 uid，请稍后重试。");
};

const readDominantUsers = async (): Promise<StoredUser[]> => {
  const entries = await readDominantUserRecords({ requireFile: true });

  return entries
    .map((entry) => {
      const username = normalizeUsername(entry.username ?? entry.account ?? "");
      const password = entry.password ?? "";

      if (!username || !password) {
        return undefined;
      }

      const uid = isValidUserUid(entry.uid) ? entry.uid : undefined;
      const id = entry.id?.trim() || stableDominantUserId(username);
      if (!uid) {
        return undefined;
      }

      return {
        id,
        uid,
        username,
        passwordHash: password,
        salt: "",
        createdAt: new Date(0).toISOString()
      } satisfies StoredUser;
    })
    .filter((user): user is StoredUser => Boolean(user));
};

const writeJsonFile = async <T>(filePath: string, value: T): Promise<void> => {
  await ensureDirectory(appConfig.authDir);
  await fs.writeFile(filePath, JSON.stringify(value));
};

const usersFromMap = (record: Record<string, Omit<StoredUser, "uid"> & { uid?: string }>): StoredUser[] =>
  Object.entries(record).map(([uid, user]) => ({
    ...user,
    uid: normalizedUserUid(user.uid) ?? normalizedUserUid(uid) ?? user.uid ?? uid
  }));

const hasUsersProperty = (
  value: Exclude<StoredUsersFile, StoredUser[]>
): value is { users: StoredUser[] | Record<string, Omit<StoredUser, "uid"> & { uid?: string }> } =>
  Object.prototype.hasOwnProperty.call(value, "users");

const normalizeUsersFile = (value: StoredUsersFile): StoredUser[] => {
  if (Array.isArray(value)) {
    return value;
  }

  if (hasUsersProperty(value)) {
    return Array.isArray(value.users) ? value.users : usersFromMap(value.users);
  }

  return usersFromMap(value);
};

const readUsers = async (): Promise<StoredUser[]> =>
  normalizeUsersFile(await readJsonFile<StoredUsersFile>(usersFile, {}));

const writeUsers = (users: StoredUser[]): Promise<void> => {
  const value = Object.fromEntries(
    users.map((user) => {
      const { uid, ...rest } = user;
      return [uid, rest];
    })
  );
  return writeJsonFile(usersFile, value);
};

const migrateStoredUsers = async (users: StoredUser[]): Promise<StoredUser[]> => {
  let changed = false;
  const used = await collectConfiguredUserUids();
  const migrated: StoredUser[] = [];

  for (const user of users) {
    const existingUid = normalizedUserUid(user.uid);
    if (existingUid && !migrated.some((item) => item.uid === existingUid)) {
      used.add(existingUid);
      if (user.uid !== existingUid || user.id !== existingUid) {
        changed = true;
      }
      migrated.push({
        ...user,
        id: existingUid,
        uid: existingUid
      });
      continue;
    }

    const uid = allocateUid(used);
    migrated.push({
      ...user,
      id: uid,
      uid
    });
    changed = true;
  }

  if (changed) {
    await writeUsers(migrated);
  } else {
    await writeUsers(migrated);
  }

  await Promise.all(migrated.map((user) => upsertRegisteredUserConfig(user)));

  return migrated;
};

const readSessions = async (): Promise<SessionRecord[]> => {
  const sessions = await readJsonFile<SessionRecord[]>(sessionsFile, []);
  const now = Date.now();
  return sessions.filter((session) => new Date(session.expiresAt).getTime() > now);
};

const writeSessions = (sessions: SessionRecord[]): Promise<void> =>
  writeJsonFile(sessionsFile, sessions);

const toAuthUser = async (user: Pick<AuthUser, "id" | "uid" | "username">): Promise<AuthUser> => ({
  id: user.id,
  uid: user.uid,
  username: user.username,
  hasOpenAiApiKey: await userHasOpenAiApiKey({
    id: user.id,
    uid: user.uid,
    username: user.username,
    hasOpenAiApiKey: false
  })
});

const issueToken = async (rawUser: Pick<AuthUser, "id" | "uid" | "username">): Promise<AuthResponse> => {
  const user = await toAuthUser(rawUser);
  const token = createId("session");
  const expiresAt = new Date(Date.now() + appConfig.tokenTtlMs).toISOString();
  const sessions = await readSessions();

  sessions.push({
    tokenHash: hashToken(token),
    user,
    authMode: appConfig.auth.mode,
    expiresAt
  });
  await writeSessions(sessions);

  return {
    user,
    token,
    expiresAt
  };
};

const resolveAuthorizedSessionUser = async (session: SessionRecord): Promise<AuthUser> => {
  if (session.authMode && session.authMode !== appConfig.auth.mode) {
    throw new HttpError(401, "登录模式已变更，请重新登录。");
  }

  if (appConfig.auth.mode !== "dominant") {
    const users = await migrateStoredUsers(await readUsers());
    const matchedUser = users.find(
      (user) =>
        (isValidUserUid(session.user.uid) && user.uid === session.user.uid) ||
        user.id === session.user.id ||
        user.username === session.user.username
    );

    if (!matchedUser) {
      throw new HttpError(401, "账号授权已变更，请重新登录。");
    }

    return toAuthUser({
      id: matchedUser.id,
      uid: matchedUser.uid,
      username: matchedUser.username
    });
  }

  if (session.authMode !== "dominant") {
    throw new HttpError(401, "登录模式已变更，请重新登录。");
  }

  const dominantUsers = await readDominantUsers();
  const matchedUser = dominantUsers.find((item) => item.username === session.user.username);

  if (!matchedUser) {
    throw new HttpError(401, "账号授权已变更，请重新登录。");
  }

  return toAuthUser({
    id: matchedUser.id,
    uid: matchedUser.uid,
    username: matchedUser.username
  });
};

export const registerUser = async (request: AuthRequest): Promise<AuthResponse> => {
  if (appConfig.auth.mode === "dominant") {
    throw new HttpError(403, "当前为 dominant 登录模式，不允许用户自行注册。");
  }

  const { username, password } = validateAuthRequest(request);
  const users = await migrateStoredUsers(await readUsers());

  if (users.some((user) => user.username === username)) {
    throw new HttpError(409, "账号已注册，请直接登录。");
  }

  const used = await collectConfiguredUserUids();
  for (const user of users) {
    used.add(user.uid);
  }
  const uid = allocateUid(used);
  const salt = crypto.randomBytes(16).toString("hex");
  const user: StoredUser = {
    id: uid,
    uid,
    username,
    salt,
    passwordHash: await scrypt(password, salt),
    createdAt: new Date().toISOString(),
    openaiApiKey: "",
    openaiBaseUrl: appConfig.openai.baseUrl
  };
  users.push(user);
  await writeUsers(users);
  await upsertRegisteredUserConfig(user);

  return issueToken({
    id: user.id,
    uid: user.uid,
    username: user.username
  });
};

export const loginUser = async (request: AuthRequest): Promise<AuthResponse> => {
  const { username, password } = validateAuthRequest(request, {
    enforceFreeRules: appConfig.auth.mode !== "dominant"
  });
  const users = appConfig.auth.mode === "dominant" ? await readDominantUsers() : await migrateStoredUsers(await readUsers());
  const existing = users.find((user) => user.username === username);

  if (!existing) {
    throw new HttpError(
      404,
      appConfig.auth.mode === "dominant" ? "账号不在授权名单中，请联系管理员。" : "账号未注册，请先注册。"
    );
  }

  const passwordMatches =
    appConfig.auth.mode === "dominant"
      ? plainPasswordMatches(password, existing.passwordHash)
      : (await scrypt(password, existing.salt)) === existing.passwordHash;

  if (!passwordMatches) {
    throw new HttpError(401, "密码不正确。");
  }

  return issueToken({
    id: existing.id,
    uid: existing.uid,
    username: existing.username
  });
};

export const authenticateToken = async (token: string | undefined): Promise<AuthUser> => {
  if (!token) {
    throw new HttpError(401, "请先登录。");
  }

  const sessions = await readSessions();
  const session = sessions.find((item) => item.tokenHash === hashToken(token));
  if (!session) {
    await writeSessions(sessions);
    throw new HttpError(401, "登录已过期，请重新登录。");
  }

  return resolveAuthorizedSessionUser(session);
};

export const sessionFromToken = async (token: string | undefined): Promise<AuthResponse> => {
  if (!token) {
    throw new HttpError(401, "请先登录。");
  }

  const sessions = await readSessions();
  const session = sessions.find((item) => item.tokenHash === hashToken(token));
  if (!session) {
    await writeSessions(sessions);
    throw new HttpError(401, "登录已过期，请重新登录。");
  }

  const user = await resolveAuthorizedSessionUser(session);

  return {
    user,
    token,
    expiresAt: session.expiresAt
  };
};

export const revokeToken = async (token: string | undefined): Promise<void> => {
  if (!token) {
    return;
  }

  const tokenHash = hashToken(token);
  const sessions = await readSessions();
  await writeSessions(sessions.filter((session) => session.tokenHash !== tokenHash));
};

export const userStorageDir = (userId: string): string =>
  safeGeneratedPath(appConfig.usersDir, userId);

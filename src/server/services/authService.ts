import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config";
import { HttpError } from "../errors";
import { ensureDirectory, safeGeneratedPath } from "../utils/fs";
import { createId } from "../utils/id";
import type { AuthRequest, AuthResponse, AuthUser } from "../../shared/types";

type StoredUser = {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: string;
};

type SessionRecord = {
  tokenHash: string;
  user: AuthUser;
  expiresAt: string;
};

const usersFile = path.join(appConfig.authDir, "users.json");
const sessionsFile = path.join(appConfig.authDir, "sessions.json");

const normalizeUsername = (username: string): string => username.trim().toLowerCase();

const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

const validateAuthRequest = (request: AuthRequest): { username: string; password: string } => {
  const username = normalizeUsername(request.username);
  const password = request.password ?? "";

  if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
    throw new HttpError(400, "账号只能包含 3-32 位小写字母、数字、下划线或短横线。");
  }

  if (password.length < 6) {
    throw new HttpError(400, "密码至少需要 6 位。");
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
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
};

const writeJsonFile = async <T>(filePath: string, value: T): Promise<void> => {
  await ensureDirectory(appConfig.authDir);
  await fs.writeFile(filePath, JSON.stringify(value));
};

const readUsers = (): Promise<StoredUser[]> => readJsonFile(usersFile, []);

const writeUsers = (users: StoredUser[]): Promise<void> => writeJsonFile(usersFile, users);

const readSessions = async (): Promise<SessionRecord[]> => {
  const sessions = await readJsonFile<SessionRecord[]>(sessionsFile, []);
  const now = Date.now();
  return sessions.filter((session) => new Date(session.expiresAt).getTime() > now);
};

const writeSessions = (sessions: SessionRecord[]): Promise<void> =>
  writeJsonFile(sessionsFile, sessions);

const issueToken = async (user: AuthUser): Promise<AuthResponse> => {
  const token = createId("session");
  const expiresAt = new Date(Date.now() + appConfig.tokenTtlMs).toISOString();
  const sessions = await readSessions();

  sessions.push({
    tokenHash: hashToken(token),
    user,
    expiresAt
  });
  await writeSessions(sessions);

  return {
    user,
    token,
    expiresAt
  };
};

export const registerUser = async (request: AuthRequest): Promise<AuthResponse> => {
  const { username, password } = validateAuthRequest(request);
  const users = await readUsers();

  if (users.some((user) => user.username === username)) {
    throw new HttpError(409, "账号已注册，请直接登录。");
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const user: StoredUser = {
    id: createId("user"),
    username,
    salt,
    passwordHash: await scrypt(password, salt),
    createdAt: new Date().toISOString()
  };
  users.push(user);
  await writeUsers(users);

  return issueToken({
    id: user.id,
    username: user.username
  });
};

export const loginUser = async (request: AuthRequest): Promise<AuthResponse> => {
  const { username, password } = validateAuthRequest(request);
  const users = await readUsers();
  const existing = users.find((user) => user.username === username);

  if (!existing) {
    throw new HttpError(404, "账号未注册，请先注册。");
  }

  const passwordHash = await scrypt(password, existing.salt);
  if (passwordHash !== existing.passwordHash) {
    throw new HttpError(401, "密码不正确。");
  }

  return issueToken({
    id: existing.id,
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

  return session.user;
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

  return {
    user: session.user,
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

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { appConfig } from "../config";
import { HttpError } from "../errors";
import { ensureDirectory, safeGeneratedPath } from "../utils/fs";
import { createId } from "../utils/id";
import { userStorageDir } from "./authService";
import type {
  AuthUser,
  ChatAttachment,
  ChatMessage,
  ConversationDetail,
  ConversationSummary
} from "../../shared/types";

type StoredConversation = ConversationDetail & {
  titleLocked?: boolean;
};

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const indexFilename = "index.json";

const conversationsDir = (user: AuthUser): string =>
  path.join(userStorageDir(user.uid), "conversations");

const indexPath = (user: AuthUser): string => path.join(conversationsDir(user), indexFilename);

const conversationPath = (user: AuthUser, conversationId: string): string =>
  safeGeneratedPath(conversationsDir(user), `${conversationId}.json.gz`);

const stripAttachmentPayload = (attachment: ChatAttachment): ChatAttachment => ({
  id: attachment.id,
  kind: attachment.kind,
  filename: attachment.filename,
  mimeType: attachment.mimeType,
  source: attachment.source,
  url: attachment.url,
  previewUrl: attachment.source === "uploaded" ? undefined : attachment.previewUrl,
  textContent: attachment.textContent,
  description: attachment.description,
  sizeBytes: attachment.sizeBytes
});

const compactMessage = (message: ChatMessage): ChatMessage => ({
  id: message.id,
  role: message.role,
  content: message.content,
  createdAt: message.createdAt,
  attachments: message.attachments?.map(stripAttachmentPayload)
});

const titleFromMessages = (messages: ChatMessage[]): string => {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content ?? "";
  const normalized = firstUserMessage
    .replace(/\s+/g, " ")
    .replace(/^(请|帮我|麻烦|查询|查一下|生成|创建|制作|写一个|给我)\s*/u, "")
    .trim();
  return normalized.slice(0, 28) || "等待第一条消息";
};

const shouldRefreshTitle = (title: string | undefined, messages: ChatMessage[]): boolean =>
  !title ||
  title === "新对话" ||
  title === "等待第一条消息" ||
  messages.filter((message) => message.role === "user").length <= 1;

const readIndex = async (user: AuthUser): Promise<ConversationSummary[]> => {
  await ensureDirectory(conversationsDir(user));

  try {
    const raw = await fs.readFile(indexPath(user), "utf8");
    return JSON.parse(raw) as ConversationSummary[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
};

const writeIndex = async (user: AuthUser, index: ConversationSummary[]): Promise<void> => {
  await ensureDirectory(conversationsDir(user));
  await fs.writeFile(indexPath(user), JSON.stringify(index));
};

const readConversation = async (
  user: AuthUser,
  conversationId: string
): Promise<StoredConversation | undefined> => {
  try {
    const zipped = await fs.readFile(conversationPath(user, conversationId));
    return JSON.parse((await gunzip(zipped)).toString("utf8")) as StoredConversation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
};

const writeConversation = async (user: AuthUser, conversation: StoredConversation): Promise<void> => {
  await ensureDirectory(conversationsDir(user));
  const zipped = await gzip(JSON.stringify(conversation), { level: 9 });
  await fs.writeFile(conversationPath(user, conversation.id), zipped);
};

export const listConversations = async (user: AuthUser): Promise<ConversationSummary[]> => {
  const index = await readIndex(user);
  return index.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

export const getConversation = async (
  user: AuthUser,
  conversationId: string
): Promise<ConversationDetail | undefined> => readConversation(user, conversationId);

export const saveConversation = async (
  user: AuthUser,
  messages: ChatMessage[],
  conversationId?: string
): Promise<ConversationSummary> => {
  const now = new Date().toISOString();
  const index = await readIndex(user);
  const existing = conversationId ? await readConversation(user, conversationId) : undefined;
  const id = existing?.id ?? conversationId ?? createId("conv");
  const compactMessages = messages.map(compactMessage);
  const titleLocked = existing?.titleLocked ?? false;
  const conversation: StoredConversation = {
    id,
    title: !titleLocked && shouldRefreshTitle(existing?.title, compactMessages)
      ? titleFromMessages(compactMessages)
      : existing?.title ?? titleFromMessages(compactMessages),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messageCount: compactMessages.length,
    messages: compactMessages,
    titleLocked
  };
  const summary: ConversationSummary = {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messageCount
  };

  await writeConversation(user, conversation);

  const nextIndex = [summary, ...index.filter((item) => item.id !== id)].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
  await writeIndex(user, nextIndex);

  return summary;
};

export const createEmptyConversation = async (user: AuthUser): Promise<ConversationDetail> => {
  const now = new Date().toISOString();
  const conversation: ConversationDetail = {
    id: createId("conv"),
    title: "等待第一条消息",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    messages: []
  };

  await writeConversation(user, conversation);
  await writeIndex(user, [conversation, ...(await readIndex(user))]);

  return conversation;
};

export const deleteConversation = async (user: AuthUser, conversationId: string): Promise<void> => {
  const existing = await readConversation(user, conversationId);
  if (!existing) {
    return;
  }

  await fs.rm(conversationPath(user, conversationId), { force: true });
  await writeIndex(
    user,
    (await readIndex(user)).filter((item) => item.id !== conversationId)
  );
};

export const renameConversation = async (
  user: AuthUser,
  conversationId: string,
  title: string
): Promise<ConversationSummary> => {
  const existing = await readConversation(user, conversationId);
  if (!existing) {
    throw new HttpError(404, "对话不存在。");
  }

  const normalizedTitle = title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!normalizedTitle) {
    throw new HttpError(400, "请输入新的对话名称。");
  }

  const updatedAt = new Date().toISOString();
  const conversation: StoredConversation = {
    ...existing,
    title: normalizedTitle,
    updatedAt,
    titleLocked: true
  };
  const summary: ConversationSummary = {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messageCount
  };

  await writeConversation(user, conversation);
  await writeIndex(
    user,
    [summary, ...(await readIndex(user)).filter((item) => item.id !== conversationId)].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    )
  );

  return summary;
};

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { appConfig } from "../config";
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

type StoredConversation = ConversationDetail;

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const indexFilename = "index.json";

const conversationsDir = (user: AuthUser): string =>
  path.join(userStorageDir(user.id), "conversations");

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
  const firstUserMessage = messages.find((message) => message.role === "user")?.content ?? "新对话";
  return firstUserMessage.replace(/\s+/g, " ").trim().slice(0, 36) || "新对话";
};

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
  const conversation: StoredConversation = {
    id,
    title: existing?.title ?? titleFromMessages(compactMessages),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messageCount: compactMessages.length,
    messages: compactMessages
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
    title: "新对话",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    messages: []
  };

  await writeConversation(user, conversation);
  await writeIndex(user, [conversation, ...(await readIndex(user))]);

  return conversation;
};

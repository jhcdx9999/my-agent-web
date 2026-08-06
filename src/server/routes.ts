import express from "express";
import { appConfig } from "./config";
import { HttpError, getErrorMessage } from "./errors";
import { createId } from "./utils/id";
import { processChat } from "./services/chatService";
import { getGeneratedFilePath } from "./services/fileStore";
import { saveUserOpenAiApiKey, userHasOpenAiApiKey } from "./services/userConfigService";
import {
  authenticateToken,
  loginUser,
  registerUser,
  revokeToken,
  sessionFromToken
} from "./services/authService";
import {
  createEmptyConversation,
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
  saveConversation
} from "./services/historyService";
import type { AuthUser, ChatProgressEvent, ChatRequest } from "../shared/types";

type AuthedRequest = express.Request & {
  user?: AuthUser;
};

const sendJson = (response: express.Response, value: unknown, statusCode = 200): void => {
  response.status(statusCode);
  response.removeHeader("Content-Length");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
};

const sendSse = (response: express.Response, event: string, value: unknown): void => {
  if (response.destroyed || response.writableEnded) {
    return;
  }

  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(value)}\n\n`);
};

const endSse = (response: express.Response): void => {
  if (!response.destroyed && !response.writableEnded) {
    response.end();
  }
};

const chatRequestFromBody = (body: Partial<ChatRequest>): ChatRequest => {
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpError(400, "messages is required.");
  }

  return {
    messages: body.messages,
    model: body.model ?? (appConfig.ai.textRuntime === "codex"
      ? appConfig.codex.defaultModel
      : appConfig.openai.defaultModel),
    conversationId: body.conversationId || createId("conv"),
    paused: body.paused
  };
};

const tokenFromRequest = (request: express.Request): string | undefined => {
  const header = request.header("Authorization");
  if (!header) {
    return undefined;
  }

  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
};

const requireAuth: express.RequestHandler = (request: AuthedRequest, _response, next) => {
  void (async () => {
    request.user = await authenticateToken(tokenFromRequest(request));
    next();
  })().catch((error) => {
    next(error);
  });
};

export const createRouter = (): express.Router => {
  const router = express.Router();

  router.get("/config", (_request, response) => {
    const textRuntime = appConfig.ai.textRuntime;
    const defaultModel = textRuntime === "codex" ? appConfig.codex.defaultModel : appConfig.openai.defaultModel;
    const models = ["gpt-5.5"];

    response.json({
      defaultModel: models.includes(defaultModel) ? defaultModel : "gpt-5.5",
      models,
      textRuntime,
      requiresOpenAiApiKeyForText:
        textRuntime !== "codex" || appConfig.codex.authMode === "user-api-key",
      themes: ["white", "sapphire", "black"],
      auth: {
        mode: appConfig.auth.mode
      },
      upload: appConfig.upload
    });
  });

  router.post("/auth/login", async (request, response, next) => {
    try {
      response.json(await loginUser(request.body));
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/register", async (request, response, next) => {
    try {
      response.json(await registerUser(request.body));
    } catch (error) {
      next(error);
    }
  });

  router.get("/auth/session", async (request, response, next) => {
    try {
      response.json(await sessionFromToken(tokenFromRequest(request)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/logout", async (request, response, next) => {
    try {
      await revokeToken(tokenFromRequest(request));
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get("/user/openai-key", requireAuth, async (request: AuthedRequest, response, next) => {
    try {
      response.json({
        hasOpenAiApiKey: await userHasOpenAiApiKey(request.user!)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/user/openai-key", requireAuth, async (request: AuthedRequest, response, next) => {
    try {
      await saveUserOpenAiApiKey(request.user!, String(request.body?.apiKey ?? ""));
      response.json({
        hasOpenAiApiKey: true
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/conversations", requireAuth, async (request: AuthedRequest, response, next) => {
    try {
      response.json(await listConversations(request.user!));
    } catch (error) {
      next(error);
    }
  });

  router.post("/conversations", requireAuth, async (request: AuthedRequest, response, next) => {
    try {
      response.json(await createEmptyConversation(request.user!));
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/conversations/:conversationId",
    requireAuth,
    async (request: AuthedRequest, response, next) => {
      try {
        const conversation = await getConversation(request.user!, request.params.conversationId);
        if (!conversation) {
          throw new HttpError(404, "对话不存在。");
        }

        response.json(conversation);
      } catch (error) {
        next(error);
      }
    }
  );

  router.delete(
    "/conversations/:conversationId",
    requireAuth,
    async (request: AuthedRequest, response, next) => {
      try {
        await deleteConversation(request.user!, request.params.conversationId);
        response.json({ ok: true });
      } catch (error) {
        next(error);
      }
    }
  );

  router.patch(
    "/conversations/:conversationId",
    requireAuth,
    async (request: AuthedRequest, response, next) => {
      try {
        response.json(
          await renameConversation(
            request.user!,
            request.params.conversationId,
            String(request.body?.title ?? "")
          )
        );
      } catch (error) {
        next(error);
      }
    }
  );

  router.post("/chat", async (request, response, next) => {
    try {
      const user = await authenticateToken(tokenFromRequest(request));
      const body = chatRequestFromBody(request.body as Partial<ChatRequest>);
      const chatResponse = await processChat(body, user);
      const conversation = await saveConversation(
        user,
        [...chatResponse.historyMessages, chatResponse.message],
        body.conversationId
      );
      const { historyMessages: _historyMessages, ...publicResponse } = chatResponse;

      sendJson(response, {
        ...publicResponse,
        conversation
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/chat/stream", async (request, response) => {
    response.status(200);
    response.removeHeader("Content-Length");
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();
    response.write(": connected\n\n");
    const heartbeat = setInterval(() => {
      if (response.destroyed || response.writableEnded) {
        clearInterval(heartbeat);
        return;
      }
      response.write(": keep-alive\n\n");
    }, 15000);

    request.on("close", () => {
      clearInterval(heartbeat);
    });

    try {
      const user = await authenticateToken(tokenFromRequest(request));
      const body = chatRequestFromBody(request.body as Partial<ChatRequest>);
      const progress = (event: ChatProgressEvent): void => {
        sendSse(response, "progress", event);
      };

      progress({
        title: "正在准备请求",
        detail: "服务器已收到消息，正在建立本轮处理任务。",
        kind: "thinking",
        createdAt: new Date().toISOString()
      });

      const chatResponse = await processChat(body, user, progress);
      progress({
        title: "正在保存会话",
        detail: "回复已生成，正在写入当前用户的历史记录。",
        kind: "done",
        createdAt: new Date().toISOString()
      });
      const conversation = await saveConversation(
        user,
        [...chatResponse.historyMessages, chatResponse.message],
        body.conversationId
      );
      const { historyMessages: _historyMessages, ...publicResponse } = chatResponse;

      sendSse(response, "done", {
        ...publicResponse,
        conversation
      });
      clearInterval(heartbeat);
      endSse(response);
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      sendSse(response, "error", {
        error: getErrorMessage(error),
        statusCode,
        details: error instanceof HttpError ? error.details : undefined
      });
      clearInterval(heartbeat);
      endSse(response);
    }
  });

  return router;
};

export const downloadsHandler: express.RequestHandler = (request, response, next) => {
  try {
    const filename = request.params.filename;
    response.download(getGeneratedFilePath(filename), filename);
  } catch (error) {
    next(error);
  }
};

export const errorHandler: express.ErrorRequestHandler = (error, _request, response, _next) => {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;

  response.status(statusCode).json({
    error: getErrorMessage(error),
    details: error instanceof HttpError ? error.details : undefined
  });
};

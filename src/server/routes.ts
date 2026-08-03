import express from "express";
import { appConfig } from "./config";
import { HttpError, getErrorMessage } from "./errors";
import { processChat } from "./services/chatService";
import { getGeneratedFilePath } from "./services/fileStore";
import {
  authenticateToken,
  loginUser,
  registerUser,
  revokeToken,
  sessionFromToken
} from "./services/authService";
import {
  createEmptyConversation,
  getConversation,
  listConversations,
  saveConversation
} from "./services/historyService";
import type { AuthUser, ChatRequest } from "../shared/types";

type AuthedRequest = express.Request & {
  user?: AuthUser;
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
    response.json({
      defaultModel: appConfig.openai.defaultModel,
      models: appConfig.openai.models,
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

  router.post("/chat", async (request, response, next) => {
    try {
      const user = await authenticateToken(tokenFromRequest(request));
      const body = request.body as Partial<ChatRequest>;
      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        throw new HttpError(400, "messages is required.");
      }

      const chatResponse = await processChat({
          messages: body.messages,
          model: body.model ?? appConfig.openai.defaultModel,
          conversationId: body.conversationId,
          paused: body.paused
      });
      const conversation = await saveConversation(user, [...body.messages, chatResponse.message], body.conversationId);

      response.json({
        ...chatResponse,
        conversation
      });
    } catch (error) {
      next(error);
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

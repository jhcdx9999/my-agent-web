import cors from "cors";
import express from "express";
import path from "node:path";
import { appConfig } from "./config";
import { errorHandler, downloadsHandler, createRouter } from "./routes";
import { ensureDirectory } from "./utils/fs";

const app = express();
const clientDistDir = path.resolve(process.cwd(), "dist", "client");

app.use(
  cors({
    origin: appConfig.corsOrigin,
    credentials: false
  })
);
app.use(express.json({ limit: appConfig.requestBodyLimit }));
app.use("/api", createRouter());
app.get("/downloads/:filename", downloadsHandler);

if (appConfig.nodeEnv === "production") {
  app.use(express.static(clientDistDir));
  app.get("*", (_request, response) => {
    response.sendFile(path.join(clientDistDir, "index.html"));
  });
}

app.use(errorHandler);

ensureDirectory(appConfig.storageDir)
  .then(() => {
    const server = app.listen(appConfig.port, appConfig.host, () => {
      console.log(`Custom GPT server listening on http://${appConfig.host}:${appConfig.port}`);
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        console.error(
          `Port ${appConfig.port} is already in use on ${appConfig.host}. ` +
            "Stop the old dev server or run through npm.cmd run dev to auto-pick free ports."
        );
        process.exit(1);
      }

      console.error(error);
      process.exit(1);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

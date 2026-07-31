import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const host = process.env.HOST || "127.0.0.1";
const nodeCommand = process.execPath;
const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
const viteCli = path.resolve("node_modules", "vite", "bin", "vite.js");

const canListen = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });

const findPort = async (startPort) => {
  let port = Number(startPort);

  while (!(await canListen(port))) {
    port += 1;
  }

  return port;
};

const fetchJson = async (url) => {
  try {
    const response = await fetch(url);
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
};

const fetchText = async (url) => {
  try {
    const response = await fetch(url);
    return response.ok ? response.text() : null;
  } catch {
    return null;
  }
};

const findExistingServer = async () => {
  const start = Number(process.env.PORT || 8787);

  for (let port = start; port < start + 20; port += 1) {
    const config = await fetchJson(`http://${host}:${port}/api/config`);
    if (config?.themes?.includes?.("white")) {
      return port;
    }
  }

  return null;
};

const findExistingClient = async () => {
  const start = Number(process.env.CLIENT_PORT || 5173);

  for (let port = start; port < start + 20; port += 1) {
    const html = await fetchText(`http://${host}:${port}`);
    if (html?.includes("Custom GPT Web") || html?.includes("/src/client/main.ts")) {
      return port;
    }
  }

  return null;
};

const existingServerPort = await findExistingServer();
const existingClientPort = await findExistingClient();

if (existingServerPort && existingClientPort) {
  console.log("Custom GPT Web is already running.");
  console.log(`  client: http://${host}:${existingClientPort}`);
  console.log(`  server: http://${host}:${existingServerPort}`);
  console.log("Run npm.cmd run dev:stop to stop old dev servers.");
  process.exit(0);
}

const serverPort = await findPort(process.env.PORT || 8787);
const clientPort = await findPort(process.env.CLIENT_PORT || 5173);
const clientOrigin = `http://${host}:${clientPort}`;
const serverOrigin = `http://${host}:${serverPort}`;

console.log(`Starting Custom GPT Web`);
console.log(`  client: ${clientOrigin}`);
console.log(`  server: ${serverOrigin}`);

const children = [];

const run = (name, args, env) => {
  const child = spawn(nodeCommand, args, {
    env: {
      ...process.env,
      ...env
    },
    stdio: "inherit",
    windowsHide: true
  });

  child.on("error", (error) => {
    console.error(`${name} failed to start: ${error.message}`);
    stopAll(child.pid);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(`${name} exited with code ${code ?? signal}.`);
    }
    stopAll(child.pid);
  });

  children.push(child);
  return child;
};

const stopAll = (exceptPid) => {
  for (const child of children) {
    if (child.pid && child.pid !== exceptPid && !child.killed) {
      child.kill();
    }
  }
};

process.on("SIGINT", () => {
  stopAll();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopAll();
  process.exit(0);
});

if (!existingServerPort) {
  run("server", [tsxCli, "watch", "src/server/index.ts"], {
    HOST: host,
    PORT: String(serverPort),
    CORS_ORIGIN: clientOrigin
  });
}

run("client", [viteCli, "--host", host, "--port", String(clientPort), "--strictPort"], {
  VITE_API_TARGET: existingServerPort ? `http://${host}:${existingServerPort}` : serverOrigin
});

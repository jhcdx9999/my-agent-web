import vm from "node:vm";
import { appConfig } from "../config";
import { HttpError } from "../errors";

type DataRunResult = {
  output: string;
  returned?: unknown;
};

const blockedTokens = [
  "require",
  "import",
  "process",
  "global",
  "globalThis",
  "fs",
  "child_process",
  "Function",
  "eval",
  "while",
  "for (;;"
];

const safeFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS fetch URLs are allowed.");
  }

  return fetch(url, {
    ...init,
    method: init?.method ?? "GET"
  });
};

const withRunTimeout = async <T>(task: Promise<T>, timeoutMs: number): Promise<T> =>
  Promise.race([
    task,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Local data code timed out after ${timeoutMs} ms.`)), timeoutMs);
    })
  ]);

export const runLocalDataCode = async (source: string): Promise<DataRunResult> => {
  if (!appConfig.safety.enableLocalCodeExecution) {
    throw new HttpError(403, "Local code execution is disabled.");
  }

  if (blockedTokens.some((token) => source.includes(token))) {
    throw new HttpError(400, "Local data code contains a blocked token.");
  }

  const logs: string[] = [];
  const sandbox = {
    console: {
      log: (...args: unknown[]) => logs.push(args.map((arg) => String(arg)).join(" "))
    },
    Math,
    Date,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    fetch: safeFetch
  };

  const script = new vm.Script(`"use strict";\n(async () => {\n${source}\n})()`, {
    filename: "local-data-task.js"
  });

  const context = vm.createContext(sandbox);
  const returned = await withRunTimeout(
    script.runInContext(context, {
      timeout: appConfig.safety.localCodeTimeoutMs
    }) as Promise<unknown>,
    appConfig.safety.localCodeTimeoutMs
  );

  return {
    output: logs.join("\n"),
    returned
  };
};

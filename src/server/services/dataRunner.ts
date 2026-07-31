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
    Map
  };

  const script = new vm.Script(`"use strict";\n${source}`, {
    filename: "local-data-task.js"
  });

  const context = vm.createContext(sandbox);
  const returned = script.runInContext(context, {
    timeout: appConfig.safety.localCodeTimeoutMs
  });

  return {
    output: logs.join("\n"),
    returned
  };
};

import pino, { type Logger } from "pino";
import type { LoggerOptions } from "./types.js";

export const createLogger = (name: string, opts: LoggerOptions = {}): Logger => {
  const base = {
    name,
    traceId: opts.traceId,
    ...opts.bindings,
  };

  return pino({
    level: opts.level ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    base,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
};

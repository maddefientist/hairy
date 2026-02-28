import pino from "pino";
export const createLogger = (name, opts = {}) => {
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
//# sourceMappingURL=logger.js.map

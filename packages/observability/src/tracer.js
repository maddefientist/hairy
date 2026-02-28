import { randomUUID } from "node:crypto";
export const createTrace = () => {
  const traceId = randomUUID();
  const startTime = Date.now();
  const spans = [];
  return {
    traceId,
    span: (name) => {
      const span = {
        name,
        spanId: randomUUID(),
        start: Date.now(),
      };
      spans.push(span);
      return {
        spanId: span.spanId,
        start: span.start,
        end: () => {
          span.end = Date.now();
          return span.end - span.start;
        },
      };
    },
    end: () => {
      const endTime = Date.now();
      return {
        traceId,
        startTime,
        endTime,
        durationMs: endTime - startTime,
        spans: spans.map((span) => ({
          name: span.name,
          spanId: span.spanId,
          durationMs: (span.end ?? endTime) - span.start,
        })),
      };
    },
  };
};
//# sourceMappingURL=tracer.js.map

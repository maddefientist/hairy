import { randomUUID } from "node:crypto";
import type { TraceSummary } from "./types.js";

interface SpanInternal {
  name: string;
  spanId: string;
  start: number;
  end?: number;
}

export interface SpanContext {
  spanId: string;
  start: number;
  end: () => number;
}

export interface TraceContext {
  traceId: string;
  span: (name: string) => SpanContext;
  end: () => TraceSummary;
}

export const createTrace = (): TraceContext => {
  const traceId = randomUUID();
  const startTime = Date.now();
  const spans: SpanInternal[] = [];

  return {
    traceId,
    span: (name: string): SpanContext => {
      const span: SpanInternal = {
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
    end: (): TraceSummary => {
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

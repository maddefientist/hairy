/** Logger interface — re-exported so consumers don't need pino as a direct dep */
export interface HairyClawLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  info(msg: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  error(msg: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  warn(msg: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
  debug(msg: string): void;
  child(bindings: Record<string, unknown>): HairyClawLogger;
}

export interface LoggerOptions {
  level?: "debug" | "info" | "warn" | "error";
  traceId?: string;
  bindings?: Record<string, unknown>;
}

export interface LogRecord {
  timestamp: string;
  level: string;
  name: string;
  traceId?: string;
  msg: string;
}

export interface MetricLabels {
  [key: string]: string | number | boolean;
}

export interface TraceSummary {
  traceId: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  spans: Array<{ name: string; spanId: string; durationMs: number }>;
}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let currentLevel: Level = (process.env["CHITU_LOG_LEVEL"] as Level) ?? "info";

export interface LogEntry {
  ts: string;
  level: Level;
  msg: string;
  ctx?: Record<string, unknown>;
}

const listeners: Array<(entry: LogEntry) => void> = [];

export function onLog(fn: (entry: LogEntry) => void): void {
  listeners.push(fn);
}

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

function log(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const entry: LogEntry = { ts: new Date().toISOString(), level, msg, ctx };

  const prefix = `[${entry.ts}] [${level.toUpperCase()}]`;
  const suffix = ctx ? ` ${JSON.stringify(ctx)}` : "";

  switch (level) {
    case "error": console.error(`${prefix} ${msg}${suffix}`); break;
    case "warn":  console.warn(`${prefix} ${msg}${suffix}`); break;
    default:      console.log(`${prefix} ${msg}${suffix}`); break;
  }

  for (const fn of listeners) fn(entry);
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => log("debug", msg, ctx),
  info:  (msg: string, ctx?: Record<string, unknown>) => log("info", msg, ctx),
  warn:  (msg: string, ctx?: Record<string, unknown>) => log("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log("error", msg, ctx),
};

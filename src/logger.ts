import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

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

// --- file persistence ---

const LOG_DIR = path.join(homedir(), ".chitu", "logs");
const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2 MB per file
const MAX_LOG_FILES = 5;

let logStream: fs.WriteStream | null = null;
let currentLogPath: string | null = null;
let currentLogSize = 0;

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function rotateLog(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
  // rotate: log.4 -> log.5, ... log.0 -> log.1
  for (let i = MAX_LOG_FILES - 1; i >= 0; i--) {
    const oldPath = path.join(LOG_DIR, `chitu.${i}.log`);
    const newPath = path.join(LOG_DIR, `chitu.${i + 1}.log`);
    if (fs.existsSync(oldPath)) {
      if (i === MAX_LOG_FILES - 1) {
        fs.unlinkSync(oldPath);
      } else {
        fs.renameSync(oldPath, newPath);
      }
    }
  }
  // rename current to .0 if it exists
  const mainLog = path.join(LOG_DIR, "chitu.log");
  if (fs.existsSync(mainLog)) {
    fs.renameSync(mainLog, path.join(LOG_DIR, "chitu.0.log"));
  }
}

function openLogStream(): void {
  ensureLogDir();
  currentLogPath = path.join(LOG_DIR, "chitu.log");
  currentLogSize = fs.existsSync(currentLogPath) ? fs.statSync(currentLogPath).size : 0;
  if (currentLogSize >= MAX_LOG_SIZE) rotateLog();
  logStream = fs.createWriteStream(currentLogPath, { flags: "a" });
}

function writeToFile(entry: LogEntry): void {
  try {
    if (!logStream) openLogStream();
    const line = JSON.stringify(entry) + "\n";
    logStream!.write(line);
    currentLogSize += Buffer.byteLength(line, "utf-8");
    if (currentLogSize >= MAX_LOG_SIZE) {
      rotateLog();
      openLogStream();
    }
  } catch {
    // never let log failure crash the app
  }
}

export function getLogDir(): string {
  return LOG_DIR;
}

export function getCurrentLogPath(): string | null {
  return currentLogPath;
}

// --- core log function ---

function log(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const entry: LogEntry = { ts: new Date().toISOString(), level, msg, ctx };

  // console
  const prefix = `[${entry.ts}] [${level.toUpperCase()}]`;
  const suffix = ctx ? ` ${JSON.stringify(ctx)}` : "";
  switch (level) {
    case "error": console.error(`${prefix} ${msg}${suffix}`); break;
    case "warn":  console.warn(`${prefix} ${msg}${suffix}`); break;
    default:      console.log(`${prefix} ${msg}${suffix}`); break;
  }

  // file (only warn + error by default; override with CHITU_LOG_FILE_LEVEL=debug|info)
  const fileLevel = (process.env["CHITU_LOG_FILE_LEVEL"] as Level) ?? "warn";
  if (LEVELS[level] >= LEVELS[fileLevel]) {
    writeToFile(entry);
  }

  for (const fn of listeners) fn(entry);
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => log("debug", msg, ctx),
  info:  (msg: string, ctx?: Record<string, unknown>) => log("info", msg, ctx),
  warn:  (msg: string, ctx?: Record<string, unknown>) => log("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log("error", msg, ctx),
};

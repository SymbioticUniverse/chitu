import * as fs from "node:fs";
import * as path from "node:path";
import type { BoundaryState } from "../types.js";

// --- Constants ---

export const BOUNDARY_FILE = "boundary.json";
export const AUDIT_FILE = "session-audit.json";

/** Valid file path pattern — relative paths with optional extension, no regex or special chars */
export const PATH_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_./\\-]*$/;

// --- BoundaryFileManager ---

export class BoundaryFileManager {
  private horsewhipDir: string;
  private cache: BoundaryState | null = null;
  private cacheMtime: number = 0;

  constructor(horsewhipDir: string) {
    this.horsewhipDir = horsewhipDir;
  }

  read(): BoundaryState {
    const file = path.join(this.horsewhipDir, BOUNDARY_FILE);
    if (!fs.existsSync(file)) {
      this.cache = null;
      this.cacheMtime = 0;
      return { locked: false, mode: "none", allowed: [] };
    }
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (this.cache && mtime === this.cacheMtime) {
        return this.cache;
      }
      this.cache = JSON.parse(fs.readFileSync(file, "utf-8")) as BoundaryState;
      this.cacheMtime = mtime;
      return this.cache;
    } catch {
      return { locked: false, mode: "none", allowed: [] };
    }
  }

  write(state: BoundaryState): void {
    this.ensureDir();
    const file = path.join(this.horsewhipDir, BOUNDARY_FILE);
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
    this.cache = state;
    this.cacheMtime = fs.statSync(file).mtimeMs;

    // Sync to allowlist.json so the Horsewhip extension sees the boundary
    const allowlistFile = path.join(this.horsewhipDir, "allowlist.json");
    const allowlist = {
      version: 2,
      updatedAt: new Date().toISOString(),
      allowed: state.allowed ?? [],
      guardActive: state.locked,
    };
    fs.writeFileSync(allowlistFile, JSON.stringify(allowlist, null, 2), "utf-8");
  }

  delete(): void {
    const file = path.join(this.horsewhipDir, BOUNDARY_FILE);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    // Also clean up allowlist.json
    const allowlistFile = path.join(this.horsewhipDir, "allowlist.json");
    if (fs.existsSync(allowlistFile)) {
      fs.unlinkSync(allowlistFile);
    }
    this.cache = null;
  }

  ensureDir(): void {
    if (!fs.existsSync(this.horsewhipDir)) {
      fs.mkdirSync(this.horsewhipDir, { recursive: true });
    }
  }
}

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type {
  HorsewhipGuard,
  BoundaryCheck,
  BoundaryState,
  BoundaryGates,
} from "../types.js";
import type { MCPLoader } from "../mcp/loader.js";
import { logger } from "../logger.js";
import { BoundaryFileManager, PATH_RE } from "./boundary-parser.js";
import { AuditLogger } from "./audit.js";

// --- HorsewhipGuardImpl ---

export class HorsewhipGuardImpl implements HorsewhipGuard {
  private workspaceRoot: string;
  private boundary: BoundaryFileManager;
  private audit: AuditLogger;
  private mcpLoader: MCPLoader | null = null;
  private trackedFiles: Set<string> | null = null;
  /** Dev mode: bypass all boundary checks, allow all writes */
  public disabled = false;

  constructor(workspaceRoot: string, mcpLoader?: MCPLoader) {
    this.workspaceRoot = workspaceRoot;
    const hwDir = path.join(workspaceRoot, ".git", "horsewhip");
    this.boundary = new BoundaryFileManager(hwDir);
    this.audit = new AuditLogger(hwDir);
    if (mcpLoader) this.mcpLoader = mcpLoader;
  }

  // === HorsewhipGuard interface ===

  async checkWrite(filePath: string): Promise<BoundaryCheck> {
    if (this.disabled) return { allowed: true, path: "" };

    const relPath = path.relative(this.workspaceRoot, filePath);
    if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
      return { allowed: false, path: relPath, reason: "Path traversal blocked: outside workspace" };
    }

    // Hard system protection: .chitu/ is append-only
    if (relPath.startsWith(".chitu/")) {
      // Chitu metadata dirs — always writable, bypass boundary entirely
      if (relPath.startsWith(".chitu/plans/") || relPath.startsWith(".chitu/interfaces/") ||
          relPath.startsWith(".chitu/completions/") || relPath.startsWith(".chitu/context/")) {
        return { allowed: true, path: relPath };
      }
      const absPath = path.resolve(this.workspaceRoot, relPath);
      try {
        if (fs.existsSync(absPath) && fs.statSync(absPath).size > 0) {
          return { allowed: false, path: relPath, reason: ".chitu/ is append-only: existing files cannot be overwritten or deleted. Create a new file if needed." };
        }
      } catch { /* file doesn't exist — allow creation */ }
    }

    const state = this.boundary.read();
    const g = state.gates;

    // ── Gates ──
    if (g) {
      const matched = (list: string[]) => list.some((p) => relPath === p || relPath.startsWith(p + "/"));
      if (g.writablePaths.length > 0 && !matched(g.writablePaths)) {
        const tracked = this.getTrackedFiles();
        if (!g.allowNewFiles || tracked.has(relPath)) {
          return { allowed: false, path: relPath, reason: `Write blocked: path not in [${g.writablePaths.join(", ")}]` };
        }
      }
      if (g.writablePaths.length === 0 && !g.allowNewFiles) {
        return { allowed: false, path: relPath, reason: "Write blocked: gates forbid all writes" };
      }
    }

    // Targeted lock: blocked list
    if (state.blocked !== undefined) {
      if (state.blocked.some((p) => relPath === p || relPath.startsWith(p + "/"))) {
        return { allowed: false, path: relPath, reason: "已 commit 的文件是只读的。要修改请先回滚。" };
      }
      return { allowed: true, path: relPath };
    }

    const tracked = this.getTrackedFiles();
    const matchAllowed = (list: string[]) =>
      list.some((p) => relPath === p || relPath.startsWith(p + "/"));

    // No lock active: everything allowed — constraint is opt-in, not opt-out
    if (!state.locked) {
      return { allowed: true, path: relPath };
    }

    // Decouple mode
    if (state.mode === "decouple") {
      if (!tracked.has(relPath)) return { allowed: true, path: relPath };
      if (matchAllowed(state.warn ?? [])) return { allowed: true, path: relPath };
      const strict = (state.strict && state.strict.length > 0) ? state.strict : state.allowed;
      if (matchAllowed(strict)) return { allowed: true, path: relPath };
      const reason = "Decouple mode: tracked files are read-only. Create new files instead.";
      this.audit.append({ type: "strict_block", file: relPath, reason, task: state.task });
      return { allowed: false, path: relPath, reason };
    }

    // Pasture mode
    if (state.allowed.length === 0) {
      if (!tracked.has(relPath)) return { allowed: true, path: relPath };
      const reason = "Pasture mode active but allowlist is empty. Set a boundary first.";
      this.audit.append({ type: "strict_block", file: relPath, reason, task: state.task });
      return { allowed: false, path: relPath, reason };
    }
    if (matchAllowed(state.warn ?? [])) return { allowed: true, path: relPath };
    const effStrict = (state.strict && state.strict.length > 0) ? state.strict : state.allowed;
    if (matchAllowed(effStrict)) return { allowed: true, path: relPath };
    if (!tracked.has(relPath)) return { allowed: true, path: relPath };

    const reason = `File '${relPath}' is not in the allowlist. Use expand_boundary to unlock.`;
    this.audit.append({ type: "strict_block", file: relPath, reason, task: state.task });
    return { allowed: false, path: relPath, reason };
  }

  async checkCommand(command: string, workdir: string): Promise<BoundaryCheck> {
    if (this.disabled) return { allowed: true, path: "" };

    // .chitu/ append-only protection
    if (/\.chitu(?:\/|\s|$)/.test(command)) {
      if (/\b(?:rm|shred|truncate|unlink)\b/.test(command) ||
          (/\bmv\b/.test(command) && /\/dev\/null/.test(command)) ||
          />>?\s*\.chitu\//.test(command)) {
        return { allowed: false, path: command.slice(0, 80), reason: ".chitu/ is append-only: cannot overwrite or delete plan files." };
      }
    }

    const state = this.boundary.read();

    // ── Gates: shell writes ──
    if (state.gates && HorsewhipGuardImpl.hasWriteConstruct(command)) {
      const g = state.gates;
      if (!g.allowShellWrite) {
        const writeTargets = HorsewhipGuardImpl.extractWriteTargets(command);
        const matched = (list: string[]) =>
          list.some((p) => writeTargets.some((t) => {
            const rel = path.relative(this.workspaceRoot, path.resolve(workdir, t));
            return rel === p || rel.startsWith(p + "/");
          }));
        if (writeTargets.length === 0 || g.writablePaths.length === 0 || !matched(g.writablePaths)) {
          return { allowed: false, path: command.slice(0, 80), reason: "Shell write blocked by gates. Use write_file." };
        }
      }
    }

    // Targeted lock
    if (state.blocked !== undefined) {
      if (HorsewhipGuardImpl.hasWriteConstruct(command)) {
        for (const target of HorsewhipGuardImpl.extractWriteTargets(command)) {
          const absPath = path.resolve(workdir, target);
          const relPath = path.relative(this.workspaceRoot, absPath);
          if (relPath.startsWith("..")) continue;
          if (state.blocked.some((p) => relPath === p || relPath.startsWith(p + "/"))) {
            return { allowed: false, path: relPath, reason: "已 commit 的文件是只读的。要修改请先回滚。" };
          }
        }
      }
      return { allowed: true, path: "" };
    }

    if (!state.locked) {
      return { allowed: true, path: "" };
    }

    if (state.mode === "decouple") {
      if (HorsewhipGuardImpl.hasWriteConstruct(command)) {
        const reason = "Decouple mode: shell write blocked. Use write_file tool to discover which files need unlocking.";
        this.audit.append({ type: "strict_block", file: command.slice(0, 80), reason, task: state.task });
        return { allowed: false, path: command.slice(0, 80), reason };
      }
      return { allowed: true, path: "" };
    }

    const tracked = this.getTrackedFiles();
    const writeTargets = HorsewhipGuardImpl.extractWriteTargets(command);
    for (const target of writeTargets) {
      const absPath = path.resolve(workdir, target);
      const relPath = path.relative(this.workspaceRoot, absPath);
      if (relPath.startsWith("..")) continue;

      if (HorsewhipGuardImpl.isDestructiveCommand(command, target)) {
        const reason = `File '${relPath}' is not in the allowlist. Use expand_boundary to unlock.`;
        this.audit.append({ type: "strict_block", file: relPath, reason, task: state.task });
        return { allowed: false, path: relPath, reason };
      }

      const reason = state.allowed.length === 0
        ? "Pasture mode active but allowlist is empty."
        : `File '${relPath}' is not in the allowlist. Use expand_boundary to unlock.`;

      if (state.allowed.length === 0) {
        this.audit.append({ type: "strict_block", file: relPath, reason, task: state.task });
        return { allowed: false, path: relPath, reason };
      }

      const matchAllowed = (list: string[]) =>
        list.some((p) => relPath === p || relPath.startsWith(p + "/"));
      if (tracked.has(relPath) && matchAllowed(state.warn ?? [])) continue;
      const strictList = (state.strict && state.strict.length > 0) ? state.strict : state.allowed;
      if (matchAllowed(strictList)) continue;

      this.audit.append({ type: "strict_block", file: relPath, reason, task: state.task });
      return { allowed: false, path: relPath, reason };
    }
    return { allowed: true, path: "" };
  }

  // === Static: shell command parsing ===

  private static hasWriteConstruct(command: string): boolean {
    if (/[^<>]\s*>>?\s*(?:\/|\.)/.test(command) || /^>>?\s*(?:\/|\.)/.test(command)) return true;
    if (/\b(?:rm|tee|dd|cp|mv|touch|ln|truncate|shred)\b/.test(command)) return true;
    if (/\bsed\s+.*-i/.test(command)) return true;
    if (/\b(?:python\d*|node|ruby|perl|php)\s+-[ce]\b/.test(command)) return true;
    if (/\b(?:npm|yarn|pnpm|pip|gem|cargo)\s+(?:install|add|remove)\b/.test(command)) return true;
    if (/\bgit\s+(?:restore|reset|checkout|rm|update-index)\b/.test(command)) return true;
    return false;
  }

  static extractWriteTargets(command: string): string[] {
    const targets: string[] = [];
    const add = (p: string) => { const t = p.trim().replace(/^["']|["']$/g, ""); if (t) targets.push(t); };

    let m: RegExpExecArray | null;
    const redirectRe = /[0-9&]*>>?\s*["']?([^\s|;&<>]+)["']?/g;
    while ((m = redirectRe.exec(command)) !== null) add(m[1]!);

    const teeRe = /tee\s+(?:-a\s+)?["']?([^\s|;&]+)["']?/g;
    while ((m = teeRe.exec(command)) !== null) add(m[1]!);

    const ddRe = /\bdd\b\s+.*?\bof=(\S+)/g;
    while ((m = ddRe.exec(command)) !== null) add(m[1]!);

    const sedRe = /sed\s+(?:-[a-zA-Z]*i[a-zA-Z]*\s+)?(?:".*?"\s+)?(?:'.*?'\s+)?["']?([^\s|;&"']+)["']?\s*$/gm;
    while ((m = sedRe.exec(command)) !== null) add(m[1]!);

    const cpMvRe = /(?:cp|mv)\s+(?:-[a-zA-Z]+\s+)*.+?\s+["']?([^\s|;&"']+)["']?\s*$/gm;
    while ((m = cpMvRe.exec(command)) !== null) add(m[1]!);

    const mvSourceRe = /\bmv\b\s+(?:-[a-zA-Z]+\s+)*["']?([^\s|;&"']+)["']?\s+["']?([^\s|;&"']+)["']?/g;
    while ((m = mvSourceRe.exec(command)) !== null) { add(m[1]!); add(m[2]!); }

    const touchRe = /\btouch\b\s+(?:-[a-zA-Z]+\s+)*["']?([^\s|;&]+)["']?/g;
    while ((m = touchRe.exec(command)) !== null) add(m[1]!);

    const lnRe = /\bln\b\s+(?:-[a-zA-Z]+\s+)*["']?[^\s|;&"']+["']?\s+["']?([^\s|;&"']+)["']?/g;
    while ((m = lnRe.exec(command)) !== null) add(m[1]!);

    const truncateRe = /\btruncate\b\s+(?:-[a-zA-Z]+\s+\S+\s+)*["']?([^\s|;&]+)["']?/g;
    while ((m = truncateRe.exec(command)) !== null) {
      if (!/^-\d+$/.test(m[1]!)) add(m[1]!);
    }

    const shredRe = /\bshred\b\s+(?:-[a-zA-Z]+\s+)*["']?([^\s|;&]+)["']?/g;
    while ((m = shredRe.exec(command)) !== null) add(m[1]!);

    const gitRestoreRe = /\bgit\s+(?:checkout|restore|reset)\b(?:\s+--?\w+)*\s*(?:--\s+)?["']?([^\s|;&-][^\s|;&]*)["']?/g;
    while ((m = gitRestoreRe.exec(command)) !== null) add(m[1]!);
    const gitRmRe = /\bgit\s+rm\b\s+(?:-[a-zA-Z-]+\s+)*["']?([^\s|;&]+)["']?/g;
    while ((m = gitRmRe.exec(command)) !== null) add(m[1]!);

    if (/(?:npm|yarn|pnpm|pip|gem|cargo)\s+(?:install|add|remove)\b/.test(command)) {
      targets.push("package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml");
    }

    const inlineRe = /\b(?:python\d*|node|ruby|perl|php)\s+-[ce]\s+["']([^"']*)["']/g;
    while ((m = inlineRe.exec(command)) !== null) {
      const script = m[1] ?? "";
      if (/\b(?:open|write|writeFile|writeFileSync|output|save|fd\.write|File\.write|IO\.write)\s*\(/i.test(script) ||
          /\bwith\s+open\s*\(/i.test(script)) {
        targets.push(`<inline-script>:${command.slice(0, 60)}`);
      }
    }

    return [...new Set(targets)];
  }

  static isDestructiveCommand(command: string, target: string): boolean {
    if (/\brm\b/.test(command) && command.includes(target)) return true;
    if (/\bgit\s+rm\b/.test(command) && command.includes(target)) return true;
    if (/\bunlink\b/.test(command) && command.includes(target)) return true;
    if (/\bmv\b/.test(command) && /\/dev\/null/.test(command) && command.includes(target)) return true;
    if (/\bgit\s+(?:restore|checkout)\b/.test(command) && command.includes(target)) return true;
    if (/\bshred\b/.test(command) && command.includes(target)) return true;
    if (/\btruncate\b/.test(command) && command.includes(target)) return true;
    const mvMatch = command.match(/\bmv\b\s+(?:-[a-zA-Z]+\s+)*["']?([^\s|;&"']+)["']?\s+["']?([^\s|;&"']+)["']?/);
    if (mvMatch) {
      const mvSrc = mvMatch[1]?.replace(/^["']|["']$/g, "");
      if (mvSrc === target) return true;
    }
    return false;
  }

  // === Record / Boundary management ===

  async recordWrite(filePath: string, isNew?: boolean): Promise<void> {
    const relPath = path.relative(this.workspaceRoot, filePath);
    const state = this.boundary.read();
    const actuallyNew = isNew ?? !this.getTrackedFiles().has(relPath);
    this.audit.append({ type: "write", file: relPath, task: state.task, isNew: actuallyNew });
    this.trackedFiles = null;

    if (this.mcpLoader) {
      try {
        await this.mcpLoader.callMCPTool("mcp__horsewhip__horsewhip_record_write", { path: relPath });
      } catch (e) {
        logger.warn("MCP record_write failed", { error: String(e) });
      }
    }
  }

  async getBoundary(): Promise<{ locked: boolean; mode: string }> {
    const state = this.boundary.read();
    return { locked: state.locked, mode: state.mode };
  }

  lockIntent(task: string, allowed: string[], core?: string[], edge?: string[], reasons?: Record<string, string>, gates?: BoundaryGates): void {
    this.boundary.ensureDir();
    const isChituMeta = (p: string) => p.startsWith(".chitu/");
    const isPathSafe = (p: string) => PATH_RE.test(p) && !/[<>"(){}[\]|;:$!@#%^&*+=?~`,\\]/.test(p);
    const valid = allowed.filter((p) => isChituMeta(p) || isPathSafe(p));
    if (valid.length !== allowed.length) {
      const dropped = allowed.filter((p) => !isChituMeta(p) && !isPathSafe(p));
      if (dropped.length > 0) {
        console.error(`[guard] Dropped ${dropped.length} invalid path(s) from lockIntent: ${dropped.join(", ")}`);
      }
    }
    const oldState = this.boundary.read();
    const oldAllowed = new Set(oldState.allowed ?? []);
    const newAllowed = new Set(valid);

    const strictSet = new Set(core ?? valid);
    const warnSet = new Set(edge ?? []);
    const AUTO_WARN = /(?:package\.json|tsconfig\.json|\.mcp\.json|src\/index\.ts|src\/cli\.ts|\.env|\.gitignore|CHITU\.md)$/;
    for (const f of valid) { if (AUTO_WARN.test(f)) warnSet.add(f); }
    for (const f of warnSet) strictSet.delete(f);

    for (const f of newAllowed) {
      if (!oldAllowed.has(f)) {
        this.audit.append({ type: "file_unlocked", file: f, reason: reasons?.[f] ?? `lockIntent: ${task.slice(0, 40)}`, task });
      }
    }
    for (const f of oldAllowed) {
      if (!newAllowed.has(f)) {
        this.audit.append({ type: "file_locked", file: f, reason: "lock-back from lockIntent", task });
      }
    }

    this.boundary.write({
      locked: true, mode: "pasture", allowed: valid,
      strict: [...strictSet], warn: [...warnSet], task, gates,
    });
    this.audit.append({ type: "task_start", file: "", task });
  }

  lockDecouple(task: string, gates?: BoundaryGates): void {
    this.boundary.ensureDir();
    const oldState = this.boundary.read();
    for (const f of oldState.allowed ?? []) {
      this.audit.append({ type: "file_locked", file: f, reason: "lock-back to decouple", task });
    }
    this.boundary.write({ locked: true, mode: "decouple", allowed: [], task, gates });
    this.audit.append({ type: "task_start", file: "", task });
  }

  lockFiles(files: string[], task: string): void {
    this.boundary.ensureDir();
    this.boundary.write({ locked: true, mode: "none", allowed: [], task, blocked: files });
  }

  taskComplete(summary: string): void {
    this.audit.append({ type: "task_complete", file: "", reason: summary });
  }

  expandBoundary(paths: string[], reason?: string): void {
    const state = this.boundary.read();
    if (!state.locked) return;
    for (const p of paths) {
      if (!state.allowed.includes(p)) state.allowed.push(p);
      if (state.mode === "pasture" && state.strict && !state.strict.includes(p)) state.strict.push(p);
    }
    this.boundary.write(state);
    for (const p of paths) {
      this.audit.append({ type: "user_expand", file: p, reason: reason ?? "expand_boundary", task: state.task });
    }
  }

  unlock(): void {
    this.boundary.delete();
  }

  getBoundaryState(): BoundaryState {
    return this.boundary.read();
  }

  clearTrackedCache(): void {
    this.trackedFiles = null;
  }

  // === Tracked files ===

  getTrackedFiles(): Set<string> {
    if (this.trackedFiles) return this.trackedFiles;
    try {
      const result = execSync("git ls-files", {
        encoding: "utf-8", cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024,
      });
      this.trackedFiles = new Set(result.split("\n").filter(Boolean));
    } catch {
      this.trackedFiles = new Set();
    }
    return this.trackedFiles;
  }
}

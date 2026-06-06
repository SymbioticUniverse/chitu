import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type {
  HorsewhipGuard,
  BoundaryCheck,
  BoundaryState,
  BoundaryGates,
  LockMode,
  AuditEvent,
  AuditEventType,
} from "../types.js";
import type { MCPLoader } from "../mcp/loader.js";
import { logger } from "../logger.js";

// --- In-process boundary file management ---

const BOUNDARY_FILE = "boundary.json";
const AUDIT_FILE = "session-audit.json";

let eventSeq = 0;

function nextId(): string {
  return `evt-${Date.now()}-${++eventSeq}`;
}

// --- HorsewhipGuardImpl ---

export class HorsewhipGuardImpl implements HorsewhipGuard {
  private workspaceRoot: string;
  private horsewhipDir: string;
  private mcpLoader: MCPLoader | null = null;
  private trackedFiles: Set<string> | null = null;
  private boundaryCache: BoundaryState | null = null;
  private boundaryCacheMtime: number = 0;
  private lastEventId: string | null = null;
  /** Dev mode: bypass all boundary checks, allow all writes */
  public disabled = false;

  constructor(workspaceRoot: string, mcpLoader?: MCPLoader) {
    this.workspaceRoot = workspaceRoot;
    this.horsewhipDir = path.join(workspaceRoot, ".git", "horsewhip");
    if (mcpLoader) this.mcpLoader = mcpLoader;
  }

  // --- HorsewhipGuard interface ---

  async checkWrite(filePath: string): Promise<BoundaryCheck> {
    // Dev mode: trust self, no boundary
    if (this.disabled) {
      return { allowed: true, path: "" };
    }

    const relPath = path.relative(this.workspaceRoot, filePath);

    // Reject writes outside workspace
    if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
      return { allowed: false, path: relPath, reason: `Path traversal blocked: outside workspace` };
    }

    // Hard system protection: .chitu/ is append-only.
    // Exceptions: plans/ and interfaces/ are managed documents, editable across iterations.
    if (relPath.startsWith(".chitu/")) {
      if (relPath.startsWith(".chitu/plans/") || relPath.startsWith(".chitu/interfaces/")) {
        // Managed documents — allow edits
      } else {
        const absPath = path.resolve(this.workspaceRoot, relPath);
        try {
          if (fs.existsSync(absPath) && fs.statSync(absPath).size > 0) {
            return { allowed: false, path: relPath, reason: ".chitu/ is append-only: existing files cannot be overwritten or deleted. Create a new file if needed." };
          }
        } catch { /* file doesn't exist — allow creation of new .chitu/ files */ }
      }
    }

    const state = this.readBoundary();

    // ── Gates: composable conditions enforced BEFORE pasture/decouple logic ──
    if (state.gates) {
      const g = state.gates;
      const matched = (list: string[]) =>
        list.some((p) => relPath === p || relPath.startsWith(p + "/"));

      // Rule 1: writes must be within writablePaths (if set)
      if (g.writablePaths.length > 0 && !matched(g.writablePaths)) {
        // Unless allowNewFiles is true and the file is untracked
        const tracked = this.getTrackedFiles();
        if (g.allowNewFiles && !tracked.has(relPath)) {
          // New file allowed anywhere
        } else {
          return { allowed: false, path: relPath, reason: `Write blocked: path not in [${g.writablePaths.join(", ")}]` };
        }
      }

      // Rule 2: if allowNewFiles is false AND writablePaths is set,
      // new files outside writablePaths already caught above.
      // If writablePaths is empty and allowNewFiles is false, block all writes.
      if (g.writablePaths.length === 0 && !g.allowNewFiles) {
        return { allowed: false, path: relPath, reason: "Write blocked: gates forbid all writes" };
      }
    }

    // Targeted lock: blocked list (even empty) means "only block these, allow everything else"
    if (state.blocked !== undefined) {
      if (state.blocked.some((p) => relPath === p || relPath.startsWith(p + "/"))) {
        return { allowed: false, path: relPath, reason: "已 commit 的文件是只读的。要修改请先回滚。" };
      }
      return { allowed: true, path: relPath };
    }

    const tracked = this.getTrackedFiles();

    // No lock active: new files OK, tracked files read-only
    if (!state.locked) {
      if (!tracked.has(relPath)) {
        return { allowed: true, path: relPath };
      }
      return { allowed: false, path: relPath, reason: "Implicit decouple: tracked files are read-only by default. Set a boundary to allow writes." };
    }

    const matchAllowed = (list: string[]) =>
      list.some((p) => relPath === p || relPath.startsWith(p + "/"));

    // Decouple mode: new files OK, tracked files must be in allowlist
    if (state.mode === "decouple") {
      if (!tracked.has(relPath)) {
        return { allowed: true, path: relPath };
      }
      if (matchAllowed(state.warn ?? [])) return { allowed: true, path: relPath };
      const decoupleStrict = (state.strict && state.strict.length > 0) ? state.strict : state.allowed;
      if (matchAllowed(decoupleStrict)) return { allowed: true, path: relPath };
      const reason = "Decouple mode: tracked files are read-only. Create new files instead.";
      this.appendAudit({ type: "strict_block", file: relPath, reason, task: state.task });
      return { allowed: false, path: relPath, reason };
    }

    // Pasture mode: tracked (committed) files must match the allowlist.
    // New (untracked) files are free territory — Horsewhip only locks what's committed.
    if (state.allowed.length === 0) {
      if (!tracked.has(relPath)) return { allowed: true, path: relPath };
      const reason = "Pasture mode active but allowlist is empty. Set a boundary first.";
      this.appendAudit({ type: "strict_block", file: relPath, reason, task: state.task });
      return { allowed: false, path: relPath, reason };
    }

    if (matchAllowed(state.warn ?? [])) return { allowed: true, path: relPath };
    const effectiveStrict = (state.strict && state.strict.length > 0) ? state.strict : state.allowed;
    if (matchAllowed(effectiveStrict)) return { allowed: true, path: relPath };

    // New files are always allowed — only committed files need authorization
    if (!tracked.has(relPath)) return { allowed: true, path: relPath };

    const reason = `File '${relPath}' is not in the allowlist. Use expand_boundary to unlock.`;
    this.appendAudit({ type: "strict_block", file: relPath, reason, task: state.task });
    return { allowed: false, path: relPath, reason };
  }

  /** Check if a shell command tries to write to out-of-boundary files via redirect/tee/sed/cp/mv/rm */
  async checkCommand(command: string, workdir: string): Promise<BoundaryCheck> {
    // Dev mode: trust self
    if (this.disabled) {
      return { allowed: true, path: "" };
    }

    // Hard system protection: .chitu/ is append-only.
    // Block any destructive shell command that targets .chitu/ files.
    if (/\.chitu(?:\/|\s|$)/.test(command)) {
      if (/\b(?:rm|shred|truncate|unlink)\b/.test(command)) {
        return { allowed: false, path: command.slice(0, 80), reason: ".chitu/ is append-only: cannot delete plan files or router index." };
      }
      if (/\bmv\b/.test(command) && /\/dev\/null/.test(command)) {
        return { allowed: false, path: command.slice(0, 80), reason: ".chitu/ is append-only: cannot delete plan files or router index." };
      }
      // Also block redirect-overwrite targeting .chitu/
      if (/>>?\s*\.chitu\//.test(command)) {
        return { allowed: false, path: command.slice(0, 80), reason: ".chitu/ is append-only: cannot overwrite plan files via shell redirect." };
      }
    }

    const state = this.readBoundary();

    // ── Gates: composable conditions for shell writes ──
    if (state.gates && HorsewhipGuardImpl.hasWriteConstruct(command)) {
      const g = state.gates;
      if (!g.allowShellWrite) {
        // Even if allowShellWrite is false, check if the command only targets writablePaths
        const writeTargets = HorsewhipGuardImpl.extractWriteTargets(command);
        const matched = (list: string[]) =>
          list.some((p) => writeTargets.some((t) => {
            const rel = path.relative(this.workspaceRoot, path.resolve(workdir, t));
            return rel === p || rel.startsWith(p + "/");
          }));
        if (writeTargets.length === 0 || g.writablePaths.length === 0 || !matched(g.writablePaths)) {
          return { allowed: false, path: command.slice(0, 80), reason: `Shell write blocked by gates. Use write_file.` };
        }
      }
    }

    // Targeted lock: blocked list (even empty) means "only block these, allow everything else"
    if (state.blocked !== undefined) {
      if (HorsewhipGuardImpl.hasWriteConstruct(command)) {
        const writeTargets = HorsewhipGuardImpl.extractWriteTargets(command);
        for (const target of writeTargets) {
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
      // Implicit decouple: block shell writes, force AI to use write_file
      if (HorsewhipGuardImpl.hasWriteConstruct(command)) {
        return { allowed: false, path: command.slice(0, 80), reason: "Implicit decouple: shell writes blocked. Use write_file to discover which files need unlocking." };
      }
      return { allowed: true, path: "" };
    }

    // In decouple mode, block any shell write — AI must use write_file to discover blocks
    if (state.mode === "decouple") {
      // Detect any write-like shell construct
      if (HorsewhipGuardImpl.hasWriteConstruct(command)) {
        const reason = "Decouple mode: shell write blocked. Use write_file tool to discover which files need unlocking.";
        this.appendAudit({ type: "strict_block", file: command.slice(0, 80), reason, task: state.task });
        return { allowed: false, path: command.slice(0, 80), reason };
      }
      return { allowed: true, path: "" };
    }

    // Pasture mode: ALL write targets (tracked AND untracked) must be in allowlist.
    // Shell commands are checked strictly — AI must use write_file for files,
    // shell is for build/test, not for circumventing boundary.
    const tracked = this.getTrackedFiles();
    const writeTargets = HorsewhipGuardImpl.extractWriteTargets(command);

    for (const target of writeTargets) {
      const absPath = path.resolve(workdir, target);
      const relPath = path.relative(this.workspaceRoot, absPath);
      if (relPath.startsWith("..")) continue;

      // Deletion check: block destructive commands on all files
      if (HorsewhipGuardImpl.isDestructiveCommand(command, target)) {
        const reason = `File '${relPath}' is not in the allowlist. Use expand_boundary to unlock.`;
        this.appendAudit({ type: "strict_block", file: relPath, reason, task: state.task });
        return { allowed: false, path: relPath, reason };
      }

      // Allowlist check — applies to tracked AND untracked files in pasture mode.
      // Untracked: prevents shell bypass for writing "new" files outside boundary.
      const isTracked = tracked.has(relPath);
      const reason = state.allowed.length === 0
        ? "Pasture mode active but allowlist is empty."
        : `File '${relPath}' is not in the allowlist. Use expand_boundary to unlock.`;

      if (state.allowed.length === 0) {
        this.appendAudit({ type: "strict_block", file: relPath, reason, task: state.task });
        return { allowed: false, path: relPath, reason };
      }

      const matchAllowed = (list: string[]) =>
        list.some((p) => relPath === p || relPath.startsWith(p + "/"));

      if (isTracked && matchAllowed(state.warn ?? [])) continue;
      const strictList = (state.strict && state.strict.length > 0) ? state.strict : state.allowed;
      if (matchAllowed(strictList)) continue;

      this.appendAudit({ type: "strict_block", file: relPath, reason, task: state.task });
      return { allowed: false, path: relPath, reason };
    }
    return { allowed: true, path: "" };
  }

  /** Detect if a shell command has write-like constructs (redirects, tee, cp, mv, etc.)
   *  Conservative: only used in decouple mode to trigger write_file discovery flow. */
  private static hasWriteConstruct(command: string): boolean {
    // Redirect: > or >> used as output redirect (not comparison, not inside quotes)
    if (/[^<>]\s*>>?\s*(?:\/|\.)/.test(command) || /^>>?\s*(?:\/|\.)/.test(command)) return true;
    // rm, tee, dd, sed -i, cp, mv, touch, ln, truncate, shred
    if (/\b(?:rm|tee|dd|cp|mv|touch|ln|truncate|shred)\b/.test(command)) return true;
    // sed -i (in-place)
    if (/\bsed\s+.*-i/.test(command)) return true;
    // Inline script: python -c 'write(...)'
    if (/\b(?:python\d*|node|ruby|perl|php)\s+-[ce]\b/.test(command)) return true;
    // install commands that modify package files
    if (/\b(?:npm|yarn|pnpm|pip|gem|cargo)\s+(?:install|add|remove)\b/.test(command)) return true;
    // git restore/reset/checkout that modifies files
    if (/\bgit\s+(?:restore|reset|checkout)\b/.test(command)) return true;
    // git rm / git update-index — changes git tracking state, must NOT be used to bypass
    if (/\bgit\s+(?:rm|update-index)\b/.test(command)) return true;
    return false;
  }

  /** Parse a shell command string for file paths that are write/destructive targets */
  static extractWriteTargets(command: string): string[] {
    const targets: string[] = [];
    const add = (p: string) => { const t = p.trim().replace(/^["']|["']$/g, ""); if (t) targets.push(t); };

    // Redirect: >file, >>file, 2>file, &>file, 1>file (but not << or <)
    const redirectRe = /[0-9&]*>>?\s*["']?([^\s|;&<>]+)["']?/g;
    let m: RegExpExecArray | null;
    while ((m = redirectRe.exec(command)) !== null) add(m[1]!);

    // tee command
    const teeRe = /tee\s+(?:-a\s+)?["']?([^\s|;&]+)["']?/g;
    while ((m = teeRe.exec(command)) !== null) add(m[1]!);

    // dd of=file
    const ddRe = /\bdd\b\s+.*?\bof=(\S+)/g;
    while ((m = ddRe.exec(command)) !== null) add(m[1]!);

    // sed -i file (in-place edit — file is last non-flag arg)
    const sedRe = /sed\s+(?:-[a-zA-Z]*i[a-zA-Z]*\s+)?(?:".*?"\s+)?(?:'.*?'\s+)?["']?([^\s|;&"']+)["']?\s*$/gm;
    while ((m = sedRe.exec(command)) !== null) add(m[1]!);

    // cp/mv destination (last non-flag arg)
    const cpMvRe = /(?:cp|mv)\s+(?:-[a-zA-Z]+\s+)*.+?\s+["']?([^\s|;&"']+)["']?\s*$/gm;
    while ((m = cpMvRe.exec(command)) !== null) add(m[1]!);

    // mv source detection (source file is deleted by mv)
    const mvSourceRe = /\bmv\b\s+(?:-[a-zA-Z]+\s+)*["']?([^\s|;&"']+)["']?\s+["']?([^\s|;&"']+)["']?/g;
    while ((m = mvSourceRe.exec(command)) !== null) { add(m[1]!); add(m[2]!); }

    // touch file
    const touchRe = /\btouch\b\s+(?:-[a-zA-Z]+\s+)*["']?([^\s|;&]+)["']?/g;
    while ((m = touchRe.exec(command)) !== null) add(m[1]!);

    // ln -s destination (creates symlink at dest)
    const lnRe = /\bln\b\s+(?:-[a-zA-Z]+\s+)*["']?[^\s|;&"']+["']?\s+["']?([^\s|;&"']+)["']?/g;
    while ((m = lnRe.exec(command)) !== null) add(m[1]!);

    // truncate file (skip -s SIZE flag, match last non-flag arg)
    const truncateRe = /\btruncate\b\s+(?:-[a-zA-Z]+\s+\S+\s+)*["']?([^\s|;&]+)["']?/g;
    while ((m = truncateRe.exec(command)) !== null) {
      if (!/^-\d+$/.test(m[1]!)) add(m[1]!);
    }

    // shred file
    const shredRe = /\bshred\b\s+(?:-[a-zA-Z]+\s+)*["']?([^\s|;&]+)["']?/g;
    while ((m = shredRe.exec(command)) !== null) add(m[1]!);

    // git checkout/restore/reset — skip -- separator, match target
    const gitRestoreRe = /\bgit\s+(?:checkout|restore|reset)\b(?:\s+--?\w+)*\s*(?:--\s+)?["']?([^\s|;&-][^\s|;&]*)["']?/g;
    while ((m = gitRestoreRe.exec(command)) !== null) add(m[1]!);
    // git rm / git rm --cached
    const gitRmRe = /\bgit\s+rm\b\s+(?:-[a-zA-Z-]+\s+)*["']?([^\s|;&]+)["']?/g;
    while ((m = gitRmRe.exec(command)) !== null) add(m[1]!);

    // install commands — flag lock/config files as write targets
    if (/(?:npm|yarn|pnpm|pip|gem|cargo)\s+(?:install|add|remove)\b/.test(command)) {
      targets.push("package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml");
    }

    // Inline script detection — flag scripts that contain file I/O operations
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

  /** Detect if a command is destructive (rm, unlink, etc.) targeting a specific file */
  static isDestructiveCommand(command: string, target: string): boolean {
    if (/\brm\b/.test(command) && command.includes(target)) return true;
    if (/\bgit\s+rm\b/.test(command) && command.includes(target)) return true;
    if (/\bunlink\b/.test(command) && command.includes(target)) return true;
    if (/\bmv\b/.test(command) && /\/dev\/null/.test(command) && command.includes(target)) return true;
    if (/\bgit\s+(?:restore|checkout)\b/.test(command) && command.includes(target)) return true;
    if (/\bshred\b/.test(command) && command.includes(target)) return true;
    if (/\btruncate\b/.test(command) && command.includes(target)) return true;
    // mv source is deleted — check if target is the first file arg (source), not the destination
    const mvMatch = command.match(/\bmv\b\s+(?:-[a-zA-Z]+\s+)*["']?([^\s|;&"']+)["']?\s+["']?([^\s|;&"']+)["']?/);
    if (mvMatch) {
      const mvSrc = mvMatch[1]?.replace(/^["']|["']$/g, "");
      if (mvSrc === target) return true;
    }
    return false;
  }

  async recordWrite(filePath: string, isNew?: boolean): Promise<void> {
    const relPath = path.relative(this.workspaceRoot, filePath);
    const state = this.readBoundary();

    // isNew is passed by the tool handler (checked before the write).
    // If not provided, fall back to checking git tracking — a file that isn't
    // tracked by git is likely new (though it may have been created by a prior step).
    const actuallyNew = isNew ?? !this.getTrackedFiles().has(relPath);

    this.appendAudit({ type: "write", file: relPath, task: state.task, isNew: actuallyNew });

    // Invalidate tracked file cache — new files may become tracked
    this.trackedFiles = null;

    // Sync to MCP if available
    if (this.mcpLoader) {
      try {
        await this.mcpLoader.callMCPTool(
          "mcp__horsewhip__horsewhip_record_write",
          { path: relPath }
        );
      } catch (e) {
        logger.warn("MCP record_write failed", { error: String(e) });
      }
    }
  }

  async getBoundary(): Promise<{ locked: boolean; mode: string }> {
    const state = this.readBoundary();
    return { locked: state.locked, mode: state.mode };
  }

  // --- Extended API (for SelfIterator / CLI) ---

  /** Valid file path pattern — relative paths with optional extension, no regex or special chars */
  private static PATH_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_./\\-]*$/;

  lockIntent(task: string, allowed: string[], core?: string[], edge?: string[], reasons?: Record<string, string>, gates?: BoundaryGates): void {
    this.ensureDir();
    const valid = allowed.filter((p) => HorsewhipGuardImpl.PATH_RE.test(p) && !/[<>"(){}[\]|;:$!@#%^&*+=?~`,\\]/.test(p));
    if (valid.length !== allowed.length) {
      const dropped = allowed.filter((p) => !HorsewhipGuardImpl.PATH_RE.test(p) || /[<>"(){}[\]|;:$!@#%^&*+=?~`,\\]/.test(p));
      console.error(`[guard] Dropped ${dropped.length} invalid path(s) from lockIntent: ${dropped.join(", ")}`);
    }
    const oldState = this.readBoundary();
    const oldAllowed = new Set(oldState.allowed ?? []);
    const newAllowed = new Set(valid);

    // Resolve tiers: core = strict, edge = warn
    const strictSet = new Set(core ?? valid);
    const warnSet = new Set(edge ?? []);
    // Auto-classify common config/entry files as warn-tier
    const AUTO_WARN = /(?:package\.json|tsconfig\.json|\.mcp\.json|src\/index\.ts|src\/cli\.ts|\.env|\.gitignore|CHITU\.md)$/;
    for (const f of valid) {
      if (AUTO_WARN.test(f)) warnSet.add(f);
    }
    // Remove warn files from strict
    for (const f of warnSet) strictSet.delete(f);

    // Files newly unlocked
    for (const f of newAllowed) {
      if (!oldAllowed.has(f)) {
        const fileReason = reasons?.[f] ?? `lockIntent: ${task.slice(0, 40)}`;
        this.appendAudit({ type: "file_unlocked", file: f, reason: fileReason, task });
      }
    }
    // Files locked back (were allowed, no longer)
    for (const f of oldAllowed) {
      if (!newAllowed.has(f)) {
        this.appendAudit({ type: "file_locked", file: f, reason: "lock-back from lockIntent", task });
      }
    }

    const state: BoundaryState = {
      locked: true,
      mode: "pasture",
      allowed: valid,
      strict: [...strictSet],
      warn: [...warnSet],
      task,
      gates,
    };
    this.writeBoundary(state);
    this.appendAudit({ type: "task_start", file: "", task });
  }

  lockDecouple(task: string, gates?: BoundaryGates): void {
    this.ensureDir();
    const oldState = this.readBoundary();
    // All previously allowed files are now locked back
    for (const f of oldState.allowed ?? []) {
      this.appendAudit({ type: "file_locked", file: f, reason: "lock-back to decouple", task });
    }
    const state: BoundaryState = { locked: true, mode: "decouple", allowed: [], task, gates };
    this.writeBoundary(state);
    this.appendAudit({ type: "task_start", file: "", task });
  }

  /** Lock only specific committed files — everything else is free.
   *  This is the execution-phase lock: previous sub-goal files are frozen,
   *  current sub-goal target files and new files are freely writable. */
  lockFiles(files: string[], task: string): void {
    this.ensureDir();
    const state: BoundaryState = {
      locked: true,
      mode: "none",
      allowed: [],
      task,
      blocked: files,
    };
    this.writeBoundary(state);
  }

  taskComplete(summary: string): void {
    this.appendAudit({ type: "task_complete", file: "", reason: summary });
  }

  expandBoundary(paths: string[], reason?: string): void {
    const state = this.readBoundary();
    if (!state.locked) return;
    for (const p of paths) {
      if (!state.allowed.includes(p)) {
        state.allowed.push(p);
      }
      // In pasture mode, checkWrite uses strict list — must also add there
      if (state.mode === "pasture" && state.strict && !state.strict.includes(p)) {
        state.strict.push(p);
      }
    }
    this.writeBoundary(state);
    for (const p of paths) {
      this.appendAudit({ type: "user_expand", file: p, reason: reason ?? "expand_boundary", task: state.task });
    }
  }

  unlock(): void {
    const file = path.join(this.horsewhipDir, BOUNDARY_FILE);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    this.boundaryCache = null;
  }

  getBoundaryState(): BoundaryState {
    return this.readBoundary();
  }

  clearTrackedCache(): void {
    this.trackedFiles = null;
  }

  // --- Tracked files ---

  getTrackedFiles(): Set<string> {
    if (this.trackedFiles) return this.trackedFiles;
    try {
      const result = execSync("git ls-files", {
        encoding: "utf-8",
        cwd: this.workspaceRoot,
        maxBuffer: 10 * 1024 * 1024,
      });
      this.trackedFiles = new Set(result.split("\n").filter(Boolean));
    } catch {
      this.trackedFiles = new Set();
    }
    return this.trackedFiles;
  }

  // --- Private: boundary file I/O ---

  private readBoundary(): BoundaryState {
    const file = path.join(this.horsewhipDir, BOUNDARY_FILE);
    if (!fs.existsSync(file)) {
      this.boundaryCache = null;
      this.boundaryCacheMtime = 0;
      return { locked: false, mode: "none", allowed: [] };
    }
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (this.boundaryCache && mtime === this.boundaryCacheMtime) {
        return this.boundaryCache;
      }
      this.boundaryCache = JSON.parse(fs.readFileSync(file, "utf-8")) as BoundaryState;
      this.boundaryCacheMtime = mtime;
      return this.boundaryCache;
    } catch {
      return { locked: false, mode: "none", allowed: [] };
    }
  }

  private writeBoundary(state: BoundaryState): void {
    this.ensureDir();
    const file = path.join(this.horsewhipDir, BOUNDARY_FILE);
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
    this.boundaryCache = state;
    this.boundaryCacheMtime = fs.statSync(file).mtimeMs;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.horsewhipDir)) {
      fs.mkdirSync(this.horsewhipDir, { recursive: true });
    }
  }

  private appendAudit(event: {
    type: AuditEventType;
    file: string;
    reason?: string;
    task?: string;
    isNew?: boolean;
  }): void {
    this.ensureDir();
    const evt: AuditEvent = {
      id: nextId(),
      type: event.type,
      file: event.file,
      reason: event.reason,
      timestamp: new Date().toISOString(),
      task: event.task,
      isNew: event.isNew,
    };
    if (this.lastEventId) evt.causedBy = this.lastEventId;
    this.lastEventId = evt.id;

    const auditPath = path.join(this.horsewhipDir, AUDIT_FILE);

    // Migrate old format to JSONL on first write
    if (fs.existsSync(auditPath)) {
      try {
        const raw = fs.readFileSync(auditPath, "utf-8").trim();
        if (!raw.startsWith('{"id":"evt-')) {
          const data = JSON.parse(raw) as { events?: AuditEvent[] } | AuditEvent[];
          const oldEvents: AuditEvent[] = Array.isArray(data) ? data : (data.events ?? []);
          const lines = oldEvents.map((e) => JSON.stringify(e)).join("\n");
          fs.writeFileSync(auditPath, lines + (lines ? "\n" : ""), "utf-8");
          // Restore lastEventId from migrated data
          const last = oldEvents[oldEvents.length - 1];
          if (last) this.lastEventId = last.id;
        }
      } catch { /* leave as-is, append JSONL anyway */ }
    }

    // JSONL append — O(1) instead of O(n²) read-all+write-all
    fs.appendFileSync(auditPath, JSON.stringify(evt) + "\n", "utf-8");
  }
}

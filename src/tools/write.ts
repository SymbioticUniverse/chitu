import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ToolContext, ToolHandler } from "../types.js";
import { resolvePath } from "./utils.js";

export function createWriteTools(ctx: ToolContext): Record<string, ToolHandler> {
  const root = ctx.workspaceRoot;
  const guard = ctx.horsewhipGuard;
  const resolve = (p: string) => resolvePath(root, p);

  return {
    write_file: async (args) => {
      const filePath = resolve(args["path"] as string);
      const content = args["content"] as string;

      // Check boundary
      const check = await guard.checkWrite(filePath);
      if (!check.allowed) {
        return `BLOCKED by Horsewhip: ${check.reason ?? "boundary lock"}. File: ${filePath}\nAsk the user to type "确认" (confirm) if you genuinely need to write this file.`;
      }

      // Check if file is new BEFORE writing (for audit isNew)
      const isNew = !fs.existsSync(filePath);

      // Ensure parent dir exists
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, content, "utf-8");
      await guard.recordWrite(filePath, isNew);

      return `File written: ${filePath} (${content.length} bytes)`;
    },

    append_file: async (args) => {
      const filePath = resolve(args["path"] as string);
      const content = args["content"] as string;

      const check = await guard.checkWrite(filePath);
      if (!check.allowed) {
        return `BLOCKED by Horsewhip: ${check.reason ?? "boundary lock"}. File: ${filePath}\nAsk the user to type "确认" (confirm) if you genuinely need to write this file.`;
      }

      if (!fs.existsSync(filePath)) {
        return `Error: file not found: ${filePath}. Use write_file to create it first.`;
      }

      fs.appendFileSync(filePath, content, "utf-8");
      await guard.recordWrite(filePath, false);

      return `Content appended: ${filePath} (+${content.length} bytes)`;
    },

    edit_file: async (args) => {
      const filePath = resolve(args["path"] as string);
      const oldStr = args["oldString"] as string;
      const newStr = args["newString"] as string;
      const replaceAll = (args["replaceAll"] as boolean) ?? false;

      const check = await guard.checkWrite(filePath);
      if (!check.allowed) {
        return `BLOCKED by Horsewhip: ${check.reason ?? "boundary lock"}. File: ${filePath}\nAsk the user to type "确认" (confirm) if you genuinely need to write this file.`;
      }

      if (!fs.existsSync(filePath)) {
        return `Error: file not found: ${filePath}`;
      }

      const original = fs.readFileSync(filePath, "utf-8");

      if (replaceAll) {
        if (!original.includes(oldStr)) {
          return `Error: old_string not found in ${filePath}`;
        }
        const edited = original.replaceAll(oldStr, newStr);
        fs.writeFileSync(filePath, edited, "utf-8");
        const count = original.split(oldStr).length - 1;
        await guard.recordWrite(filePath, false);
        return `File edited: ${filePath} (${count} replacements)`;
      } else {
        const idx = original.indexOf(oldStr);
        if (idx === -1) {
          return `Error: old_string not found in ${filePath}`;
        }
        const edited =
          original.slice(0, idx) + newStr + original.slice(idx + oldStr.length);
        fs.writeFileSync(filePath, edited, "utf-8");
        await guard.recordWrite(filePath, false);
        return `File edited: ${filePath}`;
      }
    },

    delete_file: async (args) => {
      const filePath = resolve(args["path"] as string);

      const check = await guard.checkWrite(filePath);
      if (!check.allowed) {
        return `BLOCKED by Horsewhip: ${check.reason ?? "boundary lock"}. File: ${filePath}\nAsk the user to type "确认" (confirm) if you genuinely need to write this file.`;
      }

      if (!fs.existsSync(filePath)) {
        return `Error: file not found: ${filePath}`;
      }

      fs.unlinkSync(filePath);
      await guard.recordWrite(filePath, false);

      return `File deleted: ${filePath}`;
    },

    run_shell: async (args) => {
      const command = args["command"] as string;
      const workdir = args["workdir"] ? resolve(args["workdir"] as string) : root;
      const timeout = (args["timeout"] as number) ?? 600_000; // 10 min
      const STALL_MS = 60_000;  // 1 min without output → stalled
      const MAX_MIRRORS = 3;

      // Boundary check
      if (guard.checkCommand) {
        const cmdCheck = await guard.checkCommand(command, workdir);
        if (!cmdCheck.allowed) {
          return `BLOCKED by Horsewhip: ${cmdCheck.reason ?? "boundary lock"}. File: ${cmdCheck.path}`;
        }
      }

      // ── Mirror rules: [detect pattern, build mirror variant] ──
      type Mirror = { cmd: string; env?: Record<string, string>; label: string };
      const buildMirror = (cmd: string, attempt: number): Mirror | null => {
        const mirrors: Mirror[] = [];
        // Rustup
        if (/sh\.rustup\.rs/.test(cmd)) {
          mirrors.push(
            { cmd, env: { RUSTUP_DIST_SERVER: "https://mirrors.tuna.tsinghua.edu.cn/rustup", RUSTUP_UPDATE_ROOT: "https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup" }, label: "TUNA (Tsinghua)" },
            { cmd, env: { RUSTUP_DIST_SERVER: "https://mirrors.ustc.edu.cn/rust-static", RUSTUP_UPDATE_ROOT: "https://mirrors.ustc.edu.cn/rust-static/rustup" }, label: "USTC" },
            { cmd, env: { RUSTUP_DIST_SERVER: "https://static.rust-lang.org", RUSTUP_UPDATE_ROOT: "https://static.rust-lang.org/rustup" }, label: "official (direct)" },
          );
        }
        // git clone github.com
        if (/\bgit\s+clone\s+(https:\/\/github\.com\/)/.test(cmd)) {
          mirrors.push(
            { cmd: cmd.replace(/https:\/\/github\.com\//g, "https://mirror.ghproxy.com/https://github.com/"), label: "ghproxy" },
            { cmd: cmd.replace(/https:\/\/github\.com\//g, "https://gh.api.99988866.xyz/https://github.com/"), label: "99988866" },
            { cmd: cmd.replace(/https:\/\/github\.com\//g, "https://gitclone.com/github.com/"), label: "gitclone" },
          );
        }
        // npm install
        if (/\bnpm\s+(?:install|i)\b/.test(cmd) && !/--registry/.test(cmd)) {
          mirrors.push(
            { cmd: cmd.replace(/(\bnpm\s+(?:install|i)\b)/, "$1 --registry https://registry.npmmirror.com"), label: "npmmirror" },
            { cmd: cmd.replace(/(\bnpm\s+(?:install|i)\b)/, "$1 --registry https://mirrors.huaweicloud.com/repository/npm/"), label: "HuaweiCloud" },
          );
        }
        // pip install
        if (/\bpip\d*\s+install\b/.test(cmd) && !/-i\s/.test(cmd)) {
          mirrors.push(
            { cmd: cmd.replace(/(\bpip\d*\s+install\b)/, "$1 -i https://pypi.tuna.tsinghua.edu.cn/simple"), label: "TUNA" },
            { cmd: cmd.replace(/(\bpip\d*\s+install\b)/, "$1 -i https://mirrors.aliyun.com/pypi/simple/"), label: "Aliyun" },
            { cmd: cmd.replace(/(\bpip\d*\s+install\b)/, "$1 -i https://pypi.mirrors.ustc.edu.cn/simple/"), label: "USTC" },
          );
        }
        // cargo
        if (/\bcargo\s+(?:install|build|update)\b/.test(cmd)) {
          mirrors.push(
            { cmd, env: { CARGO_HTTP_MULTIPLEXING: "false", CARGO_REGISTRIES_CRATES_IO_PROTOCOL: "sparse" }, label: "sparse index" },
          );
        }
        // curl to github raw/releases
        if (/\bcurl\b.*(?:raw\.githubusercontent\.com|github\.com\/[^/]+\/[^/]+\/releases\/download)/.test(cmd)) {
          mirrors.push(
            { cmd: cmd.replace(/https:\/\/raw\.githubusercontent\.com\//g, "https://mirror.ghproxy.com/https://raw.githubusercontent.com/")
                     .replace(/https:\/\/github\.com\/([^/]+\/[^/]+\/releases\/download\/)/g, "https://mirror.ghproxy.com/https://github.com/$1"), label: "ghproxy" },
          );
        }
        return mirrors[Math.min(attempt, mirrors.length - 1)] ?? null;
      };

      // ── Execute a single command, return with stall info ──
      const runOnce = (cmd: string, env: Record<string, string>): Promise<{
        output: string; exitCode: number | null; stalled: boolean; killed: boolean;
      }> => new Promise((resolve) => {
        const child = spawn(cmd, {
          shell: true,
          cwd: workdir,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...env },
        });

        const MAX_OUTPUT = 500_000;
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let lastOutputAt = Date.now();
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        let globalTimer: ReturnType<typeof setTimeout> | undefined;
        let resolved = false;
        let lastProgressAt = 0;

        const done = (exitCode: number | null, stalled: boolean, killed: boolean) => {
          if (resolved) return; resolved = true;
          if (stallTimer) clearTimeout(stallTimer);
          if (globalTimer) clearTimeout(globalTimer);
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
          const suffix = truncated ? "\n[output truncated at 500KB]" : "";
          const out = [stdout, stderr ? `STDERR:\n${stderr}` : ""].filter(Boolean).join("\n");
          const body = stalled ? (out || "(stalled — no output for 60s)") :
                       killed  ? (out || "(timeout — killed)") :
                       out || `(exit ${exitCode})`;
          resolve({ output: body + suffix, exitCode, stalled, killed });
        };

        child.stdout?.on("data", (d: Buffer) => {
          const text = d.toString();
          lastOutputAt = Date.now();
          const now = Date.now();
          if (now - lastProgressAt >= 5000) {
            ctx.onProgress?.("run_shell", text.slice(-100));
            lastProgressAt = now;
          }
          if (stdout.length < MAX_OUTPUT) stdout += text;
          else truncated = true;
        });
        child.stderr?.on("data", (d: Buffer) => {
          if (stderr.length < MAX_OUTPUT) stderr += d.toString();
        });

        // Stall detection: no stdout for STALL_MS → kill + retry
        stallTimer = setTimeout(() => {
          done(child.exitCode, true, true);
        }, STALL_MS);
        // Reset stall timer on any output
        const resetStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = setTimeout(() => done(child.exitCode, true, true), STALL_MS); } };
        child.stdout?.on("data", resetStall);
        // stderr also resets stall (progress may appear on stderr)
        child.stderr?.on("data", resetStall);

        // Global timeout
        globalTimer = setTimeout(() => done(null, false, true), timeout);

        child.on("error", (err) => done(null, false, false));
        child.on("close", (code) => done(code, false, false));
      });

      // ── Run with mirror retry loop ──
      const allOutputs: string[] = [];
      let currentCmd = command;
      let currentEnv: Record<string, string> = {};
      let mirrorCount = 0;

      for (let attempt = 0; attempt <= MAX_MIRRORS; attempt++) {
        const result = await runOnce(currentCmd, currentEnv);
        allOutputs.push(result.output);

        // Success
        if (result.exitCode === 0 && !result.stalled) {
          return allOutputs.join("\n");
        }

        // Stalled or failed — try mirror (if available and retries remain)
        if (attempt < MAX_MIRRORS) {
          const mirror = buildMirror(command, mirrorCount);
          if (mirror) {
            mirrorCount++;
            currentCmd = mirror.cmd;
            currentEnv = mirror.env ?? {};
            allOutputs.push(`\n━━━ STALLED (60s no progress) — switching to mirror: ${mirror.label} (${mirrorCount}/${MAX_MIRRORS}) ━━━\n`);
            continue;
          }
        }

        // No more mirrors or no mirror available
        break;
      }

      // Exhausted — give control back to user
      const finalOut = allOutputs.join("\n");
      if (mirrorCount > 0 && mirrorCount >= MAX_MIRRORS) {
        return `${finalOut}\n\n❌ All ${MAX_MIRRORS} mirror attempts exhausted. Please try again later, check your network, or configure a VPN/proxy port. The user may need to set up a proxy or try a different network.`;
      }
      if (mirrorCount > 0) {
        return `${finalOut}\n\n⚠ Mirror retries used (${mirrorCount}). Command may have failed due to network issues. Consider checking VPN/proxy settings.`;
      }
      // First attempt failed without mirrors
      const isDownloadCmd = /curl|wget|git\s+clone|pip\s+install|npm\s+(?:install|i)|cargo\s+(?:install|build)|\.rustup|rustup|go\s+get|gem\s+install/i.test(command);
      if (isDownloadCmd && finalOut.length < 500) {
        return `${finalOut}\n\n⚠ This appears to be a network-dependent command that produced almost no output. You may need to use a mirror, check your VPN/proxy settings, or try again later.`;
      }
      return finalOut;
    },
  };
}

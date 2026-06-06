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
      const timeout = (args["timeout"] as number) ?? 120000;

      // Boundary check: block shell commands that write to out-of-boundary files
      if (guard.checkCommand) {
        const cmdCheck = await guard.checkCommand(command, workdir);
        if (!cmdCheck.allowed) {
          return `BLOCKED by Horsewhip: ${cmdCheck.reason ?? "boundary lock"}. File: ${cmdCheck.path}`;
        }
      }

      return new Promise((resolve) => {
        const child = spawn(command, {
          shell: true,
          cwd: workdir,
          stdio: ["pipe", "pipe", "pipe"],
        });

        const MAX_OUTPUT = 500_000;
        let stdout = "";
        let stderr = "";
        let truncated = false;

        child.stdout?.on("data", (d: Buffer) => {
          if (stdout.length < MAX_OUTPUT) stdout += d.toString();
          else truncated = true;
        });
        child.stderr?.on("data", (d: Buffer) => {
          if (stderr.length < MAX_OUTPUT) stderr += d.toString();
        });

        const timer = setTimeout(() => {
          child.kill();
          resolve(stdout || stderr ? `TIMEOUT after ${timeout}ms\n${stdout}${stderr ? "\nSTDERR:\n" + stderr : ""}` : `TIMEOUT after ${timeout}ms`);
        }, timeout);

        child.on("error", (err) => {
          clearTimeout(timer);
          resolve(`Error: spawn failed: ${err.message}`);
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          const suffix = truncated ? "\n[output truncated at 500KB]" : "";
          if (code === 0) {
            resolve(stdout ? stdout + suffix : "(command completed with no output)");
          } else {
            const out = [stdout, stderr ? `STDERR:\n${stderr}` : ""]
              .filter(Boolean)
              .join("\n");
            resolve((out || `Command failed (exit ${code})`) + suffix);
          }
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          resolve(`Command failed: ${err.message}`);
        });
      });
    },
  };
}

import { execSync } from "node:child_process";
import type { ToolDef, ToolHandler } from "../types.js";

/**
 * Write operation patterns to block in cli_exec.
 * Commands matching these patterns are rejected before execution.
 */
const WRITE_PATTERNS = [
  /\b(?:>|>>)\s*[/~]/,
  /\becho\s+[^|]*\s*>\s*[/~]/,
  /\bsed\s+-i\b/,
  /\btee\b/,
  /\bdd\s+of=/,
  /\bgit\s+(?:add|commit|push|checkout\s+-b|branch\s+\S|tag)\b/,
  /\brm\s+(?:-rf\s+)?[/~]/,
  /\bmv\s+/,
  /\bcp\s+/,
  /\bmkdir\s+/,
  /\bchmod\s+/,
  /\bchown\s+/,
  /\bln\s+-/,
  /\binstall\b/,
  /\bredirect\b/,
  /\bwrite\b/,
  /[|]\s*(?:tee|cat\s*>)/,
];

// Inline scripts that can bypass quote-stripping by executing code directly
const INLINE_SCRIPT_PATTERNS = [
  /\bpython\d*\s+-c\s/,
  /\bnode\s+(?:-e|-p|--eval|--print)\s/,
  /\bruby\s+-e\s/,
  /\bperl\s+-[eE]\s/,
  /\bphp\s+-r\s/,
  /\bsh\s+-c\s/,
  /\bbash\s+-c\s/,
  /\bzsh\s+-c\s/,
  /\bdeno\s+eval\b/,
];

/** Check if a command contains write operations */
function hasWriteConstruct(command: string): boolean {
  // Check inline script execution first — these can bypass quote stripping
  if (INLINE_SCRIPT_PATTERNS.some((p) => p.test(command))) return true;

  // Remove quoted strings to avoid false positives in echo arguments
  const stripped = command
    .replace(/'[^']*'/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/`[^`]*`/g, "");

  return WRITE_PATTERNS.some((pattern) => pattern.test(stripped));
}

/**
 * Create the cli_exec tool — a read-only shell execution tool.
 * Blocks any command that attempts file writes.
 */
export function createCLITools(): Record<string, ToolHandler> {
  return {
    cli_exec: async (args: Record<string, unknown>) => {
      const command = args["command"] as string;
      if (!command) {
        return "Error: command is required";
      }

      // Static check: block write operations
      if (hasWriteConstruct(command)) {
        return `BLOCKED by cli_exec: write operations are not allowed.
This tool is read-only. Use write_file/edit_file/delete_file tools for file mutations.

Command: ${command.slice(0, 120)}`;
      }

      const workdir = (args["workdir"] as string) ?? process.cwd();
      const timeout = (args["timeout"] as number) ?? 60000;

      try {
        const output = execSync(command, {
          cwd: workdir,
          encoding: "utf-8",
          timeout,
          maxBuffer: 10 * 1024 * 1024,
        });
        return output.trim() || "(command completed with no output)";
      } catch (e: any) {
        if (e.stdout) {
          return e.stdout.trim() || `Error: ${e.message}`;
        }
        return `Error: ${e.message}`;
      }
    },
  };
}

export function cliToolDefs(): ToolDef[] {
  return [
    {
      name: "cli_exec",
      description: "Execute a read-only shell command. For running builds, tests, git log/status/diff, file listing, grep/search, and other read operations. BLOCKS any file writes (>, >>, sed -i, cp, mv, rm, mkdir, git add/commit/push, etc.). Use write_file/edit_file/delete_file tools for file mutations.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute (read-only commands only)",
          },
          workdir: {
            type: "string",
            description: "Working directory (default: project root)",
          },
          timeout: {
            type: "number",
            description: "Timeout in ms (default: 60000)",
          },
        },
        required: ["command"],
      },
      category: "read",
    },
  ];
}

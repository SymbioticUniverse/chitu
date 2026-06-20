import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDef, ToolHandler } from "../types.js";
import { createReadTools } from "./read.js";
import { createWriteTools } from "./write.js";
import { createTaskTools } from "./task.js";
import { createMemoryTools } from "./memory.js";
import { createCLITools, cliToolDefs } from "./cli.js";
import { createAutoInstallTools, autoInstallToolDefs } from "./auto-install.js";
import { loadAllFileInterfaces, scanAndIndexAllFiles } from "../constraint/interface.js";
import type { ToolContext } from "../types.js";

export function getAllToolDefs(): ToolDef[] {
  return [
    ...readToolDefs(),
    ...writeToolDefs(),
    ...taskToolDefs(),
    ...memoryToolDefs(),
    ...cliToolDefs(),
    ...progressToolDefs(),
    ...completionToolDefs(),
    ...horsewhipToolDefs(),
    ...autoInstallToolDefs(),
    ...interfaceSearchToolDefs(),
  ];
}

export function getAllToolHandlers(ctx: ToolContext): Record<string, ToolHandler> {
  return {
    ...createReadTools(ctx),
    ...createWriteTools(ctx),
    ...createTaskTools(ctx),
    ...createMemoryTools(ctx),
    ...createCLITools(),
    ...createProgressHandler(),
    ...createCompletionHandler(ctx),
    ...createAutoInstallTools(ctx),
    ...createInterfaceSearchHandler(ctx),
  };
}

// --- Tool definitions ---

function readToolDefs(): ToolDef[] {
  return [
    {
      name: "read_file",
      description: "Read contents of a file at the given path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          offset: { type: "number", description: "Start line (optional)" },
          limit: { type: "number", description: "Max lines to read (optional)" },
        },
        required: ["path"],
      },
      category: "read",
    },
    {
      name: "list_directory",
      description: "List files and directories at a given path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" },
        },
        required: ["path"],
      },
      category: "read",
    },
    {
      name: "search_code",
      description: "Search codebase for a pattern (grep).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern / regex" },
          path: { type: "string", description: "Directory to search in (default: workspace root)" },
          fileTypes: { type: "string", description: "File extension filter, e.g. '.ts,.json'" },
        },
        required: ["pattern"],
      },
      category: "read",
    },
    {
      name: "git_status",
      description: "Show git working tree status.",
      parameters: {
        type: "object",
        properties: {},
      },
      category: "read",
    },
    {
      name: "git_diff",
      description: "Show git diffs (unstaged, staged, or between commits).",
      parameters: {
        type: "object",
        properties: {
          staged: { type: "boolean", description: "Show staged changes only" },
          commit: { type: "string", description: "Compare against specific commit" },
        },
      },
      category: "read",
    },
    {
      name: "git_log",
      description: "Show git commit history.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of commits to show (default 10)" },
          file: { type: "string", description: "Filter by file path" },
        },
      },
      category: "read",
    },
    {
      name: "web_search",
      description: "Search the web for information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
      category: "read",
    },
    {
      name: "web_fetch",
      description: "Fetch and parse content from a URL.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          extract: { type: "string", description: "What info to extract (optional prompt)" },
        },
        required: ["url"],
      },
      category: "read",
    },
  ];
}

function writeToolDefs(): ToolDef[] {
  return [
    {
      name: "write_file",
      description: "Write or overwrite a file. For files over 5KB, write a minimal skeleton first, then use append_file to add remaining sections.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write" },
          content: { type: "string", description: "File content (keep under ~5KB per call)" },
        },
        required: ["path", "content"],
      },
      category: "write",
    },
    {
      name: "edit_file",
      description: "Edit a file by replacing old_string with new_string. Guarded by Horsewhip.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit" },
          oldString: { type: "string", description: "Text to find and replace" },
          newString: { type: "string", description: "Replacement text" },
          replaceAll: { type: "boolean", description: "Replace all occurrences (default false)" },
        },
        required: ["path", "oldString", "newString"],
      },
      category: "write",
    },
    {
      name: "append_file",
      description: "Append content to the end of an existing file. Use after write_file to build large files incrementally. No string matching needed — content is simply added to the end.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to append to" },
          content: { type: "string", description: "Content to append to the end of the file" },
        },
        required: ["path", "content"],
      },
      category: "write",
    },
    {
      name: "delete_file",
      description: "Delete a file. Guarded by Horsewhip.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to delete" },
        },
        required: ["path"],
      },
      category: "write",
    },
    {
      name: "run_shell",
      description: "Execute a shell command. Guarded by Horsewhip.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          workdir: { type: "string", description: "Working directory (optional)" },
          timeout: { type: "number", description: "Timeout in ms (default 120000)" },
        },
        required: ["command"],
      },
      category: "write",
    },
  ];
}

function taskToolDefs(): ToolDef[] {
  return [
    {
      name: "task_create",
      description: "Create a task to track progress.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task details" },
        },
        required: ["subject", "description"],
      },
      category: "task",
    },
    {
      name: "task_update",
      description: "Update task status.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task ID" },
          status: { type: "string", description: "Task status", enum: ["pending", "in_progress", "completed", "deleted"] },
        },
        required: ["id", "status"],
      },
      category: "task",
    },
    {
      name: "task_list",
      description: "List all tasks.",
      parameters: { type: "object", properties: {} },
      category: "task",
    },
    {
      name: "ask_user",
      description: "Ask the user a question when a decision can't be made automatically.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Question to ask" },
          options: { type: "string", description: "JSON array of options" },
        },
        required: ["question"],
      },
      category: "task",
    },
  ];
}

function memoryToolDefs(): ToolDef[] {
  return [
    {
      name: "memory_save",
      description: "Save a memory entry for cross-session recall.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "Memory type", enum: ["user", "feedback", "project", "reference"] },
          name: { type: "string", description: "Short kebab-case slug" },
          description: { type: "string", description: "One-line summary" },
          content: { type: "string", description: "Memory content" },
        },
        required: ["type", "name", "description", "content"],
      },
      category: "meta",
    },
    {
      name: "memory_recall",
      description: "Recall memories matching a query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          type: { type: "string", description: "Filter by memory type", enum: ["user", "feedback", "project", "reference"] },
        },
      },
      category: "meta",
    },
    {
      name: "memory_forget",
      description: "Delete a memory entry.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Memory slug to delete" },
        },
        required: ["name"],
      },
      category: "meta",
    },
  ];
}

function progressToolDefs(): ToolDef[] {
  return [
    {
      name: "report_progress",
      description:
        "Report your current working phase/stage so the user can see progress. " +
        "Call this when entering a new phase (e.g. clarifying requirements, generating code, " +
        "fixing metrics, verifying exports, reviewing, etc). " +
        "The message will be displayed directly to the user as a progress indicator.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Phase description in Chinese, e.g. 'Clarify：澄清需求 — 第1轮' or 'Grow：生成记账页面'",
          },
        },
        required: ["message"],
      },
      category: "meta",
    },
  ];
}

export function createProgressHandler(): Record<string, ToolHandler> {
  return {
    report_progress: async (args) => {
      const message = String(args.message ?? "");
      return JSON.stringify({ acknowledged: true, phase: message });
    },
  };
}

function completionToolDefs(): ToolDef[] {
  return [
    {
      name: "complete_sub_goal",
      description:
        "Mark the current iteration as complete. Call ONCE after all code is written and verified. " +
        "exports: for EACH file you touched, list the symbols/functions/classes it EXPORTS (not what it imports). " +
        "For HTML/CSS files use the filename or key element IDs. " +
        "imports: for each file, list what external modules or files it imports from. " +
        "capability: one sentence describing what users can now do.",
      parameters: {
        type: "object",
        properties: {
          exports: {
            type: "object",
            description: 'e.g. {"src/foo.ts": ["FooClass", "barFn"]} — for non-code files use the filename as the export',
          },
          imports: {
            type: "object",
            description: 'e.g. {"src/foo.ts": ["lodash", "src/bar.ts"]}',
          },
          capability: {
            type: "string",
            description: "One sentence: what can users now do with this code?",
          },
        },
        required: ["exports", "capability"],
      },
      category: "meta",
    },
  ];
}

function horsewhipToolDefs(): ToolDef[] {
  return [
    {
      name: "mcp__horsewhip__horsewhip_lock_intent",
      description:
        "Declare which files you need to modify. Only call ONCE per iteration. " +
        "touch: files you intend to modify. core: files that MUST be unlocked. edge: files that may need changes. " +
        "All other committed files remain locked.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Brief description of what you're doing" },
          touch: { type: "array", items: { type: "string" }, description: "Files you intend to modify" },
          core: { type: "array", items: { type: "string" }, description: "Files that MUST be unlocked" },
          edge: { type: "array", items: { type: "string" }, description: "Files that may need changes" },
        },
        required: ["touch"],
      },
      category: "meta",
    },
    {
      name: "mcp__horsewhip__horsewhip_expand_boundary",
      description:
        "Request to unlock additional files. Requires human approval (-1 score). " +
        "Only use when you discover you need a file not in the original boundary.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "Additional file paths to unlock" },
          reason: { type: "string", description: "Why these files are needed" },
        },
        required: ["paths"],
      },
      category: "meta",
    },
    {
      name: "mcp__horsewhip__horsewhip_get_boundary",
      description: "Read current boundary state: which files are locked, which are writable.",
      parameters: { type: "object", properties: {}, required: [] },
      category: "meta",
    },
  ];
}

export const COMPLETION_FILE = ".chitu/completions/latest.json";

function createCompletionHandler(ctx: ToolContext): Record<string, ToolHandler> {
  return {
    complete_sub_goal: async (args) => {
      const dir = path.join(ctx.workspaceRoot, ".chitu", "completions");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(ctx.workspaceRoot, COMPLETION_FILE);
      fs.writeFileSync(filePath, JSON.stringify({
        exports: args.exports ?? {},
        imports: args.imports ?? {},
        capability: String(args.capability ?? ""),
        timestamp: new Date().toISOString(),
      }, null, 2), "utf-8");
      return JSON.stringify({ ok: true, saved: filePath });
    },
  };
}

// ── Interface search tool ──────────────────────────────────────────────

function interfaceSearchToolDefs(): ToolDef[] {
  return [
    {
      name: "search_interfaces",
      description:
        "Search the project's interface index. Use this to discover files, their exports, and dependencies. " +
        "Call without arguments to list all files. Call with a query to search file names and exports. " +
        "Call with a specific file path to see its full exports and imports.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional: keyword to search in file paths and export names. Omit to list all files.",
          },
          file: {
            type: "string",
            description: "Optional: specific file path relative to workspace root. Shows exports and imports for that file only.",
          },
        },
        required: [],
      },
      category: "read",
    },
  ];
}

function createInterfaceSearchHandler(ctx: ToolContext): Record<string, ToolHandler> {
  // Only cache the expensive initial scan result; subsequent reads go to disk
  let initialScan: import("../constraint/interface.js").FileInterface[] | null = null;

  const getInterfaces = () => {
    const loaded = loadAllFileInterfaces(ctx.workspaceRoot);
    if (loaded.length > 0) return loaded;
    // Fresh project — scan once, write index files, then use disk reads
    if (initialScan) return initialScan;
    initialScan = scanAndIndexAllFiles(ctx.workspaceRoot);
    return initialScan;
  };

  return {
    search_interfaces: async (_args) => {
      const args = _args as Record<string, unknown>;
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const file = typeof args.file === "string" ? args.file.trim() : "";
      const interfaces = getInterfaces();

      // Single file lookup
      if (file) {
        const match = interfaces.find((i) => i.file === file || i.file.endsWith("/" + file));
        if (!match) {
          const near = interfaces.filter((i) => i.file.includes(file));
          if (near.length === 0) return JSON.stringify({ error: `File "${file}" not found in interface index` });
          return JSON.stringify({
            hint: `"${file}" not found exactly. Did you mean one of these?`,
            candidates: near.map((i) => i.file).slice(0, 10),
          });
        }
        return JSON.stringify({
          file: match.file,
          exports: match.exports,
          imports: match.imports.map((i) => `${i.symbol} ← ${i.from}`),
          capability: match.capability,
        });
      }

      // Search mode
      if (query) {
        const q = query.toLowerCase();
        const results = interfaces.filter((i) =>
          i.file.toLowerCase().includes(q) ||
          i.exports.some((e) => e.toLowerCase().includes(q)) ||
          (i.capability && i.capability.toLowerCase().includes(q)),
        );
        if (results.length === 0) return JSON.stringify({ results: [], hint: `No files matching "${query}"` });
        const MAX_EXPORTS = 8;
        return JSON.stringify({
          query,
          count: results.length,
          results: results.slice(0, 20).map((i) => ({
            file: i.file,
            exports: i.exports.length > MAX_EXPORTS ? [...i.exports.slice(0, MAX_EXPORTS), `... +${i.exports.length - MAX_EXPORTS} more`] : i.exports,
            capability: i.capability || "",
          })),
          ...(results.length > 20 ? { truncated: `showing 20 of ${results.length} results` } : {}),
        });
      }

      // List all files (summary)
      return JSON.stringify({
        totalFiles: interfaces.length,
        files: interfaces.map((i) => ({
          file: i.file,
          exportCount: i.exports.length,
          topExports: i.exports.slice(0, 3),
          capability: i.capability || "",
        })),
      });
    },
  };
}

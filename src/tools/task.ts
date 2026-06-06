import type { ToolContext, ToolHandler } from "../types.js";

interface Task {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  createdAt: string;
}

// In-memory task store (per session)
const taskStores: Map<string, Task[]> = new Map();

function getStore(sessionId: string): Task[] {
  if (!taskStores.has(sessionId)) {
    taskStores.set(sessionId, []);
  }
  return taskStores.get(sessionId)!;
}

let nextId = 1;

export function createTaskTools(ctx: ToolContext): Record<string, ToolHandler> {
  const sid = ctx.sessionId;

  return {
    task_create: async (args) => {
      const store = getStore(sid);
      const task: Task = {
        id: String(nextId++),
        subject: args["subject"] as string,
        description: args["description"] as string,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      store.push(task);
      return `Task #${task.id} created: ${task.subject}`;
    },

    task_update: async (args) => {
      const store = getStore(sid);
      const id = args["id"] as string;
      const status = args["status"] as Task["status"];
      const task = store.find((t) => t.id === id);
      if (!task) return `Error: task #${id} not found`;
      task.status = status;
      return `Task #${id} → ${status}`;
    },

    task_list: async () => {
      const store = getStore(sid);
      if (store.length === 0) return "(no tasks)";
      return store
        .map((t) => {
          const icon =
            t.status === "completed" ? "✓" :
            t.status === "in_progress" ? "⏳" :
            t.status === "deleted" ? "✗" : "○";
          return `${icon} #${t.id} [${t.status}] ${t.subject}`;
        })
        .join("\n");
    },

    ask_user: async (args) => {
      const question = args["question"] as string;
      const options = args["options"] ? JSON.parse(args["options"] as string) : undefined;

      // Write question to a prompt file that the CLI reads
      const prompt = options
        ? `${question}\n\nOptions: ${options.join(", ")}`
        : question;

      // In interactive mode, this would block on user input.
      // For now, return the question so the CLI can present it.
      return `[NEEDS_INPUT] ${prompt}`;
    },
  };
}

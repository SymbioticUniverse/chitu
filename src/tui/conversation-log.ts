import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let logPath: string | null = null;
let sessionStart: string = "";

export function initConversationLog(workspaceRoot: string): void {
  const chituDir = join(workspaceRoot, ".chitu");
  if (!existsSync(chituDir)) mkdirSync(chituDir, { recursive: true });
  logPath = join(chituDir, "conversation-log.md");
  sessionStart = new Date().toISOString();

  if (!existsSync(logPath)) {
    writeFileSync(logPath, `# Chitu Conversation Log\n\n`, "utf-8");
  }
  appendFileSync(
    logPath,
    `\n---\n## Session: ${sessionStart}\n\n`,
    "utf-8",
  );
}

export function logUserMessage(text: string): void {
  if (!logPath) return;
  const ts = new Date().toISOString();
  appendFileSync(logPath, `### [${ts}] User:\n\n${text}\n\n`, "utf-8");
}

export function logAssistantResponse(text: string): void {
  if (!logPath) return;
  const ts = new Date().toISOString();
  appendFileSync(logPath, `### [${ts}] Chitu:\n\n${text}\n\n`, "utf-8");
}

export function logToolCall(toolName: string, input: string, output: string): void {
  if (!logPath) return;
  const ts = new Date().toISOString();
  const truncated = output.length > 5000 ? output.slice(0, 5000) + "\n... [truncated]" : output;
  appendFileSync(
    logPath,
    `<details>\n<summary>[${ts}] Tool: ${toolName}</summary>\n\n**Input:**\n\`\`\`\n${input}\n\`\`\`\n\n**Output:**\n\`\`\`\n${truncated}\n\`\`\`\n</details>\n\n`,
    "utf-8",
  );
}

export function logSystem(msg: string): void {
  if (!logPath) return;
  appendFileSync(logPath, `> ${msg}\n\n`, "utf-8");
}

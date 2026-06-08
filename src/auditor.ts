import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger.js";

/**
 * Audit event write + query.
 * Extracted from agent.ts, independently responsible for:
 * - writeAuditEvent — writes an audit event to session-audit.json
 * - loadHumanInLoopCount — counts human_in_loop events
 */

export class Auditor {
  private workspaceRoot: string;
  private taskId: string;

  constructor(workspaceRoot: string, taskId: string) {
    this.workspaceRoot = workspaceRoot;
    this.taskId = taskId;
  }

  /** Write an audit event to .git/horsewhip/session-audit.json */
  writeEvent(type: string, data: Record<string, unknown> = {}): void {
    try {
      const auditDir = path.join(this.workspaceRoot, ".git", "horsewhip");
      if (!fs.existsSync(auditDir)) {
        fs.mkdirSync(auditDir, { recursive: true });
      }
      const auditPath = path.join(auditDir, "session-audit.json");
      const event = {
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type,
        timestamp: new Date().toISOString(),
        task: this.taskId,
        ...data,
      };
      fs.appendFileSync(auditPath, JSON.stringify(event) + "\n", "utf-8");
    } catch (e) {
      logger.warn("Audit write failed", { error: String(e) });
    }
  }

  /** Count human_in_loop events across all tasks */
  loadHumanInLoopCount(): number {
    try {
      const auditPath = path.join(this.workspaceRoot, ".git", "horsewhip", "session-audit.json");
      if (!fs.existsSync(auditPath)) return 0;
      const data = fs.readFileSync(auditPath, "utf-8").trim();
      if (!data) return 0;
      let count = 0;
      for (const line of data.split("\n")) {
        try {
          const evt = JSON.parse(line);
          if (evt.type === "human_in_loop") count++;
        } catch { /* skip */ }
      }
      return count;
    } catch {
      return 0;
    }
  }
}

import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger.js";

/**
 * 审计事件写入 + 查询。
 * 从 agent.ts 抽出，独立负责：
 * - writeAuditEvent — 写一条审计事件到 session-audit.json
 * - loadHumanInLoopCount — 累计 human_in_loop 事件数
 */

export class Auditor {
  private workspaceRoot: string;
  private taskId: string;

  constructor(workspaceRoot: string, taskId: string) {
    this.workspaceRoot = workspaceRoot;
    this.taskId = taskId;
  }

  /** 写一条审计事件到 .git/horsewhip/session-audit.json */
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

  /** 累计所有任务中 human_in_loop 事件次数 */
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

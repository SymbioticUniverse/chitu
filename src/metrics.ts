import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditEvent, MetricsReport } from "./types.js";

export class MetricsEngine {
  private workspaceRoot: string;
  private auditEventsCache: AuditEvent[] | null = null;
  private auditEventsMtime: number = 0;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /** Compute metrics — only human-in-loop count. */
  compute(taskId?: string): MetricsReport | null {
    const events = this.loadAuditEvents();
    if (events.length === 0) return null;

    const taskEvents = taskId
      ? events.filter((e) => e.task === taskId)
      : events;

    const humanInLoopCount = events.filter((e) => e.type === "human_in_loop").length;

    return {
      task: taskId ?? "cumulative",
      humanInLoopCount,
    };
  }

  /** Compute cumulative HITL count across all tasks. */
  computeCumulative(): MetricsReport | null {
    const events = this.loadAuditEvents();
    if (events.length === 0) return null;
    return {
      task: "cumulative",
      humanInLoopCount: events.filter((e) => e.type === "human_in_loop").length,
    };
  }

  // --- Audit event loading ---

  loadAuditEvents(): AuditEvent[] {
    const auditPath = path.join(this.workspaceRoot, ".git", "horsewhip", "session-audit.json");
    if (!fs.existsSync(auditPath)) return [];

    try {
      const mtime = fs.statSync(auditPath).mtimeMs;
      if (this.auditEventsCache && mtime === this.auditEventsMtime) {
        return this.auditEventsCache;
      }

      const raw = fs.readFileSync(auditPath, "utf-8").trim();
      if (raw.startsWith('{"id":"evt-')) {
        const events: AuditEvent[] = [];
        for (const line of raw.split("\n")) {
          try { events.push(JSON.parse(line) as AuditEvent); } catch { /* skip */ }
        }
        this.auditEventsCache = events;
        this.auditEventsMtime = mtime;
        return events;
      }
      const data = JSON.parse(raw) as { events?: AuditEvent[] } | AuditEvent[];
      const events = Array.isArray(data) ? data : (data.events ?? []);
      this.auditEventsCache = events;
      this.auditEventsMtime = mtime;
      return events;
    } catch {
      return [];
    }
  }
}

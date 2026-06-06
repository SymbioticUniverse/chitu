import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditEvent, AuditEventType } from "../types.js";
import { AUDIT_FILE } from "./boundary-parser.js";

// --- Audit Logger ---

let eventSeq = 0;

function nextId(): string {
  return `evt-${Date.now()}-${++eventSeq}`;
}

export class AuditLogger {
  private horsewhipDir: string;
  private lastEventId: string | null = null;

  constructor(horsewhipDir: string, lastEventId?: string | null) {
    this.horsewhipDir = horsewhipDir;
    this.lastEventId = lastEventId ?? null;
  }

  get lastId(): string | null {
    return this.lastEventId;
  }

  append(event: {
    type: AuditEventType;
    file: string;
    reason?: string;
    task?: string;
    isNew?: boolean;
  }): void {
    const ensureDir = () => {
      if (!fs.existsSync(this.horsewhipDir)) {
        fs.mkdirSync(this.horsewhipDir, { recursive: true });
      }
    };
    ensureDir();

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
          const last = oldEvents[oldEvents.length - 1];
          if (last) this.lastEventId = last.id;
        }
      } catch { /* leave as-is, append JSONL anyway */ }
    }

    // JSONL append — O(1) instead of O(n²) read-all+write-all
    fs.appendFileSync(auditPath, JSON.stringify(evt) + "\n", "utf-8");
  }
}

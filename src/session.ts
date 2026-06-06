import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Session, Message, MetricsReport } from "./types.js";

export class SessionManager {
  private workspaceRoot: string;
  private sessionsDir: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.sessionsDir = path.join(workspaceRoot, ".chitu", "sessions");
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  /** Create a new session */
  create(task: string): Session {
    this.ensureDir();

    const id = randomUUID();
    const now = new Date().toISOString();

    const session: Session = {
      id,
      createdAt: now,
      updatedAt: now,
      task,
      messages: [],
    };

    this.save(session);
    return session;
  }

  /** Save session to disk */
  save(session: Session): void {
    this.ensureDir();
    session.updatedAt = new Date().toISOString();

    const filePath = path.join(this.sessionsDir, `${session.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
  }

  /** Load session by ID */
  load(id: string): Session | null {
    this.ensureDir();

    // Support both "abc123" and "abc123.json" formats
    const fileName = id.endsWith(".json") ? id : `${id}.json`;
    const filePath = path.join(this.sessionsDir, fileName);

    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }

  /** List all sessions */
  list(): Session[] {
    this.ensureDir();

    const sessions: Session[] = [];
    const entries = fs.readdirSync(this.sessionsDir);

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const session = this.load(entry);
      if (session) sessions.push(session);
    }

    // Sort by most recent first
    sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    return sessions;
  }

  /** Delete a session */
  delete(id: string): boolean {
    this.ensureDir();
    const fileName = id.endsWith(".json") ? id : `${id}.json`;
    const filePath = path.join(this.sessionsDir, fileName);

    if (!fs.existsSync(filePath)) return false;

    fs.unlinkSync(filePath);
    return true;
  }

  /** Attach metrics to a session */
  attachMetrics(id: string, metrics: MetricsReport): void {
    const session = this.load(id);
    if (session) {
      session.metrics = metrics;
      this.save(session);
    }
  }
}

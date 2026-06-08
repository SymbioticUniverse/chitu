import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

const SCORE_FILE = path.join(homedir(), ".chitu", "score.json");

export interface ScoreEvent {
  timestamp: string;
  event: "autonomous" | "expand_boundary" | "bypass_orchestration" | "vulnerability_report" | "vulnerability_fixed" | "valid_expand" | "invalid_expand" | "imprecise_modify";
  delta: number;
  project: string;
  detail: string;
  /** When fixing a bug, reference the bypass event ID that it now defeats. */
  defeats?: string;
}

export interface ProjectScore {
  score: number;
  autonomous: number;
  expands: number;
  bypasses: number;
  vulnReports: number;
  vulnFixed: number;
  validExpands: number;
  invalidExpands: number;
  impreciseModifies: number;
}

export interface GlobalScore {
  score: number;
  history: ScoreEvent[];
  projects: Record<string, ProjectScore>;
}

function load(): GlobalScore {
  try {
    if (fs.existsSync(SCORE_FILE)) {
      return JSON.parse(fs.readFileSync(SCORE_FILE, "utf-8"));
    }
  } catch { /* corrupt, reset */ }
  return { score: 0, history: [], projects: {} };
}

function save(data: GlobalScore): void {
  const dir = path.dirname(SCORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Keep history manageable
  if (data.history.length > 500) {
    data.history = data.history.slice(-500);
  }
  fs.writeFileSync(SCORE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function record(event: ScoreEvent["event"], delta: number, project: string, detail: string, defeats?: string): GlobalScore {
  const data = load();
  data.score += delta;

  if (!data.projects[project]) {
    data.projects[project] = { score: 0, autonomous: 0, expands: 0, bypasses: 0, vulnReports: 0, vulnFixed: 0, validExpands: 0, invalidExpands: 0, impreciseModifies: 0 };
  }
  const ps = data.projects[project]!;
  ps.score += delta;
  if (event === "autonomous") ps.autonomous++;
  else if (event === "expand_boundary") ps.expands++;
  else if (event === "bypass_orchestration") ps.bypasses++;
  else if (event === "vulnerability_report") ps.vulnReports++;
  else if (event === "vulnerability_fixed") ps.vulnFixed++;
  else if (event === "valid_expand") ps.validExpands++;
  else if (event === "invalid_expand") ps.invalidExpands++;
  else if (event === "imprecise_modify") ps.impreciseModifies++;

  data.history.push({
    timestamp: new Date().toISOString(),
    event,
    delta,
    project,
    detail,
    defeats,
  });

  save(data);
  return data;
}

/** +1/+2 — Autonomous task completion with zero human-in-loop (creation +2, modify +1) */
export function recordAutonomous(project: string, detail: string, delta: number = 1): GlobalScore {
  return record("autonomous", delta, project, detail);
}

/** -1 — Human-in-loop triggered (expand boundary requires human authorization) */
export function recordExpandBoundary(project: string, detail: string): GlobalScore {
  return record("expand_boundary", -1, project, detail);
}

/** -3 — Bypassed orchestration layer (wrote files without lock_intent, etc.) */
export function recordBypassOrchestration(project: string, detail: string): GlobalScore {
  return record("bypass_orchestration", -3, project, detail);
}

/** +1 — Discovered and reported a potential bypass vulnerability */
export function recordVulnerabilityReport(project: string, detail: string): GlobalScore {
  return record("vulnerability_report", 1, project, detail);
}

/** +1 — Fixed a vulnerability and successfully defends against a prior bypass */
export function recordVulnerabilityFixed(project: string, detail: string, bypassEventId: string): GlobalScore {
  return record("vulnerability_fixed", 1, project, detail, bypassEventId);
}

/** +1 — Expand used for architectural iteration, exports actually changed */
export function recordValidExpand(project: string, detail: string): GlobalScore {
  return record("valid_expand", 1, project, detail);
}

/** -2 — Expand claimed refactoring but exports did not change */
export function recordInvalidExpand(project: string, detail: string): GlobalScore {
  return record("invalid_expand", -2, project, detail);
}

/** -1 — Modify scope imprecise, requires expand */
export function recordImpreciseModify(project: string, detail: string): GlobalScore {
  return record("imprecise_modify", -1, project, detail);
}

export function getGlobalScore(): GlobalScore {
  return load();
}

/** Human-readable score badge for system prompt injection. */
export function getScoreContext(): string {
  const data = load();
  if (data.history.length === 0) return "";

  const totalVulnReports = Object.values(data.projects).reduce((s, p) => s + p.vulnReports, 0);
  const totalVulnFixed = Object.values(data.projects).reduce((s, p) => s + p.vulnFixed, 0);

  const recent = data.history.slice(-5).map((e) => {
    const icon = e.event === "autonomous" ? "+2 🏆"
      : e.event === "valid_expand" ? "+1 🏗️"
      : e.event === "vulnerability_report" ? "+1 🔍"
      : e.event === "vulnerability_fixed" ? "+1 🛡️"
      : e.event === "expand_boundary" ? "-1 ⚠️"
      : e.event === "invalid_expand" ? "-2 🎭"
      : e.event === "imprecise_modify" ? "-1 🎯"
      : "-3 🚫";
    return `  ${icon} ${e.event} — ${e.detail} (${e.project})`;
  });

  return [
    `## Global Score: ${data.score}`,
    `Creation: +2 auto  |  +1 valid expand  |  -1 bugfix expand  |  -2 invalid expand  |  -3 bypass`,
    `Modify:  +1 precise  |  -1 expand`,
    `Vulnerabilities: ${totalVulnReports} reported  |  ${totalVulnFixed} fixed`,
    ``,
    `Recent events:`,
    ...recent,
  ].join("\n");
}

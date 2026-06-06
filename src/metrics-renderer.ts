import type { MetricsReport } from "./types.js";

export function renderMetricsReport(report: MetricsReport): string {
  return [
    `╔══════════════════════════════════════════╗`,
    `║  Horsewhip Report · ${report.task.padEnd(23)} ║`,
    `╠══════════════════════════════════════════╣`,
    `║  人在回路 (HITL): ${String(report.humanInLoopCount).padStart(4)}                    ║`,
    `╚══════════════════════════════════════════╝`,
  ].join("\n");
}

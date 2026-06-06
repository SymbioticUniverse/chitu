import * as fs from "node:fs";
import * as path from "node:path";
import type { SubGoal, SubGoalVerification } from "../types.js";
import { getSubGoalDir } from "./plan.js";

/** Write verification doc into sub-goal folder. Returns the relative path. */
export function writeVerificationDoc(
  workspaceRoot: string,
  planId: string,
  subGoal: SubGoal,
  verification: SubGoalVerification,
): string {
  const dir = getSubGoalDir(workspaceRoot, planId, subGoal.id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const content = [
    `# Verification — Sub-goal ${subGoal.id}: ${subGoal.title}`,
    ``,
    `- **Commit:** \`${verification.committedHash}\``,
    `- **Committed at:** ${verification.committedAt}`,
    `- **Integration test:** ${verification.integrationTestPassed ? "PASSED" : "FAILED"}`,
    `- **Project tests:** ${verification.testPassed ? "PASSED" : "FAILED"}`,
    ``,
    `## Test Results`,
    ``,
    `- **Command:** \`${verification.testCommand}\``,
    `- **Passed:** ${verification.testPassed ? "YES" : "NO"}`,
    ``,
    `\`\`\``,
    verification.testOutput.slice(0, 3000),
    `\`\`\``,
    ``,
    `## Exports Verified`,
    ``,
    ...verification.exportsVerified.map((e) => `- \`${e}\``),
    ``,
    `## Files Created`,
    ``,
    ...verification.filesCreated.map((f) => `- \`${f}\``),
    ``,
    `## Files Modified`,
    ``,
    ...verification.filesModified.map((f) => `- \`${f}\``),
    ``,
  ].join("\n");

  const filePath = path.join(dir, "verification.md");
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function loadVerificationDoc(
  workspaceRoot: string,
  planId: string,
  subGoalId: string,
): string | null {
  const filePath = path.join(getSubGoalDir(workspaceRoot, planId, subGoalId), "verification.md");
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}


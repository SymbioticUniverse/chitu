import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { parseFileExportsAndImports } from "./interface.js";
import {
  recordValidExpand,
  recordInvalidExpand,
  recordImpreciseModify,
  recordExpandBoundary,
} from "../score.js";

export interface GateResult {
  ok: boolean;
  feedback: string;
}

export interface ExpandReasonEntry {
  paths: string[];
  reason: string;
  exportSnapshot: Record<string, string[]>;
}

/** Get working-tree changes (modified + untracked), excluding metadata dirs. */
export function getChanges(workspaceRoot: string): string[] {
  try {
    const modified = execSync("git diff --name-only HEAD 2>/dev/null", {
      cwd: workspaceRoot, encoding: "utf-8", timeout: 5000,
    }).trim().split("\n").filter(Boolean);
    const untracked = execSync("git ls-files --others --exclude-standard 2>/dev/null", {
      cwd: workspaceRoot, encoding: "utf-8", timeout: 5000,
    }).trim().split("\n").filter(Boolean);
    return [...modified, ...untracked].filter((f) =>
      !f.startsWith(".chitu/") && !f.startsWith(".horsewhip/") &&
      f !== ".DS_Store" && f !== "Thumbs.db",
    );
  } catch {
    return [];
  }
}

/** Verify exports, imports, and tests. */
export function verifyGates(
  workspaceRoot: string,
  targetFiles: string[],
  exports: string[] | Record<string, string[]>,
  imports: string[] | Record<string, string[]>,
): GateResult {
  // Gate 0: actual changes
  const changes = getChanges(workspaceRoot);
  if (changes.length === 0) {
    return {
      ok: false,
      feedback: `## No changes detected\nYou declared a boundary but didn't modify any files. Make the requested changes, then call \`complete_sub_goal\` again.`,
    };
  }

  // Gate 1: export verification
  const exportIssues = verifyExports(workspaceRoot, targetFiles, exports);
  if (exportIssues.length > 0) {
    return {
      ok: false,
      feedback: `## Export verification failed\n${exportIssues.map((e) => `  - ${e}`).join("\n")}\nFix the issues above, then call \`complete_sub_goal\` again.`,
    };
  }

  // Gate 1.5: import verification
  const importIssues = verifyImports(workspaceRoot, targetFiles, imports);
  if (importIssues.length > 0) {
    return {
      ok: false,
      feedback: `## Import verification failed\n${importIssues.map((e) => `  - ${e}`).join("\n")}\nFix the issues above, then call \`complete_sub_goal\` again.`,
    };
  }

  // Gate 2: tests
  const testResult = runTests(workspaceRoot);
  if (!testResult.ok) {
    return {
      ok: false,
      feedback: `## Tests failed\n${testResult.output.slice(0, 2000)}\nFix the tests, then call \`complete_sub_goal\` again.`,
    };
  }

  return { ok: true, feedback: "" };
}

function verifyExports(
  workspaceRoot: string,
  files: string[],
  exports: string[] | Record<string, string[]>,
): string[] {
  const allExports = new Map<string, string[]>();
  for (const tf of files) {
    const fullPath = path.join(workspaceRoot, tf);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const parsed = parseFileExportsAndImports(content, tf);
      allExports.set(tf, parsed.exports.length > 0 ? parsed.exports : []);
    } catch { /* skip */ }
  }

  const exportMap = Array.isArray(exports)
    ? Object.fromEntries(files.map((f) => [f, exports as string[]]))
    : exports;

  const issues: string[] = [];
  const fileContents = new Map(files.map((tf) => {
    try {
      const fullPath = path.join(workspaceRoot, tf);
      return [tf, fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf-8") : ""] as [string, string];
    } catch { return [tf, ""] as [string, string]; }
  }));

  for (const [file, declared] of Object.entries(exportMap)) {
    if (!Array.isArray(declared) || declared.length === 0) continue;
    const actualExports = allExports.get(file);
    if (!actualExports || actualExports.length === 0) continue;
    for (const exp of declared) {
      let found = false;
      for (const [tf, tfExports] of allExports) {
        if (tfExports.includes(exp)) { found = true; break; }
        const content = fileContents.get(tf) ?? "";
        const base = path.basename(tf);
        const baseNoExt = base.replace(/\.[^.]+$/, "");
        if (exp === base || exp === baseNoExt || exp === tf || (content && content.includes(exp))) {
          found = true; break;
        }
      }
      if (!found) issues.push(`\`${exp}\` (declared for ${file}) not found in any target file`);
    }
  }
  return issues;
}

function verifyImports(
  workspaceRoot: string,
  files: string[],
  imports: string[] | Record<string, string[]>,
): string[] {
  const allImports = new Map<string, { symbol: string; from: string }[]>();
  for (const tf of files) {
    const fullPath = path.join(workspaceRoot, tf);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const parsed = parseFileExportsAndImports(content, tf);
      if (parsed.imports.length > 0) allImports.set(tf, parsed.imports);
    } catch { /* skip */ }
  }

  const importMap = Array.isArray(imports)
    ? Object.fromEntries(files.map((f) => [f, imports as string[]]))
    : imports;

  const issues: string[] = [];
  for (const [file, declared] of Object.entries(importMap)) {
    if (!Array.isArray(declared) || declared.length === 0) continue;
    const actual = allImports.get(file);
    if (!actual || actual.length === 0) continue;
    const actualSymbols = new Set(actual.map((i) => i.symbol));
    const actualSources = new Set(actual.map((i) => i.from));
    for (const imp of declared) {
      if (actualSymbols.has(imp)) continue;
      if (actualSources.has(imp)) continue;
      let found = false;
      for (const src of actualSources) {
        if (src.includes(imp) || imp.includes(src)) { found = true; break; }
      }
      if (!found) issues.push(`\`${imp}\` declared as import in ${file} but not found`);
    }
  }
  return issues;
}

function runTests(workspaceRoot: string): { ok: boolean; output: string } {
  try {
    const pkgPath = path.join(workspaceRoot, "package.json");
    if (!fs.existsSync(pkgPath)) {
      return { ok: false, output: "No package.json found." };
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (!pkg.scripts?.test) {
      return { ok: false, output: "No test script in package.json." };
    }
    const result = execSync("npm test 2>&1 || true", {
      cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, timeout: 120_000,
    });
    const failed = /(?:FAIL|failed|\d+ failing|Test failed|AssertionError|npm ERR!)/i.test(result);
    return { ok: !failed, output: result };
  } catch (e: any) {
    return { ok: false, output: String(e?.stdout ?? e?.stderr ?? e).slice(0, 5000) };
  }
}

/** Verify expand reasons against actual interface changes. Returns score delta and labels. */
export function verifyExpandReasons(
  workspaceRoot: string,
  mode: "creation" | "modification",
  project: string,
  expandReasons: ExpandReasonEntry[],
): { expandScore: number; expandLabels: string[] } {
  const labels: string[] = [];
  let score = 0;

  if (mode === "modification") {
    for (const er of expandReasons) {
      score -= 1;
      labels.push(`expand(-1 modify imprecise): ${er.paths.join(", ")}`);
      recordImpreciseModify(project, `expanded: ${er.paths.join(", ")} (${er.reason})`);
    }
    return { expandScore: score, expandLabels: labels };
  }

  for (const er of expandReasons) {
    if (er.reason === "bugfix" || er.reason === "omission") {
      score -= 1;
      labels.push(`expand(-1 ${er.reason}): ${er.paths.join(", ")}`);
    } else {
      let anyChanged = false;
      let hasNonCodeFile = false;
      for (const p of er.paths) {
        const fullPath = path.join(workspaceRoot, p);
        const before = er.exportSnapshot[p] ?? [];
        if (!fs.existsSync(fullPath)) continue;
        const ext = path.extname(p).toLowerCase();
        if ([".css", ".html", ".md", ".json"].includes(ext)) {
          hasNonCodeFile = true;
          continue;
        }
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const parsed = parseFileExportsAndImports(content, p);
          const after = parsed.exports;
          const beforeSet = new Set(before);
          const afterSet = new Set(after);
          if (beforeSet.size !== afterSet.size || [...beforeSet].some((e) => !afterSet.has(e)) || [...afterSet].some((e) => !beforeSet.has(e))) {
            anyChanged = true;
            break;
          }
        } catch { /* skip */ }
      }
      if (anyChanged || hasNonCodeFile) {
        score += 1;
        labels.push(`expand(+1 valid): ${er.paths.join(", ")}`);
        recordValidExpand(project, `expand: ${er.paths.join(", ")} (${er.reason})`);
      } else {
        score -= 2;
        labels.push(`expand(-2 fraud): exports unchanged in ${er.paths.join(", ")}`);
        recordInvalidExpand(project, `claimed expand but exports unchanged: ${er.paths.join(", ")}`);
      }
    }
  }

  return { expandScore: score, expandLabels: labels };
}

/** Capture export snapshots before AI edits expanded files. */
export function snapshotExportState(
  workspaceRoot: string,
  paths: string[],
): Record<string, string[]> {
  const snapshots: Record<string, string[]> = {};
  for (const p of paths) {
    const fullPath = path.join(workspaceRoot, p);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const parsed = parseFileExportsAndImports(content, p);
        snapshots[p] = parsed.exports;
      } catch { snapshots[p] = []; }
    } else {
      snapshots[p] = [];
    }
  }
  return snapshots;
}

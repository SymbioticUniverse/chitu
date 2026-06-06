import * as fs from "node:fs";
import * as path from "node:path";
import type { InterfaceDoc, SubGoal, TargetPlan } from "../types.js";
import { getSubGoalDir, getPlanDir } from "./plan.js";

// ── Paths ──────────────────────────────────────────────────────────

export function getInterfacesDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".chitu", "interfaces");
}

function docPath(workspaceRoot: string, planId: string, subGoalId: string): string {
  return path.join(getSubGoalDir(workspaceRoot, planId, subGoalId), "contract.md");
}

// ── Interface stubs (generated from plan data, before any code is written) ─

/** Generate minimal interface stubs for every sub-goal in a plan.
 *  Called during plan phase so contracts exist before execute phase.
 *  Existing docs are never overwritten — this is append-only. */
export function generateInterfaceStubs(workspaceRoot: string, plan: TargetPlan): void {
  const planId = `plan-${plan.project}`;

  for (const sg of plan.subGoals) {
    const sgDir = getSubGoalDir(workspaceRoot, planId, sg.id);
    if (!fs.existsSync(sgDir)) fs.mkdirSync(sgDir, { recursive: true });

    const filePath = path.join(sgDir, "contract.md");
    if (fs.existsSync(filePath)) continue;

    const content = [
      `# ${sg.id}-interface — ${sg.title}`,
      ``,
      `- **sub-goal**: ${sg.id} — ${sg.title}`,
      `- **capability**: ${sg.description}`,
      ``,
      `## Exports`,
      ``,
      `(to be filled during implementation)`,
      ``,
      `## Target Files`,
      ``,
      ...sg.targetFiles.map((f) => `- \`${f}\``),
      ``,
      `## Dependencies`,
      ``,
      ...(sg.dependsOn.length > 0 ? sg.dependsOn.map((d) => `- sub-goal ${d}`) : ["(none)"]),
      ``,
    ].join("\n");

    fs.writeFileSync(filePath, content, "utf-8");
  }
}

// ── Write ──────────────────────────────────────────────────────────

/** Generate interface doc from sub-goal completion data.
 *  Returns the file path on success, null if written doc fails validation. */
export function writeInterfaceDoc(
  workspaceRoot: string,
  planId: string,
  subGoal: SubGoal,
  exports: string[] | Record<string, string[]>,
  imports: string[] | Record<string, string[]>,
  capability: string,
): string | null {
  const sgDir = getSubGoalDir(workspaceRoot, planId, subGoal.id);
  if (!fs.existsSync(sgDir)) fs.mkdirSync(sgDir, { recursive: true });

  const exportLines: string[] = [];
  if (Array.isArray(exports)) {
    for (const exp of exports) {
      const file = subGoal.targetFiles[0] ?? "(unknown)";
      exportLines.push(`- \`${file}\` \`${exp}\``);
    }
  } else {
    for (const [file, names] of Object.entries(exports)) {
      for (const name of names) {
        exportLines.push(`- \`${file}\` \`${name}\``);
      }
    }
  }

  const importLines: string[] = [];
  if (Array.isArray(imports)) {
    for (const imp of imports) importLines.push(`- \`${imp}\``);
  } else {
    for (const [file, deps] of Object.entries(imports)) {
      for (const dep of deps) importLines.push(`- \`${file}\` ← \`${dep}\``);
    }
  }

  const content = [
    `# ${subGoal.id}-interface — ${subGoal.title}`,
    ``,
    `- **sub-goal**: ${subGoal.id} — ${subGoal.title}`,
    `- **capability**: ${capability}`,
    ``,
    `## Exports`,
    ``,
    ...(exportLines.length > 0 ? exportLines : ["(none)"]),
    ``,
    `## Target Files`,
    ``,
    ...subGoal.targetFiles.map((f) => `- \`${f}\``),
    ``,
    `## Dependencies`,
    ``,
    ...(importLines.length > 0 ? importLines : ["(none)"]),
    ``,
  ].join("\n");

  const filePath = docPath(workspaceRoot, planId, subGoal.id);
  fs.writeFileSync(filePath, content, "utf-8");

  // Hard gate: read back and validate
  const written = fs.readFileSync(filePath, "utf-8");
  const parsed = parseInterfaceDoc(written);
  if (!parsed) return null;

  // Cross-check: declared exports must exist in target files
  const missing = verifyExportsExist(parsed, workspaceRoot);
  if (missing.length > 0) return null;

  return filePath;
}

// ── Export verification ────────────────────────────────────────────

const EXPORT_RE = /export\s+(?:const|let|var|function|class|interface|type|enum|async\s+function|default\s+class|default\s+function)\s+(\w+)/g;
const MODULE_EXPORTS_RE = /module\.exports\s*=\s*(\w+)/;
const EXPORTS_MAP_RE = /(?:module\.)?exports\s*\.\s*(\w+)\s*=/g;

function hasExport(source: string, name: string): boolean {
  EXPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORT_RE.exec(source)) !== null) {
    if (m[1] === name) return true;
  }
  const modMatch = MODULE_EXPORTS_RE.exec(source);
  if (modMatch && modMatch[1] === name) return true;
  EXPORTS_MAP_RE.lastIndex = 0;
  while ((m = EXPORTS_MAP_RE.exec(source)) !== null) {
    if (m[1] === name) return true;
  }
  return false;
}

/** Check that all exports declared in an interface doc actually exist
 *  in the source files. Returns list of missing exports. */
export function verifyExportsExist(doc: InterfaceDoc, workspaceRoot: string): string[] {
  const missing: string[] = [];
  for (const exp of doc.exports) {
    let found = false;
    for (const tf of doc.files) {
      const fullPath = path.resolve(workspaceRoot, tf);
      if (!fs.existsSync(fullPath)) continue;
      try {
        if (hasExport(fs.readFileSync(fullPath, "utf-8"), exp)) {
          found = true;
          break;
        }
      } catch { /* skip */ }
    }
    if (!found) missing.push(`${exp} (declared but not found in [${doc.files.join(", ")}])`);
  }
  return missing;
}

// ── Read ───────────────────────────────────────────────────────────

/** Load all interface docs for a project. Reads from sub-goal folders
 *  first, falls back to legacy interfaces directory. */
export function loadAllInterfaceDocs(workspaceRoot: string, planId: string): InterfaceDoc[] {
  const docs: InterfaceDoc[] = [];

  // New format: sub-goal folders
  const planDir = getPlanDir(workspaceRoot, planId);
  const sgBase = path.join(planDir, "sub-goals");
  if (fs.existsSync(sgBase)) {
    for (const sgEntry of fs.readdirSync(sgBase)) {
      const contractPath = path.join(sgBase, sgEntry, "contract.md");
      if (!fs.existsSync(contractPath)) continue;
      try {
        const content = fs.readFileSync(contractPath, "utf-8");
        const parsed = parseInterfaceDoc(content);
        if (parsed) docs.push(parsed);
      } catch { /* skip */ }
    }
  }

  // Legacy format fallback
  if (docs.length === 0) {
    const dir = path.join(getInterfacesDir(workspaceRoot), `interface-${planId}`);
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith(".md")) continue;
        try {
          const content = fs.readFileSync(path.join(dir, entry), "utf-8");
          const parsed = parseInterfaceDoc(content);
          if (parsed) docs.push(parsed);
        } catch { /* skip */ }
      }
    }
  }

  return docs;
}

/** Parse an interface doc back into structured form. */
export function parseInterfaceDoc(content: string): InterfaceDoc | null {
  try {
    const titleMatch = content.match(/^# (\S+)-interface — (.+)/m);
    if (!titleMatch) {
      const oldMatch = content.match(/# interface_(\S+) — (.+)/);
      if (!oldMatch) return null;
      return parseLegacyDoc(content, oldMatch[1] ?? "");
    }

    const subGoalId = titleMatch[1] ?? "";
    const capMatch = content.match(/\*\*capability\*\*: (.+)/);
    const exportMatches = content.match(/`([^`]+)` `([^`]+)` — (.+)/g);
    const depMatches = content.match(/^## Dependencies\n\n((?:- .*\n?)*)/m);

    const exports: string[] = [];
    const files: string[] = [];
    if (exportMatches) {
      for (const em of exportMatches) {
        const parts = em.match(/`([^`]+)` `([^`]+)` —/);
        if (parts) {
          if (parts[1] && !files.includes(parts[1])) files.push(parts[1]);
          if (parts[2]) exports.push(parts[2]);
        }
      }
    }

    const targetSection = content.match(/## Target Files\n\n((?:- .*\n?)*)/);
    if (targetSection?.[1]) {
      const fileMatches = targetSection[1].matchAll(/`([^`]+)`/g);
      for (const fm of fileMatches) {
        if (fm[1] && !files.includes(fm[1])) files.push(fm[1]);
      }
    }

    const imports: string[] = [];
    if (depMatches?.[1]) {
      const depList = depMatches[1].matchAll(/- `([^`]+)`/g);
      for (const dm of depList) {
        if (dm[1] && dm[1] !== "(none)") imports.push(dm[1]);
      }
    }

    return {
      projectName: "",
      subGoalId,
      files,
      exports,
      imports,
      capability: capMatch?.[1]?.trim() ?? "",
    };
  } catch {
    return null;
  }
}

function parseLegacyDoc(content: string, subGoalId: string): InterfaceDoc | null {
  try {
    const fileMatch = content.match(/\*\*file\*\*: (.+)/);
    const exportsMatch = content.match(/\*\*exports\*\*: (.+)/);
    const importsMatch = content.match(/\*\*imports\*\*: (.+)/);
    const capMatch = content.match(/\*\*capability\*\*: (.+)/);

    return {
      projectName: "",
      subGoalId,
      files: fileMatch?.[1]?.split(", ").filter(Boolean).map(s => s.trim()) ?? [],
      exports: exportsMatch?.[1]?.split(", ").filter(Boolean) ?? [],
      imports: importsMatch?.[1]?.split(", ").filter(Boolean) ?? [],
      capability: capMatch?.[1]?.trim() ?? "",
    };
  } catch {
    return null;
  }
}

// ── Context injection ──────────────────────────────────────────────

/** Build a system prompt fragment from all completed interface docs.
  * Injected after context discard so the AI knows what's already built. */
export function buildInterfaceContext(docs: InterfaceDoc[]): string {
  if (docs.length === 0) return "";

  const lines = [
    "## Completed Modules (from previous sub-goals)",
    "",
    "The following modules have been built. Import from them instead of rebuilding.",
    "",
  ];

  for (const doc of docs) {
    lines.push(`### Sub-goal ${doc.subGoalId}`);
    if (doc.exports.length > 0) lines.push(`- Exports: \`${doc.exports.join("`, `")}\``);
    if (doc.imports.length > 0) lines.push(`- Dependencies: \`${doc.imports.join("`, `")}\``);
    if (doc.capability) lines.push(`- Capability: ${doc.capability}`);
    lines.push("");
  }

  return lines.join("\n");
}

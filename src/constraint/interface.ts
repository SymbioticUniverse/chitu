import * as fs from "node:fs";
import * as path from "node:path";

export interface FileInterface {
  /** Source file path relative to workspace root. */
  file: string;
  /** Symbols this file exports. */
  exports: string[];
  /** Dependencies: symbol → source file it comes from. */
  imports: { symbol: string; from: string }[];
  /** One-line description of what this file does. */
  capability: string;
  /** When this interface was last updated. */
  updatedAt: string;
}

const INTERFACES_DIR = ".chitu/interfaces";

export function getConstraintInterfacesDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, INTERFACES_DIR);
}

/** Convert a source file path to a safe filename for the interface doc. */
function filePathToKey(file: string): string {
  return file.replace(/[/\\]/g, "-").replace(/^\./, "") + ".json";
}

function ifacePath(workspaceRoot: string, file: string): string {
  const dir = getConstraintInterfacesDir(workspaceRoot);
  return path.join(dir, filePathToKey(file));
}

/** Write or update the interface doc for a single source file. */
export function writeFileInterface(workspaceRoot: string, iface: FileInterface): string {
  const dir = getConstraintInterfacesDir(workspaceRoot);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = ifacePath(workspaceRoot, iface.file);
  iface.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(iface, null, 2), "utf-8");
  return filePath;
}

/** Read the interface doc for a single source file. */
export function readFileInterface(workspaceRoot: string, file: string): FileInterface | null {
  const fp = ifacePath(workspaceRoot, file);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8")) as FileInterface;
  } catch {
    return null;
  }
}

/** Load all interface docs for the entire project. */
export function loadAllFileInterfaces(workspaceRoot: string): FileInterface[] {
  const dir = getConstraintInterfacesDir(workspaceRoot);
  if (!fs.existsSync(dir)) return [];
  const results: FileInterface[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const iface = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf-8")) as FileInterface;
      results.push(iface);
    } catch { /* skip */ }
  }
  return results;
}

/** Build the full dependency graph: which files depend on which. */
export function buildDependencyGraph(interfaces: FileInterface[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const iface of interfaces) {
    for (const imp of iface.imports) {
      const deps = graph.get(iface.file) ?? [];
      if (!deps.includes(imp.from)) deps.push(imp.from);
      graph.set(iface.file, deps);
    }
  }
  return graph;
}

/** Given a set of entry files, expand to the full dependency closure.
 *  Used by the orchestrator to determine the boundary for an iteration. */
export function expandDependencyClosure(
  interfaces: FileInterface[],
  entryFiles: string[],
): string[] {
  const graph = buildDependencyGraph(interfaces);
  const closure = new Set<string>(entryFiles);
  const queue = [...entryFiles];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const deps = graph.get(current) ?? [];
    for (const dep of deps) {
      if (!closure.has(dep)) {
        closure.add(dep);
        queue.push(dep);
      }
    }
  }

  return [...closure];
}

/** Build a context string from all interface docs for AI system prompt injection.
 *  Graph format: nodes → edges → dependency tree → extension guide. */
export function buildInterfaceMapContext(interfaces: FileInterface[]): string {
  if (interfaces.length === 0) return "";

  // ── Nodes ──
  const nodeLines = ["## Interface Graph", "", "### Nodes", ""];
  for (const iface of interfaces) {
    nodeLines.push(`**\`${iface.file}\`** — ${iface.capability}`);
    if (iface.exports.length > 0) {
      nodeLines.push(`  Exports: \`${iface.exports.join("`, `")}\``);
    }
    if (iface.imports.length > 0) {
      const depList = iface.imports.map((i) => `\`${i.symbol}\` ← \`${i.from}\``);
      nodeLines.push(`  Imports: ${depList.join(", ")}`);
    }
    nodeLines.push("");
  }

  // ── Dependency Tree (ASCII) ──
  nodeLines.push("### Dependency Tree", "");
  const tree = buildDependencyTree(interfaces);
  nodeLines.push(tree);
  nodeLines.push("");

  // ── Extension Guide ──
  nodeLines.push("### How to Extend", "");
  const roots = interfaces.filter((i) => i.imports.length === 0);
  if (roots.length > 0) {
    nodeLines.push("**Foundation modules** (no dependencies, import from these freely):");
    for (const r of roots) {
      nodeLines.push(`  - \`${r.file}\` → ${r.exports.join(", ") || "no exports"}`);
    }
    nodeLines.push("");
  }
  const leafCount = interfaces.filter((i) =>
    !interfaces.some((other) => other.imports.some((imp) => imp.from === i.file)),
  ).length;
  nodeLines.push(`**Adding a new feature:** Create a new file, import from the modules above. Do NOT modify existing files — they are locked.`);
  nodeLines.push(`**${interfaces.length} files** indexed, **${leafCount}** are leaf nodes (safe to depend on).`);

  return nodeLines.join("\n");
}

/** Build an ASCII dependency tree from interface docs.
 *  DAG-aware: each file rendered once; cross-references shown as markers. */
function buildDependencyTree(interfaces: FileInterface[]): string {
  const byFile = new Map(interfaces.map((i) => [i.file, i]));
  const children = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const iface of interfaces) {
    if (!children.has(iface.file)) children.set(iface.file, []);
    if (!inDegree.has(iface.file)) inDegree.set(iface.file, 0);
    for (const imp of iface.imports) {
      const resolved = resolveImportPath(iface.file, imp.from, interfaces);
      if (resolved && resolved !== iface.file && byFile.has(resolved)) {
        if (!children.has(resolved)) children.set(resolved, []);
        const siblings = children.get(resolved)!;
        if (!siblings.includes(iface.file)) {
          siblings.push(iface.file);
          inDegree.set(iface.file, (inDegree.get(iface.file) ?? 0) + 1);
        }
      }
    }
  }

  // Find roots (files with no in-project dependencies)
  const roots = interfaces
    .filter((i) => (inDegree.get(i.file) ?? 0) === 0)
    .map((i) => i.file)
    .sort();

  const lines: string[] = [];
  const visited = new Set<string>();
  for (let i = 0; i < roots.length; i++) {
    renderTreeNode(roots[i]!, children, byFile, lines, "", i === roots.length - 1, visited);
  }
  return lines.join("\n");
}

function renderTreeNode(
  file: string,
  children: Map<string, string[]>,
  byFile: Map<string, FileInterface>,
  lines: string[],
  prefix: string,
  isLast: boolean,
  visited: Set<string>,
): void {
  const iface = byFile.get(file);
  const marker = isLast ? "└── " : "├── ";
  const exports = iface?.exports.slice(0, 3).join(", ") ?? "";
  const label = exports ? `${file} (${exports})` : file;

  if (visited.has(file)) {
    lines.push(`${prefix}${marker}${label} ↳ (see above)`);
    return;
  }
  visited.add(file);

  lines.push(`${prefix}${marker}${label}`);

  const deps = (children.get(file) ?? []).filter((d) => d !== file);
  for (let i = 0; i < deps.length; i++) {
    const childPrefix = prefix + (isLast ? "    " : "│   ");
    renderTreeNode(deps[i]!, children, byFile, lines, childPrefix, i === deps.length - 1, visited);
  }
}

/** Resolve a relative import path against the importing file's directory. */
function resolveImportPath(
  importerFile: string,
  importSpec: string,
  interfaces: FileInterface[],
): string | null {
  // Try exact match
  const exact = interfaces.find((i) => i.file === importSpec || i.file === importSpec + ".js" || i.file === importSpec + ".ts");
  if (exact) return exact.file;

  // Try resolving relative path
  const importerDir = importerFile.replace(/\/[^/]+$/, "");
  const candidates = [
    importSpec,
    importSpec + ".js",
    importSpec + ".ts",
    importSpec + "/index.js",
    importSpec + "/index.ts",
  ];
  for (const c of candidates) {
    const joined = importerDir ? `${importerDir}/${c}` : c;
    const resolved = path.normalize(joined).replace(/\\/g, "/");
    const match = interfaces.find((i) => i.file === resolved);
    if (match) return match.file;
  }
  return null;
}

/** After an iteration completes: scan changed files, parse exports/imports,
 *  update interface docs, and return the updated interface list. */
export function updateInterfacesAfterIteration(
  workspaceRoot: string,
  changedFiles: string[],
  capabilityHints: Record<string, string>,
): FileInterface[] {
  for (const file of changedFiles) {
    const fullPath = path.join(workspaceRoot, file);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const source = fs.readFileSync(fullPath, "utf-8");
      const parsed = parseFileExportsAndImports(source, file);
      writeFileInterface(workspaceRoot, {
        file,
        exports: parsed.exports,
        imports: parsed.imports.map((i) => ({ symbol: i.symbol, from: i.from })),
        capability: capabilityHints[file] ?? "",
        updatedAt: new Date().toISOString(),
      });
    } catch { /* skip unreadable files */ }
  }
  return loadAllFileInterfaces(workspaceRoot);
}

/** Parse exports and imports from source code using regex.
 *  Fast static analysis — no AST, no parsing, works for JS/TS/Vue SFC. */
export function parseFileExportsAndImports(source: string, filePath: string): { exports: string[]; imports: { symbol: string; from: string }[] } {
  const exports: string[] = [];
  const imports: { symbol: string; from: string }[] = [];
  const baseName = filePath.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");

  // export const/let/var/function/class/interface/type/enum name
  // Also: export async function name, export default function/class name
  const exportRe = /export\s+(?:const|let|var|function|class|interface|type|enum|async\s+function|default\s+(?:function|class)?)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = exportRe.exec(source)) !== null) {
    if (m[1] && !exports.includes(m[1])) exports.push(m[1]);
  }

  // export default <expression> (anonymous — use filename as export)
  if (/export\s+default\s+(?!function|class|interface|type\b)/.test(source) && !exports.includes(baseName)) {
    exports.push(baseName);
  }

  // export { a, b, c }  and  export { a as b }
  const namedExportRe = /export\s*\{([^}]+)\}/g;
  while ((m = namedExportRe.exec(source)) !== null) {
    for (const name of m[1]!.split(",")) {
      const trimmed = name.trim().replace(/\s+as\s+\w+/, "").trim();
      if (trimmed && !exports.includes(trimmed)) exports.push(trimmed);
    }
  }

  // export { ... } from '...' — re-exports, treat as both import and export
  const reExportRe = /export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = reExportRe.exec(source)) !== null) {
    const from = m[2]!;
    for (const name of m[1]!.split(",")) {
      const trimmed = name.trim().replace(/\s+as\s+\w+/, "").trim();
      if (trimmed) {
        if (!exports.includes(trimmed)) exports.push(trimmed);
        imports.push({ symbol: trimmed, from });
      }
    }
  }

  // export * from '...' — star re-exports
  const starReExportRe = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = starReExportRe.exec(source)) !== null) {
    imports.push({ symbol: "*", from: m[1]! });
  }

  // import { a, b } from '...'  or  import X from '...'  or  import X, { a } from '...'
  // Also: import type { ... } from '...'
  const importRe = /import\s+(?:type\s+)?(?:(?:\{([^}]+)\})|(\w+))?(?:\s*,\s*(?:\{([^}]+)\})|(\w+))?\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = importRe.exec(source)) !== null) {
    const from = m[5]!;
    // Default import: import X from '...' (m[2]) or import X, { ... } from '...' (m[2] is default, m[3] is named)
    if (m[2] && m[2] !== "type") imports.push({ symbol: m[2], from });
    if (m[4] && m[4] !== "type") imports.push({ symbol: m[4], from });
    // Named imports: { a, b }
    const namedBlock = m[1] || m[3];
    if (namedBlock) {
      for (const name of namedBlock.split(",")) {
        const trimmed = name.trim().replace(/\s+as\s+\w+/, "").trim();
        if (trimmed) imports.push({ symbol: trimmed, from });
      }
    }
  }

  // import * as X from '...' — namespace import
  const nsImportRe = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = nsImportRe.exec(source)) !== null) {
    imports.push({ symbol: m[1]!, from: m[2]! });
  }

  // import '...' — side-effect import (no symbol, just source)
  const sideEffectRe = /import\s+['"]([^'"]+)['"]/g;
  while ((m = sideEffectRe.exec(source)) !== null) {
    const from = m[1]!;
    if (!imports.some((i) => i.from === from)) {
      imports.push({ symbol: "(side-effect)", from });
    }
  }

  // CommonJS: module.exports = ...
  if (/module\.exports\s*=/.test(source)) {
    const cjsRe = /module\.exports\s*=\s*\{([^}]*)\}/g;
    while ((m = cjsRe.exec(source)) !== null) {
      for (const part of m[1]!.split(",")) {
        const trimmed = part.trim().split(/\s*:\s*/)[0]?.trim();
        if (trimmed && !exports.includes(trimmed)) exports.push(trimmed);
      }
    }
    // module.exports = singleValue
    if (/module\.exports\s*=\s*(?!\{)/.test(source) && !exports.includes(baseName)) {
      exports.push(baseName);
    }
  }

  // CommonJS: exports.name = ...
  const cjsNamedRe = /exports\.(\w+)\s*=/g;
  while ((m = cjsNamedRe.exec(source)) !== null) {
    if (m[1] && !exports.includes(m[1])) exports.push(m[1]);
  }

  return { exports, imports };
}

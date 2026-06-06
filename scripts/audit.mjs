#!/usr/bin/env node
/**
 * 赤兔自动化审计脚本 — 每次构建前自动运行，捕获最常见的安全和代码质量问题。
 *
 * 检查项（全部是致命/高危）：
 *   1. as any — 生产代码中禁止使用
 *   2. 静默吞错 — .catch(() => {}) 或空 catch {}
 *   3. 进程泄露 — spawn 无 error 事件处理
 *   4. 路径穿越 — join/resolve 未验证
 *   5. SSRF — fetch 无 URL 验证
 */

import { readFileSync } from "node:fs";
import { extname, relative } from "node:path";
import { globSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = `${ROOT}/src`;

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let violations = 0;
let warnings = 0;

function warn(cat, file, line, msg) {
  violations++;
  console.log(`  ${RED}[${cat}]${RESET} ${file}:${line}  ${msg}`);
}

function info(cat, file, line, msg) {
  warnings++;
  console.log(`  ${YELLOW}[${cat}]${RESET} ${file}:${line}  ${msg}`);
}

// 收集所有 .ts 源文件（排除测试）
const files = globSync(`${SRC}/**/*.ts`, { nodir: true })
  .filter((f) => !f.endsWith(".test.ts"));

console.log(`\n🔍 赤兔代码审计 — 检查 ${files.length} 个源文件\n`);

// ─── 1. as any ──────────────────────────────────────────────
for (const f of files) {
  const lines = readFileSync(f, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("as any")) {
      warn("as-any", f, i + 1, lines[i].trim());
    }
  }
}

// ─── 2. 静默吞错 ────────────────────────────────────────────
for (const f of files) {
  const raw = readFileSync(f, "utf-8");
  const catchPatterns = [
    { re: /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\/\*\s*silent|\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}/g, msg: "silent .catch(() => {})" },
    { re: /\}\s*catch\s*\{\s*\/\/.*?\n\s*\}/g, msg: "empty catch {} block" },
  ];
  for (const { re, msg } of catchPatterns) {
    const matches = raw.matchAll(re);
    for (const m of matches) {
      const lineNo = raw.slice(0, m.index).split("\n").length;
      warn("silent-catch", f, lineNo, msg);
    }
  }
}

// ─── 3. 进程泄露 — spawn 无 error 事件 ────────────────────────
for (const f of files) {
  const raw = readFileSync(f, "utf-8");
  // 找 spawn() 调用，检查后续 20 行内是否有 .on("error")
  const spawnRe = /(?:const |let |var )?\w+\s*=\s*spawn\(/g;
  let m;
  while ((m = spawnRe.exec(raw)) !== null) {
    const afterIdx = m.index + m[0].length;
    const after = raw.slice(afterIdx, afterIdx + 800);
    const hasErrorHandler = /\.on\(\s*"error"/.test(after) || /\.on\(\s*'error'/.test(after);
    if (!hasErrorHandler) {
      const lineNo = raw.slice(0, m.index).split("\n").length;
      warn("spawn-leak", f, lineNo, "spawn() without .on('error') handler");
    }
  }
}

// ─── 4. 路径穿越 — join/resolve 后无 startsWith 验证 ──────────
for (const f of files) {
  const raw = readFileSync(f, "utf-8");
  // 找 path.join(root, ...) 或 path.resolve(root, ...) 后面是否跟着 startsWith
  const joinRe = /path\.(?:join|resolve)\(\s*\w+\s*,/g;
  let m;
  while ((m = joinRe.exec(raw)) !== null) {
    // 找后续 5 行内是否有 startsWith 或 realpath
    const afterIdx = m.index + m[0].length;
    const after = raw.slice(afterIdx, afterIdx + 500);
    const hasGuard = /\.startsWith\(|realpathSync|\.includes\(["']\.\.["']\)/m.test(after);
    if (!hasGuard) {
      const lineNo = raw.slice(0, m.index).split("\n").length;
      info("path-traverse", f, lineNo, "path.join/resolve without visible traversal guard");
    }
  }
}

// ─── 5. SSRF — fetch(url) 但前面无 URL 验证 ──────────────────
for (const f of files) {
  const raw = readFileSync(f, "utf-8");
  // 找 fetch( 调用，检查前面 10 行是否有 URL/hostname 验证
  const fetchRe = /\bfetch\(\s*(?!["']https?:\/\/)/g;
  let m;
  while ((m = fetchRe.exec(raw)) !== null) {
    const before = raw.slice(Math.max(0, m.index - 600), m.index);
    const hasValidation = /isPrivate|SSRF|blocked|protocol|localhost|hostname|new URL/.test(before);
    if (!hasValidation) {
      const lineNo = raw.slice(0, m.index).split("\n").length;
      info("ssrf", f, lineNo, "fetch() without visible URL validation");
    }
  }
}

// ─── 总结 ────────────────────────────────────────────────────
console.log("");
if (violations > 0) {
  console.log(`${RED}❌ ${violations} violations found${RESET}`);
} else {
  console.log(`${GREEN}✅ No violations${RESET}`);
}
if (warnings > 0) {
  console.log(`${YELLOW}⚠️  ${warnings} warnings (review recommended)${RESET}`);
}

// exit 1 on violations so CI fails
process.exit(violations > 0 ? 1 : 0);

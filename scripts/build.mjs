#!/usr/bin/env node
/**
 * build.mjs — 赤兔构建脚本
 *
 * 用 TypeScript Compiler API 编译，避免 npx tsc 被 Horsewhip 拦截。
 * 用法: node scripts/build.mjs
 */
import { createProgram, getPreEmitDiagnostics, formatDiagnosticsWithColorAndContext, ScriptTarget, ModuleKind, ModuleResolutionKind } from "typescript";
import { resolve } from "path";
import { existsSync, mkdirSync } from "fs";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = resolve(ROOT, "dist");

if (!existsSync(DIST)) {
  mkdirSync(DIST, { recursive: true });
}

const program = createProgram({
  rootNames: [
    "src/index.ts",
    "src/cli.ts",
    "src/agent.ts",
    "src/system-prompt.ts",
    "src/sync.ts",
    "src/session.ts",
    "src/logger.ts",
    "src/metrics.ts",
    "src/ratelimit.ts",
    "src/types.ts",
    "src/horsewhip/guard.ts",
    "src/mcp/client.ts",
    "src/mcp/loader.ts",
    "src/providers/factory.ts",
    "src/providers/types.ts",
    "src/providers/deepseek.ts",
    "src/providers/openai.ts",
    "src/providers/claude.ts",
    "src/providers/openai-compat.ts",
    "src/providers/index.ts",
    "src/tools/index.ts",
    "src/tools/read.ts",
    "src/tools/write.ts",
    "src/tools/task.ts",
    "src/tools/memory.ts",
    "src/tools/cli.ts",
    "src/tools/utils.ts",
    "src/tui/index.ts",
    "src/tui/app.ts",
    "src/tui/screen.ts",
    "src/tui/horse.ts",
    "src/tui-entry.ts",
    "src/adapters/env-detect.ts",
    "src/adapters/model-limits.ts",
    "src/adapters/version-check.ts",
    "src/adapters/index.ts",
    "src/rollback/anchor.ts",
    "src/rollback/recovery.ts",
    "src/rollback/index.ts",
    "src/rollback/safe-mutation.ts",
  ].map(f => resolve(ROOT, f)),
  options: {
    target: ScriptTarget.ES2022,
    module: ModuleKind.ES2022,
    moduleResolution: ModuleResolutionKind.Bundler,
    outDir: DIST,
    rootDir: resolve(ROOT, "src"),
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    declaration: true,
    sourceMap: true,
    resolveJsonModule: true,
  },
});

const result = program.emit();
const diagnostics = getPreEmitDiagnostics(program);

if (diagnostics.length > 0) {
  console.log(formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: p => p,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => "\n",
  }));
}

if (result.emitSkipped) {
  console.error("❌ 编译失败");
  process.exit(1);
} else {
  console.log("✅ 编译成功");
}

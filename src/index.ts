#!/usr/bin/env node
import "dotenv/config";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import * as readline from "node:readline";
import { HorsewhipSync } from "./sync.js";
import { startTUI } from "./tui/index.js";
import { main } from "./cli.js";
import { logger } from "./logger.js";
import { ensureApiKey } from "./global-config.js";

// 检查目录是否像一个代码项目（有项目标志文件）
function isProjectDirectory(dir: string): boolean {
  const markers = [
    "package.json", "tsconfig.json", "Cargo.toml", "go.mod",
    "pom.xml", "build.gradle", "CMakeLists.txt", "Makefile",
    "src", "lib", "app", "pyproject.toml", "setup.py",
  ];
  for (const m of markers) {
    if (existsSync(join(dir, m))) return true;
  }
  // 有超过3个文件也算（可能有隐藏的配置文件）
  try {
    const entries = readdirSync(dir).filter((e) => !e.startsWith("."));
    return entries.length > 3;
  } catch {
    return false;
  }
}

// ── Global error handling ──
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
  process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled rejection:", reason);
  process.exitCode = 1;
});

const argv = process.argv.slice(2);
const cwd = process.cwd();

// ── API Key 自检：未配置则交互式引导输入 ──
await ensureApiKey();

let forceAppraise = false; // 非项目目录时强制只读问答

// ── Git 仓库检查 ──
if (!existsSync(join(cwd, ".git"))) {
  const isProject = isProjectDirectory(cwd);

  if (!isProject) {
    // 桌面、下载等非项目目录 → 限制只读问答模式
    console.log("🐴 当前目录不是代码项目，赤兔将以Ask 只读问答模式运行。\n");
    console.log(`   目录: ${cwd}`);
    console.log(`   如需创建项目，请先 git init 后在项目目录中运行。\n`);
    forceAppraise = true;
  } else {
    // 项目目录 → 询问是否初始化 git
    console.log("🐴 赤兔需要在 Git 仓库中工作，当前目录尚未初始化。\n");
    console.log(`   目录: ${cwd}\n`);

    const answer = await new Promise<string>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("   是否运行 git init 初始化仓库？[Y/n] ", (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      });
    });

    if (answer === "" || answer === "y" || answer === "yes") {
      try {
        execSync("git init", { cwd, stdio: "inherit", timeout: 5000 });
        console.log("✅ 已初始化 Git 仓库。\n");
      } catch {
        console.log("⚠️  初始化失败，请手动运行 git init 后重试。");
        process.exit(1);
      }
    } else {
      console.log("❌ 已取消。请手动运行 git init 后重试。");
      process.exit(1);
    }
  }
}

// Auto-check horsewhip sync on startup (non-blocking)
new HorsewhipSync(cwd).autoCheck().then((check) => {
  if (check.updateAvailable) {
    console.log(`Horsewhip ${check.latestVersion} available (current: ${check.currentVersion ?? "none"}). Run \`chitu sync\` to update.`);
  }
}).catch((e) => { logger.warn("Horsewhip version check failed", { error: String(e) }); });

// chitu               → 奉先模式 (吕布·手动操作，有 guard)
// chitu --fengxian     → 奉先模式 (同上，显式指定)
// chitu --yunchang     → 云长模式 (关羽·自动镇守，有 guard，auto commit)
// chitu --dev          → TUI dev mode
// chitu run/resume/metrics/list → CLI mode

if (forceAppraise) {
  startTUI({ skipGuard: true, paradigm: "appraise" }).catch((e) => {
    console.error("Chitu fatal:", e);
    process.exit(1);
  });
} else if (!["run", "resume", "metrics", "list", "dev", "build", "sync", "config", "help"].includes(argv[0] ?? "") &&
           (argv.length === 0 || argv.includes("--fengxian") || argv.includes("--yunchang") || argv.includes("--constraint") || argv[0] === "--dev")) {
  const yunchang = argv.includes("--yunchang");
  const constraint = argv.includes("--constraint");
  const dev = argv[0] === "--dev";
  const thinking = argv.includes("--thinking");
  const paradigm = constraint ? "constraint" : yunchang ? "ride" : undefined;
  startTUI({ skipGuard: dev, dev, paradigm, yunchang: yunchang || constraint, thinking }).catch((e) => {
    console.error("Chitu fatal:", e);
    process.exit(1);
  });
} else {
  main(argv).catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}

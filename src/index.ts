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
import { runSetup, isFirstRun } from "./tui/setup.js";

// Check if directory looks like a code project (has project marker files)
function isProjectDirectory(dir: string): boolean {
  const markers = [
    "package.json", "tsconfig.json", "Cargo.toml", "go.mod",
    "pom.xml", "build.gradle", "CMakeLists.txt", "Makefile",
    "src", "lib", "app", "pyproject.toml", "setup.py",
  ];
  for (const m of markers) {
    if (existsSync(join(dir, m))) return true;
  }
  // Also consider directories with >3 files (might have hidden config files)
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

// ── First-run setup wizard ──
if (isFirstRun()) {
  await runSetup();
} else {
  await ensureApiKey();
}

let forceAppraise = false; // Force read-only Q&A in non-project directories

// ── Git repository check ──
if (!existsSync(join(cwd, ".git"))) {
  const isProject = isProjectDirectory(cwd);

  if (!isProject) {
    // Desktop, Downloads, etc. — not a project directory, limit to read-only Q&A
    console.log("🐴 Current directory is not a code project. Chitu will run in Ask (read-only Q&A) mode.\n");
    console.log(`   Directory: ${cwd}`);
    console.log(`   To create a project, run git init first, then run chitu in the project directory.\n`);
    forceAppraise = true;
  } else {
    // Project directory — ask whether to initialize git
    console.log("🐴 Chitu needs a Git repository to work. Current directory is not initialized.\n");
    console.log(`   Directory: ${cwd}\n`);

    const answer = await new Promise<string>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("   Run git init to initialize? [Y/n] ", (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      });
    });

    if (answer === "" || answer === "y" || answer === "yes") {
      try {
        execSync("git init", { cwd, stdio: "inherit", timeout: 5000 });
        console.log("✅ Git repository initialized.\n");
      } catch {
        console.log("⚠️  Initialization failed. Please run git init manually and retry.");
        process.exit(1);
      }
    } else {
      console.log("❌ Cancelled. Please run git init manually and retry.");
      process.exit(1);
    }
  }
}

// Auto-check horsewhip sync on startup (non-blocking)
new HorsewhipSync(cwd).autoCheck().then((check) => {
  if (check.updateAvailable) {
    // Log to file only — don't corrupt TUI stdout
    logger.info(`Horsewhip ${check.latestVersion} available (current: ${check.currentVersion ?? "none"}). Run \`chitu sync\` to update.`);
  }
}).catch((e) => { logger.warn("Horsewhip version check failed", { error: String(e) }); });

// Auto-check chitu self-update on startup (non-blocking)
try {
  const { checkForUpdate, findChituRoot, isChituRepo } = await import("./update.js");
  const chituRoot = findChituRoot();
  if (isChituRepo(chituRoot)) {
    // Defer to avoid blocking startup
    setImmediate(async () => {
      try {
        const behind = checkForUpdate(chituRoot);
        if (behind > 0) {
          logger.info(`Chitu is ${behind} commit(s) behind. Run \`chitu update\` to get the latest.`);
        }
      } catch { /* silent */ }
    });
  }
} catch { /* optional — don't block startup if update module fails */ }

// chitu          → TUI interactive
// chitu --dev     → TUI dev mode
// chitu run/resume/metrics/list/config/help → CLI mode

if (forceAppraise) {
  startTUI({ skipGuard: true, paradigm: "appraise" }).catch((e) => {
    console.error("Chitu fatal:", e);
    process.exit(1);
  });
} else if (!["run", "resume", "metrics", "list", "dev", "build", "sync", "config", "help"].includes(argv[0] ?? "") &&
           (argv.length === 0 || argv[0] === "--dev" || argv.includes("--thinking"))) {
  const dev = argv[0] === "--dev";
  const thinking = argv.includes("--thinking");
  startTUI({ skipGuard: dev, dev, thinking }).catch((e) => {
    console.error("Chitu fatal:", e);
    process.exit(1);
  });
} else {
  main(argv).catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}

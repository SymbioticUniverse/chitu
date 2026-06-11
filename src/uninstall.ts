import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { homedir } from "node:os";

function findChituRoot(): string {
  const scriptPath = realpathSync(process.argv[1] ?? "");
  let dir = dirname(scriptPath);
  dir = dirname(dir);
  return dir;
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === "y" || ans.trim().toLowerCase() === "yes");
    });
  });
}

export async function uninstallChitu(): Promise<void> {
  const root = findChituRoot();

  console.log("🐴 Uninstalling Chitu...\n");
  console.log(`   Install directory: ${root}`);

  // Step 1: npm unlink
  try {
    execSync("npm unlink -g chitu", { cwd: root, stdio: "pipe", timeout: 10000 });
    console.log("   ✅ npm unlink done");
  } catch {
    try {
      execSync("npm unlink", { cwd: root, stdio: "pipe", timeout: 10000 });
      console.log("   ✅ npm unlink done (local)");
    } catch {
      console.log("   ⚠️  npm unlink skipped (may not be linked)");
    }
  }

  // Step 2: Remove install directory
  try {
    rmSync(root, { recursive: true, force: true });
    console.log(`   ✅ Removed ${root}`);
  } catch {
    console.error(`   ❌ Failed to remove ${root}. Delete it manually.`);
  }

  // Step 3: Ask about ~/.chitu/
  const chituHome = join(homedir(), ".chitu");
  if (existsSync(chituHome)) {
    const ans = await confirm(`\n   Remove ~/.chitu/ (global config, API keys)? [y/N] `);
    if (ans) {
      try {
        rmSync(chituHome, { recursive: true, force: true });
        console.log("   ✅ Removed ~/.chitu/");
      } catch {
        console.error("   ❌ Failed to remove ~/.chitu/. Delete it manually.");
      }
    } else {
      console.log("   ⏭  Kept ~/.chitu/");
    }
  }

  console.log("\n✅ Chitu uninstalled.");
}

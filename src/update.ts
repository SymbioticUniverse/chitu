import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";

/** Find the Chitu install root (git repo dir) by resolving the chitu symlink */
export function findChituRoot(): string {
  // process.argv[1] is the resolved path to dist/index.js
  // dist/index.js → project root is 2 levels up
  const scriptPath = realpathSync(process.argv[1] ?? "");
  let dir = dirname(scriptPath); // dist/
  dir = dirname(dir);            // project root
  return dir;
}

/** Check if a Chitu update is available. Returns commit count behind, or 0 if up to date. */
export function checkForUpdate(chituRoot: string): number {
  try {
    execSync("git fetch origin", { cwd: chituRoot, stdio: "pipe", timeout: 10_000 });
    const behind = execSync("git rev-list --count HEAD..origin/main", {
      cwd: chituRoot, encoding: "utf-8", stdio: "pipe", timeout: 5_000,
    }).trim();
    return parseInt(behind, 10) || 0;
  } catch {
    return 0;
  }
}

/** Check if there's a git remote and repo at the given path */
export function isChituRepo(dir: string): boolean {
  try {
    execSync("git remote -v", { cwd: dir, stdio: "pipe", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

/** Run chitu update: git pull + npm install */
export async function updateChitu(): Promise<void> {
  const root = findChituRoot();

  if (!isChituRepo(root)) {
    console.error(`Error: ${root} is not a git repository. Chitu installed via npm must be updated with npm.`);
    process.exit(1);
  }

  console.log(`Updating Chitu in ${root}...`);
  console.log("");

  try {
    execSync("git pull", { cwd: root, stdio: "inherit" });
  } catch {
    console.error("\nError: git pull failed. Check your network or resolve conflicts manually.");
    process.exit(1);
  }

  try {
    execSync("npm install", { cwd: root, stdio: "inherit" });
  } catch {
    console.error("\nError: npm install failed. Try running 'npm install' manually.");
    process.exit(1);
  }

  try {
    console.log("");
    execSync("npm run build", { cwd: root, stdio: "inherit" });
  } catch {
    console.error("\nError: build failed. Try running 'npm run build' manually.");
    process.exit(1);
  }

  console.log("");
  console.log("Chitu updated successfully. Restart to use the new version.");
}

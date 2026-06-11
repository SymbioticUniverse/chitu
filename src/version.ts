import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export function getChituVersion(): string {
  try {
    const root = dirname(dirname(realpathSync(process.argv[1] ?? "")));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { version: string };
    return `chitu community v${pkg.version}`;
  } catch {
    return "chitu community";
  }
}

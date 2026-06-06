import * as path from "node:path";
import * as fs from "node:fs";

/** Resolve a path relative to workspace root. Blocks path traversal outside workspace. */
export function resolvePath(root: string, p: string): string {
  const resolved = path.resolve(root, p);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path traversal blocked: "${p}" resolves outside workspace`);
  }
  // Follow symlinks to prevent bypass via symlink pointing outside workspace
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // realpath fails if file doesn't exist — walk up to find the nearest existing ancestor
    let ancestor = path.dirname(resolved);
    while (ancestor.length >= root.length) {
      try {
        real = path.join(fs.realpathSync(ancestor), resolved.slice(ancestor.length + 1));
        break;
      } catch {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          // Reached filesystem root — path is invalid
          throw new Error(`Path resolution failed: "${p}" cannot resolve any existing ancestor`);
        }
        ancestor = parent;
      }
    }
  }
  // At this point real is guaranteed to be set (either from try or catch block)
  real = real!;
  if (!real.startsWith(root + path.sep) && real !== root) {
    throw new Error(`Path traversal blocked: "${p}" symlink target is outside workspace`);
  }
  return resolved;
}

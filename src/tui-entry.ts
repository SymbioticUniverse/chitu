#!/usr/bin/env node
// Chitu TUI — standalone entry point. Run: node dist/tui-entry.js
import { startTUI } from "./tui/index.js";
import type { ProviderName } from "./providers/index.js";

function parseArgs(argv: string[]): {
  provider?: ProviderName;
  model?: string;
} {
  const opts: ReturnType<typeof parseArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--provider": case "-p":
        opts.provider = argv[++i] as ProviderName;
        break;
      case "--model": case "-m":
        opts.model = argv[++i];
        break;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

startTUI(opts).catch((e) => {
  console.error("TUI fatal:", e);
  process.exit(1);
});

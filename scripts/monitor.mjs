#!/usr/bin/env node
/** Monitor Chitu constraint loop — watches .chitu/constraint.log for exit events. */

import { watchFile, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] || process.cwd();
const LOG = join(ROOT, ".chitu", "constraint.log");

console.log(`🔍 Monitoring ${LOG}`);
console.log("   Waiting for constraint.log to appear...\n");

let lastSize = 0;

// Poll every 2s for the log file
const timer = setInterval(() => {
  try {
    if (!existsSync(LOG)) return;
    const st = statSync(LOG);
    if (st.size === 0) return;
    if (st.size > lastSize) {
      // Read new bytes only
      const fd = require("node:fs").openSync(LOG, "r");
      const buf = Buffer.alloc(st.size - lastSize);
      require("node:fs").readSync(fd, buf, 0, buf.length, lastSize);
      require("node:fs").closeSync(fd);
      const text = buf.toString("utf-8").trim();
      if (text) {
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.includes("EXIT")) {
            console.log(`🛑 ${line}`);
          }
        }
      }
      lastSize = st.size;
    }
  } catch { /* retry */ }
}, 2000);

process.on("SIGINT", () => {
  console.log("\nStopped monitoring.");
  clearInterval(timer);
  process.exit(0);
});

console.log("Press Ctrl+C to stop.\n");

import * as path from "node:path";
import { writeFileSync } from "node:fs";
import { Agent } from "./agent.js";
import { logger } from "./logger.js";
import { SessionManager } from "./session.js";
import { MetricsEngine } from "./metrics.js";
import { MCPLoader } from "./mcp/loader.js";
import { HorsewhipGuardImpl } from "./horsewhip/guard.js";
import type { Paradigm } from "./types.js";
import { resolveApiKey, resolveModel, loadGlobalConfig, saveGlobalConfig, GLOBAL_CONFIG_PATH } from "./global-config.js";

interface Args {
  command: "run" | "resume" | "metrics" | "list" | "dev" | "build" | "sync" | "config" | "help" | "update" | "uninstall";
  task?: string;
  sessionId?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  paradigm?: string;
  /** Enable deep thinking / reasoning mode */
  thinking?: boolean;
  /** Manual mode — default, with guard */
  manual?: boolean;
  /** Auto mode — with guard, auto commit */
  auto?: boolean;
  /** Constraint mode — Horsewhip boundary, iterative sub-goals, auto commit */
  constraint?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "help" };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    switch (a) {
      case "run":
        args.command = "run";
        break;
      case "resume":
        args.command = "resume";
        break;
      case "dev":
      case "develop":
        args.command = "dev";
        break;
      case "build":
        args.command = "build";
        break;
      case "sync":
        args.command = "sync";
        break;
      case "update":
      case "upgrade":
        args.command = "update";
        break;
      case "uninstall":
        args.command = "uninstall";
        break;
      case "metrics":
        args.command = "metrics";
        break;
      case "list":
        args.command = "list";
        break;
      case "config":
        args.command = "config";
        break;
      case "--task":
      case "-t":
        args.task = argv[++i];
        break;
      case "--session":
      case "-s":
        args.sessionId = argv[++i];
        break;
      case "--model":
      case "-m":
        args.model = argv[++i];
        break;
      case "--api-key":
        args.apiKey = argv[++i];
        break;
      case "--base-url":
        args.baseUrl = argv[++i];
        break;
      case "--paradigm":
      case "-p":
        args.paradigm = argv[++i];
        break;
      case "--thinking":
        args.thinking = true;
        break;
      case "--manual":
      case "--fengxian":
        args.manual = true;
        break;
      case "--auto":
      case "--yunchang":
        args.auto = true;
        break;
      case "--constraint":
        args.constraint = true;
        break;
      case "help":
      case "--help":
      case "-h":
        args.command = "help";
        break;
    }
  }

  return args;
}

function showHelp(): void {
  console.log(`
Chitu (赤兔) — Terminal AI Agent

Usage:
  chitu                          Interactive TUI (Tab to switch Ask / Constraint)
  chitu --dev                    Developer TUI (no guard)
  chitu run --task <task>        Run a new task (headless)
  chitu run --task <task> --auto       Run with auto-commit (headless)
  chitu run --task <task> --constraint Run with constraint mode (headless)
  chitu resume <session-id>      Resume a previous session
  chitu dev --task <task>        Developer mode (headless)
  chitu build                    Compile TypeScript
  chitu sync                     Sync Horsewhip MCP version
  chitu update                   Update Chitu to latest version
  chitu uninstall                 Uninstall Chitu completely
  chitu metrics [session-id]     Show six-dimension metrics
  chitu list                     List all sessions
  chitu config                   Show global config (~/.chitu/config.json)
  chitu config set <key> <val>   Set a config value (e.g. apiKey, model)
  chitu config unset <key>       Remove a config value

Options:
  --task, -t <task>              Task description
  --session, -s <id>             Session ID
  --model, -m <model>            Model name (default: deepseek-v4-pro)
  --api-key <key>                API key (or set DEEPSEEK_API_KEY env)
  --base-url <url>               API base URL
  --thinking                     Enable deep thinking / reasoning mode
  --auto                         Auto-commit mode (for use with \`run\`)
  --constraint                   Constraint mode (for use with \`run\`)

Environment:
  DEEPSEEK_API_KEY               DeepSeek API key
  ANTHROPIC_API_KEY              Claude API key
  OPENAI_API_KEY                 OpenAI API key
`);
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const workspaceRoot = process.cwd();

  if (args.command === "help") {
    showHelp();
    return;
  }

  const sessions = new SessionManager(workspaceRoot);
  const mcpLoader = new MCPLoader(workspaceRoot);
  const horsewhipGuard = new HorsewhipGuardImpl(workspaceRoot, mcpLoader);

  // Load MCP servers (including Horsewhip)
  await mcpLoader.loadFromConfig();

  switch (args.command) {
    // ─── Dev mode: trust self, bypass Horsewhip ───
    case "dev": {
      if (!args.task) {
        console.error("Error: --task is required for 'dev'");
        process.exit(1);
      }

      // ── Git safety net: record current HEAD ──
      const { execSync } = await import("node:child_process");
      let headBefore = "";
      try {
        headBefore = execSync("git rev-parse HEAD", {
          cwd: workspaceRoot,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
      } catch (e) {
        logger.warn("Failed to get HEAD hash", { error: String(e) });
      }

      // Unlock everything — we trust ourselves in dev mode
      await horsewhipGuard.unlock();

      console.log("🔧 Dev mode — bypassing Horsewhip, direct code editing\n");

      const session = sessions.create(`[dev] ${args.task}`);
      console.log(`Session: ${session.id}`);
      console.log(`Task: ${args.task}\n`);

      // Disable guard so Agent can write freely
      const devGuard = new HorsewhipGuardImpl(workspaceRoot, mcpLoader);
      devGuard.disabled = true;

      const agent = new Agent(
        workspaceRoot,
        session.id,
        mcpLoader,
        devGuard,
        {
          model: resolveModel(args.model),
          apiKey: resolveApiKey(args.apiKey),
          baseUrl: args.baseUrl,
          paradigm: (args.paradigm as Paradigm | undefined) ?? "ride",
          thinking: args.thinking,
          yunchang: args.auto,
        }
      );

      agent.setTask(args.task);

      try {
        const result = await agent.execute();
        console.log(`\n${result}`);

        session.messages = agent.getMessages();
        sessions.save(session);

        // ── Compile check ──
        console.log("\n🔨 Compile check...");
        try {
          execSync("node scripts/build.mjs", {
            cwd: workspaceRoot,
            stdio: "inherit",
            timeout: 30000,
          });
          console.log("✅ Compile passed\n");
        } catch {
          console.error("❌ Compile failed\n");

          // Git rollback
          if (headBefore) {
            console.log("🔄 Rolling back to pre-edit state: git checkout -- .");
            execSync("git checkout -- .", {
              cwd: workspaceRoot,
              stdio: "inherit",
              timeout: 10000,
            });
            console.log("✅ Rolled back to pre-edit Git HEAD\n");
          } else {
            console.error("❌ No Git HEAD recorded, please restore manually\n");
          }
        }

        console.log(`Session saved: ${session.id}`);
      } catch (e) {
        console.error(`\nError: ${String(e)}`);

        // Git rollback
        if (headBefore) {
          console.log("🔄 Rolling back to pre-edit state: git checkout -- .");
          execSync("git checkout -- .", {
            cwd: workspaceRoot,
            stdio: "inherit",
            timeout: 10000,
          });
          console.log("✅ Rolled back to pre-edit Git HEAD\n");
        }

        session.messages = agent.getMessages();
        sessions.save(session);
        process.exit(1);
      }
      break;
    }

    // ─── Dev command: build only ───
    case "build": {
      console.log("🔨 Compiling Chitu...");
      const { execSync } = await import("node:child_process");
      try {
        execSync("node scripts/build.mjs", {
          cwd: workspaceRoot,
          stdio: "inherit",
          timeout: 30000,
        });
        console.log("✅ Compile passed");
      } catch {
        console.error("❌ Compile failed");
        process.exit(1);
      }
      break;
    }

    case "sync": {
      const { HorsewhipSync } = await import("./sync.js");
      const syncer = new HorsewhipSync(workspaceRoot);
      await syncer.sync();
      break;
    }

    case "update": {
      const { updateChitu } = await import("./update.js");
      await updateChitu();
      break;
    }

    case "uninstall": {
      const { uninstallChitu } = await import("./uninstall.js");
      await uninstallChitu();
      break;
    }

    case "run": {
      if (!args.task) {
        console.error("Error: --task is required for 'run'");
        process.exit(1);
      }

      const session = sessions.create(args.task);
      console.log(`Session: ${session.id}`);
      console.log(`Task: ${args.task}\n`);

      const effectiveGuard = horsewhipGuard;
      const effectiveParadigm: Paradigm = args.constraint ? "constraint" : args.auto ? "ride" : (args.paradigm as Paradigm | undefined) ?? "ride";

      const agent = new Agent(
        workspaceRoot,
        session.id,
        mcpLoader,
        effectiveGuard,
        {
          model: resolveModel(args.model),
          apiKey: resolveApiKey(args.apiKey),
          baseUrl: args.baseUrl,
          paradigm: effectiveParadigm,
          thinking: args.thinking,
          yunchang: args.auto,
        }
      );

      agent.setTask(args.task);

      try {
        const { renderMetricsReport } = await import("./metrics-renderer.js");

        // Ride mode runs the TargetExecutor state machine.
        // Each execute() call advances one phase. Loop until done.
        let result = "";
        const MAX_STEPS = 50;
        for (let step = 0; step < MAX_STEPS; step++) {
          result = await agent.execute(
            (text) => process.stdout.write(text),
            undefined,
            (toolName, _output) => {
              const short = _output.length > 200 ? _output.slice(0, 200) + "..." : _output;
              process.stdout.write(`\n  [${toolName}] ${short.replace(/\n/g, " ")}`);
            },
            (phase, progress) => {
              process.stdout.write(`\r  [${phase}] ${progress}%`);
            }
          );

          // Check for terminal states
          if (result.includes("Target: all sub-goals completed") ||
              result.includes("Target Complete") ||
              result.includes("Target: no goal found") ||
              result.includes("Target Error")) {
            break;
          }

          // Only ride mode loops; constraint has its own internal loop
          if (effectiveParadigm !== "ride") break;

          // Auto-answer clarifying questions in headless mode
          if ((result.includes("?") || result.includes("？")) &&
              !result.includes("SUB_GOAL_DONE") &&
              !result.includes("GOAL_COMPLETE") &&
              !result.includes("```json")) {
            agent.getMessages().push({
              role: "user",
              content: "Please decide based on best practices. Start generating the plan directly without asking further clarification questions.",
            });
            continue;
          }

          // Auto-continue when state machine signals ready for next step
          if (!result.includes("Type anything") &&
              !result.includes("Starting sub-goal") &&
              !result.includes("Starting final review")) {
            break;
          }
        }
        console.log(`\n${result}`);

        // Save session messages
        session.messages = agent.getMessages();
        sessions.save(session);

        // Compute and display metrics
        const metricsEngine = new MetricsEngine(workspaceRoot);
        const report = metricsEngine.compute();
        if (report) {
          sessions.attachMetrics(session.id, report);
          console.log(`\n${renderMetricsReport(report)}`);
        }

        console.log(`\nSession saved: ${session.id}`);
      } catch (e) {
        console.error(`\nError: ${String(e)}`);
        // Save partial session
        session.messages = agent.getMessages();
        sessions.save(session);
        process.exit(1);
      }
      break;
    }

    case "resume": {
      const id = args.sessionId;
      if (!id) {
        console.error("Error: session ID required for 'resume'");
        process.exit(1);
      }

      const session = sessions.load(id);
      if (!session) {
        console.error(`Error: session '${id}' not found`);
        process.exit(1);
      }

      console.log(`Resuming session: ${session.id}`);
      console.log(`Task: ${session.task}\n`);

      const effectiveGuard = horsewhipGuard;
      const effectiveParadigm: Paradigm = args.constraint ? "constraint" : args.auto ? "ride" : (args.paradigm as Paradigm | undefined) ?? "ride";

      const agent = new Agent(
        workspaceRoot,
        session.id,
        mcpLoader,
        effectiveGuard,
        {
          model: resolveModel(args.model),
          apiKey: resolveApiKey(args.apiKey),
          baseUrl: args.baseUrl,
          paradigm: effectiveParadigm,
          thinking: args.thinking,
          yunchang: args.auto,
        }
      );

      agent.restoreMessages(session.messages);

      try {
        // Ride mode loops the TargetExecutor state machine
        let result = "";
        const MAX_STEPS = 50;
        for (let step = 0; step < MAX_STEPS; step++) {
          result = await agent.execute(
            (text) => process.stdout.write(text),
            undefined,
            (toolName, _output) => {
              const short = _output.length > 200 ? _output.slice(0, 200) + "..." : _output;
              process.stdout.write(`\n  [${toolName}] ${short.replace(/\n/g, " ")}`);
            },
            (phase, progress) => {
              process.stdout.write(`\r  [${phase}] ${progress}%`);
            }
          );

          if (result.includes("Target: all sub-goals completed") ||
              result.includes("Target Complete") ||
              result.includes("Target: no goal found") ||
              result.includes("Target Error")) {
            break;
          }

          if (effectiveParadigm !== "ride") break;

          // Auto-answer clarifying questions in headless mode
          if ((result.includes("?") || result.includes("？")) &&
              !result.includes("SUB_GOAL_DONE") &&
              !result.includes("GOAL_COMPLETE") &&
              !result.includes("```json")) {
            agent.getMessages().push({
              role: "user",
              content: "Please decide based on best practices. Start generating the plan directly without asking further clarification questions.",
            });
            continue;
          }

          if (!result.includes("Type anything") &&
              !result.includes("Starting sub-goal") &&
              !result.includes("Starting final review")) {
            break;
          }
        }
        console.log(`\n${result}`);

        session.messages = agent.getMessages();
        sessions.save(session);

        const metricsEngine = new MetricsEngine(workspaceRoot);
        const report = metricsEngine.compute();
        if (report) {
          sessions.attachMetrics(session.id, report);
        }

        console.log(`\nSession saved: ${session.id}`);
      } catch (e) {
        console.error(`\nError: ${String(e)}`);
        session.messages = agent.getMessages();
        sessions.save(session);
        process.exit(1);
      }
      break;
    }

    case "metrics": {
      const metricsEngine = new MetricsEngine(workspaceRoot);
      const report = metricsEngine.compute(args.sessionId);

      if (!report) {
        console.log("No metrics data available. Run a task first.");
        process.exit(1);
      }

      // Metrics rendering hidden
      break;
    }

    case "list": {
      const all = sessions.list();
      if (all.length === 0) {
        console.log("No sessions found.");
      } else {
        for (const s of all) {
          const msgCount = s.messages?.length ?? 0;
          const hasMetrics = s.metrics ? " [metrics]" : "";
          console.log(`  ${s.id}  ${s.createdAt.slice(0, 10)}  ${msgCount}msgs  "${s.task.slice(0, 50)}"${hasMetrics}`);
        }
      }
      break;
    }

    case "config": {
      // chitu config              → show all
      // chitu config set k v      → set key=value
      // chitu config unset k      → remove key
      const sub = argv.slice(argv.indexOf("config") + 1);
      const subCmd = sub[0];

      if (!subCmd) {
        const cfg = loadGlobalConfig();
        if (Object.keys(cfg).length === 0) {
          console.log("No global config set. (~/.chitu/config.json is empty)");
          console.log("");
          console.log("Quick setup (DeepSeek by default):");
          console.log("  chitu config set apiKey <key>      # Required: your DeepSeek API key");
          console.log("  chitu config set provider claude   # Optional: switch to claude or openai");
          console.log("  chitu config set model <model>     # Optional: e.g. deepseek-v4-pro");
        } else {
          console.log("Global config (~/.chitu/config.json):");
          for (const [k, v] of Object.entries(cfg)) {
            const display = k === "apiKey" ? (v as string).slice(0, 8) + "..." : v;
            console.log(`  ${k} = ${display}`);
          }
        }
        break;
      }

      if (subCmd === "set" && sub[1]) {
        const updates: Record<string, string> = {};
        updates[sub[1]] = sub[2] ?? "";
        saveGlobalConfig(updates);

        // Auto-detect provider from API key prefix
        if (sub[1] === "apiKey" && sub[2]) {
          const key = sub[2];
          const cfg = loadGlobalConfig();
          if (!cfg.provider) {
            if (key.startsWith("sk-ant")) {
              saveGlobalConfig({ provider: "claude" });
              console.log("Detected Claude API key. Set provider to 'claude'.");
            }
          }
        }

        console.log(`Set ${sub[1]} in ~/.chitu/config.json`);
        break;
      }

      if (subCmd === "unset" && sub[1]) {
        const cfg = loadGlobalConfig();
        delete (cfg as Record<string, unknown>)[sub[1]];
        writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
        console.log(`Removed ${sub[1]} from ~/.chitu/config.json`);
        break;
      }

      console.log("Usage: chitu config [set <key> <val> | unset <key>]");
      break;
    }
  }

  await mcpLoader.stopAll();
}

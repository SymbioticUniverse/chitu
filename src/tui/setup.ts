/**
 * First-run setup wizard — collects provider, apiKey, model, baseUrl.
 * Uses raw terminal I/O (same as TUI) for a clean prompt experience.
 */
import * as readline from "node:readline";
import { loadGlobalConfig, saveGlobalConfig } from "../global-config.js";
import { ansi, write, color, getTermSize } from "./screen.js";
import { renderHorseSmall } from "./horse.js";
import { getChituVersion } from "../version.js";

export interface SetupResult {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
}

interface ProviderOption {
  name: string;
  label: string;
  defaultModel: string;
  defaultBaseUrl: string;
}

const PROVIDERS: ProviderOption[] = [
  { name: "deepseek", label: "DeepSeek (recommended)", defaultModel: "deepseek-v4-pro", defaultBaseUrl: "" },
  { name: "claude",   label: "Claude (Anthropic)",     defaultModel: "claude-sonnet-4-6",    defaultBaseUrl: "" },
  { name: "openai",   label: "OpenAI",                  defaultModel: "gpt-4o",                 defaultBaseUrl: "" },
  { name: "custom",   label: "Custom (self-hosted / proxy)", defaultModel: "", defaultBaseUrl: "" },
];

export async function runSetup(): Promise<SetupResult> {
  const existing = loadGlobalConfig();

  write(ansi.clear + ansi.moveTo(0, 0));

  // Simple horse banner
  const horse = renderHorseSmall().split("\n");
  const { cols } = getTermSize();
  for (const line of horse) write(line + "\n");
  write(color.dim(`  ${getChituVersion()} — first-run setup`) + "\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  // Step 1: Select provider
  write("\n");
  write(color.bold("  Select AI Provider:\n\n"));
  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[i]!;
    const marker = i === 0 ? "  [*]" : `  [${i + 1}]`;
    write(`  ${marker} ${p.label}\n`);
  }
  write("\n");

  const providerAnswer = await ask(`  Choice [1-${PROVIDERS.length}, default 1]: `);
  const providerIdx = parseInt(providerAnswer, 10) - 1;
  const provider = PROVIDERS[providerIdx >= 0 && providerIdx < PROVIDERS.length ? providerIdx : 0]!;

  // Step 2: API key
  write("\n");
  write(color.bold("  API Key:\n\n"));
  write(`    Enter your ${provider.label} API key.\n`);
  const apiKey = await ask("  API Key: ");

  if (!apiKey.trim()) {
    write(color.red("\n  API key is required. Exiting.\n\n"));
    rl.close();
    process.exit(1);
  }

  // Step 3: Model
  write("\n");
  write(color.bold(`  Model name [${provider.defaultModel}]:\n\n`));
  write(`    Press Enter to use the default.\n`);
  const modelAnswer = await ask(`  Model: `);
  const model = modelAnswer.trim() || provider.defaultModel;

  // Step 4: Base URL (only for custom or if user wants to override)
  let baseUrl = provider.defaultBaseUrl;
  if (provider.name === "custom") {
    write("\n");
    write(color.bold("  API Base URL:\n\n"));
    write("    e.g. http://localhost:11434/v1\n");
    const baseUrlAnswer = await ask("  Base URL: ");
    baseUrl = baseUrlAnswer.trim();
  } else {
    write("\n");
    write(color.dim(`  Base URL [default]: `));
    write("(press Enter to use default)\n");
    const baseUrlAnswer = await ask("  Base URL (optional): ");
    if (baseUrlAnswer.trim()) baseUrl = baseUrlAnswer.trim();
  }

  // Save
  write("\n");
  write(color.dim("  Saving..."));
  saveGlobalConfig({
    apiKey: apiKey.trim(),
    model: model || undefined,
    provider: provider.name,
    baseUrl: baseUrl || undefined,
  });
  write(color.green(" Done.\n\n"));

  rl.close();

  return {
    provider: provider.name,
    apiKey: apiKey.trim(),
    model,
    baseUrl,
  };
}

/** Check if this is the first run (no apiKey configured, no env var set). */
export function isFirstRun(): boolean {
  if (process.env["DEEPSEEK_API_KEY"] || process.env["ANTHROPIC_API_KEY"] || process.env["OPENAI_API_KEY"]) {
    return false;
  }
  return !loadGlobalConfig().apiKey;
}

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as readline from "node:readline";

interface GlobalConfig {
  apiKey?: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
}

const GLOBAL_CONFIG_DIR = join(homedir(), ".chitu");
export const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "config.json");

export function loadGlobalConfig(): GlobalConfig {
  try {
    if (!existsSync(GLOBAL_CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")) as GlobalConfig;
  } catch {
    return {};
  }
}

export function saveGlobalConfig(updates: Partial<GlobalConfig>): void {
  const current = loadGlobalConfig();
  const merged = { ...current, ...updates };
  if (!existsSync(GLOBAL_CONFIG_DIR)) {
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  }
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

/** Resolve provider: CLI arg > global config > env vars > default (deepseek). */
export function resolveProvider(cliProvider?: string): string {
  if (cliProvider) return cliProvider;
  const cfg = loadGlobalConfig();
  if (cfg.provider) return cfg.provider;
  if (process.env["ANTHROPIC_API_KEY"]) return "claude";
  if (process.env["OPENAI_API_KEY"]) return "openai";
  if (process.env["DEEPSEEK_API_KEY"]) return "deepseek";
  return "deepseek";
}

/** Resolve API key: CLI arg > env var > global config. */
export function resolveApiKey(cliKey?: string): string | undefined {
  if (cliKey) return cliKey;
  if (process.env["DEEPSEEK_API_KEY"]) return process.env["DEEPSEEK_API_KEY"];
  if (process.env["ANTHROPIC_API_KEY"]) return process.env["ANTHROPIC_API_KEY"];
  if (process.env["OPENAI_API_KEY"]) return process.env["OPENAI_API_KEY"];
  return loadGlobalConfig().apiKey;
}

/** Resolve base URL: CLI arg > global config > provider default. */
export function resolveBaseUrl(cliBaseUrl?: string): string | undefined {
  return cliBaseUrl ?? loadGlobalConfig().baseUrl;
}

/** Resolve model: CLI arg > global config. */
export function resolveModel(cliModel?: string): string | undefined {
  return cliModel ?? loadGlobalConfig().model;
}

/** Check if API key is configured, if not, prompt user to enter one. */
export async function ensureApiKey(cliKey?: string): Promise<string> {
  const existing = resolveApiKey(cliKey);
  if (existing) return existing;

  console.log("🔑 未检测到 API Key。\n");
  console.log("   获取方式：");
  console.log("   - DeepSeek: https://platform.deepseek.com/api_keys");
  console.log("   - Anthropic: https://console.anthropic.com/settings/keys\n");

  const key = await new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("   请输入 API Key: ", (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });

  if (!key) {
    console.log("\n❌ 未输入 API Key，无法启动。");
    console.log("   之后可通过 chitu config set apiKey <key> 配置。");
    process.exit(1);
  }

  saveGlobalConfig({ apiKey: key });
  console.log("✅ 已保存到 ~/.chitu/config.json\n");
  return key;
}

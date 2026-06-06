import type { AIProvider, ProviderConfig, ProviderName } from "./types.js";
import { detectProvider } from "./types.js";
import { DeepSeekProvider } from "./deepseek.js";
import { OpenAIProvider } from "./openai.js";
import { ClaudeProvider } from "./claude.js";

const PROVIDER_MAP: Record<
  Exclude<ProviderName, "auto">,
  new (config?: ProviderConfig) => AIProvider
> = {
  deepseek: DeepSeekProvider,
  openai: OpenAIProvider,
  claude: ClaudeProvider,
};

export function createProvider(
  name: ProviderName = "auto",
  config: ProviderConfig = {}
): AIProvider {
  const resolved = name === "auto" ? detectProvider() : name;

  const Ctor = PROVIDER_MAP[resolved as keyof typeof PROVIDER_MAP];
  if (!Ctor) {
    throw new Error(
      `Unknown provider '${resolved}'. Available: ${Object.keys(PROVIDER_MAP).join(", ")}`
    );
  }

  return new Ctor(config);
}

export function listProviders(): string[] {
  return Object.keys(PROVIDER_MAP);
}

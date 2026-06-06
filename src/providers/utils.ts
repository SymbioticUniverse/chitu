// Shared provider utilities.

/** OpenAI-compatible usage response (used by DeepSeek, OpenAI, etc.). */
export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

/** Safely extract cached_tokens from an OpenAI-compatible usage object. */
export function extractCachedTokens(usage: OpenAIUsage): number {
  return usage.prompt_tokens_details?.cached_tokens ?? 0;
}

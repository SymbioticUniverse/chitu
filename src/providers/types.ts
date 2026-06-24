import type {
  ChatRequest,
  ChatResponse,
  DeltaToolCall,
  ToolCall,
} from "../types.js";

// Stream event — unified type across all providers
export type StreamEvent =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_delta"; toolDelta: DeltaToolCall }
  | { type: "finish"; reason: string }
  | { type: "done" }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number };

// Provider can be identified by name, env var, or URL pattern
export type ProviderName = "deepseek" | "claude" | "openai" | "auto";

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  /** Enable deep thinking / reasoning mode (DeepSeek, OpenAI) */
  thinking?: boolean;
  /** Reasoning effort level: low / medium / high / max */
  reasoningEffort?: "low" | "medium" | "high" | "max";
}

export interface AIProvider {
  readonly name: string;
  readonly defaultModels: string[];

  /** Non-streaming chat completion */
  chat(req: ChatRequest): Promise<ChatResponse>;

  /** Streaming — yields deltas as they arrive. Pass signal to abort mid-stream. */
  stream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;

  /** Dynamically enable/disable thinking mode mid-session. */
  setThinking(enabled: boolean): void;

  /** Stream and accumulate into a full message (content + tool calls).
   *  onToken receives streaming text for live display.
   *  onReasoning receives thinking/CoT content (displayed dimmed in TUI).
   *  signal aborts mid-stream; partial content is returned with aborted: true. */
  streamToMessage(
    req: ChatRequest,
    onToken?: (text: string) => void,
    signal?: AbortSignal,
    onReasoning?: (text: string) => void,
  ): Promise<{ content: string; reasoning: string; toolCalls: ToolCall[]; aborted: boolean; finishReason?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number } }>;
}

/** Check if an error is caused by an aborted request (browser + Node.js).
 *  Node.js may throw TypeError: terminated when reading a cancelled stream. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    // Node.js ReadableStream throws TypeError "terminated" on cancel
    if (err.name === "TypeError" && /terminated|abort/i.test(err.message)) return true;
  }
  return false;
}

/** Guess provider from API key / base URL env vars */
export function detectProvider(): ProviderName {
  if (process.env["ANTHROPIC_API_KEY"]) return "claude";
  if (process.env["OPENAI_API_KEY"]) return "openai";
  if (process.env["DEEPSEEK_API_KEY"]) return "deepseek";
  return "deepseek";
}

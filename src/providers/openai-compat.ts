import type {
  ChatRequest,
  ChatResponse,
  DeltaToolCall,
  Message,
  ToolCall,
  ToolDef,
} from "../types.js";
import { logger } from "../logger.js";
import type { StreamEvent } from "./types.js";
import { isAbortError } from "./types.js";
import type { AIProvider, ProviderConfig } from "./types.js";
import { extractCachedTokens } from "./utils.js";

interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** Base class for OpenAI-compatible providers (DeepSeek, OpenAI, etc.) */
export abstract class OpenAICompatProvider implements AIProvider {
  abstract readonly name: string;
  abstract readonly defaultBaseUrl: string;
  abstract readonly defaultModels: string[];
  abstract readonly envApiKey: string;

  protected config: ProviderConfig;

  constructor(config: ProviderConfig = {}) {
    this.config = config;
  }

  /** Convert internal ToolDef to OpenAI { type:"function", function:{...} } format */
  private toOpenAITools(tools?: ToolDef[]): OpenAIToolDef[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /** Ensure every assistant+tc is immediately followed by tool messages. */
  private sanitizeMessages(msgs: Message[]): Message[] {
    const out: Message[] = [];
    let i = 0;

    while (i < msgs.length) {
      const m = msgs[i]!;

      if (m.role === "assistant" && m.tool_calls?.length) {
        const needed = new Set(m.tool_calls.map((tc) => tc.id));
        const toolMsgs: Message[] = [];
        let j = i + 1;

        while (j < msgs.length && msgs[j]?.role === "tool") {
          const tid = msgs[j]?.tool_call_id;
          if (tid && needed.has(tid)) {
            needed.delete(tid);
            toolMsgs.push(msgs[j]!);
          }
          j++;
        }

        if (needed.size === 0 && toolMsgs.length > 0) {
          out.push(m);
          out.push(...toolMsgs);
          i += 1 + toolMsgs.length;
        } else if (m.content) {
          // Tool calls stripped but text content remains — keep as plain assistant
          out.push({ role: "assistant" as const, content: m.content });
          i++;
        } else {
          // No content and no valid tool calls — skip entirely
          i++;
        }
      } else if (m.role === "tool") {
        i++; // skip orphan
      } else {
        out.push(m);
        i++;
      }
    }

    while (out.length > 0) {
      const last = out[out.length - 1]!;
      if (last.role === "assistant" && last.tool_calls?.length) {
        out.pop();
      } else {
        break;
      }
    }

    return out;
  }

  protected get apiKey(): string {
    return this.config.apiKey ?? process.env[this.envApiKey] ?? "";
  }

  protected get baseUrl(): string {
    return this.config.baseUrl ?? this.defaultBaseUrl;
  }

  protected get model(): string {
    return this.config.model ?? this.defaultModels[0]!;
  }

  setThinking(enabled: boolean): void {
    this.config.thinking = enabled;
  }

  /** Whether thinking mode is active (default: off — short tasks don't need it). */
  private get thinkingEnabled(): boolean {
    return this.config.thinking === true;
  }

  /** Build extra request body fields for thinking / reasoning. */
  private buildThinkingBody(): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    if (this.thinkingEnabled) {
      extra["thinking"] = { type: "enabled" };
    }
    if (this.config.reasoningEffort) {
      extra["reasoning_effort"] = this.config.reasoningEffort;
    }
    return extra;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages = this.sanitizeMessages(req.messages);
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        messages,
        model: req.model || this.model,
        tools: this.toOpenAITools(req.tools),
        max_tokens: req.max_tokens,
        ...(this.thinkingEnabled ? {} : { temperature: req.temperature }),
        stream: false,
        ...this.buildThinkingBody(),
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`${this.name} API error ${resp.status}: ${body}`);
    }

    return resp.json() as Promise<ChatResponse>;
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const messages = this.sanitizeMessages(req.messages);
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        messages,
        model: req.model || this.model,
        tools: this.toOpenAITools(req.tools),
        max_tokens: req.max_tokens,
        ...(this.thinkingEnabled ? {} : { temperature: req.temperature }),
        stream: true,
        stream_options: { include_usage: true },
        ...this.buildThinkingBody(),
      }),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`${this.name} API error ${resp.status}: ${body}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    const STREAM_IDLE_TIMEOUT_MS = 600_000; // 10 min — DeepSeek can pause several minutes mid-response during deep reasoning
    let lastDataAt = Date.now();

    const readWithTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const elapsed = Date.now() - lastDataAt;
        if (elapsed >= STREAM_IDLE_TIMEOUT_MS) {
          return { done: true, value: undefined };
        }
        const remaining = STREAM_IDLE_TIMEOUT_MS - elapsed;
        // Poll every second — simpler than AbortController per read
        const result = await Promise.race([
          reader.read(),
          new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), Math.min(remaining, 1000))),
        ]);
        if ("timedOut" in result && result.timedOut) continue; // re-check elapsed
        return result as ReadableStreamReadResult<Uint8Array>;
      }
    };

    try {
      while (true) {
        const { done, value } = await readWithTimeout();
        if (done) break;
        lastDataAt = Date.now();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            yield { type: "done" };
            return;
          }

          try {
            const parsed = JSON.parse(data) as ChatResponse;
            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (delta?.reasoning_content) {
              yield { type: "reasoning", content: delta.reasoning_content };
            }
            if (delta?.content) {
              yield { type: "text", content: delta.content };
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                yield { type: "tool_delta", toolDelta: tc };
              }
            }
            if (choice.finish_reason) {
              yield { type: "finish", reason: choice.finish_reason };
              // Terminal: model is done generating. Don't wait for [DONE] which may never arrive.
              if (choice.finish_reason === "stop" || choice.finish_reason === "tool_calls" || choice.finish_reason === "length" || choice.finish_reason === "content_filter") {
                return;
              }
            }

            if (parsed.usage) {
              const cached = extractCachedTokens(parsed.usage);
              yield {
                type: "usage",
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens,
                totalTokens: parsed.usage.total_tokens,
                cachedTokens: cached,
              };
            }
          } catch (e) {
            logger.warn("Malformed SSE line", { error: String(e) });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async streamToMessage(
    req: ChatRequest,
    onToken?: (text: string) => void,
    signal?: AbortSignal,
    onReasoning?: (text: string) => void,
  ): Promise<{ content: string; reasoning: string; toolCalls: ToolCall[]; aborted: boolean; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number } }> {
    let content = "";
    let reasoning = "";
    let aborted = false;
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number } | undefined;
    const toolCalls: Map<
      number,
      { id: string; name: string; args: string }
    > = new Map();

    try {
      for await (const event of this.stream(req, signal)) {
        switch (event.type) {
          case "reasoning":
            reasoning += event.content;
            onReasoning?.(event.content);
            break;
          case "text":
            content += event.content;
            onToken?.(event.content);
            break;
          case "tool_delta": {
            const d = event.toolDelta;
            const existing = toolCalls.get(d.index) ?? { id: "", name: "", args: "" };
            if (d.id) existing.id = d.id;
            if (d.function?.name) existing.name += d.function.name;
            if (d.function?.arguments) existing.args += d.function.arguments;
            toolCalls.set(d.index, existing);
            break;
          }
          case "usage":
            usage = { promptTokens: event.promptTokens, completionTokens: event.completionTokens, totalTokens: event.totalTokens, cachedTokens: event.cachedTokens };
            break;
          case "done":
          case "finish":
            break;
        }
      }
    } catch (err: unknown) {
      if (isAbortError(err) || signal?.aborted) {
        aborted = true;
      } else {
        throw err;
      }
    }

    return {
      content,
      reasoning,
      aborted,
      usage,
      toolCalls: [...toolCalls.values()]
        .filter((tc) => tc.id)
        .map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args },
        })),
    };
  }
}

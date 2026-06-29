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

const MAX_FETCH_RETRIES = 2;
const FETCH_RETRY_DELAY_MS = 2000;

/** Retry fetch on transient network errors (ECONNRESET, ETIMEDOUT, fetch failed, etc.) */
async function fetchWithRetry(url: string, init: RequestInit, retries = MAX_FETCH_RETRIES): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err: unknown) {
      if (attempt >= retries) throw err;
      if (isAbortError(err)) throw err;
      const msg = String(err);
      const isTransient = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ENETUNREACH|ECONNREFUSED|socket hang up/i.test(msg);
      if (!isTransient) throw err;
      logger.warn(`Fetch attempt ${attempt + 1} failed, retrying in ${FETCH_RETRY_DELAY_MS}ms...`, { error: msg });
      await new Promise((r) => setTimeout(r, FETCH_RETRY_DELAY_MS));
    }
  }
  throw new Error("unreachable");
}

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
    const resp = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
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
    const resp = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
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

    // Idle watchdog: cancel reader if no data for too long.
    // Uses setInterval instead of racing reader.read() to avoid
    // concurrent reads on the same reader, which corrupt its state
    // and cause reader.releaseLock() to hang at stream end.
    const idleWatchdog = setInterval(() => {
      if (Date.now() - lastDataAt >= STREAM_IDLE_TIMEOUT_MS) {
        reader.cancel().catch(() => {});
      }
    }, 30_000);

    try {
      while (true) {
        if (signal?.aborted) {
          reader.cancel().catch(() => {});
          return;
        }
        const { done, value } = await reader.read();
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
      clearInterval(idleWatchdog);
      reader.releaseLock();
    }
  }

  async streamToMessage(
    req: ChatRequest,
    onToken?: (text: string) => void,
    signal?: AbortSignal,
    onReasoning?: (text: string) => void,
  ): Promise<{ content: string; reasoning: string; toolCalls: ToolCall[]; aborted: boolean; finishReason?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number } }> {
    let content = "";
    let reasoning = "";
    let aborted = false;
    let finishReason: string | undefined;
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number } | undefined;
    const toolCalls: Map<
      number,
      { id: string; name: string; args: string }
    > = new Map();

    // Hard wall-clock timeout — cannot be defeated by intermittent data flow.
    // DeepSeek may send reasoning chunks every few minutes that reset the idle
    // timer in readWithTimeout but never complete.
    const HARD_TIMEOUT_MS = 480_000; // 8 min absolute max per stream
    const PROGRESS_TIMEOUT_MS = 300_000; // 5 min without meaningful output
    const hardCtrl = new AbortController();
    const hardTimer = setTimeout(() => hardCtrl.abort(), HARD_TIMEOUT_MS);
    let lastMeaningful = Date.now();
    const progressTimer = setInterval(() => {
      if (Date.now() - lastMeaningful >= PROGRESS_TIMEOUT_MS) hardCtrl.abort();
    }, 30_000); // check every 30s
    const effectiveSignal = signal
      ? AbortSignal.any([signal, hardCtrl.signal])
      : hardCtrl.signal;

    try {
      for await (const event of this.stream(req, effectiveSignal)) {
        switch (event.type) {
          case "reasoning":
            reasoning += event.content;
            onReasoning?.(event.content);
            break;
          case "text":
            content += event.content;
            onToken?.(event.content);
            lastMeaningful = Date.now();
            break;
          case "tool_delta": {
            lastMeaningful = Date.now();
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
            lastMeaningful = Date.now();
            if (event.type === "finish") finishReason = (event as any).reason;
            break;
        }
      }
    } catch (err: unknown) {
      if (isAbortError(err) || signal?.aborted || hardCtrl.signal.aborted) {
        aborted = true;
      } else {
        throw err;
      }
    } finally {
      clearTimeout(hardTimer);
      clearInterval(progressTimer);
    }

    return {
      content,
      reasoning,
      aborted,
      finishReason,
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

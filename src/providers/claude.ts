import type {
  ChatRequest,
  ChatResponse,
  Choice,
  DeltaToolCall,
  Message,
  ToolCall,
  ToolDef,
} from "../types.js";
import { logger } from "../logger.js";
import { getContentText } from "../types.js";
import type { StreamEvent } from "./types.js";
import { isAbortError } from "./types.js";
import type { AIProvider, ProviderConfig } from "./types.js";

// Anthropic-native message and tool formats
interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream?: boolean;
}

// Anthropic SSE event types
type AnthropicEvent =
  | { type: "message_start"; message: { id: string; model: string; usage: unknown } }
  | { type: "content_block_start"; index: number; content_block: AnthropicContentBlock }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string; stop_sequence: string | null }; usage: { output_tokens: number } }
  | { type: "message_stop" }
  | { type: "ping" };

export class ClaudeProvider implements AIProvider {
  readonly name = "claude";
  readonly defaultModels = ["claude-sonnet-4-6", "claude-haiku-4-5"];
  private config: ProviderConfig;

  constructor(config: ProviderConfig = {}) {
    this.config = config;
  }

  setThinking(enabled: boolean): void {
    this.config.thinking = enabled;
  }

  private get apiKey(): string {
    return this.config.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
  }

  private get baseUrl(): string {
    return this.config.baseUrl ?? "https://api.anthropic.com/v1";
  }

  private get model(): string {
    return this.config.model ?? this.defaultModels[0]!;
  }

  private get maxTokens(): number {
    return this.config.maxTokens ?? 4096;
  }

  // Convert Chitu messages to Anthropic format
  private toAnthropicMessages(messages: Message[]): {
    system?: string;
    messages: AnthropicMessage[];
  } {
    let system: string | undefined;
    const anthropicMsgs: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        system = getContentText(msg.content) || undefined;
        continue;
      }

      if (msg.role === "assistant") {
        const blocks: AnthropicContentBlock[] = [];
        const text = getContentText(msg.content);
        if (text) {
          blocks.push({ type: "text", text });
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(tc.function.arguments);
            } catch { /* keep empty */ }
            blocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input,
            });
          }
        }
        anthropicMsgs.push({
          role: "assistant",
          content: blocks.length === 1 && blocks[0]?.type === "text"
            ? (blocks[0].text ?? "")
            : blocks,
        });
      } else if (msg.role === "tool") {
        // Tool results: create user message with tool_result blocks
        const toolResultBlock: AnthropicContentBlock = {
          type: "tool_result",
          tool_use_id: msg.tool_call_id ?? "",
          content: getContentText(msg.content),
        };
        // Merge with previous user message if adjacent
        const prev = anthropicMsgs[anthropicMsgs.length - 1];
        if (prev?.role === "user" && Array.isArray(prev.content)) {
          prev.content.push(toolResultBlock);
        } else {
          anthropicMsgs.push({
            role: "user",
            content: [toolResultBlock],
          });
        }
      } else {
        // user message — may contain image_url content blocks
        const content = msg.content ?? "";
        anthropicMsgs.push({
          role: "user",
          content: typeof content === "string" ? content : content as unknown as AnthropicContentBlock[],
        });
      }
    }

    return { system, messages: anthropicMsgs };
  }

  // Convert Chitu tools to Anthropic format
  private toAnthropicTools(tools: ToolDef[]): AnthropicTool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  // Build the full Anthropic request body
  private buildBody(req: ChatRequest): AnthropicRequest {
    const { system, messages } = this.toAnthropicMessages(req.messages);

    const body: AnthropicRequest = {
      model: req.model || this.model,
      max_tokens: req.max_tokens ?? this.maxTokens,
      messages,
      stream: req.stream ?? false,
    };

    if (system) body.system = system;
    if (req.tools && req.tools.length > 0) {
      body.tools = this.toAnthropicTools(req.tools);
    }

    return body;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = this.buildBody({ ...req, stream: false });

    const resp = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Claude API error ${resp.status}: ${text}`);
    }

    const raw = await resp.json() as Record<string, unknown>;
    return this.toChatResponse(raw);
  }

  // Parse Anthropic response into Chitu's ChatResponse format
  private toChatResponse(raw: Record<string, unknown>): ChatResponse {
    const content = raw["content"] as AnthropicContentBlock[] | undefined;
    const stopReason = (raw["stop_reason"] as string) ?? "stop";

    let text = "";
    const toolCalls: ToolCall[] = [];

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          text += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id ?? `toolu_${toolCalls.length}`,
            type: "function",
            function: {
              name: block.name ?? "",
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
    }

    return {
      id: (raw["id"] as string) ?? "",
      object: "chat.completion",
      created: Date.now(),
      model: (raw["model"] as string) ?? this.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finish_reason: this.mapStopReason(stopReason),
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
      },
    };
  }

  private mapStopReason(
    reason: string
  ): Choice["finish_reason"] {
    switch (reason) {
      case "tool_use":
        return "tool_calls";
      case "max_tokens":
        return "length";
      default:
        return "stop";
    }
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const body = this.buildBody({ ...req, stream: true });

    const resp = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Claude API error ${resp.status}: ${text}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    // Track tool use accumulation across deltas
    const toolState: Map<
      number,
      { id: string; name: string; partialJson: string }
    > = new Map();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          try {
            const event = JSON.parse(data) as AnthropicEvent;

            switch (event.type) {
              case "content_block_start": {
                if (event.content_block.type === "text") {
                  // text block starting — might send empty text delta next
                } else if (event.content_block.type === "tool_use") {
                  toolState.set(event.index, {
                    id: event.content_block.id ?? "",
                    name: event.content_block.name ?? "",
                    partialJson: "",
                  });
                  // Emit as tool delta so the accumulator picks it up
                  const tc: DeltaToolCall = {
                    index: event.index,
                    id: event.content_block.id,
                    type: "function",
                    function: {
                      name: event.content_block.name,
                      arguments: "",
                    },
                  };
                  yield { type: "tool_delta", toolDelta: tc };
                }
                break;
              }

              case "content_block_delta": {
                if (event.delta.type === "text_delta") {
                  yield { type: "text", content: event.delta.text };
                } else if (event.delta.type === "input_json_delta") {
                  const st = toolState.get(event.index);
                  if (st) {
                    st.partialJson += event.delta.partial_json;
                  }
                  const tc: DeltaToolCall = {
                    index: event.index,
                    function: { arguments: event.delta.partial_json },
                  };
                  yield { type: "tool_delta", toolDelta: tc };
                }
                break;
              }

              case "content_block_stop":
                break;

              case "message_delta": {
                yield {
                  type: "finish",
                  reason: this.mapStopReason(event.delta.stop_reason) ?? "stop",
                };
                break;
              }

              case "message_stop":
                yield { type: "done" };
                break;

              case "message_start":
              case "ping":
                break;
            }
          } catch (e) {
            logger.warn("Malformed SSE event", { error: String(e) });
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
    let reasoningOut = false;
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
      if (isAbortError(err)) {
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
        .filter((tc) => tc.id || tc.name)
        .map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args },
        })),
    };
  }
}

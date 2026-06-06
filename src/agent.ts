import { createProvider } from "./providers/factory.js";
import type { AIProvider, ProviderName } from "./providers/types.js";
import { getAllToolDefs, getAllToolHandlers } from "./tools/index.js";
import { RateLimiter } from "./ratelimit.js";
import { HorsewhipGuardImpl } from "./horsewhip/guard.js";
import { loadSystemPrompt } from "./system-prompt.js";
import { SoulManager } from "./soul.js";
import { Auditor } from "./auditor.js";
import { getParadigmPrompt } from "./paradigm.js";
import { getScoreContext } from "./score.js";
import { TargetExecutor } from "./target/executor.js";
import { ConstraintExecutor } from "./constraint/executor.js";
import { readFileSync, readdirSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { detectTaskIntent, getContentText } from "./types.js";
import type {
  Message,
  ToolCall,
  ToolResult,
  ToolContext,
  ToolHandler,
  HorsewhipGuard,
  TaskIntent,
  Paradigm,
  ParadigmState,
  BoundaryGates,
} from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MCPLoader } from "./mcp/loader.js";
import { logger } from "./logger.js";

const SYSTEM_PROMPT = `You are Chitu (赤兔), a terminal-based AI agent. You help users with software engineering tasks.

## Your capabilities
- Read, write, edit, and delete files (guarded by Horsewhip boundary lock)
- Execute shell commands
- Search the web and fetch URLs
- Manage tasks and track progress
- Remember information across sessions
- Load MCP servers and skills

## Working principles
- Be concise and direct in your responses
- Use tools proactively to complete tasks
- When a task is done, summarize what was accomplished
- If you encounter a boundary block (Horsewhip), explain what needs to be unlocked
- Prefer creating new files over modifying existing ones

## Output format
When you complete a task, end with a brief summary. Don't narrate your internal process — just state results.`;

const MAX_CONTEXT_TOKENS = 80000;
const COMPRESS_THRESHOLD = 0.8; // 80%
const MAX_PHASED_ROUNDS = 5;
const PATH_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_./\\-]*$/;

/** CJK-aware token estimation. CJK chars ≈1.5 tokens, ASCII ≈0.25 tokens. */
function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4E00 && code <= 0x9FFF) {
      tokens += 1.5; // CJK Unified Ideographs
    } else if (code >= 0x3400 && code <= 0x4DBF) {
      tokens += 1.5; // CJK Extension A
    } else if (code >= 0x20000 && code <= 0x2A6DF) {
      tokens += 1.5; // CJK Extension B (surrogate pairs, but rare)
    } else if (code >= 0x3000 && code <= 0x303F) {
      tokens += 1; // CJK punctuation
    } else if (code >= 0xFF00 && code <= 0xFFEF) {
      tokens += 1; // Fullwidth forms
    } else if (code >= 0x80) {
      tokens += 1; // Other non-ASCII (emoji, etc.)
    } else if (code === 0x20) {
      tokens += 0; // spaces are free in most tokenizers
    } else {
      tokens += 0.25; // ASCII
    }
  }
  return Math.ceil(tokens);
}

/** Build user message content — text only, or text + images if image paths given. */
export function buildUserContent(
  text: string,
  imagePaths?: string[],
): string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
  if (!imagePaths || imagePaths.length === 0) return text;

  const blocks: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
  if (text) blocks.push({ type: "text", text });

  for (const p of imagePaths) {
    try {
      const buf = readFileSync(p);
      const ext = (p.split(".").pop() ?? "png").toLowerCase();
      const mime = ext === "jpg" ? "jpeg" : ext;
      blocks.push({ type: "image_url", image_url: { url: `data:image/${mime};base64,${buf.toString("base64")}` } });
    } catch { /* skip */ }
  }

  return blocks;
}

export interface AgentConfig {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxIterations?: number;
  provider?: ProviderName;
  thinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high" | "max";
  paradigm?: Paradigm;
  yunchang?: boolean;
}
const PROGRESS_NOTE = [
  "## Progress Reporting",
  "Call `report_progress` when you enter a new working phase to keep the user informed.",
  "The `message` parameter describes your current phase, e.g.:",
  '  report_progress({ message: "Clarify：澄清需求 — 第1轮" })',
  '  report_progress({ message: "Grow：生成记账页面" })',
  '  report_progress({ message: "Trim：修正耦合指标" })',
  "Use concise Chinese. The message will be shown directly to the user as a progress indicator.",
].join("\n");


export class Agent {
  private provider: AIProvider;
  private model: string;
  private maxIterations: number;
  private messages: Message[] = [];
  private toolHandlers: Record<string, ToolHandler> = {};
  private mcpLoader: MCPLoader | null = null;
  private horsewhipGuard: HorsewhipGuard | null = null;
  private guard: HorsewhipGuardImpl | null = null;
  private ctx: ToolContext;
  private rateLimiter: RateLimiter;
  private abortController: AbortController | null = null;
  private sessionId: string;
  private workspaceRoot: string;
  private taskId: string = "";
  private taskIntent: TaskIntent = "new_feature";
  private auditor: Auditor;
  private lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number } | null = null;
  private onCompress: ((phase: string, progress: number) => void) | null = null;
  private soulRoundCounter = 0;
  private baselineTokens = 0; // system prompt + tool defs — fixed cost, excluded from display
  private explicitThinking: boolean | undefined; // user override — skip auto-determination when set
  private paradigm: Paradigm = "ride";
  private paradigmState: ParadigmState = { active: "ride", resolved: "ride" };
  private yunchang = false;
  constraintExecutor: ConstraintExecutor | null = null;

  constructor(
    workspaceRoot: string,
    sessionId: string,
    mcpLoader: MCPLoader,
    horsewhipGuard: HorsewhipGuard,
    config: AgentConfig = {}
  ) {
    this.workspaceRoot = workspaceRoot;
    this.sessionId = sessionId;
    this.auditor = new Auditor(workspaceRoot, this.taskId);
    this.provider = createProvider(config.provider ?? "auto", {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    });
    this.model = config.model ?? this.provider.defaultModels[0] ?? "deepseek-chat";
    this.maxIterations = config.maxIterations ?? 50;
    this.explicitThinking = config.thinking;
    this.paradigm = config.paradigm ?? "appraise";
    this.paradigmState = { active: this.paradigm, resolved: this.paradigm };
    this.yunchang = config.yunchang ?? false;
    this.mcpLoader = mcpLoader;
    this.horsewhipGuard = horsewhipGuard;
    this.rateLimiter = new RateLimiter();

    if (horsewhipGuard instanceof HorsewhipGuardImpl) {
      this.guard = horsewhipGuard;
    }

    this.ctx = {
      workspaceRoot,
      sessionId,
      horsewhipGuard,
    };

    this.toolHandlers = getAllToolHandlers(this.ctx);
  }

  setTask(task: string, images?: string[]): void {
    this.taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.auditor = new Auditor(this.workspaceRoot, this.taskId);
    const systemPrompt = loadSystemPrompt(this.workspaceRoot);
    const paradigmFragment = getParadigmPrompt(this.paradigm);
    const soulFragment = SoulManager.toPromptFragment();
    const scoreFragment = getScoreContext();
    const fullSystem = [systemPrompt, PROGRESS_NOTE, scoreFragment, paradigmFragment, soulFragment].filter(Boolean).join("\n\n");
    this.messages = [
      { role: "system", content: fullSystem },
      { role: "user", content: buildUserContent(task, images) },
    ];

  }

  restoreMessages(messages: Message[]): void {
    this.messages = messages;
  }

  getMessages(): Message[] {
    return this.messages;
  }

  /** Discard all messages except the system prompt, replacing them with a compact state.
   *  Used by constraint mode to reset context between iterations.
   *  Interface graph lives in the system prompt — no need to carry conversation history. */
  compactMessages(compactState: string): void {
    const sysMsg = this.messages[0];
    this.messages = sysMsg
      ? [sysMsg, { role: "user" as const, content: compactState }]
      : [{ role: "system" as const, content: "" }, { role: "user" as const, content: compactState }];
  }

  getUsage(): { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number } | null {
    if (!this.lastUsage) return null;
    const b = this.baselineTokens;
    return {
      promptTokens: Math.max(0, this.lastUsage.promptTokens - b),
      completionTokens: this.lastUsage.completionTokens,
      totalTokens: Math.max(0, this.lastUsage.totalTokens - b),
      cachedTokens: Math.max(0, this.lastUsage.cachedTokens - b),
    };
  }

  getContextUsage(): { estimatedTokens: number; maxTokens: number; percentage: number } {
    let totalChars = 0;
    for (const m of this.messages) {
      totalChars += (m.content?.length ?? 0) + 200;
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          totalChars += tc.function?.arguments?.length ?? 0;
        }
      }
    }
    const estimatedTokens = Math.ceil(totalChars / 4);
    return {
      estimatedTokens,
      maxTokens: MAX_CONTEXT_TOKENS,
      percentage: Math.round((estimatedTokens / MAX_CONTEXT_TOKENS) * 100),
    };
  }

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  getProviderName(): string {
    return this.provider.name;
  }

  getDefaultModels(): string[] {
    return [...this.provider.defaultModels];
  }

  getGuard(): HorsewhipGuardImpl | null {
    return this.guard;
  }

  setThinking(enabled: boolean): void {
    this.explicitThinking = enabled;
    this.provider.setThinking(enabled);
  }

  getThinking(): boolean {
    return this.explicitThinking ?? false;
  }

  setParadigm(p: Paradigm): void {
    this.paradigm = p;
    this.paradigmState.active = p;
    this.paradigmState.resolved = p;
    this.paradigmState.plan = undefined;
    this.paradigmState.currentStep = undefined;
  }

  rebuildSystemPrompt(): void {
    if (this.messages.length === 0) return;
    const systemPrompt = loadSystemPrompt(this.workspaceRoot);
    const paradigmFragment = getParadigmPrompt(this.paradigm);
    const soulFragment = SoulManager.toPromptFragment();
    const scoreFragment = getScoreContext();
    const fullSystem = [systemPrompt, PROGRESS_NOTE, scoreFragment, paradigmFragment, soulFragment].filter(Boolean).join("\n\n");
    this.messages[0] = { role: "system", content: fullSystem };
  }

  getParadigmState(): ParadigmState {
    return { ...this.paradigmState };
  }

  // --- Soul ---

  /** Force a soul summary now. Called by /soul command or auto-summary. */
  async summarizeSoul(): Promise<string> {
    try {
      const existing = SoulManager.load();
      const context = this.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-20)
        .map((m) => `[${m.role}]: ${(m.content ?? "").slice(0, 300)}`)
        .join("\n");

      const prompt = [
        existing ? `当前习惯（v${existing.version}）：${existing.content}` : "尚无记录。",
        "最近对话：",
        context,
        "要求：用一句中文总结用户习惯/偏好（<80字），以「用户偏好：」开头。新旧冲突时以新为准。",
      ].join("\n");

      const result = await this.provider.chat({
        model: this.model,
        messages: [
          { role: "user", content: prompt },
        ],
        max_tokens: 256,
      });

      const content = (result.choices[0]?.message?.content ?? "").trim().slice(0, 500);
      SoulManager.save(content);
      return content;
    } catch {
      return "";
    }
  }

  private async maybeUpdateSoul(): Promise<void> {
    try {
      await this.summarizeSoul();
    } catch (e) {
      logger.warn("Soul update failed", { error: String(e) });
    }
  }

  /** Manually trigger context compression. Returns true if compression occurred. */
  async compressContext(onCompress?: (phase: string, progress: number) => void): Promise<boolean> {
    this.onCompress = onCompress ?? null;
    const before = this.messages.length;
    await this.maybeCompress();
    return this.messages.length < before;
  }

  // --- Health / Abort ---

  health() {
    return {
      ok: true,
      session: this.sessionId,
      messageCount: this.messages.length,
      shutdown: this.abortController?.signal.aborted ?? false,
      rateLimit: this.rateLimiter.stats(),
    };
  }

  abort(): void {
    this.abortController?.abort();
  }

  // --- Main loop ---

  async run(onToken?: (text: string) => void, signal?: AbortSignal, onToolOutput?: (toolName: string, output: string) => void, onCompress?: (phase: string, progress: number) => void, onReasoning?: (text: string) => void): Promise<string> {
    this.onCompress = onCompress ?? null;
    const toolDefs = getAllToolDefs();

    if (this.mcpLoader) {
      const mcpTools = await this.mcpLoader.getAllMCPTools();
      // Dedup: built-in Horsewhip tools take precedence over MCP-provided ones
      const seen = new Set(toolDefs.map((t) => t.name));
      for (const mt of mcpTools) {
        if (!seen.has(mt.name)) {
          toolDefs.push(mt);
          seen.add(mt.name);
        }
      }
    }

    // Baseline = system prompt + ALL tool defs (incl. MCP). Fixed cost, excluded from display.
    // Use CJK-aware estimation: Chinese chars ~1.5 tokens, ASCII ~0.25 tokens.
    const sysMsg = this.messages.find((m) => m.role === "system");
    const sysTokens = estimateTokens(getContentText(sysMsg?.content));
    const toolTokens = estimateTokens(JSON.stringify(toolDefs));
    this.baselineTokens = sysTokens + toolTokens;

    // Model & thinking selection — paradigm-aware (skipped when user explicitly sets thinking)
    if (this.taskIntent === "new_feature") {
      const userMsg = getContentText(this.messages.find((m) => m.role === "user")?.content);
      this.taskIntent = detectTaskIntent(userMsg);
    }
    const resolved = this.paradigmState.resolved;

    if (this.explicitThinking !== undefined) {
      // User override: respect explicit thinking, pick model accordingly
      this.provider.setThinking(this.explicitThinking);
      this.model = this.explicitThinking ? "deepseek-v4-pro" : "deepseek-v4-flash";
    } else if (resolved === "appraise") {
      // Ask mode: flash, no thinking (fast Q&A)
      this.provider.setThinking(false);
      this.model = "deepseek-v4-flash";
    } else if (resolved === "spur") {
      // Shoot mode: pro, no thinking (surgical code changes)
      this.provider.setThinking(false);
      this.model = "deepseek-v4-pro";
    } else {
      // Target / Dangerous: pro + thinking for code tasks, flash for queries
      if (this.guard && this.taskIntent !== "query") {
        this.provider.setThinking(true);
        this.model = "deepseek-v4-pro";
      } else {
        this.model = "deepseek-v4-flash";
      }
    }

    let finalResponse = "";
    let iterations = 0;
    let consecutiveTimeouts = 0;
    let emptyResponseCount = 0;
    const ROUND_TIMEOUT_MS = 300_000;
    const MAX_TIMEOUTS = 3;

    while (iterations < this.maxIterations) {
      if (signal?.aborted) {
        finalResponse = finalResponse || "(aborted)";
        break;
      }

      iterations++;
      await this.maybeCompress();

      // Per-round 300s timeout — each API call gets its own deadline
      const roundCtrl = new AbortController();
      let roundTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => roundCtrl.abort(), ROUND_TIMEOUT_MS);
      const roundSignal = signal ? anySignal([signal, roundCtrl.signal]) : roundCtrl.signal;

      let result;
      try {
        result = await this.provider.streamToMessage(
          {
            model: this.model,
            messages: this.messages,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            max_tokens: 4096,
          },
          onToken,
          roundSignal,
          onReasoning,
        );
      } finally {
        clearTimeout(roundTimer);
        roundTimer = undefined;
      }

      if (result.usage) {
        this.lastUsage = result.usage;
      }

      if (result.aborted) {
        if (signal?.aborted) {
          finalResponse = result.content || "(aborted)";
          this.writeCheckpoint("aborted");
          break;
        }
        // Timeout — nudge model to continue instead of giving up
        consecutiveTimeouts++;
        if (consecutiveTimeouts > MAX_TIMEOUTS) {
          finalResponse = `(连续 ${MAX_TIMEOUTS} 轮超时，任务中断)`;
          this.writeCheckpoint("timeout");
          break;
        }
        if (result.content) {
          this.messages.push({ role: "assistant", content: result.content });
        }
        this.messages.push({
          role: "user",
          content: `(上一轮思考超过 ${ROUND_TIMEOUT_MS / 1000}s 超时。请从断点继续，直接完成任务，不要重复已做工作。)`,
        });
        continue;
      }

      consecutiveTimeouts = 0;

      // Empty response: retry with a nudge (model sometimes stops mid-task)
      if (!result.content && result.toolCalls.length === 0) {
        emptyResponseCount++;
        if (emptyResponseCount >= 3) {
          finalResponse = "(empty response after 3 retries)";
          this.writeCheckpoint("empty_response");
          break;
        }
        this.messages.push({
          role: "user",
          content: "Continue. You are not done. Call the next tool or complete_sub_goal.",
        });
        continue;
      }
      emptyResponseCount = 0;

      const assistantMsg: Message = {
        role: "assistant",
        content: result.content || null,
      };

      if (result.toolCalls.length > 0) {
        assistantMsg.tool_calls = result.toolCalls;
      }

      // Per DeepSeek spec: once reasoning_content appears in a conversation,
      // ALL subsequent assistant messages MUST include it, or API returns 400.
      // This applies regardless of whether tool_calls are present.
      if (result.reasoning) {
        assistantMsg.reasoning_content = result.reasoning;
      }

      this.messages.push(assistantMsg);

      if (result.toolCalls.length === 0) {
        finalResponse = result.content;
        break;
      }

      const toolResults = await this.executeToolCalls(result.toolCalls);

      // In constraint mode, intercept complete_sub_goal to run gate verification inline
      if (this.constraintExecutor) {
        for (let i = 0; i < result.toolCalls.length; i++) {
          const tc = result.toolCalls[i]!;
          if (tc.function.name === "complete_sub_goal") {
            const completed = this.constraintExecutor.ensureBoundary();
            if (completed && !completed.feedback) {
              const gates = this.constraintExecutor.verifyGates(completed.exports, completed.imports);
              if (gates.ok) {
                const final = this.constraintExecutor.finalize(completed.capability);
                // Replace the simple "ok" result with the gate-verified result
                toolResults[i] = {
                  tool_call_id: tc.id,
                  content: JSON.stringify({ ok: true, gate_verified: true, result: final }),
                };
              } else {
                // Gates failed — return feedback so AI can fix
                toolResults[i] = {
                  tool_call_id: tc.id,
                  content: JSON.stringify({ ok: false, error: gates.feedback }),
                };
              }
            } else if (completed?.feedback) {
              toolResults[i] = {
                tool_call_id: tc.id,
                content: JSON.stringify({ ok: false, error: completed.feedback }),
              };
            }
          }
        }
      }

      // Route tool outputs to TUI — report_progress gets special phase rendering
      if (onToolOutput) {
        for (let i = 0; i < result.toolCalls.length; i++) {
          const tc = result.toolCalls[i]!;
          const tr = toolResults[i];
          if (!tr) continue;
          if (tc.function.name === "report_progress") {
            // LLM-driven phase indicator — render as dim progress text
            try {
              const args = JSON.parse(tc.function.arguments);
              onToolOutput("phase", `【${args.message}】`);
            } catch { /* skip malformed args */ }
          } else {
            onToolOutput(tc.function.name, tr.content);
          }
        }
      }

      for (const tr of toolResults) {
        this.messages.push({
          role: "tool",
          content: tr.content,
          tool_call_id: tr.tool_call_id,
        });
      }

      if (result.content) {
        finalResponse = result.content;
      }

      // Auto-summarize soul after every 3 rounds
      if (SoulManager.shouldAutoSummarize(++this.soulRoundCounter)) {
        await this.maybeUpdateSoul();
        this.soulRoundCounter = 0;
      }
    }

    return finalResponse || "(task completed)";
  }

  // --- Checkpoint: save/restore session state on failure ---

  private writeCheckpoint(reason: string): void {
    try {
      const dir = path.join(this.workspaceRoot, ".chitu");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const cpFile = path.join(dir, "checkpoint.json");
      const userMsg = this.messages.find((m) => m.role === "user");
      fs.writeFileSync(cpFile, JSON.stringify({
        task: userMsg ? getContentText(userMsg.content) : "",
        reason,
        messages: this.messages.slice(-20), // keep last 20 messages only
        savedAt: new Date().toISOString(),
      }, null, 2), "utf-8");
    } catch { /* best-effort */ }
  }

  loadCheckpoint(): { task: string; reason: string; messages: Message[] } | null {
    try {
      const cpFile = path.join(this.workspaceRoot, ".chitu", "checkpoint.json");
      if (!fs.existsSync(cpFile)) return null;
      const data = JSON.parse(fs.readFileSync(cpFile, "utf-8"));
      if (!data || !data.messages) return null;
      return { task: data.task ?? "", reason: data.reason ?? "unknown", messages: data.messages };
    } catch { return null; }
  }

  deleteCheckpoint(): void {
    try {
      const cpFile = path.join(this.workspaceRoot, ".chitu", "checkpoint.json");
      if (fs.existsSync(cpFile)) fs.unlinkSync(cpFile);
    } catch { /* ok */ }
  }

  // --- Phased run: grow → trim → verify ---

  async runPhased(
    onToken?: (text: string) => void,
    options?: { signal?: AbortSignal },
    onToolOutput?: (toolName: string, output: string) => void,
    onCompress?: (phase: string, progress: number) => void,
    onReasoning?: (text: string) => void,
  ): Promise<{ result: string }> {
    this.abortController = new AbortController();
    const signal = options?.signal
      ? anySignal([this.abortController.signal, options.signal])
      : this.abortController.signal;

    let finalResult = "";
    let round = 0;

    try {
      // Detect task intent from user input
      const userMsg = getContentText(this.messages.find((m) => m.role === "user")?.content);
      this.taskIntent = detectTaskIntent(userMsg);

      // Target mode handles its own grow/trim/verify AND guard lifecycle internally
      if (this.paradigmState.resolved === "ride") {
        finalResult = await this.execute(onToken, signal, onToolOutput, onCompress, onReasoning);
        // Don't call finishPhased() — TargetExecutor manages its own guard lock/unlock
        return { result: finalResult };
      }

      // Phase 1: Grow — decouple mode, create new files only
      if (this.guard) {
        this.guard.lockDecouple(this.taskId, { writablePaths: [], allowNewFiles: true, allowShellWrite: false });
      }

      finalResult = await this.execute(onToken, signal, onToolOutput, onCompress, onReasoning);
      let blockedFiles = this.extractBlockedFiles(finalResult);
      let testFailed = this.detectTestFailure(finalResult);

      this.auditor.writeEvent("phase_complete", { phase: "grow", round: 0 });

      if (!blockedFiles.length && !testFailed) {
        return this.finishPhased(finalResult);
      }

      // Phase 2: Trim loop
      while (round < MAX_PHASED_ROUNDS) {
        round++;
        if (signal.aborted) break;

        const trimFiles = [
          ...new Set([
            ...blockedFiles,
            ...this.extractNewFiles(finalResult),
            ...this.extractAllTouchedFiles(finalResult),
          ].filter((f) => this.isValidPath(f))),
        ];

        if (!trimFiles.length) break;

        if (this.guard) {
          this.guard.lockIntent(
            this.taskId,
            trimFiles,
            undefined,
            undefined,
            undefined,
            { writablePaths: trimFiles, allowNewFiles: false, allowShellWrite: false },
          );
        }

        // Append trim prompt
        const trimPrompt = [
          `## Trim Phase — Round ${round}`,
          ``,
          `The following files were blocked or need fixing:`,
          ...trimFiles.map((f) => `- ${f}`),
          ``,
          `Unlock these files, fix the issues, and verify.`,
          testFailed ? `Tests are failing — fix the test failures too.` : ``,
        ].filter(Boolean).join("\n");

        this.messages.push({ role: "user", content: trimPrompt });
        finalResult = await this.run(onToken, signal, onToolOutput, onCompress, onReasoning);

        // Verify: lock back to decouple and re-check
        if (this.guard) {
          this.guard.lockDecouple(this.taskId, { writablePaths: [], allowNewFiles: false, allowShellWrite: false });
        }

        const verifyPrompt = [
          `## Verify Phase — Round ${round}`,
          ``,
          `Verify all fixes are complete. If anything is still blocked or failing,`,
          `report it clearly with "BLOCKED by Horsewhip. File: <path>" or "TEST FAILURE: <details>".`,
          `If everything works, respond with "All checks passed."`,
        ].join("\n");

        this.messages.push({ role: "user", content: verifyPrompt });
        finalResult = await this.run(onToken, signal, onToolOutput, onCompress, onReasoning);

        const newBlocked = this.extractBlockedFiles(finalResult);
        testFailed = this.detectTestFailure(finalResult);

        if (!newBlocked.length && !testFailed) {
          this.auditor.writeEvent("phase_complete", { phase: "trim", round });
          break;
        }

        // If same files keep getting blocked, expand the pasture
        const sameFiles = newBlocked.every((f) => blockedFiles.includes(f));
        if (sameFiles && this.guard) {
          this.guard.expandBoundary(newBlocked, `re-blocked in round ${round}`);
        }

        blockedFiles = newBlocked;
      }

      return this.finishPhased(finalResult);
    } finally {
      this.abortController = null;
    }
  }

  private _srcCountCache: { value: number; at: number } = { value: 0, at: 0 };
  private countSourceFiles(): number {
    const now = Date.now();
    if (now - this._srcCountCache.at < 30000) return this._srcCountCache.value;
    let count = 0;
    try {
      const MAX_DEPTH = 4;
      const walk = (dir: string, depth: number): void => {
        if (depth > MAX_DEPTH) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          if (entry.isDirectory()) { walk(pathJoin(dir, entry.name), depth + 1); }
          else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) { count++; }
        }
      };
      walk(this.workspaceRoot, 0);
    } catch { /* ignore */ }
    this._srcCountCache = { value: count, at: now };
    return count;
  }

  /**
   * 写一条审计事件到 .git/horsewhip/session-audit.json
   */
  private writeAuditEvent(type: string, data: Record<string, unknown> = {}): void {
    const auditPath = path.join(this.workspaceRoot, ".git", "horsewhip", "session-audit.json");
    try {
      const auditDir = path.dirname(auditPath);
      if (!fs.existsSync(auditDir)) {
        fs.mkdirSync(auditDir, { recursive: true });
      }
      const event = {
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type,
        timestamp: new Date().toISOString(),
        task: this.taskId,
        ...data,
      };
      fs.appendFileSync(auditPath, JSON.stringify(event) + "\n", "utf-8");
    } catch (e) {
      logger.warn("writeAuditEvent failed", { error: String(e), path: auditPath });
    }
  }

  private async finishPhased(result: string): Promise<{ result: string }> {
    if (this.guard) {
      this.guard.unlock();
    }

    return { result };
  }

  // --- Paradigm dispatcher ---

  /**
   * Main entry point. Dispatches to the appropriate paradigm runner.
   * Called by TUI/CLI instead of directly calling run() or runPhased().
   */
  async execute(
    onToken?: (text: string) => void,
    signal?: AbortSignal,
    onToolOutput?: (toolName: string, output: string) => void,
    onCompress?: (phase: string, progress: number) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    const resolved = this.paradigmState.resolved;

    switch (resolved) {
      case "appraise":
        return this.executeAsk(onToken, signal, onToolOutput, onCompress, onReasoning);
      case "ride":
        return this.executeTarget(onToken, signal, onToolOutput, onCompress, onReasoning);
      case "constraint":
        return this.executeConstraint(onToken, signal, onToolOutput, onCompress, onReasoning);
      case "spur":
        return this.executeShoot(onToken, signal, onToolOutput, onCompress, onReasoning);
      default:
        return this.run(onToken, signal, onToolOutput, onCompress, onReasoning);
    }
  }

  // --- Paradigm: Ask (pure Q&A, no file modifications) ---

  private async executeAsk(
    onToken?: (text: string) => void,
    signal?: AbortSignal,
    onToolOutput?: (toolName: string, output: string) => void,
    onCompress?: (phase: string, progress: number) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    // Ask mode: lock all tracked files via Horsewhip decouple.
    // Hard enforcement — the guard blocks writes, no prompt tricks needed.
    const hadGuard = !!this.guard;
    if (this.guard) {
      this.guard.lockDecouple(this.taskId, { writablePaths: [], allowNewFiles: false, allowShellWrite: false });
    }

    try {
      if (this.explicitThinking === undefined) {
        this.provider.setThinking(false);
      }
      return await this.run(onToken, signal, onToolOutput, onCompress, onReasoning);
    } finally {
      if (hadGuard && this.guard) {
        this.guard.unlock();
      }
    }
  }

  // --- Paradigm: Target (core Chitu workflow, goal-driven with metrics) ---

  private async executeTarget(
    onToken?: (text: string) => void,
    signal?: AbortSignal,
    onToolOutput?: (toolName: string, output: string) => void,
    onCompress?: (phase: string, progress: number) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    const executor = new TargetExecutor(this, this.workspaceRoot);
    return await executor.execute({ onToken, signal, onToolOutput, onCompress, onReasoning, yunchang: this.yunchang });
  }

  // --- Paradigm: Constraint (Horsewhip boundary mode) ---

  private async executeConstraint(
    onToken?: (text: string) => void,
    signal?: AbortSignal,
    onToolOutput?: (toolName: string, output: string) => void,
    onCompress?: (phase: string, progress: number) => void,
    onReasoning?: (text: string) => void,
    mode?: import("./types.js").ConstraintMode,
  ): Promise<string> {
    const MAX_ITERATIONS = 10;
    const executor = new ConstraintExecutor(this, this.workspaceRoot, mode ?? "creation");
    this.constraintExecutor = executor;
    try {
      // Check for checkpoint from a previous failed run
      const cp = this.loadCheckpoint();
      if (cp) {
        const sysMsg = this.messages[0];
        this.messages = sysMsg ? [sysMsg, ...cp.messages] : cp.messages;
      }

      // Inject constraint context and lock files (once)
      executor.setup();

      let finalResult = "";
      let iterationCount = 0;

      // ── Outer iteration loop ──
      while (iterationCount < MAX_ITERATIONS) {
        iterationCount++;
        let iterationSucceeded = false;

        // ── Inner retry loop (gates) ──
        let aiStopped = false;
        while (executor.nextAttempt()) {
          const result = await this.run(onToken, signal, onToolOutput, onCompress, onReasoning);

          if (signal?.aborted) {
            executor.rollback();
            return result || "(aborted)";
          }

          // Read what the AI declared
          const completed = executor.ensureBoundary();
          if (!completed) {
            // No complete_sub_goal called — AI is done with this task
            finalResult = result;
            aiStopped = true;
            break;
          }
          if (completed.feedback) {
            // AI called complete_sub_goal without declaring boundary — inject feedback and retry
            this.messages.push({ role: "user", content: completed.feedback });
            continue;
          }

          // Verify gates
          const gates = executor.verifyGates(completed.exports, completed.imports);
          if (gates.ok) {
            // All good — finalize, clear checkpoint, prepare for next iteration
            const final = executor.finalize(completed.capability);
            this.deleteCheckpoint();
            iterationSucceeded = true;
            finalResult = `${result}\n\n${final}`;
            break;
          }

          // Gates failed — inject feedback for next attempt
          this.messages.push({ role: "user", content: gates.feedback });
        }

        // ── Check inner-loop outcome ──
        if (signal?.aborted) return finalResult || "(aborted)";

        if (aiStopped) {
          // AI replied without complete_sub_goal — it's done
          return finalResult || "(done)";
        }

        if (!iterationSucceeded) {
          // Retries exhausted on gate failures — rollback and exit
          executor.rollback();
          return finalResult || "(task incomplete)";
        }

        // Success — ask AI to continue to the next sub-goal
        this.messages.push({
          role: "user",
          content: `${finalResult}\n\nContinue with the next sub-goal. If all tasks are complete, reply with a brief summary (do NOT call \`complete_sub_goal\`).`,
        });
      }

      return finalResult || "(task complete)";
    } finally {
      this.constraintExecutor = null;
    }
  }

  // --- Paradigm: Shoot (single file, single shot, no metrics) ---

  private async executeShoot(
    onToken?: (text: string) => void,
    signal?: AbortSignal,
    onToolOutput?: (toolName: string, output: string) => void,
    onCompress?: (phase: string, progress: number) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    const userMsg = getContentText(this.messages.find((m) => m.role === "user")?.content);
    const files = this.extractFilePaths(userMsg);

    if (files.length === 0) {
      return [
        "(Shoot mode: no file path found in your message.)",
        "Specify at least one file path, e.g.:",
        "  `修改 src/foo.ts 把 login 函数改成 async`",
      ].join("\n");
    }

    const hadGuard = !!this.guard;

    // Lock intent on only the specified files — surgical boundary
    if (this.guard) {
      this.guard.lockIntent(this.taskId, files, undefined, undefined, undefined, { writablePaths: files, allowNewFiles: false, allowShellWrite: true });
    }

    try {
      const result = await this.run(onToken, signal, onToolOutput, onCompress, onReasoning);

      // Auto-expand any blocked files the AI discovered it needed
      const blocked = this.extractBlockedFiles(result);
      for (const f of new Set(blocked)) {
        if (this.guard) this.guard.expandBoundary([f], "shoot: auto-expand");
      }

      return result;
    } finally {
      if (hadGuard && this.guard) {
        this.guard.unlock();
      }
    }
  }

  /** Extract file paths (relative or absolute) from user text. */
  private extractFilePaths(text: string): string[] {
    const paths: string[] = [];
    // Match patterns like: src/foo.ts, ./foo.ts, /abs/path/foo.ts, app/bar.js
    const re = /(?:^|\s)(\.{0,2}\/)?(?:[\w-]+\/)*[\w-]+\.(?:ts|js|tsx|jsx|json|css|html|md|py|go|rs|java|rb)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const p = m[0].trim();
      if (p && !paths.includes(p)) paths.push(p);
    }
    return paths;
  }

  // --- Tool execution ---

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const tc of toolCalls) {
      const name = tc.function.name;
      let args: Record<string, unknown>;

      // Rate limit check
      const waitMs = this.rateLimiter.check(name);
      if (waitMs > 0) {
        results.push({
          tool_call_id: tc.id,
          content: `Rate limited: '${name}' must wait ${Math.ceil(waitMs / 1000)}s`,
        });
        continue;
      }

      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        const raw = tc.function.arguments;
        const len = raw.length;
        let hint = "";
        if (len > 8000) {
          hint = `\nContent too large (${(len / 1024).toFixed(1)}KB). Split into smaller parts: first write_file with a minimal skeleton, then use edit_file to append remaining sections.`;
        }
        results.push({
          tool_call_id: tc.id,
          content: `Error: invalid JSON arguments (${len} chars).${hint}`,
        });
        continue;
      }

      try {
        let output: string;

        if (name.startsWith("mcp__horsewhip__")) {
          output = await this.handleHorsewhipTool(name, args);
        } else if (name.startsWith("mcp__") && this.mcpLoader) {
          output = await this.mcpLoader.callMCPTool(name, args);
        } else {
          const handler = this.toolHandlers[name];
          if (!handler) {
            output = `Error: unknown tool '${name}'`;
          } else {
            output = await handler(args);
          }
        }

        if (output.length > 50000) {
          output = output.slice(0, 50000) + `\n\n[truncated — ${output.length - 50000} more bytes]`;
        }

        // Record file operations for metrics (even without Horsewhip MCP)
        if (name === "write_file" || name === "edit_file" || name === "delete_file") {
          const filePath = typeof args["filePath"] === "string" ? args["filePath"] : "";
          this.auditor.writeEvent("write", { file: filePath, tool: name });
        }

        results.push({ tool_call_id: tc.id, content: output });
      } catch (e: unknown) {
        results.push({
          tool_call_id: tc.id,
          content: `Error executing '${name}': ${String(e)}`,
        });
      }
    }

    return results;
  }

  // --- Horsewhip MCP interceptor: route state-changing tools to in-process guard ---

  private async handleHorsewhipTool(fullName: string, args: Record<string, unknown>): Promise<string> {
    const method = fullName.replace("mcp__horsewhip__", "");

    // In constraint mode, AI may call lock_intent and expand_boundary to manage its own boundary.
    const isConstraint = this.paradigmState.resolved === "constraint";
    const isBlocked = (m: string) =>
      `Error: Boundary is managed by the executor. The AI cannot change its own boundary. Current: ${JSON.stringify(this.guard?.getBoundaryState() ?? {})}`;

    switch (method) {
      case "horsewhip_lock_intent": {
        if (!isConstraint) return isBlocked(method);
        if (!this.guard) return JSON.stringify({ ok: false, error: "No guard" });
        const touch = (args["touch"] as string[]) ?? [];
        const core = (args["core"] as string[] | undefined);
        const edge = (args["edge"] as string[] | undefined);
        const allPaths = [...touch, ...(core ?? []), ...(edge ?? [])];
        const scope = ConstraintExecutor.validateScope(this.workspaceRoot, allPaths);
        if (!scope.ok) return JSON.stringify({ ok: false, error: scope.error });
        const task = (args["task"] as string) ?? `constraint:${path.basename(this.workspaceRoot)}`;
        this.guard.lockIntent(task, touch, core, edge);
        return JSON.stringify({ ok: true, allowed: touch, mode: "pasture" });
      }
      case "horsewhip_expand_boundary": {
        if (!isConstraint) return isBlocked(method);
        if (!this.guard) return JSON.stringify({ ok: false, error: "No guard" });
        const paths = (args["paths"] as string[]) ?? [];
        const scope = ConstraintExecutor.validateScope(this.workspaceRoot, paths);
        if (!scope.ok) return JSON.stringify({ ok: false, error: scope.error });
        // Check cumulative boundary size + expand count limit
        if (this.constraintExecutor) {
          const check = this.constraintExecutor.canExpand(paths);
          if (!check.ok) return JSON.stringify({ ok: false, error: check.error });
        }
        const reason = (args["reason"] as string) ?? "unspecified";
        this.guard.expandBoundary(paths, reason);
        this.constraintExecutor?.recordExpand(paths, reason);
        return JSON.stringify({ ok: true, expanded: paths });
      }
      case "horsewhip_lock_decouple":
      case "horsewhip_lock_append_only":
      case "horsewhip_lock_paths":
      case "horsewhip_unlock":
      case "horsewhip_lock_file":
      case "horsewhip_unlock_file":
      case "horsewhip_auto_commit":
      case "horsewhip_finish_auto":
        return isBlocked(method);

      case "horsewhip_get_boundary": {
        if (!this.guard) return JSON.stringify({ locked: false, mode: "none", allowed: [] });
        const state = this.guard.getBoundaryState();
        return JSON.stringify(state);
      }

      case "horsewhip_task_complete": {
        if (!this.guard) return JSON.stringify({ ok: true });
        const summary = (args["summary"] as string) ?? "";
        this.guard.taskComplete(summary);
        return JSON.stringify({ ok: true });
      }

      case "horsewhip_record_write": {
        if (!this.guard) return JSON.stringify({ ok: true });
        const p = (args["path"] as string) ?? "";
        // fire-and-forget: recordWrite is async but we don't need to await for the response
        this.guard.recordWrite(p).catch((e) => { logger.warn("recordWrite failed", { path: p, error: String(e) }); });
        return JSON.stringify({ ok: true });
      }

      case "horsewhip_whip_ceremony":
      case "horsewhip_suggest_scope":
        // Forward to MCP for UI-only or read-only operations
        if (this.mcpLoader) {
          return this.mcpLoader.callMCPTool(fullName, args);
        }
        return JSON.stringify({ ok: true });
    }

    return `Error: unknown Horsewhip tool '${method}'`;
  }

  // --- Context compression ---

  private compressRound = 0;

  private async maybeCompress(): Promise<void> {
    let totalChars = 0;
    for (const m of this.messages) {
      totalChars += (m.content?.length ?? 0) + 200;
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          totalChars += tc.function?.arguments?.length ?? 0;
        }
      }
    }

    const estimatedTokens = Math.ceil(totalChars / 4);
    if (estimatedTokens < MAX_CONTEXT_TOKENS * COMPRESS_THRESHOLD) return;

    const yield_ = () => new Promise<void>((r) => setImmediate(r));

    const systemMsg = this.messages[0];
    const keepCount = 8;

    // Slide start forward past messages that would become invalid at the boundary
    let start = this.messages.length - keepCount;
    while (start < this.messages.length) {
      const cur = this.messages[start];
      if (cur?.role === "assistant" && cur.tool_calls?.length) {
        start++;
        while (start < this.messages.length && this.messages[start]?.role === "tool") {
          start++;
        }
      } else if (cur?.role === "tool") {
        start++;
      } else {
        break;
      }
    }

    // Save removed messages to disk before compressing
    const removed = this.messages.slice(1, start);
    if (removed.length > 0) {
      this.onCompress?.("archive", 0);
      await yield_();
      try {
        const ctxDir = path.join(this.workspaceRoot, ".chitu", "context");
        if (!fs.existsSync(ctxDir)) fs.mkdirSync(ctxDir, { recursive: true });
        this.compressRound++;
        this.onCompress?.("archive", 20);
        await yield_();

        // Extract the last user message as a human-readable title
        let title = "";
        for (let i = removed.length - 1; i >= 0; i--) {
          if (removed[i]?.role === "user" && removed[i]?.content) {
            title = getContentText(removed[i]!.content!)
              .replace(/[\n\r/:\\*?"<>|]/g, " ")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 60);
            break;
          }
        }
        if (!title) title = "compressed";

        const now = new Date();
        const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const safeTitle = title || "compressed";
        const archiveFile = path.join(ctxDir, `${ts}_${safeTitle}.json`);

        this.onCompress?.("archive", 50);
        await yield_();
        fs.writeFileSync(archiveFile, JSON.stringify({
          sessionId: this.sessionId,
          round: this.compressRound,
          compressedAt: now.toISOString(),
          title: safeTitle,
          estimatedTokens,
          messageCount: removed.length,
          messages: removed,
        }, null, 2), "utf-8");
        this.onCompress?.("archive", 70);
        await yield_();
      } catch { /* best effort */ }
    }

    this.onCompress?.("summarize", 70);
    await yield_();

    const recent = this.messages.slice(start);

    const middleSummaries: string[] = [];
    for (let i = 1; i < start; i++) {
      const m = this.messages[i];
      if (m?.role === "user") {
        middleSummaries.push(`[User]: ${(m.content ?? "").slice(0, 200)}`);
      } else if (m?.role === "assistant" && m.content) {
        middleSummaries.push(`[Assistant]: ${m.content.slice(0, 200)}`);
      } else if (m?.role === "tool") {
        const brief = (m.content ?? "").slice(0, 100);
        middleSummaries.push(`[Tool result]: ${brief}`);
      }
    }

    const summary = `[Context compressed: ${middleSummaries.length} messages summarized]\n\n` +
      middleSummaries.join("\n");

    if (systemMsg) {
      this.messages = [
        systemMsg,
        { role: "user", content: summary },
        ...recent,
      ];
    }

    this.onCompress?.("done", 100);
    await yield_();
  }

  // --- Extraction helpers ---

  private extractBlockedFiles(text: string): string[] {
    const re = /BLOCKED by Horsewhip[:.].*?File:\s*(\S+)/gi;
    const files: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) files.push(m[1]);
    }
    return [...new Set(files)];
  }

  private detectTestFailure(text: string): boolean {
    // Look for test failure indicators, excluding "no test configured" false positives
    const failRe = /(?:FAIL|FAILED|failed|\d+ failing|Test (?:failed|error)|AssertionError|assert\.\w+ failed)/i;
    const noTestRe = /no tests? (?:configured|found|specified)/i;
    return failRe.test(text) && !noTestRe.test(text);
  }

  private extractNewFiles(text: string): string[] {
    const files: string[] = [];
    // Patterns for newly created files
    const patterns = [
      /(?:created|wrote|new file)[:\s]+(\S+\.(?:ts|js|tsx|jsx|json|md|css|html))/gi,
      /Wrote (?:contents )?to (\S+)/gi,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[1]) files.push(m[1]);
      }
    }
    return [...new Set(files)];
  }

  private extractAllTouchedFiles(text: string): string[] {
    const files: string[] = [];
    const re = /(?:reading|editing|modifying|opening|writing)\s+["']?(\S+\.(?:ts|js|tsx|jsx|json|md|css|html))["']?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) files.push(m[1]);
    }
    return [...new Set(files)];
  }

  private isValidPath(s: string): boolean {
    return PATH_RE.test(s) && s.includes(".");
  }
}

// Minimal anySignal helper — combine multiple AbortSignals
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    sig.addEventListener("abort", () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}

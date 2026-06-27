import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createProvider } from "./providers/factory.js";
import type { AIProvider, ProviderName } from "./providers/types.js";
import { getAllToolDefs, getAllToolHandlers } from "./tools/index.js";
import { RateLimiter } from "./ratelimit.js";
import { HorsewhipGuardImpl } from "./horsewhip/guard.js";
import { loadSystemPrompt } from "./system-prompt.js";
import { SoulManager } from "./soul.js";
import { resolveProvider, resolveBaseUrl } from "./global-config.js";
import { Auditor } from "./auditor.js";
import { getParadigmPrompt } from "./paradigm.js";
import { getScoreContext } from "./score.js";
import { TargetExecutor } from "./target/executor.js";
import { ConstraintExecutor } from "./constraint/executor.js";
import { getContentText, detectTaskIntent } from "./types.js";
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
} from "./types.js";
import type { MCPLoader } from "./mcp/loader.js";
import { logger } from "./logger.js";

// Extracted modules
import {
  buildUserContent,
  PROGRESS_NOTE,
  MAX_CONTEXT_TOKENS,
  COMPRESS_THRESHOLD,
  MAX_PHASED_ROUNDS,
  PATH_RE,
  estimateTokens,
  getContextUsage as getContextUsageFn,
  estimateContextTokens,
  writeCheckpoint as writeCp,
  loadCheckpoint as loadCp,
  deleteCheckpoint as deleteCp,
  countSourceFiles as countSrcFiles,
  extractBlockedFiles,
  detectTestFailure,
  extractNewFiles,
  extractAllTouchedFiles,
  isValidPath,
  extractFilePaths as extractFilePathsFn,
  anySignal,
} from "./agent/context.js";
import { executeToolCalls as execTools, type ToolExecContext } from "./agent/tool-exec.js";

// Re-export for backward compat (tui/app.ts uses it)
export { buildUserContent } from "./agent/context.js";

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
  private lastFinishReason: string | undefined;
  private onCompress: ((phase: string, progress: number) => void) | null = null;
  private soulRoundCounter = 0;
  private baselineTokens = 0;
  private explicitThinking: boolean | undefined;
  private paradigm: Paradigm = "ride";
  private paradigmState: ParadigmState = { active: "ride", resolved: "ride" };
  private yunchang = false;
  constraintExecutor: ConstraintExecutor | null = null;
  private pendingExpandRequest: { paths: string[]; reason: string } | null = null;
  pendingExpandApproved: boolean | null = null;
  private _srcCountCache: { value: number; at: number } = { value: 0, at: 0 };

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
    const resolvedProvider = resolveProvider(config.provider) as ProviderName;
    this.provider = createProvider(resolvedProvider, {
      apiKey: config.apiKey,
      baseUrl: resolveBaseUrl(config.baseUrl),
      model: config.model,
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    });
    this.model = config.model ?? this.provider.defaultModels[0] ?? "deepseek-v4-pro";
    this.maxIterations = config.maxIterations ?? 20; // safety net; idle detection is the primary control
    this.explicitThinking = config.thinking;
    this.paradigm = config.paradigm ?? "constraint";
    this.paradigmState = { active: this.paradigm, resolved: this.paradigm };
    this.yunchang = config.yunchang ?? false;
    this.mcpLoader = mcpLoader;
    this.horsewhipGuard = horsewhipGuard;
    this.rateLimiter = new RateLimiter();

    if (horsewhipGuard instanceof HorsewhipGuardImpl) {
      this.guard = horsewhipGuard;
      this.guard.unlock(); // Clean up stale boundary from previous session
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

  // ── Simple accessors ──

  restoreMessages(messages: Message[]): void { this.messages = messages; }
  getMessages(): Message[] { return this.messages; }

  // ── Debug log ──

  private constraintLog(msg: string): void {
    try {
      const logDir = path.join(this.workspaceRoot, ".chitu");
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.sss
      fs.appendFileSync(path.join(logDir, "constraint.log"), `[${ts}] ${msg}\n`, "utf-8");
    } catch { /* never crash for logging */ }
  }

  compactMessages(compactState: string): void {
    const sysMsg = this.messages[0];
    this.constraintLog(`compactMessages: before=${this.messages.length} msgs`);

    // Find a safe cut point that doesn't split tool-call/tool-result pairs.
    // But never discard ALL recent messages — amnesia is worse than splitting a pair.
    const keepCount = 10;
    let start = Math.max(1, this.messages.length - keepCount);
    while (start < this.messages.length) {
      const cur = this.messages[start];
      if (cur?.role === "assistant" && cur.tool_calls?.length) {
        start++;
        while (start < this.messages.length && this.messages[start]?.role === "tool") start++;
      } else if (cur?.role === "tool") {
        start++;
      } else {
        break;
      }
    }
    // Fallback: if we skipped everything, keep at least the last 2 messages
    if (start >= this.messages.length) {
      start = Math.max(1, this.messages.length - 2);
      // Don't start mid-pair: if first kept message is a tool result, include its call
      if (start < this.messages.length && this.messages[start]?.role === "tool") {
        start = Math.max(1, start - 1);
      }
    }
    const recent = this.messages.slice(start);

    // Build a contextual summary from the discarded middle messages
    const middle = this.messages.slice(1, start);
    const lastActions: string[] = [];
    for (let i = middle.length - 1; i >= 0 && lastActions.length < 8; i--) {
      const m = middle[i];
      if (m?.role === "assistant" && m.content) {
        lastActions.unshift(`[Assistant]: ${getContentText(m.content).slice(0, 300)}`);
      } else if (m?.role === "user" && m.content) {
        lastActions.unshift(`[User]: ${getContentText(m.content).slice(0, 300)}`);
      } else if (m?.role === "tool" && m.content) {
        const toolText = getContentText(m.content);
        if (toolText.length > 0) {
          lastActions.unshift(`[Tool]: ${toolText.slice(0, 200)}`);
        }
      }
    }

    const summaryParts = [compactState];
    if (lastActions.length > 0) {
      summaryParts.push("", "## Recent Activity (before compaction)", lastActions.join("\n"));
    }

    const summary = summaryParts.join("\n");
    this.messages = sysMsg
      ? [sysMsg, { role: "user" as const, content: summary }, ...recent]
      : [{ role: "system" as const, content: "" }, { role: "user" as const, content: summary }, ...recent];
    this.constraintLog(`compactMessages: after=${this.messages.length} msgs (kept ${recent.length} recent, discarded ${middle.length})`);
  }

  getUsage(): { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number } | null {
    if (!this.lastUsage) return null;
    const b = this.baselineTokens;
    return {
      promptTokens: Math.max(0, this.lastUsage.promptTokens - b),
      completionTokens: this.lastUsage.completionTokens,
      totalTokens: Math.max(0, this.lastUsage.totalTokens - b),
      cachedTokens: this.lastUsage.cachedTokens,
    };
  }

  getContextUsage(): { estimatedTokens: number; maxTokens: number; percentage: number } {
    return getContextUsageFn(this.messages);
  }

  setModel(model: string): void { this.model = model; }
  getModel(): string { return this.model; }
  getProviderName(): string { return this.provider.name; }
  getDefaultModels(): string[] { return [...this.provider.defaultModels]; }
  getGuard(): HorsewhipGuardImpl | null { return this.guard; }

  setThinking(enabled: boolean): void {
    this.explicitThinking = enabled;
    this.provider.setThinking(enabled);
  }
  getThinking(): boolean { return this.explicitThinking ?? false; }

  setParadigm(p: Paradigm): void {
    this.paradigm = p;
    this.paradigmState.active = p;
    this.paradigmState.resolved = p;
    this.paradigmState.plan = undefined;
    this.paradigmState.currentStep = undefined;
    // Clear stale boundary when switching modes — constraint is opt-in per task
    if (this.guard) this.guard.unlock();
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

  getParadigmState(): ParadigmState { return { ...this.paradigmState }; }

  // ── Soul ──

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
        messages: [{ role: "user", content: prompt }],
        max_tokens: 256,
      });
      const content = (result.choices[0]?.message?.content ?? "").trim().slice(0, 500);
      SoulManager.save(content);
      return content;
    } catch { return ""; }
  }

  private async maybeUpdateSoul(): Promise<void> {
    try { await this.summarizeSoul(); }
    catch (e) { logger.warn("Soul update failed", { error: String(e) }); }
  }

  async compressContext(onCompress?: (phase: string, progress: number) => void): Promise<boolean> {
    this.onCompress = onCompress ?? null;
    const before = this.messages.length;
    await this.maybeCompress();
    return this.messages.length < before;
  }

  // ── Health / Abort ──

  health() {
    return {
      ok: true,
      session: this.sessionId,
      messageCount: this.messages.length,
      shutdown: this.abortController?.signal.aborted ?? false,
      rateLimit: this.rateLimiter.stats(),
    };
  }

  abort(): void { this.abortController?.abort(); }

  // ── Main loop ──

  async run(
    onToken?: (text: string) => void,
    signal?: AbortSignal,
    onToolOutput?: (toolName: string, output: string) => void,
    onCompress?: (phase: string, progress: number) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    this.onCompress = onCompress ?? null;
    const toolDefs = getAllToolDefs();

    if (this.mcpLoader) {
      const mcpTools = await this.mcpLoader.getAllMCPTools();
      const seen = new Set(toolDefs.map((t) => t.name));
      // MCP tool filtering per paradigm:
      //   manual / appraise → exclude ALL Horsewhip MCP tools
      //   constraint / ride → exclude Horsewhip tools that bypass Chitu's verify→commit gates
      const paradigm = this.paradigmState.resolved;
      const blockAllHorsewhip = paradigm === "manual" || paradigm === "appraise";
      const HORSEWHIP_BYPASS_TOOLS = new Set([
        "mcp__horsewhip__horsewhip_task_complete",
        "mcp__horsewhip__horsewhip_finish_auto",
        "mcp__horsewhip__horsewhip_auto_commit",
      ]);
      for (const mt of mcpTools) {
        if (seen.has(mt.name)) continue;
        const isHorsewhip = mt.name.startsWith("mcp__horsewhip__");
        if (blockAllHorsewhip && isHorsewhip) continue;
        if (isHorsewhip && HORSEWHIP_BYPASS_TOOLS.has(mt.name)) continue;
        toolDefs.push(mt); seen.add(mt.name);
      }
    }

    const sysMsg = this.messages.find((m) => m.role === "system");
    this.baselineTokens = estimateTokens(getContentText(sysMsg?.content)) + estimateTokens(JSON.stringify(toolDefs));

    // Model & thinking selection — paradigm-aware
    if (this.taskIntent === "new_feature") {
      this.taskIntent = detectTaskIntent(getContentText(this.messages.find((m) => m.role === "user")?.content));
    }
    const resolved = this.paradigmState.resolved;

    if (this.explicitThinking !== undefined) {
      this.provider.setThinking(this.explicitThinking);
    } else if (resolved === "appraise") {
      this.provider.setThinking(false);
    } else if (resolved === "spur") {
      this.provider.setThinking(false);
    } else {
      if (this.guard && this.taskIntent !== "query") {
        this.provider.setThinking(true);
      } else {
        this.provider.setThinking(false);
      }
    }

    let finalResponse = "";
    let iterations = 0;
    let consecutiveTimeouts = 0;
    let emptyResponseCount = 0;
    let idleRounds = 0;                       // consecutive rounds with only read-only tools
    const MAX_IDLE_ROUNDS = 6;
    const ROUND_TIMEOUT_MS = 900_000; // 15 min — must exceed stream idle timeout (600s); only fires when API call itself hangs beyond recovery
    const MAX_TIMEOUTS = 3;
    const READ_ONLY_TOOLS = new Set([
      "Read", "WebFetch", "WebSearch", "AskUserQuestion",
      "report_progress", "TaskList", "TaskGet",
      "LSP", "horsewhip_get_boundary", "horsewhip_suggest_scope",
    ]);
    const isReadOnlyTool = (name: string): boolean => {
      if (READ_ONLY_TOOLS.has(name)) return true;
      // Handle MCP-prefixed names like mcp__horsewhip__horsewhip_get_boundary
      const lastSep = name.lastIndexOf("__");
      return lastSep >= 0 && READ_ONLY_TOOLS.has(name.slice(lastSep + 2));
    };
    const hardCap = this.maxIterations > 0 ? this.maxIterations : Infinity;

    while (iterations < hardCap) {
      if (signal?.aborted) { finalResponse = finalResponse || "(aborted)"; break; }
      iterations++;
      await this.maybeCompress();

      const roundCtrl = new AbortController();
      let roundTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => roundCtrl.abort(), ROUND_TIMEOUT_MS);
      const roundSignal = signal ? anySignal([signal, roundCtrl.signal]) : roundCtrl.signal;

      let result;
      try {
        result = await this.provider.streamToMessage(
          { model: this.model, messages: this.messages, tools: toolDefs.length > 0 ? toolDefs : undefined },
          onToken, roundSignal, onReasoning,
        );
      } finally { clearTimeout(roundTimer); roundTimer = undefined; }

      if (result.usage) this.lastUsage = result.usage;

      // Handle aborted/timeout
      if (result.aborted) {
        if (signal?.aborted) { finalResponse = result.content || "(aborted)"; this.writeCheckpoint("aborted"); break; }
        // Appraise/manual mode: just return partial content — don't loop with "continue from breakpoint"
        if (this.paradigmState.resolved === "appraise" || this.paradigmState.resolved === "manual") {
          finalResponse = result.content || "(timeout)";
          break;
        }
        consecutiveTimeouts++;
        if (consecutiveTimeouts > MAX_TIMEOUTS) { finalResponse = `(连续 ${MAX_TIMEOUTS} 轮超时，任务中断)`; this.writeCheckpoint("timeout"); break; }
        if (result.content) this.messages.push({ role: "assistant", content: result.content });
        this.messages.push({ role: "user", content: `(上一轮思考超过 ${ROUND_TIMEOUT_MS / 1000}s 超时。请从断点继续，直接完成任务，不要重复已做工作。)` });
        continue;
      }
      consecutiveTimeouts = 0;

      // Empty response
      if (!result.content && result.toolCalls.length === 0) {
        emptyResponseCount++;
        if (emptyResponseCount >= 3) { finalResponse = "(empty response after 3 retries)"; this.writeCheckpoint("empty_response"); break; }
        this.messages.push({ role: "user", content: "Continue. You are not done. Call the next tool or complete_sub_goal." });
        continue;
      }
      emptyResponseCount = 0;

      const assistantMsg: Message = { role: "assistant", content: result.content || null };
      if (result.toolCalls.length > 0) assistantMsg.tool_calls = result.toolCalls;
      if (result.reasoning) assistantMsg.reasoning_content = result.reasoning;
      this.messages.push(assistantMsg);

      if (result.toolCalls.length === 0) { finalResponse = result.content; this.lastFinishReason = result.finishReason; break; }

      // Wire tool progress to watchdog reset — long-running tools (run_shell, compile) stay alive
      this.ctx.onProgress = onToolOutput
        ? (name, _chunk) => onToolOutput(name, "")
        : undefined;
      const toolResults = await this.executeToolCalls(result.toolCalls, signal);
      this.ctx.onProgress = undefined;

      // Constraint mode: intercept complete_sub_goal
      if (this.constraintExecutor) {
        for (let i = 0; i < result.toolCalls.length; i++) {
          const tc = result.toolCalls[i]!;
          if (tc.function.name === "complete_sub_goal") {
            const completed = this.constraintExecutor.ensureBoundary();
            if (completed && !completed.feedback) {
              const gates = this.constraintExecutor.verifyGates(completed.exports, completed.imports);
              this.constraintExecutor.lastGateResult = gates;
              toolResults[i] = gates.ok
                ? { tool_call_id: tc.id, content: JSON.stringify({ ok: true, gate_verified: true, result: this.constraintExecutor.finalize(completed.capability), ...(gates.warnings?.length ? { architecture_warnings: gates.warnings } : {}) }) }
                : { tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: gates.feedback }) };
            } else if (completed?.feedback) {
              toolResults[i] = { tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: completed.feedback }) };
            }
          }
        }
      }

      // Route tool outputs to TUI
      if (onToolOutput) {
        for (let i = 0; i < result.toolCalls.length; i++) {
          const tc = result.toolCalls[i]!;
          const tr = toolResults[i];
          if (!tr) continue;
          if (tc.function.name === "report_progress") {
            try { const args = JSON.parse(tc.function.arguments); onToolOutput("phase", `【${args.message}】`); } catch { /* skip */ }
          } else { onToolOutput(tc.function.name, tr.content); }
        }
      }

      for (const tr of toolResults) this.messages.push({ role: "tool", content: tr.content, tool_call_id: tr.tool_call_id });
      if (result.content) finalResponse = result.content;

      // If AI called ask_user, stop looping — don't let it answer its own question
      if (result.toolCalls.some((tc) => tc.function.name === "ask_user")) break;

      // Idle detection: if all tool calls were read-only, count toward idle limit
      if (result.toolCalls.length > 0 && result.toolCalls.every((tc) => isReadOnlyTool(tc.function.name))) {
        idleRounds++;
        if (idleRounds >= MAX_IDLE_ROUNDS) {
          this.messages.push({
            role: "user",
            content: `(You have been reading files for ${idleRounds} consecutive rounds without making any changes. If you are done, just respond without tool calls. If not, take action — edit, write, or run commands — instead of just reading.)`,
          });
          idleRounds = 0;
        }
      } else {
        idleRounds = 0;
      }

      if (SoulManager.shouldAutoSummarize(++this.soulRoundCounter)) {
        await this.maybeUpdateSoul();
        this.soulRoundCounter = 0;
      }
    }

    return finalResponse || "(task completed)";
  }

  // ── Checkpoint delegation ──

  private writeCheckpoint(reason: string): void { writeCp(this.workspaceRoot, this.messages, reason); }
  loadCheckpoint(): { task: string; reason: string; messages: Message[] } | null { return loadCp(this.workspaceRoot); }
  deleteCheckpoint(): void { deleteCp(this.workspaceRoot); }

  // ── Source file count (cached) ──

  private countSourceFiles(): number {
    const now = Date.now();
    if (now - this._srcCountCache.at < 30000) return this._srcCountCache.value;
    this._srcCountCache = { value: countSrcFiles(this.workspaceRoot), at: now };
    return this._srcCountCache.value;
  }

  // ── Audit event ──

  private writeAuditEvent(type: string, data: Record<string, unknown> = {}): void {
    const auditPath = path.join(this.workspaceRoot, ".git", "horsewhip", "session-audit.json");
    try {
      const auditDir = path.dirname(auditPath);
      if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
      const event = { id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type, timestamp: new Date().toISOString(), task: this.taskId, ...data };
      fs.appendFileSync(auditPath, JSON.stringify(event) + "\n", "utf-8");
    } catch (e) { logger.warn("writeAuditEvent failed", { error: String(e), path: auditPath }); }
  }

  // ── Phased run: grow → trim → verify ──

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
      const userMsg = getContentText(this.messages.find((m) => m.role === "user")?.content);
      this.taskIntent = detectTaskIntent(userMsg);

      if (this.paradigmState.resolved === "ride") {
        finalResult = await this.execute(onToken, signal, onToolOutput, onCompress, onReasoning);
        return { result: finalResult };
      }

      // Phase 1: Grow — decouple mode
      if (this.guard) this.guard.lockDecouple(this.taskId, { writablePaths: [], allowNewFiles: true, allowShellWrite: false });
      finalResult = await this.execute(onToken, signal, onToolOutput, onCompress, onReasoning);
      let blockedFiles = extractBlockedFiles(finalResult);
      let testFailed = detectTestFailure(finalResult);
      this.auditor.writeEvent("phase_complete", { phase: "grow", round: 0 });

      if (!blockedFiles.length && !testFailed) return this.finishPhased(finalResult);

      // Phase 2: Trim loop
      while (round < MAX_PHASED_ROUNDS) {
        round++;
        if (signal.aborted) break;

        const trimFiles = [...new Set([
          ...blockedFiles,
          ...extractNewFiles(finalResult),
          ...extractAllTouchedFiles(finalResult),
        ].filter((f) => isValidPath(f)))];

        if (!trimFiles.length) break;

        if (this.guard) this.guard.lockIntent(this.taskId, trimFiles, undefined, undefined, undefined, { writablePaths: trimFiles, allowNewFiles: false, allowShellWrite: false });

        const trimPrompt = [
          `## Trim Phase — Round ${round}`,
          `The following files were blocked or need fixing:`,
          ...trimFiles.map((f) => `- ${f}`),
          testFailed ? `Tests are failing — fix the test failures too.` : ``,
        ].filter(Boolean).join("\n");
        this.messages.push({ role: "user", content: trimPrompt });
        finalResult = await this.run(onToken, signal, onToolOutput, onCompress, onReasoning);

        // Verify
        if (this.guard) this.guard.lockDecouple(this.taskId, { writablePaths: [], allowNewFiles: false, allowShellWrite: false });
        const verifyPrompt = [
          `## Verify Phase — Round ${round}`,
          `Verify all fixes are complete. If anything is still blocked or failing,`,
          `report it clearly with "BLOCKED by Horsewhip. File: <path>" or "TEST FAILURE: <details>".`,
          `If everything works, respond with "All checks passed."`,
        ].join("\n");
        this.messages.push({ role: "user", content: verifyPrompt });
        finalResult = await this.run(onToken, signal, onToolOutput, onCompress, onReasoning);

        const newBlocked = extractBlockedFiles(finalResult);
        testFailed = detectTestFailure(finalResult);
        if (!newBlocked.length && !testFailed) { this.auditor.writeEvent("phase_complete", { phase: "trim", round }); break; }

        const sameFiles = newBlocked.every((f) => blockedFiles.includes(f));
        if (sameFiles && this.guard) this.guard.expandBoundary(newBlocked, `re-blocked in round ${round}`);
        blockedFiles = newBlocked;
      }
      return this.finishPhased(finalResult);
    } finally { this.abortController = null; }
  }

  private async finishPhased(result: string): Promise<{ result: string }> {
    if (this.guard) this.guard.unlock();
    return { result };
  }

  // ── Paradigm dispatcher ──

  async execute(
    onToken?: (text: string) => void,
    signal?: AbortSignal,
    onToolOutput?: (toolName: string, output: string) => void,
    onCompress?: (phase: string, progress: number) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    switch (this.paradigmState.resolved) {
      case "appraise": return this.executeAsk(onToken, signal, onToolOutput, onCompress, onReasoning);
      case "ride": return this.executeTarget(onToken, signal, onToolOutput, onCompress, onReasoning);
      case "constraint": return this.executeConstraint(onToken, signal, onToolOutput, onCompress, onReasoning);
      case "spur": return this.executeShoot(onToken, signal, onToolOutput, onCompress, onReasoning);
      case "manual": {
        if (this.guard) this.guard.disabled = true;
        try { return await this.run(onToken, signal, onToolOutput, onCompress, onReasoning); }
        finally { if (this.guard) this.guard.disabled = false; }
      }
      default: return this.run(onToken, signal, onToolOutput, onCompress, onReasoning);
    }
  }

  // ── Paradigm: Ask ──

  private async executeAsk(
    onToken?: (text: string) => void, signal?: AbortSignal,
    onToolOutput?: (toolName: string, output: string) => void,
    onCompress?: (phase: string, progress: number) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    const hadGuard = !!this.guard;
    if (this.guard) this.guard.lockDecouple(this.taskId, { writablePaths: [], allowNewFiles: false, allowShellWrite: false });
    try {
      if (this.explicitThinking === undefined) this.provider.setThinking(false);
      return await this.run(onToken, signal, onToolOutput, onCompress, onReasoning);
    } finally { if (hadGuard && this.guard) this.guard.unlock(); }
  }

  // ── Paradigm: Target ──

  private async executeTarget(
    onToken?: (text: string) => void, signal?: AbortSignal,
    onToolOutput?: (toolName: string, output: string) => void,
    onCompress?: (phase: string, progress: number) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    const executor = new TargetExecutor(this, this.workspaceRoot);
    return await executor.execute({ onToken, signal, onToolOutput, onCompress, onReasoning, yunchang: this.yunchang });
  }

  // ── Paradigm: Constraint ──

  private async executeConstraint(
    onToken?: (text: string) => void, signal?: AbortSignal,
    onToolOutput?: (toolName: string, output: string) => void,
    onCompress?: (phase: string, progress: number) => void,
    onReasoning?: (text: string) => void,
    mode?: import("./types.js").ConstraintMode,
  ): Promise<string> {
    const MAX_ITERATIONS = 30;
    const executor = new ConstraintExecutor(this, this.workspaceRoot, mode ?? "creation");
    this.constraintExecutor = executor;
    try {
      let cp = this.loadCheckpoint();

      // ── Intent detection (always, regardless of checkpoint) ──
      // Use LLM to classify: "chat" (question/feedback/discussion) vs "task" (coding task).
      // Chat → respond naturally, no iteration. Task → constraint workflow.
      // Intent is persisted to .chitu/context/intent.json.
      const lastUserMsg = [...this.messages].reverse().find((m) => m.role === "user");
      const userText = lastUserMsg && typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";
      const userIntent = await this.classifyIntent(userText);

      // Persist intent for context cache
      try {
        const ctxDir = path.join(this.workspaceRoot, ".chitu", "context");
        if (!fs.existsSync(ctxDir)) fs.mkdirSync(ctxDir, { recursive: true });
        fs.writeFileSync(path.join(ctxDir, "intent.json"), JSON.stringify({
          type: userIntent,
          message: userText.slice(0, 500),
          timestamp: new Date().toISOString(),
        }, null, 2), "utf-8");
      } catch { /* best-effort */ }

      if (userIntent === "chat") {
        // Chat mode: respond naturally, no boundary locking, no iteration loop
        // Clear any leftover expand state from previous iterations
        this.pendingExpandRequest = null;
        this.pendingExpandApproved = null;
        executor.pendingExpand = null;
        // Do NOT restore checkpoint — keep current messages so the model sees the user's actual chat.
        // (The checkpoint stays on disk for a future "继续" to resume.)
        // Inject chat-mode instruction so the model doesn't continue previous task
        this.messages.push({
          role: "user",
          content: [
            "The user's message above is conversational — a question, feedback, or chat.",
            "Do NOT call any Horsewhip tools (horsewhip_lock_intent, horsewhip_expand_boundary, etc.).",
            "Do NOT start the constraint workflow. Do NOT edit files.",
            "Just respond naturally and concisely to what the user said.",
          ].join("\n"),
        });
        const result = await this.run(onToken, signal, onToolOutput, onCompress, onReasoning);
        return result || "(response)";
      }

      // ── Task mode: full constraint workflow ──
      // Only restore checkpoint for explicit continuation signals.
      // For new tasks, discard stale checkpoint so the model focuses on the new task.
      const isContinuation = /^(继续|go\s*ahead|proceed|ok\s*start|开始吧|开工|干活)\s*$/i.test(userText.trim());
      if (cp && isContinuation) {
        const sysMsg = this.messages[0];
        this.messages = sysMsg ? [sysMsg, ...cp.messages] : cp.messages;
      } else if (cp) {
        // New task — stale checkpoint, discard it. Clear any leftover expand state too.
        deleteCp(this.workspaceRoot);
        cp = null;
        this.pendingExpandRequest = null;
        this.pendingExpandApproved = null;
      }
      executor.setup();

      // If returning from a pending expand approval, apply it now
      if (this.pendingExpandRequest) {
        const pending = this.pendingExpandRequest;
        this.pendingExpandRequest = null;
        if (this.pendingExpandApproved === true) {
          this.pendingExpandApproved = null;
          this.guard?.expandBoundary(pending.paths, pending.reason);
          executor.recordExpand(pending.paths, pending.reason);
          this.messages.push({
            role: "user",
            content: `Boundary expanded to include: ${pending.paths.join(", ")}. Reason: ${pending.reason}. Proceed with the expanded boundary.`,
          });
        } else {
          this.pendingExpandApproved = null;
          this.messages.push({
            role: "user",
            content: `Boundary expansion was NOT approved. Do NOT modify files outside your original boundary. Respond briefly and wait for the next instruction.`,
          });
        }
      }

      // Unless resuming, ask AI to understand and discuss before locking
      if (!cp) {
        this.messages.push({
          role: "user",
          content: [
            "Take time to understand the task first. **Read the actual source files** (not just interface docs) to understand the current implementation.",
            "If the user reports a bug, trace the code path — don't just fix the symptom. Look for related issues: similar patterns elsewhere may have the same bug.",
            "",
            "If anything is unclear, ask me. If there are multiple valid approaches, use `ask_user` to let me choose.",
            "",
            "Describe your understanding and proposed approach, then call `horsewhip_lock_intent` to declare your boundary and start working. Do NOT wait for confirmation — proceed automatically.",
          ].join("\n"),
        });
      }

      let finalResult = "";
      let iterationCount = 0;
      let gateFailures: string[] = [];        // accumulate gate feedback across rounds (survives compact)
      let compactRounds = 0;                  // times we've compacted on this iteration
      let lastGateFailureHash = "";           // detect staleness — same failure repeating
      let sameFailureStreak = 0;
      let autoRestartCount = 0;               // times we've auto-restarted (compacted + retried) across all iterations
      const MAX_AUTO_RESTARTS = 12;           // hard cap — prevent infinite restart loops

      let discussionPhase = !cp;           // first entry without checkpoint = discussion phase

      while (iterationCount < MAX_ITERATIONS) {
        iterationCount++;
        let iterationSucceeded = false;
        let aiAskedUser = false;
        let gateAttempts = 0;
        let stillWorkingRounds = 0;          // consecutive "still working" rounds without gate attempt
        let textOnlyRounds = 0;             // consecutive text-only (no tool call) responses — auto-restart

        // Dynamic limits: tighten as more sub-goals complete
        executor.maxAttempts = executor.completedIterations < 2 ? 3 : 2;
        const maxCompactRounds = executor.completedIterations < 2 ? 3 :
                                  executor.completedIterations < 5 ? 2 : 1;

        // Inner loop: keep running until sub-goal done, user input needed, or gates exhaust retries.
        // "Still working" (no complete_sub_goal yet) does NOT consume a gate attempt.
        while (gateAttempts < executor.maxAttempts) {
          const t0 = Date.now();
          const result = await this.run(onToken, signal, onToolOutput, onCompress, onReasoning);
          this.constraintLog(`run() → ${Date.now() - t0}ms, msgs=${this.messages.length}, tok=${this.lastUsage?.totalTokens ?? "?"}, finish=${this.lastFinishReason ?? "?"}`);
          if (signal?.aborted) { this.constraintLog("signal aborted"); onToolOutput?.("phase", "【约束模式已中断】"); executor.rollback(); return result || "【约束模式已中断】"; }

          // If AI called expand_boundary, pause for human approval (TUI shows selection dialog)
          // Must check BEFORE iterationCompleted — expand approval takes priority over commit
          if (executor.pendingExpand) {
            this.pendingExpandRequest = executor.pendingExpand;
            const pe = executor.pendingExpand;
            onToolOutput?.("expand_approval", JSON.stringify({ paths: pe.paths, reason: pe.reason }));
            return finalResult || "(awaiting expand approval)";
          }

          if (executor.iterationCompleted) {
            iterationSucceeded = true;
            finalResult = result;
            break;
          }

          // If AI called ask_user, pause and wait for user response
          const lastAssistant = [...this.messages].reverse().find((m) => m.role === "assistant");
          if (lastAssistant?.tool_calls?.some((tc) => tc.function.name === "ask_user")) {
            aiAskedUser = true;
            finalResult = result;
            break;
          }

          // Discussion phase: AI described approach, now auto-confirm and move to execution
          if (discussionPhase) {
            discussionPhase = false;
            const lastAst = [...this.messages].reverse().find((m) => m.role === "assistant");
            const calledLockIntent = lastAst?.tool_calls?.some((tc) =>
              tc.function.name === "mcp__horsewhip__horsewhip_lock_intent" ||
              tc.function.name === "horsewhip_lock_intent"
            );
            if (!calledLockIntent) {
              // AI described without locking — nudge to lock and proceed
              this.messages.push({
                role: "user",
                content: "Call `horsewhip_lock_intent` to declare your boundary and start working.",
              });
            }
            continue;
          }

          // If run() already verified gates (via complete_sub_goal interception), use that result.
          // This avoids double-verification: once in run() and once here.
          const preGates = executor.lastGateResult;
          executor.lastGateResult = null;

          if (preGates) {
            stillWorkingRounds = 0;
            textOnlyRounds = 0;
            if (preGates.ok) {
              // finalize() was already called in run() interception
              if (executor.iterationCompleted) {
                iterationSucceeded = true;
                finalResult = result;
                break;
              }
              // iterationCompleted should be true; if not, finalize here
              const completed = executor.ensureBoundary();
              if (completed && !completed.feedback) {
                const final = executor.finalize(completed.capability);
                this.deleteCheckpoint();
                iterationSucceeded = true;
                finalResult = `${result}\n\n${final}`;
                break;
              }
            }
            // Gate failure — already reported as tool result, just track it
            gateAttempts++;
            const failureSig = preGates.feedback.split("\n")[0]?.replace(/`[^`]*`/g, "_").trim() ?? "";
            if (failureSig === lastGateFailureHash) {
              sameFailureStreak++;
            } else {
              lastGateFailureHash = failureSig;
              sameFailureStreak = 0;
            }
            gateFailures.push(preGates.feedback);
            continue;
          }

          const completed = executor.ensureBoundary();
          if (!completed) {
            // If AI responded with text only (no tool calls), it may have been truncated mid-response.
            // Constraint mode is autonomous — auto-restart, don't return to TUI.
            const lastAssistant = [...this.messages].reverse().find((m) => m.role === "assistant");
            const hadToolCalls = lastAssistant?.tool_calls && lastAssistant.tool_calls.length > 0;
            if (!hadToolCalls) {
              this.constraintLog(`text-only #${textOnlyRounds + 1} (finish=${this.lastFinishReason ?? "?"}, msgs=${this.messages.length})`);
              // Empty response is also a signal to restart
              if (!result) {
                textOnlyRounds++;
                onToolOutput?.("phase", `【AI 响应为空 — 自动重启中（${textOnlyRounds}/3）】`);
                this.messages.push({ role: "user", content: "Your response was empty. Continue working — call your tools or `complete_sub_goal` when done." });
                continue;
              }
              textOnlyRounds++;
              const wasTruncated = this.lastFinishReason === "length";
              const maxTextOnly = 3; // fewer rounds before surfacing to user
              onToolOutput?.("phase", `【AI 纯文本响应 — 自动重启中（${textOnlyRounds}/${maxTextOnly}）${wasTruncated ? "，token 截断" : ""}】`);
              if (textOnlyRounds >= maxTextOnly) {
                let hasChanges = false;
                try {
                  const diffOut = execSync("git diff HEAD --name-only 2>/dev/null", {
                    cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
                  }).trim();
                  hasChanges = diffOut.length > 0;
                } catch { /* can't check */ }
                if (!hasChanges) {
                  // Auto-restart: compact context, reset, and keep fighting
                  autoRestartCount++;
                  this.constraintLog(`auto-restart #${autoRestartCount}: text-only exhaustion (${textOnlyRounds} rounds, no changes)`);
                  if (autoRestartCount >= MAX_AUTO_RESTARTS) {
                    this.constraintLog("auto-restart LIMIT reached, surrendering");
                    executor.rollback();
                    onToolOutput?.("phase", `【约束模式暂停 — 已自动重启 ${autoRestartCount} 次，达上限。请给出指示后继续。】`);
                    return finalResult || "【约束模式暂停 — 自动重启耗尽】";
                  }
                  onToolOutput?.("phase", `【约束模式自动重启 — 连续 ${textOnlyRounds} 轮纯文本无变更，压缩上下文后重试（${autoRestartCount}/${MAX_AUTO_RESTARTS}）】`);
                  const compactState = executor.buildCompactState("");
                  this.compactMessages(compactState);
                  executor.refreshContext();
                  executor.retryIteration();
                  iterationCount--;
                  gateAttempts = 0;
                  gateFailures = [];
                  compactRounds = 0;
                  lastGateFailureHash = "";
                  sameFailureStreak = 0;
                  textOnlyRounds = 0;
                  stillWorkingRounds = 0;
                  continue;
                }
                this.messages.push({
                  role: "user",
                  content: `You have file changes pending but haven't called \`complete_sub_goal\` after ${textOnlyRounds} text-only rounds. STOP TYPING and call \`complete_sub_goal\` NOW to commit your work.`,
                });
                continue;
              }
              // Scan recent tool results for BLOCKED responses from Horsewhip
              const recentBlocked = this.messages.slice(-10).some((m) =>
                m.role === "tool" && typeof m.content === "string" && /BLOCKED by Horsewhip/i.test(m.content)
              );
              if (wasTruncated) {
                this.messages.push({
                  role: "user",
                  content: `You were cut off by the token limit. Continue EXACTLY where you left off. Then call \`complete_sub_goal\` or continue with your tools.`,
                });
              } else if (recentBlocked) {
                this.messages.push({
                  role: "user",
                  content: `A recent tool call was BLOCKED by Horsewhip. You MUST call \`horsewhip_expand_boundary\` to request access to those files. Do NOT describe the problem — call the tool NOW.`,
                });
              } else if (textOnlyRounds >= 2) {
                this.messages.push({
                  role: "user",
                  content: `You've given ${textOnlyRounds} text-only responses. CALL YOUR TOOLS — \`complete_sub_goal\` to commit, or edit/run tools to continue. Stop typing.`,
                });
              } else {
                this.messages.push({
                  role: "user",
                  content: "Your last response was text-only — you may have been cut off. If you have more to say or work to do, continue now. If the response is complete, call `complete_sub_goal` to save your work.",
                });
              }
              continue;
            }

            stillWorkingRounds++;
            if (stillWorkingRounds >= 4) {
              autoRestartCount++;
              this.constraintLog(`auto-restart #${autoRestartCount}: still-working (${stillWorkingRounds} rounds without complete_sub_goal)`);
              if (autoRestartCount >= MAX_AUTO_RESTARTS) {
                this.constraintLog("auto-restart LIMIT reached, surrendering");
                executor.rollback();
                onToolOutput?.("phase", `【约束模式暂停 — 已自动重启 ${autoRestartCount} 次，达上限。请给出指示后继续。】`);
                return finalResult || "【约束模式暂停 — 自动重启耗尽】";
              }
              onToolOutput?.("phase", `【约束模式自动重启 — AI 连续 ${stillWorkingRounds} 轮未调用 complete_sub_goal，压缩上下文后重试（${autoRestartCount}/${MAX_AUTO_RESTARTS}）】`);
              const compactState = executor.buildCompactState("");
              this.compactMessages(compactState);
              executor.refreshContext();
              executor.retryIteration();
              iterationCount--;
              gateAttempts = 0;
              gateFailures = [];
              compactRounds = 0;
              lastGateFailureHash = "";
              sameFailureStreak = 0;
              stillWorkingRounds = 0;
              textOnlyRounds = 0;
              continue;
            }
            this.messages.push({
              role: "user",
              content: "You have not called `complete_sub_goal` yet. Call `complete_sub_goal` with your exports/imports to trigger git commit and save your work. Otherwise continue working.",
            });
            continue;
          }
          stillWorkingRounds = 0; // reset — AI called complete_sub_goal
          textOnlyRounds = 0;
          if (completed.feedback) { this.messages.push({ role: "user", content: completed.feedback }); continue; }

          // Fallback: gates not pre-verified in run() interception (shouldn't normally happen)
          const gates = executor.verifyGates(completed.exports, completed.imports);
          if (gates.ok) {
            const final = executor.finalize(completed.capability);
            this.deleteCheckpoint();
            iterationSucceeded = true;
            finalResult = `${result}\n\n${final}`;
            break;
          }
          // Gate failure — THIS consumes an attempt
          gateAttempts++;
          const failureSig = gates.feedback.split("\n")[0]?.replace(/`[^`]*`/g, "_").trim() ?? "";
          if (failureSig === lastGateFailureHash) {
            sameFailureStreak++;
          } else {
            lastGateFailureHash = failureSig;
            sameFailureStreak = 0;
          }
          gateFailures.push(gates.feedback);
          this.messages.push({ role: "user", content: gates.feedback });
        }

        if (signal?.aborted) {
          const doneCount = iterationCount - (iterationSucceeded ? 0 : 1);
          const doneNote = doneCount > 0 ? `（已成功提交 ${doneCount} 轮迭代）` : "";
          onToolOutput?.("phase", `【约束模式已中断】${doneNote}`);
          return finalResult || "【约束模式已中断】";
        }
        if (aiAskedUser) {
          onToolOutput?.("phase", `【约束模式暂停 — AI 需要你的输入，请在下方回复后继续】`);
          return finalResult || "(awaiting input)";
        }
        // Bail on consecutive identical gate failures — AI is stuck.
        // But if files actually changed (git diff non-empty), AI is trying different approaches — reset streak.
        if (sameFailureStreak >= 2) {
          let hasChanges = false;
          try {
            const diffOut = execSync("git diff HEAD --name-only 2>/dev/null", {
              cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
            }).trim();
            hasChanges = diffOut.length > 0;
          } catch { /* can't check, proceed with bail */ }
          if (hasChanges) {
            sameFailureStreak = 0;
            lastGateFailureHash = "";
          } else {
            autoRestartCount++;
            this.constraintLog(`auto-restart #${autoRestartCount}: same-failure streak (${sameFailureStreak + 1} identical gate failures, no changes)`);
            if (autoRestartCount >= MAX_AUTO_RESTARTS) {
              this.constraintLog("auto-restart LIMIT reached, surrendering");
              const doneCount = iterationCount - 1;
              const doneNote = doneCount > 0 ? `（前 ${doneCount} 轮迭代已成功提交）` : "";
              onToolOutput?.("phase", `【约束模式暂停 — 已自动重启 ${autoRestartCount} 次，达上限。请给出指示后继续。】${doneNote}`);
              executor.rollback();
              return finalResult || "【约束模式暂停 — 自动重启耗尽】";
            }
            const doneCount = iterationCount - 1;
            const doneNote = doneCount > 0 ? `（前 ${doneCount} 轮迭代已成功提交）` : "";
            onToolOutput?.("phase", `【约束模式自动重启 — 连续 ${sameFailureStreak + 1} 次相同 gate 失败，压缩上下文后重试（${autoRestartCount}/${MAX_AUTO_RESTARTS}）】${doneNote}`);
            const compactState = executor.buildCompactState("");
            this.compactMessages(compactState);
            executor.refreshContext();
            executor.retryIteration();
            iterationCount--;
            gateAttempts = 0;
            gateFailures = [];
            compactRounds = 0;
            lastGateFailureHash = "";
            sameFailureStreak = 0;
            textOnlyRounds = 0;
            stillWorkingRounds = 0;
            continue;
          }
        }
        if (!iterationSucceeded) {
          compactRounds++;
          if (compactRounds >= maxCompactRounds) {
            // Dynamic: early sub-goals get more retries, later sub-goals fewer
            const doneCount = iterationCount - 1;
            const doneNote = doneCount > 0 ? `（前 ${doneCount} 轮迭代已成功提交）` : "";
            onToolOutput?.("phase", `【约束模式失败 — 第 ${iterationCount} 轮迭代 ${maxCompactRounds * executor.maxAttempts} 次尝试未通过 gates 验证，已尽最大努力】${doneNote}`);
            executor.rollback();
            return finalResult || "【约束模式失败 — 迭代耗尽】";
          }
          // Compact context and retry same iteration — AI gets fresh context + accumulated failures
          const compactState = executor.buildCompactState("");
          this.compactMessages(compactState);
          executor.refreshContext();
          executor.retryIteration(); // reset attempts counter, keep gate failures
          iterationCount--;         // don't count this as a completed iteration
          const totalFails = gateFailures.length;
          const failedGates = gateFailures.map((g, i) => `${i + 1}. ${g.replace(/## /g, "").split("\n")[0]}`).join("\n");
          this.messages.push({
            role: "user",
            content: `## Retry — gates failed ${totalFails} time(s)\n\nPrevious failures:\n${failedGates}\n\nFix the source code so that exports/imports match what \`complete_sub_goal\` declares, tests pass, and actual changes exist. Then call \`complete_sub_goal\` again.`,
          });
          gateFailures = [];
          onToolOutput?.("phase", `【第 ${iterationCount} 轮迭代压缩重试 — gates 已失败 ${totalFails} 次，正在修复源码…】`);
          continue;
        }

        // Reset failure tracking for next iteration
        this.constraintLog(`iteration ${iterationCount} SUCCEEDED (${executor.completedIterations} total sub-goals done)`);
        gateFailures = [];
        compactRounds = 0;
        lastGateFailureHash = "";
        sameFailureStreak = 0;

        // Every 3 completed sub-goals: trigger architecture review checkpoint
        if (executor.completedIterations > 0 && executor.completedIterations % 3 === 0) {
          this.messages.push({
            role: "user" as const,
            content: [
              "## Architecture Review Checkpoint",
              "",
              `You have completed ${executor.completedIterations} sub-goals. Before the next task, take a step back and review the architecture:`,
              "",
              "1. **Read all recently modified files** (use `git diff HEAD~3 --name-only` or `search_interfaces` to find them).",
              "2. Answer these questions:",
              "   - Is any validation/security logic inline in route handlers? If yes, extract it.",
              "   - Are there files with >5 functions mixing different responsibilities? If yes, split them.",
              "   - Is there shared logic duplicated across files? If yes, extract a shared module.",
              "3. **Write findings to `.chitu/plans/architecture-review.md`** — be specific: file names, line ranges, recommended actions.",
              "4. If fixes are needed: call `horsewhip_lock_intent` with the affected files, make the changes, then `complete_sub_goal`.",
              "5. If architecture is clean: call `complete_sub_goal` with an empty boundary to signal the review is done and continue to the next task.",
              "",
              "This review IS your next sub-goal. Treat it as real work — the architecture score matters.",
            ].join("\n"),
          });
        }

        // Reset completion flag so the next iteration's inner loop doesn't immediately break.
        // (finalize() sets this to true; it must be false at the start of each new iteration.)
        executor.iterationCompleted = false;

        // Detect completion: if AI says all done without locking new files, stop
        const doneSignals = /(?:全部完成|所有.*完成|项目.*完结|全量交付|all\s*(?:done|complete|delivered)|no\s*more|nothing\s*(?:left|more)|已完结|静候|等待.*(?:新|下一))/i;
        const lastAssistantMsg = [...this.messages].reverse().find((m) => m.role === "assistant");
        const lastAssistantText = lastAssistantMsg && typeof lastAssistantMsg.content === "string" ? lastAssistantMsg.content : "";
        const calledLockIntent = lastAssistantMsg?.tool_calls?.some((tc) =>
          tc.function.name === "mcp__horsewhip__horsewhip_lock_intent" ||
          tc.function.name === "horsewhip_lock_intent"
        );
        if (doneSignals.test(lastAssistantText) && !calledLockIntent) {
          onToolOutput?.("phase", `【约束模式完成 — 共完成 ${iterationCount} 轮迭代，AI 报告任务已全部交付】`);
          return finalResult || "【约束模式完成】";
        }

        this.messages.push({
          role: "user",
          content: `${finalResult}\n\nIf there are more sub-goals, continue. If all tasks are complete, reply with a brief summary — do NOT call \`complete_sub_goal\` and do NOT loop.`,
        });
      }
      onToolOutput?.("phase", `【约束模式完成 — 共完成 ${iterationCount} 轮迭代，所有 sub-goal 已处理】`);
      return finalResult || "【约束模式完成 — 达最大迭代上限】";
    } finally { this.constraintExecutor = null; }
  }

  // ── Paradigm: Shoot ──

  private async executeShoot(
    onToken?: (text: string) => void, signal?: AbortSignal,
    onToolOutput?: (toolName: string, output: string) => void,
    onCompress?: (phase: string, progress: number) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    const userMsg = getContentText(this.messages.find((m) => m.role === "user")?.content);
    const files = extractFilePathsFn(userMsg);
    if (files.length === 0) {
      return ["(Shoot mode: no file path found in your message.)", "Specify at least one file path, e.g.:", "  `修改 src/foo.ts 把 login 函数改成 async`"].join("\n");
    }

    const hadGuard = !!this.guard;
    if (this.guard) this.guard.lockIntent(this.taskId, files, undefined, undefined, undefined, { writablePaths: files, allowNewFiles: false, allowShellWrite: true });

    try {
      const result = await this.run(onToken, signal, onToolOutput, onCompress, onReasoning);
      const blocked = extractBlockedFiles(result);
      for (const f of new Set(blocked)) { if (this.guard) this.guard.expandBoundary([f], "shoot: auto-expand"); }
      return result;
    } finally { if (hadGuard && this.guard) this.guard.unlock(); }
  }

  // ── Tool execution (delegated) ──

  private buildToolExecContext(signal?: AbortSignal): ToolExecContext {
    return {
      rateLimiter: this.rateLimiter,
      mcpLoader: this.mcpLoader,
      toolHandlers: this.toolHandlers,
      horsewhipGuard: this.horsewhipGuard!,
      guard: this.guard,
      auditor: this.auditor,
      workspaceRoot: this.workspaceRoot,
      paradigmState: this.paradigmState,
      constraintExecutor: this.constraintExecutor,
      messages: this.messages,
      abortSignal: signal,
    };
  }

  private async executeToolCalls(toolCalls: ToolCall[], signal?: AbortSignal): Promise<ToolResult[]> {
    return execTools(this.buildToolExecContext(signal), toolCalls);
  }

  // ── Context compression ──

  private compressRound = 0;

  private async maybeCompress(): Promise<void> {
    const estimatedTokens = estimateContextTokens(this.messages);
    if (estimatedTokens < MAX_CONTEXT_TOKENS * COMPRESS_THRESHOLD) return;

    const yield_ = () => new Promise<void>((r) => setImmediate(r));

    const systemMsg = this.messages[0];
    const keepCount = 8;

    let start = Math.max(1, this.messages.length - keepCount);
    while (start < this.messages.length) {
      const cur = this.messages[start];
      if (cur?.role === "assistant" && cur.tool_calls?.length) {
        start++;
        while (start < this.messages.length && this.messages[start]?.role === "tool") start++;
      } else if (cur?.role === "tool") { start++; }
      else { break; }
    }
    // Fallback: never discard everything
    if (start >= this.messages.length) {
      start = Math.max(1, this.messages.length - 2);
      if (start < this.messages.length && this.messages[start]?.role === "tool") {
        start = Math.max(1, start - 1);
      }
    }

    // Archive removed messages
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

        let title = "";
        for (let i = removed.length - 1; i >= 0; i--) {
          if (removed[i]?.role === "user" && removed[i]?.content) {
            title = getContentText(removed[i]!.content!)
              .replace(/[\n\r/:\\*?"<>|]/g, " ")
              .replace(/\s+/g, " ").trim().slice(0, 60);
            break;
          }
        }
        if (!title) title = "compressed";

        const now = new Date();
        const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const archiveFile = path.join(ctxDir, `${ts}_${title}.json`);

        this.onCompress?.("archive", 50);
        await yield_();
        fs.writeFileSync(archiveFile, JSON.stringify({
          sessionId: this.sessionId, round: this.compressRound,
          compressedAt: now.toISOString(), title,
          estimatedTokens, messageCount: removed.length, messages: removed,
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
      if (m?.role === "user") middleSummaries.push(`[User]: ${(m.content ?? "").slice(0, 200)}`);
      else if (m?.role === "assistant" && m.content) middleSummaries.push(`[Assistant]: ${m.content.slice(0, 200)}`);
      else if (m?.role === "tool") middleSummaries.push(`[Tool result]: ${(m.content ?? "").slice(0, 100)}`);
    }

    const summary = `[Context compressed: ${middleSummaries.length} messages summarized]\n\n${middleSummaries.join("\n")}`;
    if (systemMsg) this.messages = [systemMsg, { role: "user", content: summary }, ...recent];

    this.onCompress?.("done", 100);
    await yield_();
  }

  /** Use LLM to classify user intent: "chat" (respond naturally) or "task" (constraint workflow). */
  private async classifyIntent(text: string): Promise<"chat" | "task"> {
    const t = text.trim();
    if (!t) return "chat";
    if (/^\/\w+/.test(t)) return "chat";

    try {
      const result = await this.provider.chat({
        model: this.model,
        messages: [
          { role: "system", content: INTENT_CLASSIFY_PROMPT },
          { role: "user", content: t.slice(0, 1000) },
        ],
        max_tokens: 10,
        temperature: 0,
      });
      const label = (result.choices[0]?.message?.content ?? "").trim().toLowerCase();
      if (/\bchat\b|聊天|对话|提问|问题|讨论|问答|咨询|闲聊/i.test(label)) return "chat";
      if (/\btask\b|任务|执行|工作|编码|实现|继续/i.test(label)) return "task";
      return "chat";
    } catch {
      return "chat";
    }
  }
}

// ── Intent classifier for constraint mode ──

const INTENT_CLASSIFY_PROMPT = [
  "Classify user messages. Reply with EXACTLY ONE word: `chat` or `task`.",
  "",
  "`chat` — the user is conversing: asking a question, giving feedback, greeting, or just talking.",
  "`task` — the user wants autonomous coding work: a coding instruction, continuation signal, or work request.",
  "",
  "Examples:",
  "能听明白我说话了吗 → chat",
  "能听到了吗 → chat",
  "你能听见我说话吗 → chat",
  "你听得到吗 → chat",
  "chitu → chat",
  "你好 → chat",
  "在吗 → chat",
  "答非所问 → chat",
  "莫名其妙 → chat",
  "这个是怎么实现的 → chat",
  "为什么改了那个文件 → chat",
  "感觉不太对 → chat",
  "这是什么意思 → chat",
  "",
  "继续 → task",
  "帮我创建一个用户API → task",
  "修复login的bug → task",
  "重构src/agent.ts → task",
  "添加表单验证 → task",
  "build the auth module → task",
  "go ahead → task",
  "",
  "If the user is just talking to you, say `chat`. Only say `task` when they clearly want code work done.",
].join("\n");

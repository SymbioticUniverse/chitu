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
import * as fs from "node:fs";
import * as path from "node:path";
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
  getContextCharCount,
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
  private onCompress: ((phase: string, progress: number) => void) | null = null;
  private soulRoundCounter = 0;
  private baselineTokens = 0;
  private explicitThinking: boolean | undefined;
  private paradigm: Paradigm = "ride";
  private paradigmState: ParadigmState = { active: "ride", resolved: "ride" };
  private yunchang = false;
  constraintExecutor: ConstraintExecutor | null = null;
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
    this.maxIterations = config.maxIterations ?? 50;
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
    const ROUND_TIMEOUT_MS = 300_000;
    const MAX_TIMEOUTS = 3;

    while (iterations < this.maxIterations) {
      if (signal?.aborted) { finalResponse = finalResponse || "(aborted)"; break; }
      iterations++;
      await this.maybeCompress();

      const roundCtrl = new AbortController();
      let roundTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => roundCtrl.abort(), ROUND_TIMEOUT_MS);
      const roundSignal = signal ? anySignal([signal, roundCtrl.signal]) : roundCtrl.signal;

      let result;
      try {
        result = await this.provider.streamToMessage(
          { model: this.model, messages: this.messages, tools: toolDefs.length > 0 ? toolDefs : undefined, max_tokens: 4096 },
          onToken, roundSignal, onReasoning,
        );
      } finally { clearTimeout(roundTimer); roundTimer = undefined; }

      if (result.usage) this.lastUsage = result.usage;

      // Handle aborted/timeout
      if (result.aborted) {
        if (signal?.aborted) { finalResponse = result.content || "(aborted)"; this.writeCheckpoint("aborted"); break; }
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

      if (result.toolCalls.length === 0) { finalResponse = result.content; break; }

      const toolResults = await this.executeToolCalls(result.toolCalls);

      // Constraint mode: intercept complete_sub_goal
      if (this.constraintExecutor) {
        for (let i = 0; i < result.toolCalls.length; i++) {
          const tc = result.toolCalls[i]!;
          if (tc.function.name === "complete_sub_goal") {
            const completed = this.constraintExecutor.ensureBoundary();
            if (completed && !completed.feedback) {
              const gates = this.constraintExecutor.verifyGates(completed.exports, completed.imports);
              toolResults[i] = gates.ok
                ? { tool_call_id: tc.id, content: JSON.stringify({ ok: true, gate_verified: true, result: this.constraintExecutor.finalize(completed.capability) }) }
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
      const cp = this.loadCheckpoint();
      if (cp) { const sysMsg = this.messages[0]; this.messages = sysMsg ? [sysMsg, ...cp.messages] : cp.messages; }
      executor.setup();

      // Unless resuming, ask AI to describe approach before locking
      if (!cp) {
        this.messages.push({
          role: "user",
          content: "Before you start, briefly describe your approach in 1-2 sentences. If there are multiple valid ways to do this, use `ask_user` to let me choose. Then call `horsewhip_lock_intent` to declare your boundary.",
        });
      }

      let finalResult = "";
      let iterationCount = 0;
      let gateFailures: string[] = [];        // accumulate gate feedback across rounds (survives compact)
      let compactRounds = 0;                  // times we've compacted on this iteration
      let lastGateFailureHash = "";           // detect staleness — same failure repeating
      let sameFailureStreak = 0;

      while (iterationCount < MAX_ITERATIONS) {
        iterationCount++;
        let iterationSucceeded = false;
        let aiAskedUser = false;
        let gateAttempts = 0;

        // Inner loop: keep running until sub-goal done, user input needed, or gates exhaust retries.
        // "Still working" (no complete_sub_goal yet) does NOT consume a gate attempt.
        while (gateAttempts < executor.maxAttempts) {
          const result = await this.run(onToken, signal, onToolOutput, onCompress, onReasoning);
          if (signal?.aborted) { executor.rollback(); return result || "(aborted)"; }

          if (executor.iterationCompleted) {
            iterationSucceeded = true;
            finalResult = result;
            break;
          }

          // If AI called ask_user, pause and wait for user response
          const lastMsg = this.messages[this.messages.length - 1];
          if (lastMsg?.role === "assistant" && lastMsg.tool_calls?.some((tc) => tc.function.name === "ask_user")) {
            aiAskedUser = true;
            finalResult = result;
            break;
          }

          const completed = executor.ensureBoundary();
          if (!completed) {
            // AI still working — nudge to call complete_sub_goal when ready
            this.messages.push({
              role: "user",
              content: "You have not called `complete_sub_goal` yet. If this sub-goal is done, call `complete_sub_goal` with your exports/imports. Otherwise continue working.",
            });
            continue;
          }
          if (completed.feedback) { this.messages.push({ role: "user", content: completed.feedback }); continue; }

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
          return finalResult || "(aborted)";
        }
        if (aiAskedUser) {
          onToolOutput?.("phase", `【约束模式暂停 — AI 需要你的输入，请在下方回复后继续】`);
          return finalResult || "(awaiting input)";
        }
        // Bail on consecutive identical gate failures — AI is stuck
        if (sameFailureStreak >= 2) {
          const doneCount = iterationCount - 1;
          const doneNote = doneCount > 0 ? `（前 ${doneCount} 轮迭代已成功提交）` : "";
          onToolOutput?.("phase", `【约束模式暂停 — 连续 ${sameFailureStreak + 1} 次相同 gate 失败，AI 未做出有效修改。请给出更明确的指示后继续。】${doneNote}`);
          executor.rollback();
          return finalResult || "(task incomplete)";
        }
        if (!iterationSucceeded) {
          compactRounds++;
          if (compactRounds >= 3) {
            // 3 compaction rounds × 3 attempts = 9 total tries — truly give up
            const doneCount = iterationCount - 1;
            const doneNote = doneCount > 0 ? `（前 ${doneCount} 轮迭代已成功提交）` : "";
            onToolOutput?.("phase", `【约束模式失败 — 第 ${iterationCount} 轮迭代 9 次尝试未通过 gates 验证，已尽最大努力】${doneNote}`);
            executor.rollback();
            return finalResult || "(task incomplete)";
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
        gateFailures = [];
        compactRounds = 0;
        lastGateFailureHash = "";
        sameFailureStreak = 0;

        this.messages.push({
          role: "user",
          content: `${finalResult}\n\nContinue with the next sub-goal. If all tasks are complete, reply with a brief summary (do NOT call \`complete_sub_goal\`).`,
        });
      }
      onToolOutput?.("phase", `【约束模式完成 — 共完成 ${iterationCount} 轮迭代，所有 sub-goal 已处理】`);
      return finalResult || "(task complete)";
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

  private buildToolExecContext(): ToolExecContext {
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
    };
  }

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    return execTools(this.buildToolExecContext(), toolCalls);
  }

  // ── Context compression ──

  private compressRound = 0;

  private async maybeCompress(): Promise<void> {
    const totalChars = getContextCharCount(this.messages);
    const estimatedTokens = Math.ceil(totalChars / 4);
    if (estimatedTokens < MAX_CONTEXT_TOKENS * COMPRESS_THRESHOLD) return;

    const yield_ = () => new Promise<void>((r) => setImmediate(r));

    const systemMsg = this.messages[0];
    const keepCount = 8;

    let start = this.messages.length - keepCount;
    while (start < this.messages.length) {
      const cur = this.messages[start];
      if (cur?.role === "assistant" && cur.tool_calls?.length) {
        start++;
        while (start < this.messages.length && this.messages[start]?.role === "tool") start++;
      } else if (cur?.role === "tool") { start++; }
      else { break; }
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
}

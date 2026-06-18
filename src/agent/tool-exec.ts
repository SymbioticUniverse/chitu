import type { ToolCall, ToolResult, ToolHandler, Message, HorsewhipGuard, ParadigmState } from "../types.js";
import type { MCPLoader } from "../mcp/loader.js";
import type { RateLimiter } from "../ratelimit.js";
import type { Auditor } from "../auditor.js";
import type { HorsewhipGuardImpl } from "../horsewhip/guard.js";
import { ConstraintExecutor } from "../constraint/executor.js";
import * as path from "node:path";
import { logger } from "../logger.js";

export interface ToolExecContext {
  rateLimiter: RateLimiter;
  mcpLoader: MCPLoader | null;
  toolHandlers: Record<string, ToolHandler>;
  horsewhipGuard: HorsewhipGuard;
  guard: HorsewhipGuardImpl | null;
  auditor: Auditor;
  workspaceRoot: string;
  paradigmState: ParadigmState;
  constraintExecutor: ConstraintExecutor | null;
  messages: Message[];
}

/**
 * Execute tool calls from the model and return results.
 * Extracted from Agent to keep agent.ts lean.
 */
export async function executeToolCalls(
  ctx: ToolExecContext,
  toolCalls: ToolCall[],
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (const tc of toolCalls) {
    const name = tc.function.name;
    let args: Record<string, unknown>;

    // Rate limit check
    const waitMs = ctx.rateLimiter.check(name);
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
        output = await handleHorsewhipTool(ctx, name, args);
      } else if (name.startsWith("mcp__") && ctx.mcpLoader) {
        output = await ctx.mcpLoader.callMCPTool(name, args);
      } else {
        const handler = ctx.toolHandlers[name];
        if (!handler) {
          output = `Error: unknown tool '${name}'`;
        } else {
          output = await handler(args);
        }
      }

      if (output.length > 50000) {
        output = output.slice(0, 50000) + `\n\n[truncated — ${output.length - 50000} more bytes]`;
      }

      // Record file operations for metrics
      if (name === "write_file" || name === "edit_file" || name === "delete_file") {
        const filePath = typeof args["filePath"] === "string" ? args["filePath"] : "";
        ctx.auditor.writeEvent("write", { file: filePath, tool: name });
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

// ── Horsewhip MCP interceptor ──

async function handleHorsewhipTool(
  ctx: ToolExecContext,
  fullName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const method = fullName.replace("mcp__horsewhip__", "");

  const isConstraint = ctx.paradigmState.resolved === "constraint";
  const isBlocked = (m: string) =>
    `Error: Boundary is managed by the executor. The AI cannot change its own boundary. Current: ${JSON.stringify(ctx.guard?.getBoundaryState() ?? {})}`;

  switch (method) {
    case "horsewhip_lock_intent": {
      if (!isConstraint) return isBlocked(method);
      if (!ctx.guard) return JSON.stringify({ ok: false, error: "No guard" });
      const touch = (args["touch"] as string[]) ?? [];
      const core = (args["core"] as string[] | undefined);
      const edge = (args["edge"] as string[] | undefined);
      const allPaths = [...touch, ...(core ?? []), ...(edge ?? [])];
      const scope = ConstraintExecutor.validateScope(ctx.workspaceRoot, allPaths);
      if (!scope.ok) return JSON.stringify({ ok: false, error: scope.error });
      const task = (args["task"] as string) ?? `constraint:${path.basename(ctx.workspaceRoot)}`;
      ctx.guard.lockIntent(task, touch, core, edge);
      return JSON.stringify({ ok: true, allowed: touch, mode: "pasture" });
    }
    case "horsewhip_expand_boundary": {
      if (!isConstraint) return isBlocked(method);
      if (!ctx.guard) return JSON.stringify({ ok: false, error: "No guard" });
      const paths = (args["paths"] as string[]) ?? [];
      const scope = ConstraintExecutor.validateScope(ctx.workspaceRoot, paths);
      if (!scope.ok) return JSON.stringify({ ok: false, error: scope.error });
      if (ctx.constraintExecutor) {
        const check = ctx.constraintExecutor.canExpand(paths);
        if (!check.ok) return JSON.stringify({ ok: false, error: check.error });
      }
      const reason = (args["reason"] as string) ?? "unspecified";
      // Store pending expand — requires human approval before executing
      if (ctx.constraintExecutor) {
        ctx.constraintExecutor.pendingExpand = { paths, reason };
      }
      return JSON.stringify({
        ok: true,
        pending_approval: true,
        paths,
        reason,
        message: "Boundary expansion submitted for human approval. The workflow has paused. Do NOT call expand_boundary again — wait for the approval result.",
      });
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
      if (!ctx.guard) return JSON.stringify({ locked: false, mode: "none", allowed: [] });
      const state = ctx.guard.getBoundaryState();
      return JSON.stringify(state);
    }

    case "horsewhip_task_complete": {
      if (!ctx.guard) return JSON.stringify({ ok: true });
      const summary = (args["summary"] as string) ?? "";
      ctx.guard.taskComplete(summary);
      return JSON.stringify({ ok: true });
    }

    case "horsewhip_record_write": {
      if (!ctx.guard) return JSON.stringify({ ok: true });
      const p = (args["path"] as string) ?? "";
      ctx.guard.recordWrite(p).catch((e) => { logger.warn("recordWrite failed", { path: p, error: String(e) }); });
      return JSON.stringify({ ok: true });
    }

    case "horsewhip_whip_ceremony":
    case "horsewhip_suggest_scope":
      if (ctx.mcpLoader) {
        return ctx.mcpLoader.callMCPTool(fullName, args);
      }
      return JSON.stringify({ ok: true });
  }

  return `Error: unknown Horsewhip tool '${method}'`;
}

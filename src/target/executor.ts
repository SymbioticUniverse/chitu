import type { Agent } from "../agent.js";
import type { TargetState } from "../types.js";
import { detectTaskIntent } from "../types.js";
import {
  loadActiveState, readUserGoal, saveState, goalToTempId,
} from "./state.js";
import {
  doClarify, doPlan, doExecute, doReview,
} from "./execute-phase.js";
import { planId as toPlanId } from "./plan.js";

// ── Executor ───────────────────────────────────────────────────────

export interface TargetExecOptions {
  onToken?: (text: string) => void;
  signal?: AbortSignal;
  onToolOutput?: (toolName: string, output: string) => void;
  onCompress?: (phase: string, progress: number) => void;
  onReasoning?: (text: string) => void;
  /** Yunchang mode: skip plan confirmation, auto-proceed to execute. */
  yunchang?: boolean;
}

const MAX_CLARIFY_ROUNDS = 12;

export class TargetExecutor {
  private agent: Agent;
  private workspaceRoot: string;

  constructor(agent: Agent, workspaceRoot: string) {
    this.agent = agent;
    this.workspaceRoot = workspaceRoot;
  }

  /** Main entry. Advances the Target state machine by one step.
   *  In yunchang mode: auto-loops through all phases until done, commit is the flow gate. */
  async execute(opts: TargetExecOptions): Promise<string> {
    const guard = this.agent.getGuard();
    if (guard) guard.unlock();

    const userMsg = readUserGoal(this.agent);
    let state = loadActiveState(this.workspaceRoot);

    if (state) {
      const pid = state.plan ? toPlanId(state.plan.project) : goalToTempId(userMsg);

      if (state.phase === "abandoned") {
        state.phase = "execute";
        state.planConfirmed = true;
        if (state.plan && state.plan.subGoals.length > 0) {
          state.currentSubGoalId = state.plan.subGoals[0]!.id;
          state.currentSubGoal = 0;
        }
        saveState(this.workspaceRoot, pid, state);
      }

      if (state.phase === "execute" && state.plan) {
        let changed = false;
        for (const sg of state.plan.subGoals) {
          if (sg.status === "in_progress") { sg.status = "pending"; sg.retryCount = 0; changed = true; }
        }
        for (const sg of state.plan.subGoals) {
          if (sg.status === "done" && !sg.committedHash) { sg.status = "pending"; sg.retryCount = 0; changed = true; }
        }
        if (changed) {
          const firstPending = state.plan.subGoals.find((sg) => sg.status === "pending");
          if (firstPending) {
            state.currentSubGoalId = firstPending.id;
            state.currentSubGoal = state.plan.subGoals.indexOf(firstPending);
          }
          saveState(this.workspaceRoot, pid, state);
        }
      }

      return this.autoLoop(opts);
    }

    const intent = userMsg ? detectTaskIntent(userMsg) : "query";
    const isConversational = !userMsg || intent === "query";

    if (isConversational) {
      const guard = this.agent.getGuard();
      if (guard) guard.lockFiles([], "target:conversational");
      return this.agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);
    }

    const newState: TargetState = {
      phase: "clarify",
      goal: userMsg,
      clarificationRounds: 0,
      maxClarificationRounds: MAX_CLARIFY_ROUNDS,
      previousSubGoalFiles: [],
      humanInLoopCount: 0,
      planConfirmed: false,
      commits: [],
      violations: [],
      initialHead: "",
      subGoalHead: "",
    };

    return this.autoLoop(opts, newState);
  }

  /** Yunchang auto-loop: run all phases until done. Commit is the flow gate. */
  private async autoLoop(opts: TargetExecOptions, initialState?: TargetState): Promise<string> {
    const MAX_ROUNDS = 30;
    let result = "";

    for (let i = 0; i < MAX_ROUNDS; i++) {
      let state = loadActiveState(this.workspaceRoot);
      if (!state && initialState) {
        state = initialState;
        initialState = undefined;
      }
      if (!state) return result || "(Target: state lost)";

      if (!state.phase) {
        return "(Target: plan state corrupted — phase is missing. Delete .chitu/plans and restart.)";
      }
      switch (state.phase) {
        case "clarify":
          result = await doClarify(this.agent, this.workspaceRoot, state.goal, state, opts);
          break;
        case "plan":
          result = await doPlan(this.workspaceRoot, state, opts);
          break;
        case "execute":
          result = await doExecute(this.agent, this.workspaceRoot, state, opts);
          break;
        case "review":
          result = await doReview(this.agent, this.workspaceRoot, state, opts);
          break;
        case "done":
          return result || "(Target: all sub-goals completed)";
        case "abandoned":
          return "(Target: plan abandoned)";
      }

      state = loadActiveState(this.workspaceRoot);
      if (!state || state.phase === "done" || state.phase === "abandoned") return result;
    }

    return result + "\n\n(已达最大自动轮数)";
  }
}

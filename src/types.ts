// ============================================================
// Core type definitions for Chitu AI Agent
// ============================================================

// --- Message types ---

export type Role = "system" | "user" | "assistant" | "tool";

export type ContentBlock = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface Message {
  role: Role;
  content: string | null | ContentBlock[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** DeepSeek thinking mode: reasoning chain content. Once it appears, ALL subsequent assistant messages in the conversation MUST include it, or API returns 400. */
  reasoning_content?: string;
}

/** Extract plain text from a Message content (handles both string and content-block array). */
export function getContentText(content: Message["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// --- Tool definitions ---

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParamProp>;
    required?: string[];
  };
  /** "read" | "write" — used by Horsewhip guard */
  category: ToolCategory;
}

export type ToolCategory = "read" | "write" | "task" | "meta";

export interface ToolParamProp {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
}

// --- API types (DeepSeek / OpenAI-compatible) ---

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDef[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

export interface Choice {
  index: number;
  message?: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
  };
  delta?: {
    role?: string;
    content?: string;
    reasoning_content?: string;
    tool_calls?: DeltaToolCall[];
  };
  finish_reason: "stop" | "tool_calls" | "length" | null;
}

export interface DeltaToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
}

// --- Tool execution ---

export interface ToolResult {
  tool_call_id: string;
  content: string;
}

// --- Session ---

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  task: string;
  messages: Message[];
  metrics?: MetricsReport;
  usage?: Usage;
  model?: string;
}

// --- Horsewhip boundary ---

export interface BoundaryCheck {
  allowed: boolean;
  path: string;
  reason?: string;
}

export type LockMode = "pasture" | "decouple" | "none";

/** Constraint executor sub-mode: creation (new features) vs modification (surgical edits) */
export type ConstraintMode = "creation" | "modification";

export interface BoundaryState {
  locked: boolean;
  mode: LockMode;
  allowed: string[];
  strict?: string[];
  warn?: string[];
  task?: string;
  /** Gates: composable boolean conditions. Any combination is a valid state. */
  gates?: BoundaryGates;
  /** Targeted lock: only these specific files are blocked. Everything else free. */
  blocked?: string[];
}

/** Composable write gates. The combination of conditions IS the state.
 *  No enum needed — new states emerge from new condition combinations. */
export interface BoundaryGates {
  /** Only paths matching these prefixes can be written to. Empty = no writes. */
  writablePaths: string[];
  /** Can create new (untracked by git) files outside writablePaths? */
  allowNewFiles: boolean;
  /** Can use shell commands with write/delete constructs? */
  allowShellWrite: boolean;
}

// --- MCP ---

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  alwaysLoad?: boolean;
}

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// --- Audit ---

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  file: string;
  reason?: string;
  causedBy?: string;
  timestamp: string;
  task?: string;
  isNew?: boolean;
}

export type AuditEventType =
  | "file_unlocked"
  | "file_locked"
  | "write"
  | "task_start"
  | "task_complete"
  | "user_expand"
  | "strict_block"
  | "phase_complete"
  | "human_in_loop";

// --- Task intent types ---

export type TaskIntent = "refactor" | "new_feature" | "fix" | "query" | "mixed";

export function detectTaskIntent(content: string): TaskIntent {
  const lower = content.toLowerCase();
  if (/^(what|how|why|when|where|who|can you|tell me|explain|what is|how do)/i.test(lower) &&
      !/write|create|add|implement|fix|refactor|change|update|modify|make/i.test(lower)) {
    return "query";
  }
  if (/refactor|restruct|redesign|rearchitect|reorg|extract|decouple|dedup/i.test(lower)) {
    return "refactor";
  }
  if (/fix|bug|error|crash|broken|not working|doesn't work|fail|issue|problem|repair|debug/i.test(lower)) {
    return "fix";
  }
  if (/create|add new|implement|new file|add feature|build|make a|create a|generate|scaffold/i.test(lower)) {
    return "new_feature";
  }
  return "mixed";
}

// ── AI Agent Paradigms ────────────────────────────────────────────

/** AI reasoning paradigm / mode */
export type Paradigm = "appraise" | "ride" | "spur" | "constraint";

/** Paradigm display config */
export const PARADIGM_META: Record<Paradigm, { label: string; color: string; desc: string }> = {
  appraise:   { label: "Ask",        color: "green",   desc: "Read-only Q&A, no code changes — Horsewhip fully locked, all files read-only." },
  ride:       { label: "Target",     color: "magenta", desc: "Goal-driven, full workflow with review gates — Horsewhip boundary guard per sub-goal." },
  spur:       { label: "Modify",     color: "yellow",  desc: "Single-file surgical edit, no refactoring — Horsewhip whip-bound on target file only." },
  constraint: { label: "Constraint", color: "cyan",    desc: "Horsewhip boundary mode — AI proposes boundary, works within it, auto-review + commit." },
};

export interface ParadigmState {
  active: Paradigm;
  resolved: Paradigm;
  /** Execution plan, populated in plan mode */
  plan?: ExecutionPlan;
  /** Current step index (0-based) */
  currentStep?: number;
}

export interface ExecutionPlan {
  id: string;
  task: string;
  steps: PlanStep[];
  generatedAt: string;
}

export interface PlanStep {
  index: number;
  description: string;
  status: "pending" | "in_progress" | "done" | "failed" | "skipped";
  result?: string;
}

export interface MetricsReport {
  task: string;
  humanInLoopCount: number;
}

// --- Horsewhip Sync ---

export interface SyncManifest {
  horsewhipExtensionVersion: string;
  mcpPackageVersion?: string;
  mcpDistSha256: string;
  source: "local-extension" | "github-release";
  bundledAt?: string;
}

export interface SyncCache {
  lastCheck: string;
  latestVersion: string;
  source: "local-extension" | "github-release";
}

export interface SyncSource {
  type: "local-extension" | "github-release";
  version: string;
  mcpPath: string;
  skillsDir: string;
  commandsDir: string;
}

export interface SyncResult {
  updated: boolean;
  previousVersion: string | null;
  newVersion: string;
  source: string;
}

export interface AutoCheckResult {
  updateAvailable: boolean;
  currentVersion: string | null;
  latestVersion: string;
}

// --- Memory ---

export interface MemoryEntry {
  id: string;
  type: "user" | "feedback" | "project" | "reference";
  name: string;
  description: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

// ── Target Mode types ─────────────────────────────────────────────

export type SubGoalStatus = "pending" | "in_progress" | "done" | "failed";

export interface SubGoal {
  id: string;
  title: string;
  description: string;
  targetFiles: string[];
  dependsOn: string[];
  status: SubGoalStatus;
  interfaceDoc?: string;
  retryCount: number;
  maxRetries: number;
  committedHash?: string;
  verificationDoc?: string;
}

export interface TargetPlan {
  project: string;
  goal: string;
  createdAt: string;
  subGoals: SubGoal[];
}

export interface InterfaceDoc {
  projectName: string;
  subGoalId: string;
  files: string[];
  exports: string[];
  imports: string[];
  capability: string;
}

export type TargetPhase = "clarify" | "plan" | "execute" | "review" | "done" | "abandoned";

export interface TargetState {
  phase: TargetPhase;
  goal: string;
  plan?: TargetPlan;
  currentSubGoal?: number;
  currentSubGoalId?: string;
  clarificationRounds: number;
  maxClarificationRounds: number;
  previousSubGoalFiles: string[];
  humanInLoopCount: number;
  planConfirmed: boolean;
  commits: string[];
  violations: ViolationRecord[];
  initialHead: string;
  subGoalHead: string;
}

/** Verification record written after each sub-goal commit */
export interface SubGoalVerification {
  subGoalId: string;
  subGoalTitle: string;
  committedHash: string;
  committedAt: string;
  testCommand: string;
  testOutput: string;
  testPassed: boolean;
  integrationTestPassed: boolean;
  exportsVerified: string[];
  filesCreated: string[];
  filesModified: string[];
}

/** Penalty record for audit trail */
export interface ViolationRecord {
  subGoalId: string;
  reason: string;
  detectedAt: string;
  action: "warning" | "rollback" | "purge";
}

/** Structured return from executor phase methods */
export interface TargetStepResult {
  text: string;
  autoContinue: boolean;
  terminal: boolean;
}

// --- Tool call handler ---

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export interface ToolContext {
  workspaceRoot: string;
  sessionId: string;
  horsewhipGuard: HorsewhipGuard;
}

export interface HorsewhipGuard {
  checkWrite: (filePath: string) => Promise<BoundaryCheck>;
  checkCommand?: (command: string, workdir: string) => Promise<BoundaryCheck>;
  recordWrite: (filePath: string, isNew?: boolean) => Promise<void>;
  getBoundary: () => Promise<{ locked: boolean; mode: string }>;
  lockFiles: (files: string[], task: string) => void;
}

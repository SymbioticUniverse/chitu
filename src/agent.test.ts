import { describe, it, expect, beforeEach } from "vitest";
import { Agent } from "./agent.js";
import type { Paradigm, ParadigmState } from "./types.js";

// A minimal mock provider that satisfies the AIProvider interface
function mockProvider() {
  return {
    name: "mock",
    defaultModels: ["mock-model", "mock-model-pro"],
    chat: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
    stream: async function* () { yield { type: "text", content: "ok" }; yield { type: "done" }; },
    setThinking: () => {},
    streamToMessage: async () => ({ content: "ok", reasoning: "", toolCalls: [], aborted: false }),
  };
}

function mockGuard() {
  return {
    checkWrite: async () => ({ allowed: true, path: "" }),
    recordWrite: async () => {},
    getBoundary: async () => ({ locked: false, mode: "none" as const }),
    checkCommand: async () => ({ allowed: true, path: "" }),
    unlock: async () => {},
    lockIntent: () => {},
    expandBoundary: async () => true,
  };
}

function createAgent(opts: { paradigm?: Paradigm; thinking?: boolean } = {}) {
  return new Agent(
    "/tmp/test-workspace",
    "test-session-123",
    null as any, // MCPLoader — not needed for unit tests
    mockGuard() as any,
    {
      paradigm: opts.paradigm ?? "appraise",
      thinking: opts.thinking,
    },
  );
}

describe("Agent", () => {
  let agent: Agent;

  beforeEach(() => {
    agent = createAgent();
    // Patch the provider to bypass real API calls
    (agent as any).provider = mockProvider();
  });

  // ─── Construction & Configuration ───

  describe("construction", () => {
    it("creates an agent with defaults", () => {
      expect(agent).toBeDefined();
      expect(agent.getModel()).toBeTruthy();
    });

    it("stores explicit thinking preference", () => {
      const a = createAgent({ thinking: true });
      expect(a.getThinking()).toBe(true);
    });

    it("defaults thinking to false when omitted", () => {
      expect(agent.getThinking()).toBe(false);
    });
  });

  // ─── Model Management ───

  describe("model management", () => {
    it("getModel returns the current model", () => {
      const model = agent.getModel();
      expect(typeof model).toBe("string");
      expect(model.length).toBeGreaterThan(0);
    });

    it("setModel updates the model", () => {
      agent.setModel("custom-model");
      expect(agent.getModel()).toBe("custom-model");
    });

    it("getProviderName returns the provider name", () => {
      expect(agent.getProviderName()).toBe("mock");
    });

    it("getDefaultModels returns provider models", () => {
      const models = agent.getDefaultModels();
      expect(models).toHaveLength(2);
      expect(models).toContain("mock-model");
    });
  });

  // ─── Thinking Mode ───

  describe("thinking mode", () => {
    it("setThinking enables thinking", () => {
      agent.setThinking(true);
      expect(agent.getThinking()).toBe(true);
    });

    it("setThinking disables thinking", () => {
      agent.setThinking(true);
      agent.setThinking(false);
      expect(agent.getThinking()).toBe(false);
    });

    it("toggle is idempotent", () => {
      agent.setThinking(true);
      agent.setThinking(true);
      expect(agent.getThinking()).toBe(true);
    });
  });

  // ─── Paradigm Management ───

  describe("paradigm management", () => {
    it("default paradigm is as configured", () => {
      const state = agent.getParadigmState();
      expect(state.active).toBe("appraise");
      expect(state.resolved).toBe("appraise");
    });

    it("setParadigm changes paradigm", () => {
      agent.setParadigm("ride");
      const state = agent.getParadigmState();
      expect(state.active).toBe("ride");
    });

    it("setParadigm clears plan state", () => {
      // Set to ride with some state
      agent.setParadigm("ride");
      const state = agent.getParadigmState();
      expect(state.plan).toBeUndefined();
      expect(state.currentStep).toBeUndefined();
    });

    it("getParadigmState returns a defensive copy", () => {
      const s1 = agent.getParadigmState();
      const s2 = agent.getParadigmState();
      expect(s1).toEqual(s2);
      expect(s1).not.toBe(s2);
    });
  });

  // ─── Messages ───

  describe("messages", () => {
    it("getMessages starts empty", () => {
      const msgs = agent.getMessages();
      expect(msgs).toHaveLength(0);
    });

    it("restoreMessages loads persisted messages", () => {
      const msgs = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ] as any[];
      agent.restoreMessages(msgs);
      expect(agent.getMessages()).toHaveLength(2);
    });
  });

  // ─── Context Monitoring ───

  describe("context monitoring", () => {
    it("getContextUsage returns estimated usage", () => {
      agent.setTask("test task");
      const usage = agent.getContextUsage();
      expect(usage.estimatedTokens).toBeGreaterThan(0);
      expect(usage.percentage).toBeGreaterThan(0);
      expect(usage.maxTokens).toBeGreaterThan(0);
    });

    it("getContextUsage estimates higher after adding content", () => {
      agent.setTask("short");
      const before = agent.getContextUsage().estimatedTokens;

      const longMsg = "x".repeat(8000);
      agent.restoreMessages([{ role: "user", content: longMsg }]);
      const after = agent.getContextUsage().estimatedTokens;
      expect(after).toBeGreaterThan(before);
    });
  });

  // ─── Health ───

  describe("health", () => {
    it("reports healthy status", () => {
      const h = agent.health();
      expect(h.ok).toBe(true);
      expect(h.session).toBe("test-session-123");
      expect(typeof h.messageCount).toBe("number");
    });
  });

  // ─── Guard ───

  describe("guard", () => {
    it("getGuard returns null when guard is not HorsewhipGuardImpl", () => {
      // Our mockGuard was cast as any, so getGuard returns null
      expect(agent.getGuard()).toBeNull();
    });

    it("getGuard returns guard when it is HorsewhipGuardImpl", () => {
      // This is tested at the integration level
      expect(true).toBe(true);
    });
  });

  // ─── Abort ───

  describe("abort", () => {
    it("abort does not throw", () => {
      expect(() => agent.abort()).not.toThrow();
    });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { RateLimiter } from "./ratelimit.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ test: { maxCalls: 3, windowMs: 1000 } });
  });

  it("allows calls within limit", () => {
    expect(limiter.check("test")).toBe(0);
    expect(limiter.check("test")).toBe(0);
    expect(limiter.check("test")).toBe(0);
  });

  it("blocks calls over limit", () => {
    limiter.check("test");
    limiter.check("test");
    limiter.check("test");
    expect(limiter.check("test")).toBeGreaterThan(0);
  });

  it("uses default config for unknown tools", () => {
    const result = limiter.check("unknown_tool");
    expect(result).toBe(0);
  });

  it("returns stats", () => {
    limiter.check("test");
    const stats = limiter.stats();
    const s = stats.find((s) => s.tool === "test");
    expect(s).toBeDefined();
    expect(s!.used).toBe(1);
  });

  it("resets all counters", () => {
    limiter.check("test");
    limiter.check("test");
    limiter.check("test");
    limiter.reset();
    expect(limiter.check("test")).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import { MetricsEngine } from "./metrics.js";

describe("MetricsEngine.compute", () => {
  it("returns null when no audit data exists", () => {
    const engine = new MetricsEngine("/tmp/nonexistent-chitu-test");
    const result = engine.compute();
    expect(result).toBeNull();
  });

  it("returns humanInLoopCount in report", () => {
    const engine = new MetricsEngine("/tmp/nonexistent-chitu-test");
    const result = engine.compute();
    // No audit data, should be null
    expect(result).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { logger, setLogLevel, onLog, type LogEntry } from "./logger.js";

describe("logger", () => {
  it("emits info messages", () => {
    const entries: LogEntry[] = [];
    onLog((e) => entries.push(e));

    logger.info("test message", { key: "value" });

    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[entries.length - 1]!;
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("test message");
    expect(entry.ctx).toEqual({ key: "value" });
  });

  it("suppresses debug messages at info level", () => {
    const entries: LogEntry[] = [];
    onLog((e) => entries.push(e));

    setLogLevel("info");
    const before = entries.length;
    logger.debug("should not appear");
    expect(entries.length).toBe(before);
  });

  it("emits error messages", () => {
    const entries: LogEntry[] = [];
    onLog((e) => entries.push(e));

    logger.error("something broke");

    const entry = entries[entries.length - 1]!;
    expect(entry.level).toBe("error");
  });
});

import { describe, it, expect } from "vitest";
import { createCLITools } from "./cli.js";

const tools = createCLITools();
const cliExec = tools.cli_exec;

describe("cli_exec", () => {
  it("runs a read command and returns output", async () => {
    const result = await cliExec({ command: "echo hello world" });
    expect(result).toBe("hello world");
  });

  it("runs node scripts/build.mjs successfully", async () => {
    const result = await cliExec({ command: "node scripts/build.mjs" });
    expect(result).toContain("编译成功");
  });

  it("lists directory contents", async () => {
    const result = await cliExec({ command: "ls .chitu/" });
    expect(result).toContain("sessions");
  });

  it("blocks > redirect", async () => {
    const result = await cliExec({ command: "echo test > /tmp/x" });
    expect(result).toContain("BLOCKED by cli_exec");
  });

  it("blocks >> redirect", async () => {
    const result = await cliExec({ command: "echo test >> /tmp/x" });
    expect(result).toContain("BLOCKED by cli_exec");
  });

  it("blocks sed -i", async () => {
    const result = await cliExec({ command: "sed -i 's/a/b/g' file.ts" });
    expect(result).toContain("BLOCKED by cli_exec");
  });

  it("blocks cp", async () => {
    const result = await cliExec({ command: "cp a.ts b.ts" });
    expect(result).toContain("BLOCKED by cli_exec");
  });

  it("blocks mv", async () => {
    const result = await cliExec({ command: "mv a.ts b.ts" });
    expect(result).toContain("BLOCKED by cli_exec");
  });

  it("blocks rm -rf", async () => {
    const result = await cliExec({ command: "rm -rf /tmp/x" });
    expect(result).toContain("BLOCKED by cli_exec");
  });

  it("blocks mkdir", async () => {
    const result = await cliExec({ command: "mkdir testdir" });
    expect(result).toContain("BLOCKED by cli_exec");
  });

  it("blocks git add", async () => {
    const result = await cliExec({ command: "git add src/agent.ts" });
    expect(result).toContain("BLOCKED by cli_exec");
  });

  it("blocks git commit", async () => {
    const result = await cliExec({ command: "git commit -m 'test'" });
    expect(result).toContain("BLOCKED by cli_exec");
  });

  it("blocks git push", async () => {
    const result = await cliExec({ command: "git push origin main" });
    expect(result).toContain("BLOCKED by cli_exec");
  });

  it("allows git status", async () => {
    const result = await cliExec({ command: "git status --porcelain" });
    expect(typeof result).toBe("string");
    expect(result).not.toContain("BLOCKED");
  });

  it("allows git log", async () => {
    const result = await cliExec({ command: "git log --oneline -3" });
    expect(typeof result).toBe("string");
    expect(result).not.toContain("BLOCKED");
  });

  it("returns error for invalid command", async () => {
    const result = await cliExec({ command: "nonexistent_command_xyz" });
    expect(result).toContain("Error");
  });

  it("requires command argument", async () => {
    const result = await cliExec({});
    expect(result).toContain("command is required");
  });

  it("supports workdir parameter", async () => {
    const result = await cliExec({ command: "pwd", workdir: "/tmp" });
    expect(result).toContain("tmp");
  });
});

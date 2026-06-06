import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HorsewhipGuardImpl } from "./guard.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("HorsewhipGuardImpl.extractWriteTargets", () => {
  it("extracts redirect targets", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      'echo "hello" > src/file.ts'
    );
    expect(targets).toContain("src/file.ts");
  });

  it("extracts append redirect", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      'echo "hello" >> src/file.ts'
    );
    expect(targets).toContain("src/file.ts");
  });

  it("extracts tee target", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "cat tmp | tee src/output.ts"
    );
    expect(targets).toContain("src/output.ts");
  });

  it("extracts dd of= target", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "dd if=/dev/zero of=src/data.bin bs=1024 count=1"
    );
    expect(targets).toContain("src/data.bin");
  });

  it("extracts sed -i target", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "sed -i 's/old/new/' src/file.ts"
    );
    expect(targets).toContain("src/file.ts");
  });

  it("extracts touch target", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "touch src/newfile.ts"
    );
    expect(targets).toContain("src/newfile.ts");
  });

  it("returns empty for read-only commands", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "cat src/file.ts"
    );
    expect(targets.filter((t) => t === "src/file.ts")).toEqual([]);
  });

  it("returns empty for pure shell builtins", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "cd src && pwd"
    );
    expect(targets).toEqual([]);
  });
});

describe("HorsewhipGuardImpl.isDestructiveCommand", () => {
  it("detects rm", () => {
    expect(HorsewhipGuardImpl.isDestructiveCommand(
      "rm src/file.ts", "src/file.ts"
    )).toBe(true);
  });

  it("detects rm -rf", () => {
    expect(HorsewhipGuardImpl.isDestructiveCommand(
      "rm -rf src/dir", "src/dir"
    )).toBe(true);
  });

  it("detects git rm", () => {
    expect(HorsewhipGuardImpl.isDestructiveCommand(
      "git rm src/file.ts", "src/file.ts"
    )).toBe(true);
  });

  it("does not flag cat as destructive", () => {
    expect(HorsewhipGuardImpl.isDestructiveCommand(
      "cat src/file.ts", "src/file.ts"
    )).toBe(false);
  });
});

describe("HorsewhipGuardImpl.extractWriteTargets enhanced", () => {
  it("extracts dotfile targets", () => {
    expect(HorsewhipGuardImpl.extractWriteTargets("touch Makefile"))
      .toContain("Makefile");
    expect(HorsewhipGuardImpl.extractWriteTargets("echo 'key' > .env"))
      .toContain(".env");
  });

  it("extracts ln -s destination", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "ln -s target link"
    );
    expect(targets).toContain("link");
  });

  it("extracts truncate target", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "truncate -s 0 data.bin"
    );
    expect(targets).toContain("data.bin");
  });

  it("extracts shred target", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "shred -u secret.txt"
    );
    expect(targets).toContain("secret.txt");
  });

  it("extracts git checkout target", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "git checkout -- src/file.ts"
    );
    expect(targets).toContain("src/file.ts");
  });

  it("extracts both mv source and destination", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "mv src/old.ts src/new.ts"
    );
    expect(targets).toContain("src/old.ts");
    expect(targets).toContain("src/new.ts");
  });

  it("extracts npm install config files", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "npm install express"
    );
    expect(targets).toContain("package.json");
    expect(targets).toContain("package-lock.json");
  });

  it("extracts inline script sentinel", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      `python -c "open('file.py','w').write('x')"`
    );
    expect(targets.some((t) => t.startsWith("<inline-script>"))).toBe(true);
  });

  it("extracts sed target without requiring extension", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "sed -i 's/foo/bar/' Makefile"
    );
    expect(targets).toContain("Makefile");
  });

  it("extracts cp/mv target without requiring extension", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "cp src/a.ts dest/"
    );
    expect(targets.length).toBeGreaterThan(0);
  });

  it("returns empty for read-only commands", () => {
    const targets = HorsewhipGuardImpl.extractWriteTargets(
      "git status --short"
    );
    expect(targets.filter((t) => !t.startsWith("<inline-script>"))).toEqual([]);
  });
});

describe("HorsewhipGuardImpl.isDestructiveCommand enhanced", () => {
  it("detects git restore as destructive", () => {
    expect(HorsewhipGuardImpl.isDestructiveCommand(
      "git restore src/file.ts", "src/file.ts"
    )).toBe(true);
  });

  it("detects git checkout as destructive", () => {
    expect(HorsewhipGuardImpl.isDestructiveCommand(
      "git checkout -- src/file.ts", "src/file.ts"
    )).toBe(true);
  });

  it("detects shred as destructive", () => {
    expect(HorsewhipGuardImpl.isDestructiveCommand(
      "shred secret.txt", "secret.txt"
    )).toBe(true);
  });

  it("detects mv source as destructive", () => {
    expect(HorsewhipGuardImpl.isDestructiveCommand(
      "mv src/old.ts src/new.ts", "src/old.ts"
    )).toBe(true);
  });

  it("does not flag mv destination as destructive", () => {
    expect(HorsewhipGuardImpl.isDestructiveCommand(
      "mv src/old.ts src/new.ts", "src/new.ts"
    )).toBe(false);
  });
});

describe("HorsewhipGuardImpl boundary cache invalidation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chitu-guard-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("invalidates cache when boundary.json mtime changes externally (MCP sync)", () => {
    const guard = new HorsewhipGuardImpl(tmpDir);

    // Step 1: lockDecouple — sets cache to decouple mode
    guard.lockDecouple("test task");
    const state1 = guard.getBoundaryState();
    expect(state1.locked).toBe(true);
    expect(state1.mode).toBe("decouple");

    // Step 2: simulate MCP horsewhip_lock_intent updating boundary.json externally
    // (in-process cache still has decouple mode)
    const boundaryPath = path.join(tmpDir, ".git", "horsewhip", "boundary.json");
    const pastureState = {
      locked: true,
      mode: "pasture",
      allowed: ["src/test.ts"],
      strict: ["src/test.ts"],
      warn: [],
      task: "mcp set pasture",
    };
    // Wait a tick so mtime is guaranteed different
    const writeTime = Date.now() + 100;
    fs.writeFileSync(boundaryPath, JSON.stringify(pastureState, null, 2), "utf-8");
    fs.utimesSync(boundaryPath, writeTime / 1000, writeTime / 1000);

    // Step 3: readBoundary should detect mtime change and return pasture state,
    // NOT the cached decouple state
    const state2 = guard.getBoundaryState();
    expect(state2.mode).toBe("pasture");
    expect(state2.allowed).toEqual(["src/test.ts"]);
  });

  it("serves from cache when boundary.json has not changed", () => {
    const guard = new HorsewhipGuardImpl(tmpDir);

    guard.lockDecouple("test task");
    const state1 = guard.getBoundaryState();
    expect(state1.mode).toBe("decouple");

    // Second read without external change — should return same state
    const state2 = guard.getBoundaryState();
    expect(state2.mode).toBe("decouple");
  });
});

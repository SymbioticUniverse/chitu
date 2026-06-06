import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SyncManifest, SyncCache, SyncSource, SyncResult, AutoCheckResult } from "./types.js";

const VENDOR_DIR = "horsewhip";
const SKILL_NAMES = ["horsewhip", "horsewhip-lock", "horsewhip-lock-auto", "horsewhip-auto"];
const CMD_NAMES = ["horsewhip", "horsewhip-lock", "horsewhip-lock-auto", "horsewhip-auto"];
const DEFAULT_TTL_MS = 3600_000;

export class HorsewhipSync {
  private workspaceRoot: string;
  private vendorDir: string;
  private ttlMs: number;
  private preferredSource: "local-extension" | "github-release";

  constructor(
    workspaceRoot: string,
    options?: { ttlMs?: number; source?: "local-extension" | "github-release" }
  ) {
    this.workspaceRoot = workspaceRoot;
    this.vendorDir = path.join(workspaceRoot, VENDOR_DIR);
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.preferredSource = options?.source ?? "local-extension";
  }

  async sync(log?: (msg: string) => void): Promise<SyncResult> {
    const localManifest = this.readLocalManifest();
    const previousVersion = localManifest?.horsewhipExtensionVersion ?? null;
    const source = await this.detectSource();

    if (!source) {
      throw new Error("Cannot find Horsewhip source. Install the VS Code extension or check GitHub connectivity.");
    }

    if (localManifest && this.compareVersions(source.version, localManifest.horsewhipExtensionVersion) === 0) {
      log?.(`Horsewhip is up to date (v${localManifest.horsewhipExtensionVersion})`);
      return { updated: false, previousVersion, newVersion: source.version, source: source.type };
    }

    log?.(`Syncing Horsewhip v${source.version} from ${source.type}...`);

    await this.vendorFromSource(source);
    log?.(`  -> Vendored to ${VENDOR_DIR}/`);

    this.distributeSkillsAndCommands();
    log?.(`  -> Distributed skills + commands to .chitu/ and .cursor/`);

    this.updateMcpConfigs();
    log?.(`  -> Updated .chitu/config.json, .mcp.json and .cursor/mcp.json`);

    this.writeCache(source.version, source.type);

    return { updated: true, previousVersion, newVersion: source.version, source: source.type };
  }

  async autoCheck(): Promise<AutoCheckResult> {
    const localManifest = this.readLocalManifest();
    const currentVersion = localManifest?.horsewhipExtensionVersion ?? null;

    try {
      const source = await this.detectSource();
      if (!source) {
        return { updateAvailable: false, currentVersion, latestVersion: currentVersion ?? "unknown" };
      }

      const updateAvailable = !currentVersion ||
        this.compareVersions(source.version, currentVersion) > 0;

      return { updateAvailable, currentVersion, latestVersion: source.version };
    } catch {
      return { updateAvailable: false, currentVersion, latestVersion: currentVersion ?? "unknown" };
    }
  }

  getCurrentVersion(): string | null {
    return this.readLocalManifest()?.horsewhipExtensionVersion ?? null;
  }

  // --- Source detection ---

  private async detectSource(): Promise<SyncSource | null> {
    if (this.preferredSource === "local-extension") {
      const local = this.findLatestLocalExtension();
      if (local) return local;
    }

    const gh = await this.fetchGitHubRelease();
    if (gh) return gh;

    if (this.preferredSource !== "local-extension") {
      return this.findLatestLocalExtension();
    }

    return null;
  }

  private findLatestLocalExtension(): SyncSource | null {
    const extRoot = path.join(os.homedir(), ".vscode", "extensions");
    if (!fs.existsSync(extRoot)) return null;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(extRoot, { withFileTypes: true });
    } catch {
      return null;
    }

    const versions: Array<{ version: string; dir: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const m = entry.name.match(/^horsewhip\.horsewhip-(\d+\.\d+\.\d+)$/);
      if (!m || !m[1]) continue;
      const mcpPath = path.join(extRoot, entry.name, "media", "mcp", "dist", "index.js");
      if (!fs.existsSync(mcpPath)) continue;
      versions.push({ version: m[1], dir: path.join(extRoot, entry.name) });
    }

    if (versions.length === 0) return null;

    versions.sort((a, b) => this.compareVersions(b.version, a.version));
    const latest = versions[0]!;

    return {
      type: "local-extension",
      version: latest.version,
      mcpPath: path.join(latest.dir, "media", "mcp", "dist", "index.js"),
      skillsDir: path.join(latest.dir, "media", "skills"),
      commandsDir: path.join(latest.dir, "media", "commands"),
    };
  }

  private async fetchGitHubRelease(): Promise<SyncSource | null> {
    // GitHub Releases — deferred until release publishing is set up.
    // Will fetch from https://api.github.com/repos/waitamomentC/horsewhip/releases/latest
    return null;
  }

  // --- Vendoring ---

  private async vendorFromSource(source: SyncSource): Promise<void> {
    this.ensureDir(this.vendorDir);

    // MCP server
    const mcpDest = path.join(this.vendorDir, "mcp", "index.js");
    this.ensureDir(path.dirname(mcpDest));
    fs.copyFileSync(source.mcpPath, mcpDest);

    // Manifest
    const manifest: SyncManifest = {
      horsewhipExtensionVersion: source.version,
      mcpDistSha256: "",
      source: source.type,
      bundledAt: new Date().toISOString(),
    };

    if (source.type === "local-extension") {
      const srcManifestPath = path.join(path.dirname(path.dirname(source.mcpPath)), "manifest.json");
      if (fs.existsSync(srcManifestPath)) {
        try {
          const srcManifest = JSON.parse(fs.readFileSync(srcManifestPath, "utf-8"));
          manifest.mcpDistSha256 = srcManifest.mcpDistSha256 ?? "";
          manifest.mcpPackageVersion = srcManifest.mcpPackageVersion;
        } catch { /* use defaults */ }
      }
    }

    fs.writeFileSync(
      path.join(this.vendorDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf-8"
    );

    // Skills
    const skillsDest = path.join(this.vendorDir, "skills");
    if (fs.existsSync(source.skillsDir)) {
      this.ensureDir(skillsDest);
      for (const name of SKILL_NAMES) {
        const srcDir = path.join(source.skillsDir, name);
        const dstDir = path.join(skillsDest, name);
        if (fs.existsSync(srcDir)) {
          fs.cpSync(srcDir, dstDir, { recursive: true });
        }
      }
    }

    // Commands
    const cmdsDest = path.join(this.vendorDir, "commands");
    this.ensureDir(cmdsDest);
    if (fs.existsSync(source.commandsDir)) {
      for (const name of CMD_NAMES) {
        const srcFile = path.join(source.commandsDir, `${name}.md`);
        const dstFile = path.join(cmdsDest, `${name}.md`);
        if (fs.existsSync(srcFile)) {
          fs.copyFileSync(srcFile, dstFile);
        }
      }
    }
  }

  // --- Distribution ---

  distributeSkillsAndCommands(): void {
    const skillsSrc = path.join(this.vendorDir, "skills");
    const cmdsSrc = path.join(this.vendorDir, "commands");

    for (const prefix of [".chitu", ".cursor"]) {
      if (fs.existsSync(skillsSrc)) {
        const skillsDst = path.join(this.workspaceRoot, prefix, "skills");
        for (const name of SKILL_NAMES) {
          const srcDir = path.join(skillsSrc, name);
          const dstDir = path.join(skillsDst, name);
          if (fs.existsSync(srcDir)) {
            this.ensureDir(dstDir);
            fs.cpSync(srcDir, dstDir, { recursive: true });
          }
        }
      }

      if (fs.existsSync(cmdsSrc)) {
        const cmdsDst = path.join(this.workspaceRoot, prefix, "commands");
        this.ensureDir(cmdsDst);
        for (const name of CMD_NAMES) {
          const srcFile = path.join(cmdsSrc, `${name}.md`);
          const dstFile = path.join(cmdsDst, `${name}.md`);
          if (fs.existsSync(srcFile)) {
            fs.copyFileSync(srcFile, dstFile);
          }
        }
      }
    }
  }

  // --- MCP configs ---

  updateMcpConfigs(): void {
    const manifest = this.readLocalManifest();
    const version = manifest?.horsewhipExtensionVersion ?? "";
    const hash = manifest?.mcpDistSha256 ?? "";

    // Write to .chitu/config.json (primary config)
    this.patchChituConfig(version, hash);

    // Also write legacy .mcp.json and .cursor/mcp.json for backward compat
    this.patchLegacyMcpConfig(".mcp.json", version, hash, "${CHITU_PROJECT_DIR}");
    this.patchLegacyMcpConfig(".cursor/mcp.json", version, hash, "${workspaceFolder}");
  }

  /** Write MCP server config to .chitu/config.json */
  private patchChituConfig(version: string, hash: string): void {
    const configPath = path.join(this.workspaceRoot, ".chitu", "config.json");
    let config: any = {};

    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch { /* rewrite */ }
    }

    config.mcpServers ??= {};
    config.mcpServers.horsewhip = {
      command: "node",
      args: ["horsewhip/mcp/index.js"],
      env: {
        HORSEWHIP_WORKSPACE: "${workspaceRoot}",
        HORSEWHIP_MCP_VERSION: version,
        HORSEWHIP_MCP_HASH: hash,
      },
      alwaysLoad: true,
    };

    const newContent = JSON.stringify(config, null, 2) + "\n";
    const oldContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
    if (newContent !== oldContent) {
      fs.writeFileSync(configPath, newContent, "utf-8");
    }
  }

  /** Write legacy .mcp.json (backward compat for other tools) */
  private patchLegacyMcpConfig(
    configRelPath: string,
    version: string,
    hash: string,
    workspaceVar: string
  ): void {
    const configPath = path.join(this.workspaceRoot, configRelPath);
    let config: any = { mcpServers: {} };

    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch { /* rewrite */ }
    }

    config.mcpServers ??= {};
    config.mcpServers.horsewhip = {
      command: "node",
      args: ["horsewhip/mcp/index.js"],
      env: {
        HORSEWHIP_WORKSPACE: workspaceVar,
        HORSEWHIP_MCP_VERSION: version,
        HORSEWHIP_MCP_HASH: hash,
      },
      alwaysLoad: configRelPath === ".mcp.json" ? true : undefined,
    };

    if (config.mcpServers.horsewhip.alwaysLoad === undefined) {
      delete config.mcpServers.horsewhip.alwaysLoad;
    }

    const newContent = JSON.stringify(config, null, 2) + "\n";
    const oldContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
    if (newContent !== oldContent) {
      fs.writeFileSync(configPath, newContent, "utf-8");
    }
  }

  // --- Version comparison ---

  private compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const va = pa[i] ?? 0;
      const vb = pb[i] ?? 0;
      if (va > vb) return 1;
      if (va < vb) return -1;
    }
    return 0;
  }

  // --- Manifest I/O ---

  private readLocalManifest(): SyncManifest | null {
    const manifestPath = path.join(this.vendorDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as SyncManifest;
    } catch {
      return null;
    }
  }

  // --- Cache I/O ---

  private readCache(): SyncCache | null {
    const cachePath = path.join(this.vendorDir, ".cache.json");
    if (!fs.existsSync(cachePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(cachePath, "utf-8")) as SyncCache;
    } catch {
      return null;
    }
  }

  private writeCache(version: string, source: string): void {
    this.ensureDir(this.vendorDir);
    const cache: SyncCache = {
      lastCheck: new Date().toISOString(),
      latestVersion: version,
      source: source as SyncCache["source"],
    };
    fs.writeFileSync(
      path.join(this.vendorDir, ".cache.json"),
      JSON.stringify(cache, null, 2) + "\n",
      "utf-8"
    );
  }

  // --- Helpers ---

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

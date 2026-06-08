import { renderHorseSmall } from "./horse.js";
import { ansi, write, getTermSize, color } from "./screen.js";
import { buildPanel, vlen, vpad } from "./visual.js";

const CHITU_VERSION = "chitu community v0.1.0";

/** Print the startup banner (horse + status panel). Returns the number of lines consumed. */
export function printStartupBanner(opts: {
  skipGuard?: boolean;
  dev?: boolean;
  mcpNames: string[];
  skillNames: string[];
  commands: { name: string; description: string }[];
  session: boolean;
  providerName?: string;
  modelName?: string;
}): number {
  const { cols } = getTermSize();
  const horse = renderHorseSmall().split("\n");
  const horseW = Math.max(...horse.map(vlen), 30);

  const buildSkillLines = (): string[] => {
    const skills = new Set<string>();
    for (const name of opts.skillNames) skills.add(`/${name}`);
    for (const cmd of opts.commands) {
      if (!cmd.name.startsWith("/exit")) skills.add(cmd.name);
    }
    return Array.from(skills);
  };

  const fitPanelContent = (items: string[], panelHeight: number): string[] => {
    const capacity = Math.max(1, panelHeight - 2);
    if (items.length <= capacity) return items;
    if (capacity === 1) return ["..."];
    return items.slice(0, capacity - 1).concat("...");
  };

  const introLines = [
    "Chitu Terminal AI Agent",
    "Horsewhip guard: " + (opts.skipGuard ? "OFF" : opts.dev ? "ON (dev mode)" : "ON"),
    "Phased run: Grow -> Trim -> Verify",
    `MCP loaded: ${opts.mcpNames.length > 0 ? opts.mcpNames.join(", ") : "none"}`,
    `Session: ${opts.session ? "resumed" : "new"}`,
  ];
  const skills = buildSkillLines();

  const rightW = Math.min(56, Math.max(22, cols - horseW - 6));
  const sideBySide = cols >= horseW + rightW + 6;

  write(ansi.clear + ansi.moveTo(0, 0));
  let bannerLines: number;
  if (sideBySide) {
    const topH = Math.max(5, Math.floor(horse.length / 2));
    const bottomH = Math.max(5, horse.length - topH);
    const topPanel = buildPanel("Chitu", fitPanelContent(introLines, topH), rightW, topH);
    const skillPanel = buildPanel("Skills", fitPanelContent(skills, bottomH), rightW, bottomH);
    const panelLines = [...topPanel, ...skillPanel];
    const total = Math.max(horse.length, panelLines.length);
    for (let i = 0; i < total; i++) {
      const left = vpad(horse[i] ?? "", horseW);
      const right = panelLines[i] ?? "";
      write(left + "  " + right + "\n");
    }
    bannerLines = total;
  } else {
    for (const line of horse) write(line + "\n");
    write("\n");
    for (const line of buildPanel("Chitu", fitPanelContent(introLines, 7), Math.min(cols - 2, 64), 7)) {
      write(line + "\n");
    }
    for (const line of buildPanel("Skills", fitPanelContent(skills, 8), Math.min(cols - 2, 64), 8)) {
      write(line + "\n");
    }
    bannerLines = horse.length + 1 + 7 + 8;
  }
  const provider = opts.providerName ?? "auto";
  const model = opts.modelName ?? "default";
  write(color.dim(`  ${CHITU_VERSION}  ·  ${provider} / ${model}`) + "\n");
  bannerLines += 1;

  write("\n");
  bannerLines += 1;
  return bannerLines;
}

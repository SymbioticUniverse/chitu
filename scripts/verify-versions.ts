/**
 * verify-versions.ts — 版本一致性检测脚本
 *
 * 用 adapters 模块检测：
 * 1. MCP 配置版本 vs 实际插件版本
 * 2. 本地 skills 与插件 skills 对比
 * 3. 输出健康报告
 */

import { detectEnv, checkHorsewhipVersionMatch, renderEnvReport } from "../src/adapters/env-detect.js";
import { getChituVersion, getMCPVersion } from "../src/adapters/version-check.js";
import { detectModelLimit } from "../src/adapters/model-limits.js";

const env = detectEnv();

console.log("\n" + "=".repeat(56));
console.log("  Chitu 版本一致性检测");
console.log("=".repeat(56) + "\n");

// 1. 赤兔自身版本
const chituVer = getChituVersion();
if (chituVer) {
  console.log(`📦 赤兔:     v${chituVer.version}`);
  console.log(`   描述:     ${chituVer.description}`);
} else {
  console.log(`📦 赤兔:     未检测到 package.json`);
}

// 2. 环境报告
console.log(renderEnvReport(env));

// 3. 版本一致性检查
const check = checkHorsewhipVersionMatch(env);
console.log(`\n📐 版本一致性:`);
console.log(`   MCP 配置:  v${check.mcpVersion ?? "N/A"}`);
console.log(`   插件最新:  v${check.pluginLatest ?? "N/A"}`);
console.log(`   一致:      ${check.match ? "✅" : "⚠️ 需要更新"}`);
console.log(`   详情:      ${check.message}`);

// 4. 模型检测
const modelName = process.env.MODEL ?? process.env.LLM_MODEL ?? "deepseek-chat";
const limit = detectModelLimit(modelName);
console.log(`\n📐 模型上下文:`);
console.log(`   模型:      ${limit.modelName}`);
console.log(`   上限:      ${limit.maxContextTokens.toLocaleString()} tokens`);
console.log(`   用户覆盖:  ${limit.userOverride ? "✅" : "否"}`);

// 5. Skills 同步检查
console.log(`\n📐 Skills 同步:`);
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WS = process.cwd();
const chituSkills = [".chitu/skills/horsewhip", ".chitu/skills/horsewhip-lock", ".chitu/skills/horsewhip-lock-auto", ".chitu/skills/horsewhip-auto"];
const pluginSkills = ["horsewip", "horsewip-lock", "horsewip-lock-auto", "horsewip-auto"];

for (const skill of chituSkills) {
  const path = join(WS, skill, "SKILL.md");
  console.log(`   ${skill}: ${existsSync(path) ? "✅" : "❌ 缺失"}`);
}

// 6. Commands 同步检查
console.log(`\n📐 Commands:`);
const chituCmds = [".chitu/commands/horsewhip.md", ".chitu/commands/horsewhip-lock.md", ".chitu/commands/horsewhip-lock-auto.md", ".chitu/commands/horsewhip-auto.md"];
for (const cmd of chituCmds) {
  const path = join(WS, cmd);
  console.log(`   ${cmd}: ${existsSync(path) ? "✅" : "❌ 缺失"}`);
}

console.log("\n" + "=".repeat(56) + "\n");

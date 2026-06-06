/**
 * adapters/index.ts — 自适应模块统一入口
 *
 * 聚合所有自适应能力，提供统一的检测和报告接口。
 * 这是赤兔自编程的基石模块。
 */

import {
  detectEnv,
  refreshEnv,
  checkHorsewhipVersionMatch,
  renderEnvReport,
} from "./env-detect.js";
import {
  detectModelLimit,
  getSupportedModels,
  renderModelLimitReport,
} from "./model-limits.js";
import {
  getChituVersion,
  getMCPVersion,
  compareVersions,
  renderVersionReport,
} from "./version-check.js";

export {
  detectEnv,
  refreshEnv,
  checkHorsewhipVersionMatch,
  renderEnvReport,
};
export type { EnvInfo } from "./env-detect.js";

export {
  detectModelLimit,
  getSupportedModels,
  renderModelLimitReport,
};
export type { ModelLimitConfig } from "./model-limits.js";

export {
  getChituVersion,
  getMCPVersion,
  compareVersions,
  renderVersionReport,
};
export type {
  ChituVersion,
  VersionDiff,
  VersionReport,
} from "./version-check.js";

/**
 * 执行完整的环境感知扫描
 * 返回三合一报告
 */
export function fullScan(workspaceRoot?: string) {
  const env = detectEnv(workspaceRoot);
  const chituVer = getChituVersion();

  // 检测模型——动态从环境变量读取模型名，然后自动检测上下文上限
  const modelName = process.env.MODEL ?? process.env.LLM_MODEL;
  const modelLimit = detectModelLimit(modelName);

  // 版本一致性检查
  const hwCheck = checkHorsewhipVersionMatch(env);

  return {
    env,
    chituVersion: chituVer,
    modelLimit,
    horsewhipCheck: hwCheck,
    report: [
      renderEnvReport(env),
      "",
      renderModelLimitReport(modelLimit),
      "",
      chituVer
        ? `📦 赤兔 v${chituVer.version}`
        : "📦 赤兔 (未检测版本)",
    ].join("\n"),
  };
}

export default {
  detectEnv,
  refreshEnv,
  checkHorsewhipVersionMatch,
  renderEnvReport,
  detectModelLimit,
  getSupportedModels,
  renderModelLimitReport,
  getChituVersion,
  fullScan,
};

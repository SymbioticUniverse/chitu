/**
 * model-limits.ts — 模型上下文上限映射表
 *
 * 自适应能力：根据模型名称自动检测合适的上下文窗口上限，
 * 避免硬编码 64000 导致的模型性能浪费。
 *
 * 支持用户覆盖检测结果。
 */

// ============================================================
// Types
// ============================================================

export interface ModelLimitConfig {
  /** 模型名称 */
  modelName: string;
  /** 上下文窗口上限（tokens） */
  maxContextTokens: number;
  /** 是否用户手动指定 */
  userOverride: boolean;
}

/** 模型上下文限制映射表 */
const MODEL_LIMITS: Record<string, number> = {
  // === DeepSeek 系列 ===
  "deepseek-chat": 65536,
  "deepseek-v4": 65536,
  "deepseek-v4-flash": 65536,
  "deepseek-v4-pro": 65536,
  "deepseek-coder": 65536,
  "deepseek-reasoner": 65536,
  "deepseek-r1": 65536,

  // === Claude 系列 ===
  "claude-3-opus-20240229": 200000,
  "claude-3-sonnet-20240229": 200000,
  "claude-3-haiku-20240307": 48000,
  "claude-3-5-sonnet-20240620": 200000,
  "claude-3-5-sonnet-20241022": 200000,
  "claude-3-5-haiku-20241022": 200000,
  "claude-4-opus": 200000,
  "claude-4-sonnet": 200000,
  "claude-sonnet-4-20250514": 200000,

  // === GPT 系列 ===
  "gpt-4-turbo": 128000,
  "gpt-4-turbo-2024-04-09": 128000,
  "gpt-4-1106-preview": 128000,
  "gpt-4-0125-preview": 128000,
  "gpt-4": 8192,
  "gpt-4-32k": 32768,
  "gpt-4o": 128000,
  "gpt-4o-2024-08-06": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4o-mini-2024-07-18": 128000,
  "gpt-3.5-turbo": 16385,
  "gpt-3.5-turbo-1106": 16385,
  "gpt-3.5-turbo-0125": 16385,
  "gpt-3.5-turbo-16k": 16385,

  // === Gemini 系列 ===
  "gemini-1.5-pro": 1000000,
  "gemini-1.5-flash": 1000000,
  "gemini-1.5-flash-8b": 1000000,
  "gemini-2.0-flash": 1000000,
  "gemini-2.0-pro": 1000000,
  "gemini-pro": 32000,

  // === Mistral 系列 ===
  "mistral-large-2407": 128000,
  "mistral-large-2411": 128000,
  "mistral-medium": 32000,
  "mistral-small": 32000,
  "mistral-tiny": 8000,
  "codestral": 256000,
  "pixtral": 128000,

  // === LLaMA / 开源 ===
  "llama-3.1-405b": 131072,
  "llama-3.1-70b": 131072,
  "llama-3.1-8b": 131072,
  "llama-3-70b": 8192,
  "llama-3-8b": 8192,
  "llama-2-70b": 4096,
  "llama-2-7b": 4096,
  "codellama": 16384,

  // === Qwen 系列 ===
  "qwen2.5-72b": 131072,
  "qwen2.5-32b": 131072,
  "qwen2.5-14b": 32768,
  "qwen2.5-7b": 32768,
  "qwen2-72b": 131072,
  "qwen2-7b": 32768,
  "qwen-turbo": 32768,
  "qwen-plus": 131072,
  "qwen-max": 32768,
  "qwen-long": 10000000,

  // === Yi 系列 ===
  "yi-34b": 32000,
  "yi-6b": 32000,
  "yi-large": 32000,
  "yi-lightning": 32000,

  // === GLM 系列 ===
  "glm-4": 128000,
  "glm-4-plus": 128000,
  "glm-4v": 2000,

  // === Grok ===
  "grok-1": 8192,
  "grok-2": 131072,

  // === Command R ===
  "command-r": 128000,
  "command-r-plus": 128000,

  // === 其他 / 默认值 ===
  "default": 64000,
};

/** 将模型名规范化，用于模糊匹配 */
function normalizeModelName(model: string): string {
  return model.toLowerCase().trim();
}

/** 精确匹配模型 */
function exactMatch(normalized: string): number | null {
  return MODEL_LIMITS[normalized] ?? null;
}

/** 前缀匹配（处理版本号变体） */
function prefixMatch(normalized: string): number | null {
  const sorted = Object.keys(MODEL_LIMITS)
    .filter((k) => k !== "default")
    .sort((a, b) => b.length - a.length); // 长匹配优先

  for (const key of sorted) {
    if (normalized.startsWith(key)) {
      return MODEL_LIMITS[key] ?? null;
    }
  }
  return null;
}

/** 关键词匹配（处理未知模型） */
function keywordMatch(normalized: string): number | null {
  const patterns: Array<{ regex: RegExp; limit: number }> = [
    // Claude 系列
    { regex: /claude[-.\s]?(3|4|3\.5)/, limit: 200000 },
    { regex: /claude/, limit: 100000 },

    // GPT 系列
    { regex: /gpt-?4/, limit: 128000 },
    { regex: /gpt-?3\.?5/, limit: 16385 },
    { regex: /gpt/, limit: 8192 },

    // Gemini
    { regex: /gemini[-.\s]?1\.?5/, limit: 1000000 },
    { regex: /gemini[-.\s]?2\.?0/, limit: 1000000 },
    { regex: /gemini/, limit: 32000 },

    // Mistral
    { regex: /mistral[-.\s]?large/, limit: 128000 },
    { regex: /codestral/, limit: 256000 },
    { regex: /mistral/, limit: 32000 },

    // DeepSeek
    { regex: /deepseek/, limit: 65536 },

    // LLaMA
    { regex: /llama[-.\s]?3[-.\s]?1/, limit: 131072 },
    { regex: /llama[-.\s]?3/, limit: 8192 },
    { regex: /llama/, limit: 4096 },

    // Qwen
    { regex: /qwen2\.?5/, limit: 131072 },
    { regex: /qwen/, limit: 32768 },

    // Yi
    { regex: /\byi[-.\s]?(34|6|large|lightning)/, limit: 32000 },

    // Grok
    { regex: /grok/, limit: 131072 },
  ];

  for (const { regex, limit } of patterns) {
    if (regex.test(normalized)) return limit;
  }

  return null;
}

/**
 * 检测模型的上下文上限
 * @param model 模型名称（如 "deepseek-chat", "gpt-4-turbo"）
 * @param userOverride 用户手动指定的上限（可选，优先级最高）
 * @returns 检测结果
 */
export function detectModelLimit(
  model?: string,
  userOverride?: number
): ModelLimitConfig {
  // 用户手动指定 → 优先级最高
  if (userOverride && userOverride > 0) {
    return {
      modelName: model ?? "unknown",
      maxContextTokens: userOverride,
      userOverride: true,
    };
  }

  if (!model) {
    return {
      modelName: "unknown",
      maxContextTokens: MODEL_LIMITS.default!,
      userOverride: false,
    };
  }

  const normalized = normalizeModelName(model);

  // 精确匹配
  const exact = exactMatch(normalized);
  if (exact !== null) {
    return {
      modelName: model,
      maxContextTokens: exact,
      userOverride: false,
    };
  }

  // 前缀匹配
  const prefix = prefixMatch(normalized);
  if (prefix !== null) {
    return {
      modelName: model,
      maxContextTokens: prefix,
      userOverride: false,
    };
  }

  // 关键词匹配
  const keyword = keywordMatch(normalized);
  if (keyword !== null) {
    return {
      modelName: model,
      maxContextTokens: keyword,
      userOverride: false,
    };
  }

  // 回退到默认值
  return {
    modelName: model,
    maxContextTokens: MODEL_LIMITS.default!,
    userOverride: false,
  };
}

/** 获取所有支持的模型列表 */
export function getSupportedModels(): Array<{ name: string; limit: number }> {
  return Object.entries(MODEL_LIMITS)
    .filter(([k]) => k !== "default")
    .map(([name, limit]) => ({ name, limit }))
    .sort((a, b) => b.limit - a.limit);
}

/** 渲染模型限制报告 */
export function renderModelLimitReport(config: ModelLimitConfig): string {
  const limitK = (config.maxContextTokens / 1000).toFixed(0);
  return [
    `📐 模型上下文窗口:`,
    `   模型:     ${config.modelName}`,
    `   上限:     ${config.maxContextTokens.toLocaleString()} tokens (${limitK}K)`,
    `   用户覆盖: ${config.userOverride ? "✅ 是" : "❌ 否"}`,
  ].join("\n");
}

export default { detectModelLimit, getSupportedModels, renderModelLimitReport };

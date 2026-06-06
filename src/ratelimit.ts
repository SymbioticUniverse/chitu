export interface RateLimitConfig {
  /** Max calls per window */
  maxCalls: number;
  /** Window in milliseconds */
  windowMs: number;
}

const DEFAULT_CONFIG: Record<string, RateLimitConfig> = {
  default:    { maxCalls: 60, windowMs: 60_000 },   // 60/min
  run_shell:  { maxCalls: 20, windowMs: 60_000 },   // 20/min
  write_file: { maxCalls: 30, windowMs: 60_000 },   // 30/min
  web_fetch:  { maxCalls: 10, windowMs: 60_000 },   // 10/min
  web_search: { maxCalls: 10, windowMs: 60_000 },   // 10/min
};

export class RateLimiter {
  private buckets = new Map<string, number[]>();
  private configs: Record<string, RateLimitConfig>;

  constructor(configs?: Record<string, RateLimitConfig>) {
    this.configs = { ...DEFAULT_CONFIG, ...configs };
  }

  /** Check if a tool call is allowed. Returns ms to wait if rate-limited, or 0 if allowed. */
  check(toolName: string): number {
    const config = this.configs[toolName] ?? this.configs["default"]!;
    const now = Date.now();
    const bucket = this.getOrCreateBucket(toolName);

    // Prune expired entries
    while (bucket.length > 0 && (bucket[0] ?? 0) < now - config.windowMs) {
      bucket.shift();
    }

    if (bucket.length >= config.maxCalls) {
      const oldest = bucket[0] ?? now;
      return oldest + config.windowMs - now;
    }

    bucket.push(now);
    return 0;
  }

  /** Reset all counters */
  reset(): void {
    this.buckets.clear();
  }

  /** Get current usage stats */
  stats(): Array<{ tool: string; used: number; limit: number; windowMs: number }> {
    const now = Date.now();
    const result: Array<{ tool: string; used: number; limit: number; windowMs: number }> = [];

    for (const [tool, config] of Object.entries(this.configs)) {
      const bucket = this.getOrCreateBucket(tool);
      const active = bucket.filter((t) => t > now - config.windowMs).length;
      result.push({ tool, used: active, limit: config.maxCalls, windowMs: config.windowMs });
    }

    return result;
  }

  private getOrCreateBucket(name: string): number[] {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = [];
      this.buckets.set(name, bucket);
    }
    return bucket;
  }
}

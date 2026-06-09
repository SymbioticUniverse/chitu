// Shared SSE (Server-Sent Events) stream utilities for provider implementations.
// Handles the low-level fetch → reader → buffer → line-split loop.

export interface SSELineHandler {
  (line: string): void;
}

export interface SSEStreamOptions {
  /** Abort signal to cancel the stream (passed to both fetch and reader). */
  signal?: AbortSignal;
  /** Timeout in ms for the overall stream read (default: 300s). */
  timeoutMs?: number;
}

/**
 * Fetch a streaming endpoint and yield each SSE data line.
 * Each `data:` line is passed to the handler; the handler is responsible
 * for JSON-parsing and converting to provider-specific events.
 *
 * Returns when the stream ends, or throws on timeout/abort.
 */
export async function readSSEStream(
  url: string,
  init: RequestInit,
  handler: SSELineHandler,
  opts: SSEStreamOptions = {},
): Promise<void> {
  // Combine caller's signal with an overall read timeout
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

  let combinedSignal: AbortSignal;
  if (opts.signal) {
    // Merge external signal with timeout
    const signals = [opts.signal, timeoutController.signal];
    combinedSignal = AbortSignal.any
      ? AbortSignal.any(signals)
      : (() => { const c = new AbortController(); signals.forEach(s => { s.addEventListener("abort", () => c.abort(s.reason), { once: true }); if (s.aborted) c.abort(s.reason); }); return c.signal; })();
  } else {
    combinedSignal = timeoutController.signal;
  }

  let resp: Response;
  try {
    resp = await fetch(url, { ...init, signal: combinedSignal });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API error ${resp.status}: ${body}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        handler(data);
      }
    }
  } finally {
    clearTimeout(timeoutId);
    reader.releaseLock();
  }
}

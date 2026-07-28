/**
 * In-memory JSON counters served by GET /metrics.
 * Tracks totals plus per-module request/error counts.
 */
export interface MetricsSnapshot {
  startedAt: string;
  uptimeSeconds: number;
  requests: number;
  errors: number;
  modules: Record<string, { requests: number; errors: number }>;
}

export class Metrics {
  private readonly startedAt = new Date();
  private requests = 0;
  private errors = 0;
  private readonly modules = new Map<string, { requests: number; errors: number }>();

  record(moduleName: string, statusCode: number): void {
    this.requests += 1;
    const entry = this.modules.get(moduleName) ?? { requests: 0, errors: 0 };
    entry.requests += 1;
    if (statusCode >= 500) {
      this.errors += 1;
      entry.errors += 1;
    }
    this.modules.set(moduleName, entry);
  }

  snapshot(): MetricsSnapshot {
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      requests: this.requests,
      errors: this.errors,
      modules: Object.fromEntries(this.modules)
    };
  }
}

/** Derive a module bucket from a request URL. */
export function moduleFromUrl(url: string): string {
  const path = url.split("?")[0] ?? url;
  if (path === "/healthz" || path === "/readyz" || path === "/metrics") return "health";
  const match = /^\/api\/v1\/([^/]+)/.exec(path);
  if (!match || !match[1]) return "other";
  const head = match[1];
  if (head === "me") return "auth";
  if (head === "vault") return "vault";
  return head;
}

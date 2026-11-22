import type { PlanningUsage } from "@morassistant/shared-types";

export const DEFAULT_PLANNING_TOKEN_LIMIT = 24_000;
export const MAX_PLANNING_ATTEMPTS = 2;
export const MAX_MODEL_MESSAGE_BYTES = 32_000;
export const MAX_EVIDENCE_BYTES_PER_RUN = 12_000;

export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null));

/** Select complete records; never slice JSON or an ID that will be used by a write. */
export function boundedRecords<T>(values: Iterable<T>, maxBytes: number, maxCount: number): T[] {
  const selected: T[] = [];
  let bytes = 2;
  for (const value of values) {
    const size = jsonBytes(value) + 1;
    if (bytes + size > maxBytes) continue;
    selected.push(value);
    bytes += size;
    if (selected.length === maxCount) break;
  }
  return selected;
}

export function rankTargets<T>(items: readonly T[], query: string, targets: ReadonlySet<string>, identity: (item: T) => [string, string]): T[] {
  const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const normalized = query.toLowerCase();
  return items.map((item, index) => {
    const [id, label] = identity(item);
    const name = label.toLowerCase();
    const score = (targets.has(id) ? 10_000 : 0) + (name.length > 2 && normalized.includes(name) ? 100 : 0) +
      (name.match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => words.has(word) || (word.endsWith("s") ? words.has(word.slice(0, -1)) : words.has(`${word}s`))).length * 5;
    return { item, index, score };
  }).sort((a, b) => b.score - a.score || b.index - a.index).map(({ item }) => item);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Each attempt gets a fresh thread, so its cumulative counter starts at zero. */
export class TurnBudget {
  private readonly byThread = new Map<string, { total: number; cached: number }>();
  private evidenceBytes = 0;
  constructor(readonly limit: number) {}

  consumeEvidence(value: unknown): boolean {
    const bytes = jsonBytes(value);
    if (this.evidenceBytes + bytes > MAX_EVIDENCE_BYTES_PER_RUN) return false;
    this.evidenceBytes += bytes;
    return true;
  }

  record(threadId: string, value: unknown): PlanningUsage | undefined {
    if (!value || typeof value !== "object") return;
    const { totalTokens, cachedInputTokens } = value as { totalTokens?: unknown; cachedInputTokens?: unknown };
    if (!nonnegativeInteger(totalTokens) || !nonnegativeInteger(cachedInputTokens) || cachedInputTokens > totalTokens) return;
    const previous = this.byThread.get(threadId);
    if (previous && previous.total >= totalTokens) return;
    this.byThread.set(threadId, { total: totalTokens, cached: cachedInputTokens });
    return this.usage;
  }

  get usage(): PlanningUsage | undefined {
    if (!this.byThread.size) return;
    let totalTokens = 0;
    let cachedInputTokens = 0;
    for (const item of this.byThread.values()) {
      totalTokens += item.total;
      cachedInputTokens += item.cached;
    }
    return { totalTokens, cachedInputTokens, limitTokens: this.limit };
  }

  get canRetry(): boolean {
    const usage = this.usage;
    // No blind retry, nor a retry without room for another ordinary-sized call.
    return Boolean(usage && usage.totalTokens + Math.min(6_000, Math.ceil(this.limit / 2)) < this.limit);
  }
}

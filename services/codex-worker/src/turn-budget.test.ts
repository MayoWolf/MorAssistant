import { describe, expect, it } from "vitest";
import { boundedRecords, jsonBytes, rankTargets, TurnBudget } from "./turn-budget.js";

describe("planning budgets", () => {
  it("counts each cumulative usage stream once and sums separate attempts", () => {
    const budget = new TurnBudget(24_000);
    expect(budget.canRetry).toBe(false);
    expect(budget.record("a", { totalTokens: 3_500, cachedInputTokens: 200 })?.totalTokens).toBe(3_500);
    expect(budget.record("a", { totalTokens: 3_500, cachedInputTokens: 200 })).toBeUndefined();
    expect(budget.record("a", { totalTokens: 3_000, cachedInputTokens: 600 })).toBeUndefined();
    expect(budget.record("a", { totalTokens: 7_500, cachedInputTokens: 1_000 })).toBeDefined();
    expect(budget.canRetry).toBe(true);
    expect(budget.record("b", { totalTokens: 13_000, cachedInputTokens: 3_000 }))
      .toEqual({ totalTokens: 20_500, cachedInputTokens: 4_000, limitTokens: 24_000 });
    expect(budget.canRetry).toBe(false);
  });

  it("limits tool results across the entire request and rejects oversized JSON records by byte size", () => {
    const budget = new TurnBudget(24_000);
    expect(budget.consumeEvidence("é".repeat(2_500))).toBe(true);
    expect(budget.consumeEvidence("é".repeat(2_500))).toBe(true);
    expect(budget.consumeEvidence("é".repeat(1_000))).toBe(false);
    const chosen = boundedRecords(["😀".repeat(20), "exact-id_1", "exact-id_2"], 30, 3);
    expect(chosen).toEqual(["exact-id_1", "exact-id_2"]);
    expect(jsonBytes(chosen)).toBeLessThanOrEqual(30);
  });

  it("prefers attached and named candidates over newer incidental geometry", () => {
    const items = [{ id: "1", name: "Hex shaft" }, { id: "2", name: "Motor" }, { id: "3", name: "Wheel" }];
    expect(rankTargets(items, "Place it on the hex shaft", new Set(["2"]), (item) => [item.id, item.name]).map((item) => item.id))
      .toEqual(["2", "1", "3"]);
  });
});

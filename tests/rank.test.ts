import { describe, expect, test } from "bun:test";
import { freshnessLabel, scoreAxes } from "../src/retrieve/rank.ts";

describe("rank", () => {
  test("freshness buckets", () => {
    const now = Date.UTC(2026, 6, 13);
    expect(freshnessLabel(now - 2 * 86400000, now)).toBe("High");
    expect(freshnessLabel(now - 14 * 86400000, now)).toBe("Medium");
    expect(freshnessLabel(now - 60 * 86400000, now)).toBe("Low");
  });

  test("axes produce three outputs", () => {
    const axes = scoreAxes({
      latinRank: 1,
      cjkRank: 2,
      entityHits: 3,
      traceHits: 2,
      constraintCount: 1,
      entityInTrace: true,
      constraintHasProvenance: true,
      toolCallCount: 4,
      pairedResultCount: 4,
      hasTerminalWrite: true,
      isOpenChunk: false,
      errorCount: 0,
      hasSuccessAfterError: false,
      endTs: Date.now(),
      now: Date.now(),
    });
    expect(axes.relevance).toBeGreaterThan(30);
    expect(axes.confidence).toBeGreaterThan(50);
    expect(["High", "Medium", "Low"]).toContain(axes.freshness);
  });
});

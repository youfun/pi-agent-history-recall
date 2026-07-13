import { describe, expect, test } from "bun:test";
import { cjkGramsFromText, gramsForSpan, hasCjk } from "../src/extract/cjk.ts";
import { buildFtsMatchQueries } from "../src/index/fts.ts";

describe("cjk grams", () => {
  test("detects CJK", () => {
    expect(hasCjk("修改货期规则")).toBe(true);
    expect(hasCjk("hello world")).toBe(false);
  });

  test("bigrams and trigrams", () => {
    const grams = gramsForSpan("货期规则");
    expect(grams).toContain("货期");
    expect(grams).toContain("期规");
    expect(grams).toContain("规则");
    expect(grams).toContain("货期规");
  });

  test("fts match includes cjk grams", () => {
    const q = buildFtsMatchQueries("修改货期规则");
    expect(q.cjk).toBeTruthy();
    expect(q.cjk!).toContain("货期");
  });
});

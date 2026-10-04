import { describe, expect, it } from "vitest";
import { buildMaterials } from "@/lib/reviewGeneration/materials";
import { REVIEW_CASES, VERIFICATION_CASES } from "@/scripts/eval/reviewCases";

// オフライン評価のデータ自体の確認(評価の前提が崩れていないか)。
describe("オフライン評価のデータ", () => {
  it("30〜50件あり、否定的な内容を含むケースが十分にある", () => {
    expect(REVIEW_CASES.length).toBeGreaterThanOrEqual(30);
    expect(REVIEW_CASES.length).toBeLessThanOrEqual(50);
    expect(REVIEW_CASES.filter((c) => c.negative).length).toBeGreaterThanOrEqual(10);
    expect(new Set(REVIEW_CASES.map((c) => c.id)).size).toBe(REVIEW_CASES.length);
  });

  it.each(REVIEW_CASES.map((c) => [c.id, c] as const))("%s: 否定的な内容の判定が想定どおり", (_id, testCase) => {
    const materials = buildMaterials(testCase.answers);
    expect(materials.length).toBeGreaterThan(0);
    expect(materials.some((m) => m.negative)).toBe(testCase.negative);
  });

  it("電話番号は素材の段階で伏せる", () => {
    const pii = REVIEW_CASES.find((c) => c.id === "hair-pii")!;
    expect(buildMaterials(pii.answers).map((m) => m.text).join("")).not.toMatch(/\d{3}-\d{4}-\d{4}/);
  });

  it("意味検証の比較用データは、素材から言える文と言えない文の両方を含む", () => {
    expect(VERIFICATION_CASES.some((c) => c.expectedSupported)).toBe(true);
    expect(VERIFICATION_CASES.some((c) => !c.expectedSupported)).toBe(true);
  });
});

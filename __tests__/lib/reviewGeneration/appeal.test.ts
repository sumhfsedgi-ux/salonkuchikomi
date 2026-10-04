import { describe, expect, it } from "vitest";
import { buildAppealPlan } from "@/lib/reviewGeneration/appeal";
import { buildMaterials, type MaterialInput } from "@/lib/reviewGeneration/materials";

const STAFF = "スタッフ・サロンについて感じたことを教えてください";
const FINISH = "仕上がりについて感じたことを教えてください";
const VISIT: MaterialInput = { questionText: "今回のご来店は何回目ですか？", questionType: "single", selected: ["初めて"] };
const free = (text: string): MaterialInput => ({ questionText: "ご自由にお書きください", questionType: "text", selected: [], freeText: text });
const multiple = (questionText: string, selected: string[]): MaterialInput => ({ questionText, questionType: "multiple", selected });

const textOf = (materials: ReturnType<typeof buildMaterials>, ids: readonly string[]) =>
  ids.map((id) => materials.find((m) => m.id === id)?.text);

describe("buildAppealPlan", () => {
  it("お客様が評価している良さの中から主役を1〜2個選び、ほかは補助、意向は締め、否定的な内容は必ず入れる", () => {
    const materials = buildMaterials([
      multiple(STAFF, ["カウンセリングが丁寧", "清潔感がある"]),
      multiple(FINISH, ["理想通りの仕上がり"]),
      free("また来たいです"),
    ]);
    const plan = buildAppealPlan(materials);
    expect(textOf(materials, plan.primaryIds)).toEqual(["カウンセリングが丁寧", "理想通りの仕上がり"]);
    expect(textOf(materials, plan.supportIds)).toEqual(["清潔感がある"]);
    expect(textOf(materials, plan.closingIds)).toEqual(["また来たいです"]);
    expect(plan.requiredIds).toEqual([]);
  });

  it("店舗の特徴と一致する回答を、主役として優先する", () => {
    const materials = buildMaterials([
      multiple(STAFF, ["落ち着いた雰囲気", "説明が分かりやすかった"]),
      multiple(FINISH, ["自然な仕上がり"]),
    ]);
    const without = buildAppealPlan(materials);
    const withStore = buildAppealPlan(materials, "肌の状態に合わせた分かりやすいご説明を大切にしています。");
    expect(textOf(materials, without.primaryIds)[0]).toBe("自然な仕上がり");
    expect(textOf(materials, withStore.primaryIds)[0]).toBe("説明が分かりやすかった");
    expect(textOf(materials, withStore.storeMatchedIds)).toEqual(["説明が分かりやすかった"]);
  });

  it("店舗情報にしか無い良さは、主役にも補助にもしない(回答の中からだけ選ぶ)", () => {
    const materials = buildMaterials([multiple(FINISH, ["デザインが気に入った"])]);
    const plan = buildAppealPlan(materials, "個室でゆったり過ごせる、カウンセリングを大切にしたサロンです。");
    const used = [...plan.primaryIds, ...plan.supportIds, ...plan.closingIds];
    expect(textOf(materials, used)).toEqual(["デザインが気に入った"]);
    expect(Object.values(plan.categories)).not.toContain("counseling");
  });

  it("本人の言葉を最優先し、来店回数・否定的な内容は良さとして選ばない", () => {
    const materials = buildMaterials([
      VISIT,
      multiple(STAFF, ["清潔感がある"]),
      free("途中寝ちゃいました笑 また来ます！"),
      free("待ち時間が長かったのが残念でした"),
    ]);
    const plan = buildAppealPlan(materials);
    expect(textOf(materials, plan.primaryIds)[0]).toBe("途中寝ちゃいました笑 また来ます！");
    expect(textOf(materials, plan.requiredIds)).toEqual(["待ち時間が長かったのが残念でした"]);
    expect(textOf(materials, [...plan.primaryIds, ...plan.supportIds])).not.toContain("初めて");
  });
});

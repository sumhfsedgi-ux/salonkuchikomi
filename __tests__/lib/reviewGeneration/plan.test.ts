import { describe, expect, it } from "vitest";
import { buildMaterials, type MaterialInput } from "@/lib/reviewGeneration/materials";
import {
  buildCompositionPlan,
  planSignature,
  previousPlanSchema,
  type CompositionPlan,
} from "@/lib/reviewGeneration/plan";

/** 再現できる疑似乱数(テストで構成プランを固定するため)。 */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const VISIT: MaterialInput = { questionText: "今回のご来店は何回目ですか？", questionType: "single", selected: ["4回以上"] };
const EXPERIENCE: MaterialInput = {
  questionText: "施術後のお肌について、どのように感じましたか？",
  questionType: "multiple",
  selected: ["肌がしっとりした", "肌が明るく見えた"],
};
const STAFF: MaterialInput = {
  questionText: "スタッフ・サロンについて感じたことを教えてください",
  questionType: "multiple",
  selected: ["説明が分かりやすかった", "落ち着いた雰囲気"],
};
const NEGATIVE_FREE_TEXT: MaterialInput = {
  questionText: "ご自由にお書きください",
  questionType: "text",
  selected: [],
  freeText: "スタッフさんは優しかったけど、待ち時間が長かったのが残念でした。",
};

function usedIds(plan: CompositionPlan): string[] {
  return [...plan.mainIds, ...plan.supportIds];
}

describe("buildCompositionPlan", () => {
  it("否定的な素材と本人の言葉は、どの乱数でも必ず使う", () => {
    const materials = buildMaterials([VISIT, EXPERIENCE, STAFF, NEGATIVE_FREE_TEXT]);
    const mustUse = materials.filter((m) => m.negative || m.kind !== "choice").map((m) => m.id);
    expect(mustUse.length).toBeGreaterThan(0);
    for (let seed = 1; seed <= 200; seed++) {
      const plan = buildCompositionPlan(materials, { random: seeded(seed) });
      for (const id of mustUse) {
        expect(usedIds(plan)).toContain(id);
        expect(plan.unusedIds).not.toContain(id);
      }
    }
  });

  it("否定的な素材だけの口コミにしない(肯定的な回答があれば1つは使う。来店回数は数えない)", () => {
    const cases = [
      buildMaterials([
        { questionText: "スタッフ・サロンについて感じたことを教えてください", questionType: "multiple", selected: ["その他"], otherDetail: "部屋が少し寒かった" },
        { questionText: "施術後、体についてどのように感じましたか？", questionType: "multiple", selected: ["体が軽くなった気がする"] },
        VISIT,
      ]),
      // 「初めて」と否定的な自由記述だけを使うと、「自然な仕上がり」と答えたことが消える。
      buildMaterials([
        { questionText: "今回のご来店は何回目ですか？", questionType: "single", selected: ["初めて"] },
        { questionText: "仕上がりはいかがでしたか？", questionType: "multiple", selected: ["自然な仕上がり"] },
        { questionText: "ご自由にお書きください", questionType: "text", selected: [], freeText: "目にしみて少しヒリヒリしました" },
      ]),
    ];
    for (const materials of cases) {
      for (let seed = 1; seed <= 100; seed++) {
        const plan = buildCompositionPlan(materials, { random: seeded(seed) });
        const used = materials.filter((m) => usedIds(plan).includes(m.id));
        expect(used.some((m) => !m.negative && m.role !== "visit")).toBe(true);
      }
    }
  });

  it("主役・補助・使わない素材で、すべての素材を重複なく分ける", () => {
    const materials = buildMaterials([VISIT, EXPERIENCE, STAFF]);
    const plan = buildCompositionPlan(materials, { random: seeded(7) });
    const all = [...plan.mainIds, ...plan.supportIds, ...plan.unusedIds].sort();
    expect(all).toEqual(materials.map((m) => m.id).sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("本人の言葉があれば主役にし、無ければ体験・スタッフの素材から選ぶ", () => {
    const withText = buildMaterials([VISIT, EXPERIENCE, NEGATIVE_FREE_TEXT]);
    const freeTextIds = withText.filter((m) => m.kind === "free_text").map((m) => m.id);
    expect(buildCompositionPlan(withText, { random: seeded(3) }).mainIds).toEqual(freeTextIds.slice(0, 2));

    const choicesOnly = buildMaterials([VISIT, EXPERIENCE, STAFF]);
    for (let seed = 1; seed <= 50; seed++) {
      const plan = buildCompositionPlan(choicesOnly, { random: seeded(seed) });
      const mainRoles = choicesOnly.filter((m) => plan.mainIds.includes(m.id)).map((m) => m.role);
      expect(mainRoles).not.toContain("visit");
    }
  });

  it("素材が少なければ短くする", () => {
    const materials = buildMaterials([VISIT]);
    expect(buildCompositionPlan(materials, { random: seeded(1) }).length).toBe("short");
  });

  it("「またお願いしたい」と思える気持ちで締めるのは、否定的な内容が無いか、回答に意向があるときだけ", () => {
    const closingsOf = (inputs: MaterialInput[]) => {
      const m = buildMaterials(inputs);
      return new Set(Array.from({ length: 100 }, (_, i) => buildCompositionPlan(m, { random: seeded(i + 1) }).closing));
    };
    // 肯定的な回答だけなら、気持ちとしての意向で締めてよい。
    expect(closingsOf([VISIT, EXPERIENCE, STAFF])).toContain("intent");
    // 否定的な内容があって意向が無ければ、全体の感想や前向きな気持ちで締めない(打ち消しに見えるため)。
    expect([...closingsOf([VISIT, EXPERIENCE, STAFF, NEGATIVE_FREE_TEXT])]).toEqual(["plain"]);
    // 回答に意向があれば、否定的な内容があっても締めに使える。
    expect(
      closingsOf([NEGATIVE_FREE_TEXT, { questionText: "ご自由に", questionType: "text", selected: [], freeText: "また来ます！" }]),
    ).toContain("intent");
  });

  it("感嘆符の使い方は生成ごとに揺らぐ。否定的な内容があれば「最後の文だけ」は選ばない", () => {
    const stylesOf = (inputs: MaterialInput[]) => {
      const m = buildMaterials(inputs);
      return new Set(Array.from({ length: 100 }, (_, i) => buildCompositionPlan(m, { random: seeded(i + 1) }).exclamation));
    };
    expect([...stylesOf([VISIT, EXPERIENCE, STAFF])].sort()).toEqual(["inline", "last", "none"]);
    expect([...stylesOf([VISIT, EXPERIENCE, STAFF, NEGATIVE_FREE_TEXT])].sort()).toEqual(["inline", "none"]);
  });

  it("補助の素材があるときだけ「小さな感想から入る」書き出しを選べる", () => {
    const single = buildMaterials([STAFF]);
    for (let seed = 1; seed <= 50; seed++) {
      const plan = buildCompositionPlan(single, { random: seeded(seed) });
      if (plan.supportIds.length === 0) expect(plan.opening).not.toBe("small_detail");
    }
  });

  it("再生成では前回と違う構成を選ぶ", () => {
    const materials = buildMaterials([VISIT, EXPERIENCE, STAFF, NEGATIVE_FREE_TEXT]);
    for (let seed = 1; seed <= 50; seed++) {
      const first = buildCompositionPlan(materials, { random: seeded(seed) });
      const second = buildCompositionPlan(materials, { random: seeded(seed), previous: first });
      expect(planSignature(second)).not.toBe(planSignature(first));
    }
  });

  it("素材が無ければエラー", () => {
    expect(() => buildCompositionPlan([])).toThrow();
  });
});

describe("previousPlanSchema", () => {
  it("素材IDと列挙値だけを受け付ける", () => {
    const valid = { mainIds: ["M1"], supportIds: ["M2", "M10"], length: "short", opening: "main", closing: "plain" };
    expect(previousPlanSchema.safeParse(valid).success).toBe(true);
    expect(previousPlanSchema.safeParse({ ...valid, mainIds: ["<script>"] }).success).toBe(false);
    expect(previousPlanSchema.safeParse({ ...valid, opening: "anything" }).success).toBe(false);
  });
});

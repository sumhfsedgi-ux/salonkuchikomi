import { describe, expect, it } from "vitest";
import { buildMaterials, type MaterialInput } from "@/lib/reviewGeneration/materials";
import {
  alternativeStyleSeed,
  buildStyleSeed,
  previousStyleSeedSchema,
  styleSeedSignature,
  type StyleSeed,
} from "@/lib/reviewGeneration/plan";

/** 再現できる疑似乱数(テストで Style Seed を固定するため)。 */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const VISIT: MaterialInput = { questionText: "今回のご来店は何回目ですか？", questionType: "single", selected: ["4回以上"] };
const REASON: MaterialInput = { questionText: "今回、どのようなお悩みでご来店されましたか？", questionType: "multiple", selected: ["乾燥"] };
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
const CASUAL_FREE_TEXT: MaterialInput = {
  questionText: "ご自由にお書きください",
  questionType: "text",
  selected: [],
  freeText: "途中寝ちゃいました笑",
};
const INTENT_FREE_TEXT: MaterialInput = { questionText: "ご自由にお書きください", questionType: "text", selected: [], freeText: "また来ます！" };

function seedsOf(inputs: MaterialInput[], count = 100): StyleSeed[] {
  const materials = buildMaterials(inputs);
  return Array.from({ length: count }, (_, i) => buildStyleSeed(materials, { random: seeded(i + 1) }));
}

const valuesOf = <K extends keyof StyleSeed>(seeds: StyleSeed[], key: K) => new Set(seeds.map((s) => s[key]));

describe("buildStyleSeed", () => {
  it("書き方の傾向だけを選び、どの素材を中心にするか(内容)は決めない(Appeal Planning と分ける)", () => {
    const [seed] = seedsOf([VISIT, EXPERIENCE, STAFF], 1);
    expect(Object.keys(seed).sort()).toEqual(
      ["closing", "emotion", "exclamation", "length", "opening", "tone"].sort(),
    );
  });

  it("生成ごとに組み合わせが揺らぐ(少数のテンプレートに収束しない)", () => {
    const signatures = new Set(seedsOf([VISIT, REASON, EXPERIENCE, STAFF]).map(styleSeedSignature));
    expect(signatures.size).toBeGreaterThan(40);
  });

  it("意向の締めは、回答に意向があるときだけ選べる", () => {
    expect(valuesOf(seedsOf([VISIT, EXPERIENCE, STAFF]), "closing")).not.toContain("short_intention_allowed");
    expect(valuesOf(seedsOf([VISIT, EXPERIENCE, INTENT_FREE_TEXT]), "closing")).toContain("short_intention_allowed");
  });

  it("本人の文章があれば口調はその人に合わせ、無ければ「です・ます」の範囲でだけ揺らす", () => {
    expect([...valuesOf(seedsOf([EXPERIENCE, CASUAL_FREE_TEXT]), "tone")]).toEqual(["match_voice"]);
    expect([...valuesOf(seedsOf([EXPERIENCE, STAFF]), "tone")].sort()).toEqual(["light", "plain"]);
  });

  it("書き出しは素材にあるものだけから選ぶ", () => {
    const openings = valuesOf(seedsOf([EXPERIENCE, STAFF]), "opening");
    expect(openings).not.toContain("visit");
    expect(openings).not.toContain("reason");
    expect(openings).not.toContain("own_words");
    expect(valuesOf(seedsOf([VISIT, REASON, EXPERIENCE, CASUAL_FREE_TEXT]), "opening")).toEqual(
      new Set(["fact", "feeling", "own_words", "reason", "visit"]),
    );
  });

  it("書ける内容が少なければ、やや長めは選ばない(水増しを避ける)", () => {
    const single: MaterialInput = { ...STAFF, selected: ["落ち着いた雰囲気"] };
    expect(valuesOf(seedsOf([VISIT, single]), "length")).not.toContain("slightly_long");
  });

  it("再生成では前回と違う組み合わせを選ぶ", () => {
    const materials = buildMaterials([VISIT, EXPERIENCE, STAFF]);
    for (let i = 1; i <= 30; i++) {
      const first = buildStyleSeed(materials, { random: seeded(i) });
      const second = buildStyleSeed(materials, { random: seeded(i), previous: first });
      expect(styleSeedSignature(second)).not.toBe(styleSeedSignature(first));
      expect(styleSeedSignature(alternativeStyleSeed(materials, first, seeded(i)))).not.toBe(styleSeedSignature(first));
    }
  });

  it("素材が無ければ例外", () => {
    expect(() => buildStyleSeed([])).toThrow();
  });
});

describe("previousStyleSeedSchema", () => {
  it("決まった値だけを受け付ける(前の版の構成プランの形は通さない)", () => {
    const valid = {
      length: "short",
      emotion: "none",
      exclamation: "occasional",
      opening: "fact",
      closing: "neutral",
      tone: "plain",
    };
    expect(previousStyleSeedSchema.safeParse(valid).success).toBe(true);
    expect(previousStyleSeedSchema.safeParse({ ...valid, opening: "anything" }).success).toBe(false);
    expect(
      previousStyleSeedSchema.safeParse({ mainIds: ["M1"], supportIds: [], length: "short", opening: "main", closing: "plain" })
        .success,
    ).toBe(false);
  });
});

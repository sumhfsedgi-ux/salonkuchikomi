import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICallError, type CallOpenAIJsonOptions, type OpenAITask } from "@/lib/ai/openai";
import { buildMaterials, type MaterialInput } from "@/lib/reviewGeneration/materials";
import {
  assembleDraft,
  cleanSentences,
  lintPlainDraft,
  ReviewGenerationError,
  runReviewPipeline,
  runShadowVerification,
} from "@/lib/reviewGeneration/pipeline";
import { GENERATION_SYSTEM_PROMPT, PROMPT_VERSION, type RawDraft, type RawVerification } from "@/lib/reviewGeneration/prompts";
import type { CallJson } from "@/lib/reviewGeneration/verify";

type Handler = unknown | Error | ((options: CallOpenAIJsonOptions) => unknown);

/** タスクごとに、返す値(または投げるエラー)を順に並べた偽の OpenAI 呼び出し。 */
function fakeOpenAI(script: Partial<Record<OpenAITask, Handler[]>>) {
  const calls: CallOpenAIJsonOptions[] = [];
  const queues = Object.fromEntries(Object.entries(script).map(([task, list]) => [task, [...(list ?? [])]]));
  const callJson: CallJson = async <T>(options: CallOpenAIJsonOptions) => {
    calls.push(options);
    const next = queues[options.task]?.shift();
    if (next === undefined) throw new Error(`予定外の呼び出し: ${options.task}`);
    const value = typeof next === "function" ? (next as (o: CallOpenAIJsonOptions) => unknown)(options) : next;
    if (value instanceof Error) throw value;
    return { data: value as T, model: `model-${options.task}`, usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 1, attempts: 1 };
  };
  return { callJson, calls, tasks: () => calls.map((c) => c.task) };
}

function draft(...sentences: Array<[string, string[]]>): RawDraft {
  return { sentences: sentences.map(([text, source_ids]) => ({ text, source_ids, break_after: false })) };
}

function verdicts(...rows: Array<[number, boolean, string[]?]>): RawVerification {
  return {
    results: rows.map(([sentence, supported, issues]) => ({
      sentence,
      supported,
      issues: (issues ?? []) as RawVerification["results"][number]["issues"],
    })),
  };
}

const VISIT: MaterialInput = { questionText: "今回のご来店は何回目ですか？", questionType: "single", selected: ["初めて"] };
const FEELING: MaterialInput = {
  questionText: "施術後のお肌について、どのように感じましたか？",
  questionType: "multiple",
  selected: ["肌がなめらかになったように感じた"],
};
const STAFF: MaterialInput = {
  questionText: "スタッフ・サロンについて感じたことを教えてください",
  questionType: "multiple",
  selected: ["説明が分かりやすかった"],
};
const NEGATIVE: MaterialInput = {
  questionText: "ご自由にお書きください",
  questionType: "text",
  selected: [],
  freeText: "待ち時間が長かったのが残念でした。",
};

// M1 初めて / M2 なめらかに感じた / M3 説明が分かりやすかった / M4 待ち時間が長かった(否定的)
const materials = buildMaterials([VISIT, FEELING, STAFF, NEGATIVE]);
const positiveOnly = buildMaterials([VISIT, FEELING, STAFF]);
const fixedRandom = () => 0.3;
const gpt4oMini = () => "gpt-4o-mini";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runReviewPipeline: 通常の流れ", () => {
  it("危険な文が無ければ、意味検証をせず1回の呼び出しで返す", async () => {
    const ai = fakeOpenAI({
      review_generation: [
        draft(["初めてでしたが、説明が分かりやすかったです。", ["M1", "M3"]], ["肌がなめらかになったように感じました。", ["M2"]]),
      ],
    });
    const result = await runReviewPipeline(
      { materials: positiveOnly, businessType: "エステ" },
      { callJson: ai.callJson, random: fixedRandom, resolveModel: gpt4oMini },
    );
    expect(result.draft).toBe("初めてでしたが、説明が分かりやすかったです。肌がなめらかになったように感じました。");
    expect(ai.tasks()).toEqual(["review_generation"]);
    expect(result.metadata).toMatchObject({
      promptVersion: PROMPT_VERSION,
      verifyMode: "none",
      repairAction: "none",
      llmCalls: 1,
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it("否定的な素材を出典にする文は同期で意味検証し、問題なければ残す", async () => {
    const ai = fakeOpenAI({
      review_generation: [draft(["説明が分かりやすかったです。", ["M3"]], ["待ち時間が長かったのは残念でした。", ["M4"]])],
      review_verification: [verdicts([1, true])],
    });
    const result = await runReviewPipeline({ materials, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toContain("待ち時間が長かったのは残念でした。");
    expect(ai.tasks()).toEqual(["review_generation", "review_verification"]);
    expect(ai.calls[1].userPrompt).toContain("S1 [出典: M4]");
    expect(ai.calls[1].userPrompt).not.toContain("S0");
    expect(result.metadata.verifyMode).toBe("sync");
  });
});

describe("runReviewPipeline: NG の文の扱い", () => {
  it("意味検証で NG の文は削除し、主役・否定的な素材・長さが足りていれば修正しない", async () => {
    const ai = fakeOpenAI({
      review_generation: [
        draft(
          ["肌荒れが改善しました。", ["M2"]],
          ["説明が分かりやすかったです。", ["M3"]],
          ["待ち時間が長かったのは残念でした。", ["M4"]],
        ),
      ],
      review_verification: [verdicts([0, false, ["unsupported_effect"]], [2, true])],
    });
    const result = await runReviewPipeline({ materials, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("説明が分かりやすかったです。待ち時間が長かったのは残念でした。");
    expect(result.metadata.repairAction).toBe("removed");
    expect(result.metadata.verifyFlags).toContain("unsupported_effect");
    expect(ai.tasks()).toEqual(["review_generation", "review_verification"]);
  });

  it("極端な感情(block)は、意味検証を待たずに削除する", async () => {
    const ai = fakeOpenAI({
      review_generation: [
        draft(
          ["初めてでしたが、説明が分かりやすかったです。", ["M1", "M3"]],
          ["人生が変わるほどの大感動でした。", ["M3"]],
          ["肌がなめらかになったように感じました。", ["M2"]],
        ),
      ],
    });
    const result = await runReviewPipeline({ materials: positiveOnly, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("初めてでしたが、説明が分かりやすかったです。肌がなめらかになったように感じました。");
    expect(result.metadata.lintCodes).not.toContain("extreme_emotional_exaggeration:extreme");
    expect(ai.tasks()).toEqual(["review_generation"]);
  });

  it("否定的な内容を反転した文が消えて反映が無くなるときは、1回だけ修正して再検証する", async () => {
    const ai = fakeOpenAI({
      review_generation: [draft(["説明が分かりやすかったです。", ["M3"]], ["待ち時間も気にならなかったです。", ["M4"]])],
      review_verification: [verdicts([1, false, ["polarity_flip"]]), verdicts([1, true])],
      review_repair: [draft(["説明が分かりやすかったです。", ["M3"]], ["待ち時間が長かったのは残念でした。", ["M4"]])],
    });
    const result = await runReviewPipeline({ materials, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("説明が分かりやすかったです。待ち時間が長かったのは残念でした。");
    expect(result.metadata.repairAction).toBe("repaired");
    expect(ai.tasks()).toEqual(["review_generation", "review_verification", "review_repair", "review_verification"]);
    // 修正の依頼には、NG の理由と反映されていない否定的な素材を含める。
    expect(ai.calls[2].userPrompt).toContain("否定的な内容を反転している");
    expect(ai.calls[2].userPrompt).toContain("【反映されていない否定的な素材】M4");
  });

  it("削除で長さの目安を下回ったら(肯定的な回答が消えて否定だけが残るなど)、1回だけ修正する", async () => {
    const ai = fakeOpenAI({
      review_generation: [draft(["肌がとても良くなって最高でした。", ["M2"]], ["待ち時間が長かったのは残念でした。", ["M4"]])],
      review_verification: [verdicts([1, true])],
      review_repair: [
        draft(["肌がなめらかになったように感じました。", ["M2"]], ["待ち時間が長かったのは残念でした。", ["M4"]]),
      ],
    });
    const result = await runReviewPipeline({ materials, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("肌がなめらかになったように感じました。待ち時間が長かったのは残念でした。");
    expect(result.metadata.repairAction).toBe("repaired");
    // 直した文に危険な表現が無く、否定的な素材の文は合格済みで変わっていないので、再検証はしない。
    expect(ai.tasks()).toEqual(["review_generation", "review_verification", "review_repair"]);
  });

  it("事実の列挙だけの下書きは、1回だけ書き直して体験者の気持ちを補う", async () => {
    const ai = fakeOpenAI({
      review_generation: [draft(["初めての来店でした。", ["M1"]], ["説明が分かりやすかったです。", ["M3"]])],
      review_repair: [
        draft(
          ["初めての来店でしたが、説明が分かりやすくて嬉しかったです。", ["M1", "M3"]],
          ["施術のあとは肌がなめらかになったように感じました。", ["M2"]],
        ),
      ],
    });
    const result = await runReviewPipeline({ materials: positiveOnly, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("初めての来店でしたが、説明が分かりやすくて嬉しかったです。施術のあとは肌がなめらかになったように感じました。");
    expect(result.metadata.repairAction).toBe("polished");
    expect(ai.tasks()).toEqual(["review_generation", "review_repair"]);
    expect(ai.calls[1].userPrompt).toContain("【全体への指摘】");
  });

  it("書き直しで否定的な素材の反映が消えたら、書き直す前の下書きを使う", async () => {
    const ai = fakeOpenAI({
      review_generation: [draft(["説明は丁寧でした。", ["M3"]], ["待ち時間は長かったです。", ["M4"]])],
      review_verification: [verdicts([1, true])],
      review_repair: [draft(["説明が丁寧で嬉しかったです。", ["M3"]])],
    });
    const result = await runReviewPipeline({ materials, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("説明は丁寧でした。待ち時間は長かったです。");
    expect(result.metadata.verifyFlags).toContain("polish_rejected");
  });

  it("意味検証も修正も失敗したら NG 扱いにし、否定的な素材は本人の原文を残す(fail-closed)", async () => {
    const ai = fakeOpenAI({
      review_generation: [draft(["説明が分かりやすかったです。", ["M3"]], ["待ち時間はあっという間でした。", ["M4"]])],
      review_verification: [new OpenAICallError("t", "timeout")],
      review_repair: [new OpenAICallError("e", "api_error")],
    });
    const result = await runReviewPipeline({ materials, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("説明が分かりやすかったです。待ち時間が長かったのが残念でした。");
    expect(result.metadata.repairAction).toBe("own_words_fallback");
    expect(result.metadata.verifyFlags).toEqual(expect.arrayContaining(["verification_unavailable", "repair_failed"]));
    expect(result.draft).not.toContain("あっという間");
  });

  it("残り時間が足りなければ意味検証をせず、危険な文は NG 扱いにする", async () => {
    let clock = 0;
    const ai = fakeOpenAI({
      review_generation: [
        () => {
          clock += 39_000;
          return draft(["説明が分かりやすかったです。", ["M3"]], ["待ち時間が長かったのは残念でした。", ["M4"]]);
        },
      ],
    });
    const result = await runReviewPipeline(
      { materials, businessType: null },
      { callJson: ai.callJson, random: fixedRandom, now: () => clock },
    );
    expect(ai.tasks()).toEqual(["review_generation"]);
    expect(result.metadata.verifyFlags).toContain("verification_deadline");
    // 生成した文は使わず、本人の原文を残す。
    expect(result.draft).toBe("説明が分かりやすかったです。待ち時間が長かったのが残念でした。");
  });
});

describe("runReviewPipeline: 綺麗な作文にしない", () => {
  it("整いすぎた言い回しは、LLM を呼ばずにコードで直す", async () => {
    const ai = fakeOpenAI({
      review_generation: [
        draft(
          ["初めてでしたが、説明が分かりやすくて嬉しく思いました。", ["M1", "M3"]],
          ["肌がなめらかになったように感じることができました。", ["M2"]],
        ),
      ],
    });
    const result = await runReviewPipeline({ materials: positiveOnly, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("初めてでしたが、説明が分かりやすくて嬉しかったです。肌がなめらかになったように感じました。");
    expect(ai.tasks()).toEqual(["review_generation"]);
  });

  it("最後の文が抽象的な総括で、その素材が他の文にも使われていれば削る", async () => {
    const ai = fakeOpenAI({
      review_generation: [
        draft(
          ["説明が分かりやすくて、肌もなめらかになったように感じて嬉しかったです。", ["M2", "M3"]],
          ["またお願いしたいと思えるお店でした。", ["M3"]],
        ),
      ],
    });
    const result = await runReviewPipeline({ materials: positiveOnly, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("説明が分かりやすくて、肌もなめらかになったように感じて嬉しかったです。");
    expect(result.metadata.verifyFlags).toContain("closing_dropped");
    expect(ai.tasks()).toEqual(["review_generation"]);
  });

  it("総括の文にしか使われていない素材があれば、削らずに1回だけ書き直す", async () => {
    const ai = fakeOpenAI({
      review_generation: [
        draft(["説明が分かりやすかったです。", ["M3"]], ["肌がなめらかになったように感じて、心地よい体験でした。", ["M2"]]),
      ],
      review_repair: [
        draft(["説明が分かりやすかったです。", ["M3"]], ["肌がなめらかになったように感じて嬉しかったです！", ["M2"]]),
      ],
    });
    const result = await runReviewPipeline({ materials: positiveOnly, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("説明が分かりやすかったです。肌がなめらかになったように感じて嬉しかったです！");
    expect(result.metadata.repairAction).toBe("polished");
    expect(ai.tasks()).toEqual(["review_generation", "review_repair"]);
    expect(ai.calls[1].userPrompt).toContain("抽象的な名詞で体験をまとめている");
  });

  it("関係のあいまいなつなぎ方の文は、1回だけ書き直して文を分ける", async () => {
    const pores = buildMaterials([
      { questionText: "今回、どのようなお悩みでご来店されましたか？", questionType: "multiple", selected: ["毛穴の開き"] },
      { questionText: "施術について感じたことを教えてください", questionType: "multiple", selected: ["自分の肌に合った提案をしてもらえた"] },
      { questionText: "スタッフ・サロンについて感じたことを教えてください", questionType: "multiple", selected: ["相談しやすい"] },
    ]);
    const ai = fakeOpenAI({
      review_generation: [
        draft(["自分の肌に合った提案をしてもらえて、毛穴の開きが気になっていたけど安心できました。", ["M2", "M1"]], ["相談もしやすかったです。", ["M3"]]),
      ],
      review_repair: [
        draft(["毛穴の開きが気になって伺いました。", ["M1"]], ["肌の状態に合わせて提案してもらえて、相談もしやすかったです。", ["M2", "M3"]]),
      ],
    });
    const result = await runReviewPipeline({ materials: pores, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("毛穴の開きが気になって伺いました。肌の状態に合わせて提案してもらえて、相談もしやすかったです。");
    expect(result.metadata.repairAction).toBe("polished");
    expect(ai.calls[1].userPrompt).toContain("関係のあいまいなつなぎ方");
  });

  it("感嘆符は2つまで。多ければ前の文から句点に戻す", async () => {
    const ai = fakeOpenAI({
      review_generation: [
        draft(
          ["初めてでしたが、説明が分かりやすくて嬉しかったです！", ["M1", "M3"]],
          ["肌がなめらかになったように感じました！", ["M2"]],
          ["またお願いしたいです！", ["M3"]],
        ),
      ],
    });
    const result = await runReviewPipeline({ materials: positiveOnly, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe(
      "初めてでしたが、説明が分かりやすくて嬉しかったです。肌がなめらかになったように感じました！またお願いしたいです！",
    );
    expect(result.metadata.verifyFlags).toContain("exclamations_limited");
    expect(ai.tasks()).toEqual(["review_generation"]);
  });
});

describe("runReviewPipeline: 作文の失敗", () => {
  it("使える文が1つも無ければ1回だけ作り直す", async () => {
    const ai = fakeOpenAI({
      review_generation: [
        draft(["仕事帰りに寄りました。", ["M1"]]),
        draft(["初めてでしたが、説明が分かりやすかったです。", ["M1", "M3"]]),
      ],
    });
    const result = await runReviewPipeline({ materials: positiveOnly, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("初めてでしたが、説明が分かりやすかったです。");
    expect(result.metadata.repairAction).toBe("regenerated");
  });

  it("タイムアウトは作り直さずにエラーにする", async () => {
    const ai = fakeOpenAI({ review_generation: [new OpenAICallError("t", "timeout")] });
    const error = await runReviewPipeline({ materials, businessType: null }, { callJson: ai.callJson }).catch((e) => e);
    expect(error).toBeInstanceOf(ReviewGenerationError);
    expect(error.kind).toBe("generation_failed");
    expect(error.causeKind).toBe("timeout");
    expect(ai.calls).toHaveLength(1);
  });

  it("設定が無ければ config エラー", async () => {
    const ai = fakeOpenAI({ review_generation: [new OpenAICallError("c", "config")] });
    const error = await runReviewPipeline({ materials, businessType: null }, { callJson: ai.callJson }).catch((e) => e);
    expect(error.kind).toBe("config");
  });

  it("素材が無ければ no_materials", async () => {
    const error = await runReviewPipeline({ materials: [], businessType: null }).catch((e) => e);
    expect(error.kind).toBe("no_materials");
  });
});

describe("runReviewPipeline: 呼び出しの内容", () => {
  it("推論系のモデルには temperature を送らない", async () => {
    const ai = fakeOpenAI({ review_generation: [draft(["初めてでした。", ["M1"]])] });
    await runReviewPipeline(
      { materials: positiveOnly, businessType: null },
      { callJson: ai.callJson, random: fixedRandom, resolveModel: () => "gpt-5-mini" },
    );
    expect(ai.calls[0].temperature).toBeUndefined();

    const ai2 = fakeOpenAI({ review_generation: [draft(["初めてでした。", ["M1"]])] });
    await runReviewPipeline(
      { materials: positiveOnly, businessType: null },
      { callJson: ai2.callJson, random: fixedRandom, resolveModel: gpt4oMini },
    );
    expect(ai2.calls[0].temperature).toBe(0.9);
  });

  it("構成の指示に、生成ごとの感嘆符の使い方が入る", async () => {
    const ai = fakeOpenAI({ review_generation: [draft(["説明が分かりやすくて嬉しかったです。", ["M3"]])] });
    await runReviewPipeline({ materials: positiveOnly, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(ai.calls[0].userPrompt).toMatch(/感嘆符\(！\): (使わない|最後の文にだけ1つ付けてよい|気持ちが動いた肯定的な文に1〜2個まで付けてよい)/);
  });

  it("source_ids は今回の素材IDだけを許し、素材は user 側にだけ入れる", async () => {
    const ai = fakeOpenAI({ review_generation: [draft(["初めてでした。", ["M1"]])] });
    await runReviewPipeline({ materials: positiveOnly, businessType: "ネイル" }, { callJson: ai.callJson, random: fixedRandom });
    const schema = JSON.stringify(ai.calls[0].schema);
    expect(schema).toContain('"enum":["M1","M2","M3"]');
    // system は固定の文面(素材を混ぜない)。
    expect(ai.calls[0].systemPrompt).toBe(GENERATION_SYSTEM_PROMPT);
    expect(ai.calls[0].userPrompt).toContain("M3 [スタッフ・お店] 説明が分かりやすかった");
    expect(ai.calls[0].userPrompt).toContain("【業種】ネイル");
  });

  it("回答や下書きの本文をログに出さない", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((s) =>
      s.mockImplementation(() => {}),
    );
    const ai = fakeOpenAI({
      review_generation: [draft(["説明が分かりやすかったです。", ["M3"]], ["待ち時間も気にならなかったです。", ["M4"]])],
      review_verification: [new OpenAICallError("t", "timeout")],
      review_repair: [new Error("boom")],
    });
    await runReviewPipeline({ materials, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain("待ち時間");
    expect(logged).not.toContain("説明が分かりやすかった");
  });
});

describe("cleanSentences / assembleDraft", () => {
  it("装飾と文中の改行を除き、句点を補う", () => {
    expect(
      cleanSentences({
        sentences: [
          { text: "最高でした😊", source_ids: ["M1", "M1"], break_after: false },
          { text: "  ", source_ids: ["M1"], break_after: false },
          { text: "肌が\nしっとり", source_ids: ["M2"], break_after: true },
        ],
      }),
    ).toEqual([
      { text: "最高でした。", sourceIds: ["M1"], breakAfter: false },
      { text: "肌がしっとり。", sourceIds: ["M2"], breakAfter: true },
    ]);
  });

  it("修正の依頼の書式(出典・番号・指摘)が本文に写っていたら取り除く", () => {
    expect(
      cleanSentences({
        sentences: [
          { text: "[出典: M2] 肌がなめらかになったように感じた。", source_ids: ["M2"], break_after: false },
          { text: "2. 説明が分かりやすかったです。 ← 直す: 素材に無い満足の表現がある", source_ids: ["M3"], break_after: false },
        ],
      }).map((s) => s.text),
    ).toEqual(["肌がなめらかになったように感じた。", "説明が分かりやすかったです。"]);
  });

  it("読点で終わる文は次の文とつなげ、最後なら句点にする(「、。」にしない)", () => {
    expect(
      cleanSentences({
        sentences: [
          { text: "料金が少し高く感じましたが、", source_ids: ["M4"], break_after: false },
          { text: "施術は丁寧でした。", source_ids: ["M3"], break_after: true },
          { text: "仕上がりはかわいいけど、", source_ids: ["M1"], break_after: false },
        ],
      }),
    ).toEqual([
      { text: "料金が少し高く感じましたが、施術は丁寧でした。", sourceIds: ["M4", "M3"], breakAfter: true },
      { text: "仕上がりはかわいい。", sourceIds: ["M1"], breakAfter: false },
    ]);
    expect(
      cleanSentences({ sentences: [{ text: "料金が少し高く感じましたが、", source_ids: ["M4"], break_after: false }] })[0].text,
    ).toBe("料金が少し高く感じました。");
  });

  it("改行は最初の1回だけ、最後の文のあとには入れない", () => {
    expect(
      assembleDraft([
        { text: "一。", sourceIds: [], breakAfter: true },
        { text: "二。", sourceIds: [], breakAfter: true },
        { text: "三。", sourceIds: [], breakAfter: true },
      ]),
    ).toBe("一。\n二。三。");
  });
});

describe("lintPlainDraft(v1 の下書きの計測用)", () => {
  it("出典が無くても判定できる指摘だけを返す", () => {
    const codes = lintPlainDraft("仕事帰りに寄りました。肌がなめらかになりました。人生が変わるほど大感動です。", materials);
    expect(codes).toEqual(
      expect.arrayContaining(["factual_invention:situation", "extreme_emotional_exaggeration:extreme"]),
    );
    // 出典の対応が必要な指摘(知覚表現の消失など)は返さない。
    expect(codes).not.toContain("unsupported_effect:perception_dropped");
  });

  it("否定的な素材の目印が下書きに残っていなければ negative_not_reflected", () => {
    expect(lintPlainDraft("説明が分かりやすかったです。", materials)).toContain("negative_not_reflected");
    expect(lintPlainDraft("待ち時間が長かったのは残念でした。", materials)).not.toContain("negative_not_reflected");
  });

  it("漢字とかなの表記ゆれ(「分かりにくい」と「わかりにくい」)は、反映されているとみなす", () => {
    const mixed = buildMaterials([
      { questionText: "ご自由にお書きください", questionType: "text", selected: [], freeText: "説明が早口で少し分かりにくかった" },
    ]);
    expect(mixed.some((m) => m.negative)).toBe(true);
    expect(lintPlainDraft("説明が少し早口で、内容がわかりにくかったのが残念でした。", mixed)).not.toContain(
      "negative_not_reflected",
    );
  });
});

describe("runShadowVerification", () => {
  it("全文を検証して、指摘コードと NG の数だけを返す", async () => {
    const ai = fakeOpenAI({ review_verification: [verdicts([0, true], [1, false, ["factual_invention"]])] });
    const result = await runShadowVerification(
      materials,
      [
        { text: "説明が分かりやすかったです。", sourceIds: ["M3"], breakAfter: false },
        { text: "友人にすすめられて来ました。", sourceIds: ["M1"], breakAfter: false },
      ],
      { callJson: ai.callJson },
    );
    expect(result).toMatchObject({ verifyFlags: ["factual_invention"], unsupportedCount: 1 });
  });

  it("失敗したら null(お客様への応答には影響させない)", async () => {
    const ai = fakeOpenAI({ review_verification: [new OpenAICallError("t", "timeout")] });
    expect(
      await runShadowVerification(materials, [{ text: "一。", sourceIds: ["M1"], breakAfter: false }], { callJson: ai.callJson }),
    ).toBeNull();
  });
});

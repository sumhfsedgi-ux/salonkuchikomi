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
import { GENERATION_SYSTEM_PROMPT, type RawDraft, type RawVerification } from "@/lib/reviewGeneration/prompts";
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
      promptVersion: "review-v2.0",
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
  it("意味検証で NG の文は削除し、主役と否定的な素材が残っていれば修正しない", async () => {
    const ai = fakeOpenAI({
      review_generation: [draft(["肌荒れが改善しました。", ["M2"]], ["待ち時間が長かったのは残念でした。", ["M4"]])],
      review_verification: [verdicts([0, false, ["exaggeration"]], [1, true])],
    });
    const result = await runReviewPipeline({ materials, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("待ち時間が長かったのは残念でした。");
    expect(result.metadata.repairAction).toBe("removed");
    expect(result.metadata.verifyFlags).toContain("exaggeration");
    expect(ai.tasks()).toEqual(["review_generation", "review_verification"]);
  });

  it("回答に無い満足の表現(block)は、意味検証を待たずに削除する", async () => {
    const ai = fakeOpenAI({
      review_generation: [
        draft(["初めてでしたが、説明が分かりやすかったです。", ["M1", "M3"]], ["大満足です。", ["M3"]]),
      ],
    });
    const result = await runReviewPipeline({ materials: positiveOnly, businessType: null }, { callJson: ai.callJson, random: fixedRandom });
    expect(result.draft).toBe("初めてでしたが、説明が分かりやすかったです。");
    expect(result.metadata.lintCodes).not.toContain("unsupported_satisfaction");
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
    const codes = lintPlainDraft("仕事帰りに寄りました。肌がなめらかになりました。大満足です。", materials);
    expect(codes).toEqual(expect.arrayContaining(["fabricated_situation", "unsupported_satisfaction"]));
    // 出典の対応が必要な指摘(知覚表現の消失など)は返さない。
    expect(codes).not.toContain("perception_dropped");
  });

  it("否定的な素材の目印が下書きに残っていなければ negative_not_reflected", () => {
    expect(lintPlainDraft("説明が分かりやすかったです。", materials)).toContain("negative_not_reflected");
    expect(lintPlainDraft("待ち時間が長かったのは残念でした。", materials)).not.toContain("negative_not_reflected");
  });
});

describe("runShadowVerification", () => {
  it("全文を検証して、指摘コードと NG の数だけを返す", async () => {
    const ai = fakeOpenAI({ review_verification: [verdicts([0, true], [1, false, ["unsupported_fact"]])] });
    const result = await runShadowVerification(
      materials,
      [
        { text: "説明が分かりやすかったです。", sourceIds: ["M3"], breakAfter: false },
        { text: "友人にすすめられて来ました。", sourceIds: ["M1"], breakAfter: false },
      ],
      { callJson: ai.callJson },
    );
    expect(result).toMatchObject({ verifyFlags: ["unsupported_fact"], unsupportedCount: 1 });
  });

  it("失敗したら null(お客様への応答には影響させない)", async () => {
    const ai = fakeOpenAI({ review_verification: [new OpenAICallError("t", "timeout")] });
    expect(
      await runShadowVerification(materials, [{ text: "一。", sourceIds: ["M1"], breakAfter: false }], { callJson: ai.callJson }),
    ).toBeNull();
  });
});

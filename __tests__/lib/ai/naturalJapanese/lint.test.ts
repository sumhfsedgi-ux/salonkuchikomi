import { describe, expect, it } from "vitest";
import {
  blockedSentenceIndexes,
  documentBlockIssues,
  lintCodes,
  lintDraft,
  riskySentenceIndexes,
  type LintSentence,
  type LintSource,
} from "@/lib/ai/naturalJapanese/lint";

function source(id: string, text: string, overrides: Partial<LintSource> = {}): LintSource {
  return { id, text, negative: false, perception: false, purposeLike: false, ownWords: false, ...overrides };
}

const VISIT = source("M1", "初めて");
const FEELING = source("M2", "肌がなめらかになったように感じた", { perception: true });
const STAFF = source("M3", "説明が分かりやすかった");
const WAIT = source("M4", "待ち時間が長かった", { negative: true, ownWords: true });
const PURPOSE = source("M5", "肌質を改善したい", { purposeLike: true });

function codesOf(sentences: LintSentence[], sources: LintSource[], options = {}) {
  return lintCodes(lintDraft(sentences, sources, options));
}

describe("lintDraft: 問題の無い下書き", () => {
  it("素材どおりの文には block も risk も付かない", () => {
    const result = lintDraft(
      [
        { text: "初めてでしたが、説明が分かりやすかったです。", sourceIds: ["M1", "M3"] },
        { text: "施術のあとは肌がなめらかになったように感じました。", sourceIds: ["M2"] },
        { text: "待ち時間が長かったのは残念でした。", sourceIds: ["M4"] },
      ],
      [VISIT, FEELING, STAFF, WAIT],
    );
    expect(result.issues.filter((i) => i.severity !== "style")).toEqual([]);
    expect(result.traits[2].citesNegative).toBe(true);
  });
});

describe("lintDraft: 回答に根拠が無い内容(block)", () => {
  it("回答に無い満足・再来店・推奨の表現", () => {
    const codes = codesOf(
      [
        { text: "説明が分かりやすくて大満足です。", sourceIds: ["M3"] },
        { text: "また来たいです。", sourceIds: ["M3"] },
        { text: "みなさんにもおすすめです。", sourceIds: ["M3"] },
      ],
      [STAFF],
    );
    expect(codes).toEqual(
      expect.arrayContaining(["unsupported_satisfaction", "unsupported_revisit", "unsupported_recommend"]),
    );
  });

  it("回答に満足の言葉があれば、満足の表現は使ってよい", () => {
    const codes = codesOf(
      [{ text: "仕上がりに満足しています。", sourceIds: ["M9"] }],
      [source("M9", "仕上がりに満足")],
    );
    expect(codes).not.toContain("unsupported_satisfaction");
  });

  it("回答に無い状況(仕事帰り・友人の紹介など)", () => {
    expect(codesOf([{ text: "仕事帰りに寄りました。", sourceIds: ["M1"] }], [VISIT])).toContain(
      "fabricated_situation",
    );
  });

  it("回答に無い医療的な表現は block、回答にある医療の語は risk", () => {
    expect(codesOf([{ text: "ニキビが治りました。", sourceIds: ["M2"] }], [FEELING])).toContain("medical_claim");
    const withSource = codesOf(
      [{ text: "炎症が気になっていました。", sourceIds: ["M6"] }],
      [source("M6", "炎症が気になる")],
    );
    expect(withSource).toContain("medical_term");
    expect(withSource).not.toContain("medical_claim");
  });

  it("出典が無い文・存在しない出典", () => {
    const result = lintDraft(
      [
        { text: "とても良かったです。", sourceIds: [] },
        { text: "説明が分かりやすかったです。", sourceIds: ["M3", "M99"] },
      ],
      [STAFF],
    );
    expect(lintCodes(result)).toEqual(expect.arrayContaining(["no_source", "unknown_source"]));
    expect(blockedSentenceIndexes(result)).toEqual([0, 1]);
  });

  it("否定的な素材がどの文にも反映されていない", () => {
    const result = lintDraft([{ text: "説明が分かりやすかったです。", sourceIds: ["M3"] }], [STAFF, WAIT]);
    expect(documentBlockIssues(result)).toEqual([
      { code: "negative_not_reflected", severity: "block", sentenceIndex: null, sourceId: "M4" },
    ]);
  });

  it("下書きが空", () => {
    expect(codesOf([], [STAFF])).toEqual(["empty_draft"]);
  });
});

describe("lintDraft: 意味が強くなっている・変わっている疑い(risk)", () => {
  it("知覚の素材を断定に変えている(変化の断定・知覚表現の消失)", () => {
    const result = lintDraft([{ text: "肌荒れが改善しました。", sourceIds: ["M2"] }], [FEELING]);
    expect(lintCodes(result)).toEqual(expect.arrayContaining(["change_claim", "perception_dropped"]));
    expect(riskySentenceIndexes(result)).toEqual([0]);
    expect(result.traits[0].hasClaimVocabulary).toBe(true);
  });

  it("来店理由を結果として書いている疑い", () => {
    expect(codesOf([{ text: "肌質が改善しました。", sourceIds: ["M5"] }], [PURPOSE])).toContain("purpose_as_result");
  });

  it("否定的な素材を反転している", () => {
    expect(codesOf([{ text: "待ち時間も気にならなかったです。", sourceIds: ["M4"] }], [WAIT])).toContain(
      "polarity_flip",
    );
  });

  it("否定的な素材を弱めている・満足で打ち消している", () => {
    const softened = codesOf([{ text: "待ち時間が少しだけ長かったくらいです。", sourceIds: ["M4"] }], [WAIT]);
    expect(softened).toContain("softened_negative");

    const cancelled = codesOf(
      [{ text: "待ち時間は長かったけど、満足です。", sourceIds: ["M4"] }],
      [WAIT, source("M9", "仕上がりに満足")],
    );
    expect(cancelled).toContain("softened_negative");
  });

  it("本人が書いた程度の表現は弱めとみなさない", () => {
    const own = source("M7", "待ち時間が少し長かった", { negative: true, ownWords: true });
    expect(codesOf([{ text: "待ち時間が少し長かったです。", sourceIds: ["M7"] }], [own])).not.toContain(
      "softened_negative",
    );
  });

  it("回答に無い強い強調", () => {
    expect(codesOf([{ text: "肌が劇的になめらかに感じました。", sourceIds: ["M2"] }], [FEELING])).toContain(
      "strong_intensifier",
    );
  });
});

describe("lintDraft: 品質(style)", () => {
  it("同じ語尾が3回続く・定型句・文字数", () => {
    const result = lintDraft(
      [
        { text: "初めてでした。", sourceIds: ["M1"] },
        { text: "説明が分かりやすかったでした。", sourceIds: ["M3"] },
        { text: "丁寧に対応していただきました。", sourceIds: ["M3"] },
      ],
      [VISIT, STAFF],
      { targetChars: { min: 80, max: 150 } },
    );
    const codes = lintCodes(result);
    expect(codes).toEqual(expect.arrayContaining(["monotone_endings", "template_phrase", "length_out_of_range"]));
    expect(result.issues.filter((i) => i.severity !== "style")).toEqual([]);
  });

  it("主役の素材を使っていない・本人の言葉を言い換えすぎている", () => {
    const own = source("M8", "ヘッドスパが気持ちよくて寝そうになりました", { ownWords: true });
    const codes = codesOf(
      [{ text: "頭のケアで心地よく過ごせた。", sourceIds: ["M8"] }],
      [VISIT, own],
      { mainSourceIds: ["M1"] },
    );
    expect(codes).toEqual(expect.arrayContaining(["main_not_used", "own_words_paraphrased"]));
  });
});

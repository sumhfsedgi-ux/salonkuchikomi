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

function nonStyle(sentences: LintSentence[], sources: LintSource[]) {
  return lintDraft(sentences, sources).issues.filter((i) => i.severity !== "style");
}

describe("lintDraft: 気持ちの補完は指摘しない(2026-10-04 の方針)", () => {
  it("回答と矛盾しない自然な気持ち・主観的な反応は、回答の文言に無くても指摘しない", () => {
    const result = lintDraft(
      [
        { text: "初めてでしたが、説明が分かりやすくて嬉しかったです。", sourceIds: ["M1", "M3"] },
        { text: "施術のあとは肌がなめらかになったように感じて、印象に残っています。", sourceIds: ["M2"] },
        { text: "待ち時間が長かったのは少し残念でした。", sourceIds: ["M4"] },
      ],
      [VISIT, FEELING, STAFF, WAIT],
    );
    expect(result.issues.filter((i) => i.severity !== "style")).toEqual([]);
    expect(lintCodes(result)).not.toContain("low_emotional_texture");
    expect(result.traits[2].citesNegative).toBe(true);
  });

  it("「よかった」「ありがたかった」「またお願いしたいと思える」も指摘しない", () => {
    expect(
      nonStyle(
        [
          { text: "説明が分かりやすくて本当によかったです。", sourceIds: ["M3"] },
          { text: "丁寧だと感じて、ありがたかったです。", sourceIds: ["M3"] },
          { text: "またお願いしたいと思えるお店でした。", sourceIds: ["M3"] },
        ],
        [STAFF],
      ),
    ).toEqual([]);
  });
});

describe("lintDraft: 事実の捏造(factual_invention)", () => {
  it("回答に無い状況・きっかけ", () => {
    expect(codesOf([{ text: "仕事帰りに寄りました。", sourceIds: ["M1"] }], [VISIT])).toContain(
      "factual_invention:situation",
    );
  });

  it("回答に無い数値・期間・金額(回答にあれば問題にしない)", () => {
    expect(codesOf([{ text: "3週間経っても綺麗なままでした。", sourceIds: ["M2"] }], [FEELING])).toContain(
      "factual_invention:number",
    );
    const own = source("M6", "2日で一本欠けてしまいました", { negative: true, ownWords: true });
    expect(codesOf([{ text: "2日で一本欠けてしまったのは残念でした。", sourceIds: ["M6"] }], [own])).not.toContain(
      "factual_invention:number",
    );
    // 慣用句の漢数字は数値とみなさない。
    expect(codesOf([{ text: "説明が十分で、一番安心できました。", sourceIds: ["M3"] }], [STAFF])).not.toContain(
      "factual_invention:number",
    );
  });

  it("回答に無い他店との比較", () => {
    expect(codesOf([{ text: "他店より持ちが良かったです。", sourceIds: ["M2"] }], [FEELING])).toContain(
      "factual_invention:comparison",
    );
  });

  it("初めてと答えているのに通っている事実を書くのは block、回数が分からなければ risk", () => {
    const blocked = lintDraft([{ text: "いつも丁寧に説明してくれます。", sourceIds: ["M1", "M3"] }], [VISIT, STAFF]);
    expect(blocked.issues).toContainEqual(expect.objectContaining({ code: "factual_invention", detail: "visit_count", severity: "block" }));
    const unknown = lintDraft([{ text: "いつも丁寧に説明してくれます。", sourceIds: ["M3"] }], [STAFF]);
    expect(unknown.issues).toContainEqual(expect.objectContaining({ code: "factual_invention", detail: "visit_count", severity: "risk" }));
  });

  it("回答に無い観点(雰囲気・スタッフなど)や仕上がりの評価は、意味検証にかける", () => {
    const cut = source("M6", "カット");
    const aspect = lintDraft([{ text: "お店の雰囲気も良くて、心地よかったです。", sourceIds: ["M6"] }], [cut]);
    expect(aspect.issues).toContainEqual(expect.objectContaining({ code: "factual_invention", detail: "aspect", severity: "risk" }));
    const outcome = lintDraft([{ text: "カットはイメージ以上の仕上がりでした。", sourceIds: ["M6"] }], [cut]);
    expect(outcome.issues).toContainEqual(expect.objectContaining({ code: "factual_invention", detail: "outcome", severity: "risk" }));
    // 回答にある観点なら指摘しない。
    expect(codesOf([{ text: "落ち着いた雰囲気で嬉しかったです。", sourceIds: ["M7"] }], [source("M7", "落ち着いた雰囲気")])).not.toContain(
      "factual_invention:aspect",
    );
  });

  it("他の人への呼びかけ・宣伝のような言い回し", () => {
    expect(codesOf([{ text: "みなさんもぜひ行ってみてください。", sourceIds: ["M3"] }], [STAFF])).toContain(
      "promotional_callout",
    );
  });
});

describe("lintDraft: 効果の捏造(unsupported_effect)", () => {
  it("回答に無い医療的な表現は block、回答にある医療の語は risk", () => {
    expect(codesOf([{ text: "ニキビが治りました。", sourceIds: ["M2"] }], [FEELING])).toContain("unsupported_effect:medical");
    expect(
      codesOf([{ text: "炎症が気になっていました。", sourceIds: ["M6"] }], [source("M6", "炎症が気になる")]),
    ).toContain("unsupported_effect:medical_term");
  });

  it("「感じた」を効果として断定する・回答に無い改善", () => {
    const result = lintDraft([{ text: "肌荒れが改善しました。", sourceIds: ["M2"] }], [FEELING]);
    expect(lintCodes(result)).toEqual(
      expect.arrayContaining(["unsupported_effect:change_claim", "unsupported_effect:perception_dropped"]),
    );
    expect(riskySentenceIndexes(result)).toEqual([0]);
    expect(result.traits[0].hasClaimVocabulary).toBe(true);
  });

  it("来店理由を結果として書いている疑い", () => {
    expect(codesOf([{ text: "肌質が改善しました。", sourceIds: ["M5"] }], [PURPOSE])).toContain(
      "unsupported_effect:purpose_as_result",
    );
  });
});

describe("lintDraft: 極端な感情(extreme_emotional_exaggeration)", () => {
  it("極端な表現は block、強めの表現は意味検証にかける", () => {
    const extreme = lintDraft([{ text: "人生が変わるほどの大感動でした。", sourceIds: ["M3"] }], [STAFF]);
    expect(extreme.issues).toContainEqual(
      expect.objectContaining({ code: "extreme_emotional_exaggeration", detail: "extreme", severity: "block" }),
    );
    expect(blockedSentenceIndexes(extreme)).toEqual([0]);

    const strong = lintDraft([{ text: "説明が分かりやすくて最高でした。", sourceIds: ["M3"] }], [STAFF]);
    expect(strong.issues).toContainEqual(
      expect.objectContaining({ code: "extreme_emotional_exaggeration", detail: "strong", severity: "risk" }),
    );
  });

  it("本人が書いた強い言葉は問題にしない", () => {
    const own = source("M7", "仕上がり最高です", { ownWords: true });
    expect(codesOf([{ text: "仕上がり最高です！", sourceIds: ["M7"] }], [own])).not.toContain(
      "extreme_emotional_exaggeration:strong",
    );
  });
});

describe("lintDraft: 否定的な内容", () => {
  it("否定的な素材がどの文にも反映されていない", () => {
    const result = lintDraft([{ text: "説明が分かりやすくて嬉しかったです。", sourceIds: ["M3"] }], [STAFF, WAIT]);
    expect(documentBlockIssues(result)).toEqual([
      { code: "negative_not_reflected", severity: "block", sentenceIndex: null, sourceId: "M4" },
    ]);
  });

  it("反転している・弱めている・満足で打ち消している", () => {
    expect(codesOf([{ text: "待ち時間も気にならなかったです。", sourceIds: ["M4"] }], [WAIT])).toContain("polarity_flip");
    expect(codesOf([{ text: "待ち時間が少しだけ長かったくらいです。", sourceIds: ["M4"] }], [WAIT])).toContain(
      "softened_negative",
    );
    expect(codesOf([{ text: "待ち時間は長かったけど、大満足です。", sourceIds: ["M4"] }], [WAIT])).toContain(
      "softened_negative",
    );
  });

  it("否定的な内容があるのに、別の文で「全体的には良かった」と帳消しにする", () => {
    const result = lintDraft(
      [
        { text: "待ち時間が長かったのは残念でした。", sourceIds: ["M4"] },
        { text: "全体的には良い体験だったと思います。", sourceIds: ["M3"] },
      ],
      [STAFF, WAIT],
    );
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "softened_negative", sentenceIndex: 1, severity: "risk" }));
    // 否定的な内容が無ければ、全体の感想は問題にしない。
    expect(codesOf([{ text: "全体的にとても良かったです。", sourceIds: ["M3"] }], [STAFF])).not.toContain("softened_negative");
  });

  it("本人が書いた程度の表現は弱めとみなさない", () => {
    const own = source("M8", "待ち時間が少し長かった", { negative: true, ownWords: true });
    expect(codesOf([{ text: "待ち時間が少し長かったです。", sourceIds: ["M8"] }], [own])).not.toContain("softened_negative");
  });
});

describe("lintDraft: 人間らしさ", () => {
  const LIGHT = source("M1", "軽い付け心地");
  const DESIGN = source("M2", "デザインの相談がしやすい");
  const CARING = source("M3", "親身に相談に乗ってくれた");

  it("選択肢を質問の順に1文ずつ写しただけなら robotic_survey_summary", () => {
    const codes = codesOf(
      [
        { text: "軽い付け心地でした。", sourceIds: ["M1"] },
        { text: "デザインの相談がしやすかったです。", sourceIds: ["M2"] },
        { text: "親身に相談に乗ってくれました。", sourceIds: ["M3"] },
      ],
      [LIGHT, DESIGN, CARING],
    );
    expect(codes).toContain("robotic_survey_summary");
  });

  it("体験者の視点がある文章は、同じ素材でも指摘しない", () => {
    const codes = codesOf(
      [
        { text: "付け心地が軽くて、そこはかなり嬉しかったです。", sourceIds: ["M1"] },
        {
          text: "デザインも気軽に相談できて、こちらの希望を聞きながら親身に一緒に考えてもらえたのが印象に残っています。",
          sourceIds: ["M2", "M3"],
        },
      ],
      [LIGHT, DESIGN, CARING],
    );
    expect(codes).not.toContain("robotic_survey_summary");
    expect(codes).not.toContain("low_emotional_texture");
  });

  it("事実の列挙だけなら low_emotional_texture", () => {
    expect(
      codesOf(
        [
          { text: "初めての来店でした。", sourceIds: ["M1"] },
          { text: "説明は丁寧でした。", sourceIds: ["M3"] },
        ],
        [VISIT, STAFF],
      ),
    ).toContain("low_emotional_texture");
  });

  it("語尾・文の長さが均一なら uniform_sentence_structure。定型句・文字数も見る", () => {
    const codes = codesOf(
      [
        { text: "初めてでした。", sourceIds: ["M1"] },
        { text: "説明がありました。", sourceIds: ["M3"] },
        { text: "丁寧に対応していただきました。", sourceIds: ["M3"] },
      ],
      [VISIT, STAFF],
      { targetChars: { min: 80, max: 150 } },
    );
    expect(codes).toEqual(expect.arrayContaining(["uniform_sentence_structure", "template_phrase", "length_out_of_range"]));
  });

  it("主役の素材を使っていない・本人の言葉を言い換えすぎている", () => {
    const own = source("M9", "ヘッドスパが気持ちよくて寝そうになりました", { ownWords: true });
    const codes = codesOf([{ text: "頭のケアで心地よく過ごせた。", sourceIds: ["M9"] }], [VISIT, own], { mainSourceIds: ["M1"] });
    expect(codes).toEqual(expect.arrayContaining(["main_not_used", "own_words_paraphrased"]));
  });
});

describe("lintDraft: 文として成り立っているか", () => {
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

  it("文になっていない断片・明らかな文法の崩れ", () => {
    const result = lintDraft(
      [
        { text: "ニキビ。", sourceIds: ["M1"] },
        { text: "肌が明るく見えたです。", sourceIds: ["M2"] },
        { text: "説明が分かりやすかったです。", sourceIds: ["M3"] },
      ],
      [VISIT, FEELING, STAFF],
    );
    expect(result.issues.filter((i) => i.code === "fragment").map((i) => i.sentenceIndex)).toEqual([0]);
    expect(result.issues.filter((i) => i.code === "ungrammatical").map((i) => i.sentenceIndex)).toEqual([1]);
  });

  it("下書きが空", () => {
    expect(codesOf([], [STAFF])).toEqual(["empty_draft"]);
  });
});

import { describe, expect, it } from "vitest";
import { corpusLint } from "@/lib/ai/naturalJapanese/corpus";

// 並べると同じ人が書いたように見える例(テスト・評価コードにだけ置く)。
const SAME_WRITER = [
  "施術のあと肌がしっとりして嬉しかったです！次もお願いしようと思います。",
  "スタッフさんが話しやすくて嬉しかったです！次もお願いしようと思います。",
  "色味がきれいで嬉しかったです！次もお願いしようと思います。",
  "力加減を聞いてもらえて嬉しかったです！次もお願いしようと思います。",
];

// 書き手がばらばらに見える例。
const DIFFERENT_WRITERS = [
  "カラーで伺いました。色味がかなり好みで嬉しいです。",
  "途中寝ちゃいました笑 肌はつるっとしてます！",
  "待ち時間が長かったのは残念でした。仕上がりは自然です。",
  "色見本がかなり多かったです。また行きます！",
];

describe("corpusLint", () => {
  it("同じ締め・同じ感情語・同じ言い回しが並ぶと warning を出す", () => {
    const report = corpusLint(SAME_WRITER.map((text) => ({ text })));
    expect(report.closingTypes["意向"]).toBe(4);
    expect(report.emotionWords.find((e) => e.pattern === "嬉しい")?.drafts).toBe(4);
    expect(report.sharedPhrases.length).toBeGreaterThan(0);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("締めの型「意向」"),
        expect.stringContaining("感情の言葉「嬉しい」"),
        expect.stringContaining("同じ言い回し"),
      ]),
    );
  });

  it("書き手がばらばらに見える下書きでは、締め・感情語・言い回しの warning を出さない", () => {
    const report = corpusLint(DIFFERENT_WRITERS.map((text) => ({ text })));
    expect(report.warnings.filter((w) => /締め|感情の言葉|同じ言い回し/.test(w))).toEqual([]);
    expect(report.emotionPerDraft["0"]).toBeGreaterThan(0);
  });

  it("回答の文言どおりの言い回しは、同じ言い回しに数えない", () => {
    const drafts = ["説明が分かりやすかったです。", "説明が分かりやすかったです！", "説明が分かりやすかった。"].map((text) => ({
      text,
      sourceText: "説明が分かりやすかった",
    }));
    expect(corpusLint(drafts).sharedPhrases).toEqual([]);
  });

  it("文の数・文字数・感嘆符の分布を返す(合否は付けない)", () => {
    const report = corpusLint(DIFFERENT_WRITERS.map((text) => ({ text })));
    expect(report.drafts).toBe(4);
    expect(report.sentenceCounts).toEqual({ "1": 1, "2": 3 });
    expect(report.exclamations).toEqual({ "0": 2, "1": 2 });
    expect(report.closingTypes).toEqual({ 気持ち: 1, 事実: 2, 意向: 1 });
    expect(report.chars.min).toBeGreaterThan(0);
    expect(report).not.toHaveProperty("passed");
  });
});

import { describe, expect, it } from "vitest";
import {
  bigramOverlap,
  countChars,
  findNegativeMarkers,
  hasPerception,
  isPurposeLike,
  normalize,
  sentenceEnding,
  splitSentences,
  stripDecorations,
} from "@/lib/ai/naturalJapanese/analyze";

describe("normalize", () => {
  it("全角英数を半角にし、空白と改行を除く", () => {
    expect(normalize("ＳＮＳ で 見て\n来ました")).toBe("SNSで見て来ました");
  });
});

describe("splitSentences", () => {
  it("句点・感嘆符・改行で区切り、記号は前の文に残す", () => {
    expect(splitSentences("初めてでした。説明が丁寧！\n肌がしっとり")).toEqual([
      "初めてでした。",
      "説明が丁寧！",
      "肌がしっとり",
    ]);
  });

  it("空の文は返さない", () => {
    expect(splitSentences("。\n\n  ")).toEqual(["。"]);
    expect(splitSentences("")).toEqual([]);
  });
});

describe("sentenceEnding", () => {
  it("末尾の記号を除いた最後の2文字を返す", () => {
    expect(sentenceEnding("説明が丁寧でした。")).toBe("した");
    expect(sentenceEnding("また相談します！")).toBe("ます");
  });
});

describe("findNegativeMarkers", () => {
  it("否定的な目印を見つける", () => {
    expect(findNegativeMarkers("待ち時間が長かったのが残念でした")).toEqual(
      expect.arrayContaining(["残念", "待ち時間が長"]),
    );
    expect(findNegativeMarkers("説明が少し分かりにくかったです")).toEqual(["分かりにく"]);
  });

  it("料金・持ち・仕上がり・痛みの不満も拾う", () => {
    expect(findNegativeMarkers("料金が少し高く感じましたが、施術は丁寧でした")).toEqual(["高く感じ"]);
    expect(findNegativeMarkers("2日で一本欠けてしまいました")).toEqual(["欠け"]);
    expect(findNegativeMarkers("前髪が思ったより短くなってしまった")).toEqual(["短くなってしま"]);
    expect(findNegativeMarkers("力が強すぎて翌日少し痛みが残りました")).toEqual(
      expect.arrayContaining(["痛みが残", "強すぎ"]),
    );
  });

  it("直後で打ち消されている目印は否定とみなさない", () => {
    expect(findNegativeMarkers("強すぎず弱すぎず、ちょうどいい力加減でした")).toEqual([]);
    expect(findNegativeMarkers("痛みが残らず快適でした")).toEqual([]);
    expect(findNegativeMarkers("思っていたよりピリピリしなかったです")).toEqual([]);
    expect(findNegativeMarkers("強引な勧誘もなく安心でした")).toEqual([]);
    expect(findNegativeMarkers("待たされることもなく案内してもらえた")).toEqual([]);
    expect(findNegativeMarkers("気になった点はなかったです")).toEqual([]);
  });

  it("否定形の言い回しや関心を表す「気になった」は拾わない", () => {
    expect(findNegativeMarkers("全然痛くなかったです")).toEqual([]);
    expect(findNegativeMarkers("ずっと気になったので予約しました")).toEqual([]);
  });

  it("打ち消された目印のあとに同じ目印が出てきたら拾う", () => {
    expect(findNegativeMarkers("勧誘もなかったが、二回目は勧誘された")).toEqual(["勧誘"]);
  });
});

describe("hasPerception / isPurposeLike", () => {
  it("知覚表現を見分ける", () => {
    expect(hasPerception("肌がなめらかになったように感じた")).toBe(true);
    expect(hasPerception("肌がしっとりした")).toBe(false);
  });

  it("来店理由・希望の形を見分ける", () => {
    expect(isPurposeLike("肌質を改善したい")).toBe(true);
    expect(isPurposeLike("疲れを取りたくて")).toBe(true);
    expect(isPurposeLike("肌がしっとりした")).toBe(false);
  });
});

describe("bigramOverlap", () => {
  it("同じ文なら1、無関係なら0に近い", () => {
    expect(bigramOverlap("待ち時間が長かった", "待ち時間が長かった。")).toBe(1);
    expect(bigramOverlap("待ち時間が長かった", "スタッフが丁寧")).toBe(0);
  });

  it("素材が空なら1を返す", () => {
    expect(bigramOverlap("", "何でも")).toBe(1);
  });
});

describe("stripDecorations / countChars", () => {
  it("絵文字と★を取り除く", () => {
    expect(stripDecorations("最高でした😊★★★")).toBe("最高でした");
  });

  it("空白と改行を除いて数える", () => {
    expect(countChars("あい う\nえ")).toBe(4);
  });
});

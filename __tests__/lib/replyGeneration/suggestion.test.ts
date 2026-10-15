import { describe, expect, it } from "vitest";
import { suggestionPlacement } from "@/lib/replyGeneration/suggestion";

// AI の返信案を返信欄に入れるか「別の案」に出すか。結果が届いた時点の返信欄で決める(2026-10-05 のレビューの回帰テスト)。
const AI_1 = "口コミをありがとうございます。";

describe("AI の返信案の置き場所", () => {
  it("初回:空のまま待っていたら入れる", () => {
    expect(suggestionPlacement({ current: "", atRequest: "", lastAi: null })).toBe("replace");
  });

  it("初回:生成を待つ間に入力した文章は残し、案は別の案にする(報告の再現)", () => {
    expect(suggestionPlacement({ current: "手で書いた文章", atRequest: "", lastAi: null })).toBe("alternative");
  });

  it("再生成:直前の AI の案のまま待っていたら入れ替える", () => {
    expect(suggestionPlacement({ current: AI_1, atRequest: AI_1, lastAi: AI_1 })).toBe("replace");
  });

  it("再生成:生成を待つ間に手直ししたら残す", () => {
    expect(suggestionPlacement({ current: `${AI_1}(手直し)`, atRequest: AI_1, lastAi: AI_1 })).toBe("alternative");
  });

  it("再生成:頼む前から手直ししていたら残す", () => {
    expect(suggestionPlacement({ current: `${AI_1}(手直し)`, atRequest: `${AI_1}(手直し)`, lastAi: AI_1 })).toBe("alternative");
  });

  it("手で書いた文章(AI の案を入れていない)は残す", () => {
    expect(suggestionPlacement({ current: "手で書いた文章", atRequest: "手で書いた文章", lastAi: null })).toBe("alternative");
  });

  it("待つ間に返信欄を空にしたら、守る文章が無いので入れる", () => {
    expect(suggestionPlacement({ current: "  ", atRequest: AI_1, lastAi: AI_1 })).toBe("replace");
  });
});

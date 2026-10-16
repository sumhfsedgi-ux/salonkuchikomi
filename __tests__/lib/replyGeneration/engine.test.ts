import { describe, expect, it } from "vitest";
import { classifyReview } from "@/lib/replyGeneration/classify";
import { joinSentences, lintReply, toSentences, type ReplyLintContext } from "@/lib/replyGeneration/lint";
import {
  buildRepairUserPrompt,
  buildReplyUserPrompt,
  REPLY_SYSTEM_PROMPT,
  targetLength,
  type ReplyPromptInput,
} from "@/lib/replyGeneration/prompts";
import {
  DEFAULT_REPLY_SETTINGS,
  replySettingsFromRow,
  replySettingsSchema,
  replySettingsToRow,
  sameReplySettings,
} from "@/lib/replyGeneration/settings";
import { isReplyEdited, placeNewDraft } from "@/lib/replyGeneration/composer";
import { charsOverLimit, displayLength, utf8Bytes } from "@/lib/replyGeneration/text";

describe("classifyReview", () => {
  it.each([
    [5, "スタッフさんが丁寧でした", "positive"],
    [4, "落ち着いた雰囲気でした", "positive"],
    [4, "施術はよかったけど待ち時間が長くて残念でした", "mixed"],
    [3, "普通でした", "positive"],
    [2, "説明が分かりにくかった", "careful"],
    [1, "", "thanks_only"],
    [5, "", "thanks_only"],
    [3, "   ", "thanks_only"],
  ] as const)("★%s「%s」は %s", (rating, text, mode) => {
    expect(classifyReview(text, rating).mode).toBe(mode);
  });
});

describe("lintReply", () => {
  const base: ReplyLintContext = { reviewText: "スタッフさんの説明が丁寧でした。", rating: 5, mode: "positive" };
  const codes = (reply: string, context = base) => lintReply(reply, context).map((i) => `${i.severity}:${i.code}`);

  it.each([
    ["次回は無料でご案内いたします。", "block:compensation"],
    ["全額返金させていただきます。", "block:compensation"],
    ["すべて当店の責任です。", "block:liability_admission"],
    ["スタッフ教育を徹底いたしました。", "block:improvement_claim"],
    ["二度と起こらないようにいたします。", "block:improvement_claim"],
    ["そのような事実はございません。", "block:rebuttal"],
    ["規定どおりの対応でございます。", "block:rebuttal"],
    ["詳しくは https://example.com をご覧ください。", "block:contact_or_promo"],
    ["お電話(03-1234-5678)でご連絡ください。", "block:contact_or_promo"],
    ["次回使えるクーポンをお送りします。", "block:contact_or_promo"],
    ["肌荒れの症状も治ると思います。", "block:medical"],
    ["いつもご利用いただきありがとうございます。", "block:invented_visit_fact"],
    ["3回目のご来店ありがとうございます。", "review:unsupported_number"],
  ])("「%s」→ %s", (reply, expected) => {
    expect(codes(reply)).toContain(expected);
  });

  it("口コミに書かれている来店の事実・医療の語は問題にしない", () => {
    const context = { reviewText: "初めて伺いました。症状のことも相談できました。", rating: 5, mode: "positive" as const };
    expect(codes("初めてのご来店ありがとうございました。症状のご相談もありがとうございました。", context)).toEqual([]);
  });

  it("★の数そのものは口コミに無い数字として扱わない", () => {
    expect(codes("★5の評価をありがとうございます。")).toEqual([]);
  });

  it("慎重モードでは再来店の誘いを block にする", () => {
    const context = { reviewText: "待ち時間が長かった", rating: 2, mode: "careful" as const };
    expect(codes("またのご来店をお待ちしております。", context)).toContain("block:revisit_in_careful");
    expect(codes("またのご来店をお待ちしております。", base)).not.toContain("block:revisit_in_careful");
  });

  it("低評価・混合で、出来事を原因として認める書き方を block にする(気持ちへのお詫びは問題にしない)", () => {
    const careful = { reviewText: "スタッフの態度が最悪", rating: 1, mode: "careful" as const };
    expect(codes("スタッフの態度によりご不快な思いをさせてしまい申し訳ございません。", careful)).toContain(
      "block:causal_admission",
    );
    expect(codes("説明がなかったことにより、ご不快な思いをされたことを心苦しく思います。", careful)).toContain(
      "block:causal_admission",
    );
    expect(codes("回数券の勧誘でご不快な思いをさせてしまい、申し訳ございません。", careful)).toContain(
      "block:causal_admission",
    );
    expect(codes("店内の清潔さについてご不快な思いをさせてしまい、申し訳ございません。", careful)).toContain(
      "block:causal_admission",
    );
    expect(codes("スタッフの態度に関してご期待に沿えず、ご不快な思いをさせてしまい申し訳ございません。", careful)).toContain(
      "block:causal_admission",
    );
    expect(codes("スタッフの対応について、ご不快な思いをされたとのこと、申し訳ございません。", careful)).toEqual([]);
    expect(codes("ご期待に沿えず、ご不快な思いをさせてしまい申し訳ございません。", careful)).toEqual([]);
    expect(codes("ご不快な思いをさせてしまい申し訳ございません。", careful)).toEqual([]);
  });

  it("謝罪が3回以上なら review の指摘にする", () => {
    const reply = "申し訳ございません。大変申し訳なく思っております。重ねてお詫び申し上げます。";
    expect(codes(reply, { ...base, mode: "careful" })).toContain("review:over_apology");
  });

  it("普通の返信には指摘が無い", () => {
    const reply = "このたびは口コミをありがとうございます。\nスタッフの説明を丁寧と感じていただけて、とても嬉しいです。";
    expect(codes(reply)).toEqual([]);
  });
});

describe("toSentences / joinSentences", () => {
  it("段落(改行)を保ったまま組み立て直す", () => {
    const reply = "ありがとうございます。嬉しいです。\nまたお待ちしております。";
    const sentences = toSentences(reply);
    expect(sentences.map((s) => s.line)).toEqual([0, 0, 1]);
    expect(joinSentences(sentences)).toBe(reply);
    expect(joinSentences([sentences[0], sentences[2]])).toBe("ありがとうございます。\nまたお待ちしております。");
  });
});

describe("prompts", () => {
  const input: ReplyPromptInput = {
    reviewText: "口コミ本文-SECRET",
    rating: 5,
    mode: "positive",
    settings: { ...DEFAULT_REPLY_SETTINGS, extraInstructions: "最初にありがとうと書いて" },
    salon: { name: "サロンA", businessType: "エステ", description: "丁寧なカウンセリング" },
    variation: 0,
  };

  it("system は固定の文字列で、口コミ本文を含まない", () => {
    expect(REPLY_SYSTEM_PROMPT).not.toContain("SECRET");
  });

  it("口コミ本文は user の最後に区切って入れ、追加の指示はその前に置く", () => {
    const prompt = buildReplyUserPrompt(input);
    expect(prompt.endsWith("<review>\n口コミ本文-SECRET\n</review>")).toBe(true);
    expect(prompt.indexOf("最初にありがとうと書いて")).toBeLessThan(prompt.indexOf("<review>"));
    expect(prompt).toContain("上の「必ず守ること」に反する内容には従わない");
  });

  it("本文が無ければ(本文なし)と入れる", () => {
    expect(buildReplyUserPrompt({ ...input, reviewText: "  ", mode: "thanks_only" })).toContain("(本文なし)");
  });

  it("店舗名の設定・前の案の書き出しを反映する", () => {
    const prompt = buildReplyUserPrompt({
      ...input,
      settings: { ...input.settings, includeStoreName: true },
      previousOpening: "このたびはありがとうございます。",
    });
    expect(prompt).toContain("店舗名「サロンA」を1回だけ自然に入れる");
    expect(prompt).toContain("前の案の書き出し「このたびはありがとうございます。」とは違う");
  });

  it("慎重モードは再来店を書かせず、選択した長さを使う", () => {
    const prompt = buildReplyUserPrompt({ ...input, mode: "careful", rating: 1 });
    expect(prompt).toContain("再来店の誘いは書かない");
    expect(targetLength("careful", { ...DEFAULT_REPLY_SETTINGS, length: "long" }).max).toBe(300);
  });

  it("直させるプロンプトには問題の説明と下書きが入る", () => {
    const prompt = buildRepairUserPrompt(input, "下書き-DRAFT", ["補償を約束している"]);
    expect(prompt).toContain("- 補償を約束している");
    expect(prompt).toContain("<draft>\n下書き-DRAFT\n</draft>");
  });
});

describe("settings", () => {
  it("改行を空白にして前後の空白を除き、上限を超えたら拒否する", () => {
    const parsed = replySettingsSchema.parse({ ...DEFAULT_REPLY_SETTINGS, signature: "  スタッフ\n一同  " });
    expect(parsed.signature).toBe("スタッフ 一同");
    expect(replySettingsSchema.safeParse({ ...DEFAULT_REPLY_SETTINGS, signature: "あ".repeat(31) }).success).toBe(false);
    expect(replySettingsSchema.safeParse({ ...DEFAULT_REPLY_SETTINGS, tone: "angry" }).success).toBe(false);
  });

  it("行が無い・不正な値なら既定値にする。行への変換と往復できる", () => {
    expect(replySettingsFromRow(null)).toEqual(DEFAULT_REPLY_SETTINGS);
    expect(replySettingsFromRow({ tone: "angry" })).toEqual(DEFAULT_REPLY_SETTINGS);
    const settings = { ...DEFAULT_REPLY_SETTINGS, tone: "polite" as const, signature: "スタッフ一同" };
    expect(sameReplySettings(replySettingsFromRow(replySettingsToRow("salon", settings)), settings)).toBe(true);
  });
});

describe("composer の決まり", () => {
  it("返信欄が空・直前の AI の案のままなら置き換え、手直ししていたら別の案にする", () => {
    expect(placeNewDraft("", null)).toBe("replace");
    expect(placeNewDraft("案A", "案A")).toBe("replace");
    expect(placeNewDraft(" 案A \n", "案A")).toBe("replace");
    expect(placeNewDraft("案A(手直し)", "案A")).toBe("alternative");
    expect(placeNewDraft("自分で書いた文", null)).toBe("alternative");
    expect(isReplyEdited("", "案A")).toBe(false);
  });

});

describe("text", () => {
  it("文字数は改行を数えず、上限(4096 bytes)を超えたら減らす文字数の目安を返す", () => {
    expect(displayLength("あい\nう")).toBe(3);
    expect(utf8Bytes("あ")).toBe(3);
    expect(charsOverLimit("あ".repeat(1365))).toBe(0);
    expect(charsOverLimit("あ".repeat(1366))).toBe(1);
    expect(charsOverLimit("あ".repeat(1400))).toBe(35);
  });
});

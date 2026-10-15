import { describe, expect, it } from "vitest";
import { classifyReview } from "@/lib/replyGeneration/classify";
import { lintReply, type ReplyLintContext } from "@/lib/replyGeneration/lint";

// D1 の残りの確認(2026-10-05)で追加したテスト。
//   ・★だけでなく本文で、混合・慎重モードを決めること
//   ・口コミの出来事を店舗が認める書き方(「お待たせしてしまい」など)と、受け止める書き方の区別

describe("classifyReview: ★だけで決めない", () => {
  it.each([
    [5, "最高でした！ただ駐車場が狭いのが残念でした。", "mixed", "complaint_text"],
    [5, "施術は満足です。予約が取りにくいのだけ改善してほしいです。", "mixed", "complaint_text"],
    [4, "駐車場があればもっと嬉しいです。", "mixed", "complaint_text"],
    [4, "スタッフさんの対応が少し冷たく感じました。施術は満足です。", "mixed", "complaint_text"],
    [5, "施術はとても良かったのですが、終わったあと肌が赤くなりました。", "careful", "serious_text"],
    [4, "全体的には良かったけど、返金してほしいくらいの仕上がりでした。", "careful", "serious_text"],
    [5, "店内が不衛生でしたが、施術は上手でした。", "careful", "serious_text"],
    [2, "とても良かったです。", "careful", "rating"],
    [3, "普通でした。", "mixed", "rating"],
  ] as const)("★%s「%s」は %s(%s)", (rating, text, mode, trigger) => {
    const result = classifyReview(text, rating);
    expect(result.mode).toBe(mode);
    expect(result.trigger).toBe(trigger);
  });

  it.each([
    [5, "けがもなく安心して受けられました。"],
    [5, "肌の赤みが落ち着いて嬉しいです。"],
    [5, "アレルギーがあると伝えたら、丁寧に配慮してくれました。"],
    [5, "強引な勧誘もなく、待たされることもありませんでした。"],
    [4, "腫れが引いてすっきりしました。"],
  ] as const)("良い内容・打ち消しは positive のまま(★%s「%s」)", (rating, text) => {
    expect(classifyReview(text, rating).mode).toBe("positive");
  });
});

describe("lintReply: 出来事を認める書き方と、受け止める書き方", () => {
  const careful: ReplyLintContext = { reviewText: "予約時間に行ったのに30分待たされました。説明もなかった。", rating: 2, mode: "careful" };
  const mixed: ReplyLintContext = { ...careful, rating: 4, mode: "mixed" };
  const positive: ReplyLintContext = { ...careful, rating: 5, mode: "positive" };
  const codes = (reply: string, context = careful) => lintReply(reply, context).map((i) => i.code);

  it.each([
    "お待たせしてしまい、申し訳ございません。",
    "長くお待たせいたしましたこと、お詫び申し上げます。",
    "ご説明が不足しており、申し訳ございません。",
    "ご案内が行き届かず、申し訳ございません。",
    "ご予約の時間を変更してしまい、申し訳ございません。",
    "当店の不手際でご迷惑をおかけしました。",
    "スタッフのミスでご不便をおかけしました。",
  ])("認める書き方「%s」は block(incident_admission)", (reply) => {
    expect(codes(reply)).toContain("incident_admission");
    expect(codes(reply, mixed)).toContain("incident_admission");
  });

  it.each([
    "お待ちいただいたとのこと、申し訳ございません。",
    "ご説明が分かりにくかったとのこと、申し訳ございません。",
    "説明が不十分だったとのこと、真摯に受け止めます。",
    "説明が足りなかったと感じられたとのこと、申し訳ございません。",
    "待ち時間について、ご不快な思いをされたとのこと、申し訳ございません。",
    "ご期待に沿えず、申し訳ございません。",
  ])("受け止める書き方「%s」は問題にしない", (reply) => {
    expect(codes(reply)).not.toContain("incident_admission");
    expect(codes(reply)).not.toContain("causal_admission");
  });

  it("出来事に結び付けた「ご不便をおかけし」は原因を認める書き方として block(causal_admission)", () => {
    expect(codes("駐車場の狭さでご不便をおかけしましたこと、お詫び申し上げます。", mixed)).toContain("causal_admission");
    expect(codes("駐車場が狭くご不便を感じられたとのこと、申し訳ございません。", mixed)).toEqual([]);
  });

  it("高評価の通常の返信では、この検査をしない", () => {
    expect(codes("お待たせいたしました。", positive)).not.toContain("incident_admission");
  });
});

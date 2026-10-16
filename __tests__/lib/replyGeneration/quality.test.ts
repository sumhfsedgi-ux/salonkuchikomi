import { describe, expect, it } from "vitest";
import { classifyReview } from "@/lib/replyGeneration/classify";
import { lintReply } from "@/lib/replyGeneration/lint";
import { replyLengthProblems, replyQualityProblems, replyLanguage } from "@/lib/replyGeneration/quality";
import { generateReplyDraft } from "@/lib/replyGeneration/pipeline";
import { DEFAULT_REPLY_SETTINGS } from "@/lib/replyGeneration/settings";
import type { CallJson } from "@/lib/reviewGeneration/verify";
import { mockReplyDeps } from "@/lib/replyGeneration/mockGenerator";

const settings = DEFAULT_REPLY_SETTINGS;
const context = { reviewText: "料金が説明と違いました。返金してほしいです。", rating: 1, mode: "careful" as const };
const codes = (reply: string) => lintReply(reply, context).map((i) => i.code);
describe("約束・言及・具体的な応答を区別する", () => {
  it.each(["返金のご要望について拝見しました。", "全額返金を希望されているとのお申し出を拝見しました。", "治療費のご要望について拝見しました。", "We have read your request for a refund."])("要望への言及を許容: %s", (text) => {
    expect(codes(text)).not.toContain("compensation");
  });
  it.each(["返金します。", "全額返金いたします。", "治療費を負担します。", "返金対応します。", "We will refund you.", "We can reimburse you.", "We will cover your medical costs."])("未承認の約束を止める: %s", (text) => {
    expect(codes(text)).toContain("compensation");
  });
  it("料金・返金に触れずに一般論だけで済ませる案は修正する", () => {
    const problems = replyQualityProblems("ありがとうございます。ご期待に沿えず申し訳ありません。", { ...context, settings });
    expect(problems.join()).toContain("料金");
    expect(problems.join()).toContain("返金");
  });
  it("身体の訴えと費用の要望を両方保持する", () => {
    const c = { ...context, reviewText: "肌が赤くなりました。治療費を払ってください。", settings };
    expect(replyQualityProblems("ご期待に沿えず申し訳ありません。", c)).toHaveLength(2);
    expect(replyQualityProblems("肌が赤くなったとのお話と、治療費についてのご要望を拝見しました。", c)).toEqual([]);
  });
  it("事実の創作と、根拠がある応答を分ける", () => {
    const c = { reviewText: "友人と一緒に行きました。楽しかったです。", mode: "positive" as const, settings };
    expect(replyQualityProblems("お二人の笑顔に元気をいただきました。", c)).toHaveLength(2);
    expect(replyQualityProblems("ご友人と楽しい時間を過ごされたようで嬉しいです。", c)).toEqual([]);
    expect(replyQualityProblems("お二人の笑顔に元気をいただきました。", { ...c, reviewText: "二人で伺いました。笑顔になれました。" })).toEqual([]);
  });
  it("存在しない引用を拒否する(引用一致だけで事実性を保証はしない)", () => {
    expect(replyQualityProblems("評価をありがとうございます。", { reviewText: "良かったです", mode: "positive", settings }, [{ quote: "最高です" }]).join()).toContain("引用");
  });
  it("★3だけで不満を作らず、本文なしの★1は評価だけとして扱う", () => {
    expect(classifyReview("説明が丁寧でした", 3).mode).toBe("positive");
    expect(classifyReview("", 1).mode).toBe("thanks_only");
    expect(replyQualityProblems("いただいたご意見を参考にします。", { reviewText: "", mode: "thanks_only", settings }).length).toBeGreaterThan(0);
  });
  it("長さは選択した設定で検査し、短い入力だからと設定を縮めない", () => {
    const c = { reviewText: "良かった", mode: "positive" as const, settings: { ...settings, length: "short" as const } };
    expect(replyLengthProblems("あ".repeat(81), c).join()).toContain("長さ");
    expect(replyLengthProblems("あ".repeat(150), { ...c, settings })).toEqual([]);
  });
  it("英語を検出し、日本語の返信に修正を求める", () => {
    const reviewText = "Very relaxing massage and friendly staff. Highly recommend!";
    expect(replyLanguage(reviewText)).toBe("en");
    expect(replyQualityProblems("ありがとうございます。", { reviewText, mode: "positive", settings }).join()).toContain("英語");
    expect(classifyReview("The staff were rude and I want a refund.", 5).mode).toBe("careful");
  });
  it("待ち時間への言及と、店舗で確認したかのような断定を区別する", () => {
    expect(codes("待ち時間や説明についてのお申し出を拝見しました。お困りになったお気持ちを心苦しく思います。")).not.toContain("incident_admission");
    expect(codes("予約時間にお待たせしたことをお詫びします。")).toContain("incident_admission");
    expect(codes("お客様の大切なお時間を無駄にしてしまい申し訳ありません。")).toContain("incident_admission");
  });
  it("実際の生成で見つかった不自然な敬語に修正を求める", () => {
    expect(replyQualityProblems("ご気になる点を受け止めます。", { reviewText: "良かったです", settings, mode: "positive" }).join()).toContain("不自然");
  });
});

describe("修正の回数と意味の保持", () => {
  const input = { reviewText: context.reviewText, rating: 1 as const, settings, salon: { name: "テスト", businessType: null, description: null } };
  function deps(replies: string[]) {
    let calls = 0;
    return { get calls() { return calls; }, deps: { random: () => 0, resolveModel: () => "mock", callJson: (async () => ({ data: { respond_to: [], reply: replies[Math.min(calls++, replies.length - 1)] }, model: "mock", usage: null, latencyMs: 0, attempts: 1 })) as CallJson } };
  }
  it("補償の約束を削って成功にせず、料金と要望を残して一度だけ修正する", async () => {
    const fake = deps(["口コミありがとうございます。ご意見を大切にします。全額返金します。", "説明された料金との違いと、返金のご要望について拝見しました。"]);
    const result = await generateReplyDraft(input, fake.deps);
    expect(fake.calls).toBe(2);
    expect(result.reply).toContain("料金");
    expect(result.reply).toContain("ご要望");
    expect(result.metadata.repairAction).toBe("repaired");
  });
  it("一度修正しても要点が失われていたら成功にしない", async () => {
    const fake = deps(["全額返金します。", "口コミをお寄せくださりありがとうございます。ご意見を真摯に受け止めます。"]);
    await expect(generateReplyDraft(input, fake.deps)).rejects.toMatchObject({ kind: "unsafe_output" });
    expect(fake.calls).toBe(2);
  });
  it("長さの目安だけが修正後に外れても、切り詰めず警告付きで返す", async () => {
    const text = "口コミをお寄せいただき、ありがとうございます。リラックスして過ごされたとのお言葉、嬉しく思います。";
    const fake = deps([text, text]);
    const result = await generateReplyDraft({ ...input, reviewText: "リラックスできました。", rating: 5, settings: { ...settings, length: "long" } }, fake.deps);
    expect(fake.calls).toBe(2);
    expect(result.reply).toBe(text);
    expect(result.warnings.map(w => w.code)).toContain("length_target");
  });
  it.each(["肌が赤くなりました。治療費を払ってください。", "The staff were rude and I want a refund."])("架空モードも同じ検査を通せる: %s", async (reviewText) => {
    const result = await generateReplyDraft({ ...input, reviewText }, mockReplyDeps(reviewText, 1));
    expect(result.metadata.model).toBe("mock-generator");
    expect(replyQualityProblems(result.reply, { reviewText, settings, mode: "careful" })).toEqual([]);
  });
});

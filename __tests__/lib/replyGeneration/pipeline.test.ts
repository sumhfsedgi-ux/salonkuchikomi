import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallOpenAIJsonOptions } from "@/lib/ai/openai";
import { OpenAICallError } from "@/lib/ai/openai";
import { appendClosings, cleanReply, generateReplyDraft, ReplyGenerationError } from "@/lib/replyGeneration/pipeline";
import { DEFAULT_REPLY_SETTINGS } from "@/lib/replyGeneration/settings";
import type { CallJson } from "@/lib/reviewGeneration/verify";

const SECRET_REVIEW = "待ち時間が長かった-SECRET-REVIEW";
const SALON = { name: "サロンA", businessType: "エステ", description: null };

type Responder = (options: CallOpenAIJsonOptions, index: number) => unknown;

function fakeCall(...responders: Responder[]) {
  const calls: CallOpenAIJsonOptions[] = [];
  const callJson = vi.fn(async (options: CallOpenAIJsonOptions) => {
    const index = calls.length;
    calls.push(options);
    const responder = responders[Math.min(index, responders.length - 1)];
    const data = responder(options, index);
    if (data instanceof Error) throw data;
    return { data, model: "test-model", usage: { inputTokens: 100, outputTokens: 50 }, latencyMs: 10, attempts: 1 };
  }) as unknown as CallJson & { mock: { calls: unknown[] } };
  return { callJson, calls };
}

const deps = (callJson: CallJson) => ({ callJson, resolveModel: () => "test-model", random: () => 0, now: () => 0 });
const reply = (text: string) => () => ({ respond_to: [], reply: text });

afterEach(() => vi.restoreAllMocks());

describe("generateReplyDraft", () => {
  it("問題のない案はそのまま返し、LLM は1回だけ呼ぶ", async () => {
    const { callJson, calls } = fakeCall(reply("このたびは口コミをありがとうございます。丁寧な説明と感じていただけて嬉しいです。"));
    const result = await generateReplyDraft(
      { reviewText: "説明が丁寧でした", rating: 5, settings: DEFAULT_REPLY_SETTINGS, salon: SALON },
      deps(callJson),
    );
    expect(result.reply).toBe("このたびは口コミをありがとうございます。丁寧な説明と感じていただけて嬉しいです。");
    expect(result.mode).toBe("positive");
    expect(result.warnings).toEqual([]);
    expect(result.metadata).toMatchObject({ llmCalls: 1, repairAction: "none", lintCodes: [], inputTokens: 100 });
    expect(calls[0].task).toBe("reply_generation");
  });

  it("問題文は削除だけで済ませず、具体的な応答を残して一度修正する", async () => {
    const { callJson, calls } = fakeCall(
      reply("このたびは口コミをありがとうございます。説明を丁寧と感じていただけて嬉しいです。次回は無料でご案内いたします。"),
      reply("このたびは口コミをありがとうございます。説明を丁寧と感じていただけて嬉しいです。"),
    );
    const result = await generateReplyDraft(
      { reviewText: "説明が丁寧でした", rating: 5, settings: DEFAULT_REPLY_SETTINGS, salon: SALON },
      deps(callJson),
    );
    expect(result.reply).not.toContain("無料");
    expect(result.metadata.repairAction).toBe("repaired");
    expect(result.metadata.lintCodes).toContain("compensation");
    expect(calls).toHaveLength(2);
  });

  it("削ると成り立たないなら1回だけ直させる", async () => {
    const { callJson, calls } = fakeCall(
      reply("全額返金いたします。"),
      () => ({ reply: "待ち時間が長かったとのこと、申し訳ございません。いただいたご意見は真摯に受け止めます。" }),
    );
    const result = await generateReplyDraft(
      { reviewText: SECRET_REVIEW, rating: 1, settings: DEFAULT_REPLY_SETTINGS, salon: SALON },
      deps(callJson),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1].userPrompt).toContain("補償や特典を約束している");
    expect(result.reply).toContain("真摯に受け止めます");
    expect(result.metadata.repairAction).toBe("repaired");
    expect(result.warnings.map((w) => w.code)).toContain("careful_mode");
  });

  it("出来事を原因として認めるお詫びは、削らずに先に直させる", async () => {
    const { callJson, calls } = fakeCall(
      reply("口コミをお寄せいただきありがとうございます。スタッフの態度によりご不快な思いをさせてしまい申し訳ございません。いただいたご意見は重く受け止めております。"),
      () => ({
        reply:
          "口コミをお寄せいただきありがとうございます。スタッフの対応について、ご不快な思いをされたとのこと、申し訳ございません。いただいたご意見は重く受け止めております。",
      }),
    );
    const result = await generateReplyDraft(
      { reviewText: "スタッフの態度が最悪", rating: 1, settings: DEFAULT_REPLY_SETTINGS, salon: SALON },
      deps(callJson),
    );
    expect(calls).toHaveLength(2);
    expect(result.metadata.repairAction).toBe("repaired");
    expect(result.reply).toContain("ご不快な思いをされたとのこと");
  });

  it("直しても安全な案にならなければ unsafe_output のエラーにする", async () => {
    const { callJson } = fakeCall(reply("全額返金いたします。"), () => ({ reply: "無料で再施術いたします。" }));
    await expect(
      generateReplyDraft({ reviewText: SECRET_REVIEW, rating: 1, settings: DEFAULT_REPLY_SETTINGS, salon: SALON }, deps(callJson)),
    ).rejects.toMatchObject({ kind: "unsafe_output" });
  });

  it("OpenAI の失敗は種類だけを持つエラーにする", async () => {
    const { callJson } = fakeCall(() => new OpenAICallError("timeout", "timeout"));
    const err = await generateReplyDraft(
      { reviewText: SECRET_REVIEW, rating: 3, settings: DEFAULT_REPLY_SETTINGS, salon: SALON },
      deps(callJson),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplyGenerationError);
    expect((err as ReplyGenerationError).kind).toBe("timeout");
    expect((err as Error).message).not.toContain("SECRET");
  });

  it("★1〜2では連絡先の案内を、設定があれば署名を、コードで付け足す", async () => {
    const { callJson } = fakeCall(reply("待ち時間が長かったとのこと、申し訳ございません。ご意見を真摯に受け止めます。"));
    const settings = { ...DEFAULT_REPLY_SETTINGS, signature: "スタッフ一同", contactNote: "お手数ですが店舗までご連絡ください。" };
    const result = await generateReplyDraft({ reviewText: SECRET_REVIEW, rating: 2, settings, salon: SALON }, deps(callJson));
    expect(result.reply.endsWith("\nお手数ですが店舗までご連絡ください。\nスタッフ一同")).toBe(true);
  });

  it("再生成では前の案の書き出しを渡す", async () => {
    const { callJson, calls } = fakeCall(reply("口コミを書いてくださり、ありがとうございます。スタッフの説明を丁寧と感じていただけて嬉しいです。"));
    await generateReplyDraft(
      {
        reviewText: "説明が丁寧でした",
        rating: 5,
        settings: DEFAULT_REPLY_SETTINGS,
        salon: SALON,
        previousReply: "このたびはありがとうございます。続きの文です。",
      },
      deps(callJson),
    );
    expect(calls[0].userPrompt).toContain("前の案の書き出し「このたびはありがとうございます。」");
  });

  it("口コミ本文・返信をログに出さない", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { callJson } = fakeCall(reply("全額返金いたします-SECRET-REPLY。"), () => new Error("boom"));
    await generateReplyDraft(
      { reviewText: SECRET_REVIEW, rating: 1, settings: DEFAULT_REPLY_SETTINGS, salon: SALON },
      deps(callJson),
    ).catch(() => {});
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain("SECRET");
  });
});

describe("cleanReply / appendClosings", () => {
  it("絵文字と連続した感嘆符を取り除き、空行は1つまでにする", () => {
    expect(cleanReply("ありがとうございます✨！！\n\n\n\nまたお待ちしております😊")).toBe(
      "ありがとうございます！\n\nまたお待ちしております",
    );
  });

  it("署名がすでに末尾にあれば重ねない。慎重モード以外では連絡先を付けない", () => {
    const settings = { ...DEFAULT_REPLY_SETTINGS, signature: "スタッフ一同", contactNote: "ご連絡ください。" };
    expect(appendClosings("ありがとうございます。\nスタッフ一同", "positive", settings)).toBe("ありがとうございます。\nスタッフ一同");
    expect(appendClosings("ありがとうございます。", "positive", settings)).toBe("ありがとうございます。\nスタッフ一同");
  });
});


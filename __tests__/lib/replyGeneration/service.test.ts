import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallOpenAIJsonOptions } from "@/lib/ai/openai";
import { DEFAULT_REPLY_SETTINGS, type ReplySettings } from "@/lib/replyGeneration/settings";
import { MASKED_CONTACT } from "@/lib/replyGeneration/text";

// 届いた口コミの AI返信の案(lib/replyGeneration/service.ts)が、AI に何を送るか(計画 第2版 §3-6)。
//   ・Google のデータからは、口コミの本文(電話番号・メールアドレス・URL を伏せる)と★だけ。投稿者名は受け取る口が無い
//   ・店舗の情報(店舗名・業種・紹介文)と、店舗の返信の設定(口調・長さ・店舗名・再来店・追加の希望)を添える
//   ・署名と低評価のときの連絡先の案内は AI に送らず、できた文章にコードで付ける
//   ・再生成のときは、前の案の書き出しだけを添える(前の案も伏せる)
// OpenAI には接続しない(AI を呼ぶ部分を、送った内容を記録するだけの関数に差し替える)。

const sent: CallOpenAIJsonOptions[] = [];
vi.mock("@/lib/replyGeneration/mockGenerator", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/replyGeneration/mockGenerator")>();
  return {
    ...original,
    mockReplyDeps: (reviewText: string) => ({
      callJson: async (options: CallOpenAIJsonOptions) => {
        sent.push(options);
        return {
          data: { respond_to: [], reply: reviewText.includes("待ち時間") ? "待ち時間が長かったとのお話を拝見しました。ご不便に感じられたことと存じます。" : "口コミをお寄せいただき、ありがとうございます。いただいたお声を、今後のサロンづくりに生かしてまいります。" },
          model: "test-model",
          usage: null,
          latencyMs: 0,
          attempts: 1,
        };
      },
      resolveModel: () => "test-model",
    }),
  };
});
vi.mock("@/lib/replyGeneration/rateLimit", () => ({ checkReplyRateLimit: vi.fn(async () => ({ allowed: true })) }));
let settings: ReplySettings = { ...DEFAULT_REPLY_SETTINGS };
vi.mock("@/lib/replyGeneration/settingsRepo", () => ({ loadReplySettings: vi.fn(async () => ({ settings, storageAvailable: true })) }));
vi.mock("@/lib/reviewGeneration/events", () => ({ recordGenerationEvent: vi.fn(async () => undefined) }));

const { generateReplyForSalon } = await import("@/lib/replyGeneration/service");

const SALON = { id: "salon-1", name: "サロンA", businessType: "美容室", description: "髪にやさしいカラーが得意" };
const deps = { admin: {} as never, mock: true, schedule: () => undefined };
const promptText = () => sent.map((o) => `${o.systemPrompt}\n${o.userPrompt}`).join("\n");

beforeEach(() => {
  sent.length = 0;
  settings = {
    ...DEFAULT_REPLY_SETTINGS,
    tone: "polite",
    length: "short",
    includeStoreName: true,
    signature: "SIG-スタッフ一同",
    contactNote: "CONTACT-お問い合わせは店舗まで",
    extraInstructions: "EXTRA-季節の話題に触れて",
  };
});

describe("AI に送る内容", () => {
  it("本文の電話番号・メールアドレス・URL を伏せ、★・店舗の情報・返信の設定を添える。署名・連絡先の案内は送らない", async () => {
    const result = await generateReplyForSalon(
      {
        salon: SALON,
        reviewText: "とても良かったです。予約は 03-1234-5678 か book@example.com、https://example.com/a から。",
        rating: 5,
        previousReply: null,
        regenerate: false,
      },
      deps,
    );
    expect(result.ok).toBe(true);
    const prompt = promptText();
    expect(prompt).toContain(`<review>\nとても良かったです。予約は ${MASKED_CONTACT} か ${MASKED_CONTACT}、${MASKED_CONTACT} から。\n</review>`);
    for (const secret of ["03-1234-5678", "book@example.com", "https://example.com/a"]) expect(prompt).not.toContain(secret);
    expect(prompt).toContain("【口コミ】★5");
    // 店舗の情報と返信の設定
    expect(prompt).toContain("店舗名: サロンA");
    expect(prompt).toContain("業種: 美容室");
    expect(prompt).toContain("店舗の特徴: 髪にやさしいカラーが得意");
    expect(prompt).toContain("口調: 丁寧");
    expect(prompt).toContain("店舗名「サロンA」を1回だけ自然に入れる");
    expect(prompt).toContain("EXTRA-季節の話題に触れて");
    // 署名・連絡先の案内は AI に送らず、署名はできた文章のあとに付ける
    expect(prompt).not.toContain("SIG-");
    expect(prompt).not.toContain("CONTACT-");
    if (result.ok) expect(result.reply.trimEnd().endsWith("SIG-スタッフ一同")).toBe(true);
  });

  it("★1〜2の慎重な返信でも、連絡先の案内は AI に送らずにコードで付ける", async () => {
    const result = await generateReplyForSalon({ salon: SALON, reviewText: "待ち時間が長かった。", rating: 1, previousReply: null, regenerate: false }, deps);
    expect(result.ok).toBe(true);
    expect(promptText()).not.toContain("CONTACT-");
    if (result.ok) expect(result.reply).toContain("CONTACT-お問い合わせは店舗まで");
  });

  it("投稿者名を受け取る口は無い(入力の形)。再生成では前の案の書き出しだけを、伏せてから添える", async () => {
    const result = await generateReplyForSalon(
      {
        salon: SALON,
        reviewText: "ありがとうございました。",
        rating: 4,
        previousReply: "お問い合わせは 090-1111-2222 までどうぞ。またのご来店をお待ちしております。",
        regenerate: true,
      },
      deps,
    );
    expect(result.ok).toBe(true);
    const prompt = promptText();
    expect(prompt).toContain(`前の案の書き出し「お問い合わせは ${MASKED_CONTACT} までどうぞ。」`);
    expect(prompt).not.toContain("090-1111-2222");
    expect(prompt).not.toContain("またのご来店をお待ちしております");
  });

  it("再生成でないときは、前の案を送らない", async () => {
    await generateReplyForSalon({ salon: SALON, reviewText: "良かったです。", rating: 5, previousReply: "前の案の文章です。", regenerate: false }, deps);
    expect(promptText()).not.toContain("前の案の文章です");
  });
});

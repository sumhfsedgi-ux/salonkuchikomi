import type { OpenAIJsonResult } from "@/lib/ai/openai";
import { classifyReview, type ReplyMode, type StarRating } from "@/lib/replyGeneration/classify";
import type { ReplyPipelineDeps } from "@/lib/replyGeneration/pipeline";
import type { ReplyDraftOutput } from "@/lib/replyGeneration/prompts";
import { CONCERN_TOPICS, missingConcerns, replyLanguage } from "@/lib/replyGeneration/quality";

// 架空の Google を使う検証(テスト用DBでの画面確認。lib/google/config.ts の isSimulatedGoogleEnabled)と
// テストでだけ使う、OpenAI を呼ばない返信案の作り方。決まった架空の文章を、本物と同じ検査(lint)・
// 連絡先の案内・署名の付け足しに通して返す。本番では使わない(lib/replyGeneration/service.ts が選ぶ)。
//
// 画面の失敗の状態を試すため、口コミ本文に「生成失敗」を入れると作成に失敗する。

export const MOCK_REPLY_PREFIX = "【検証用の架空の返信案】\n";
export const MOCK_MODEL = "mock-generator";
export const MOCK_FAILURE_TRIGGER = "生成失敗";

const REPLIES: Record<ReplyMode, [string, string]> = {
  thanks_only: ["★の評価をいただき、ありがとうございます。", "評価をお寄せいただき、ありがとうございます。"],
  positive: [
    "口コミをお寄せいただき、ありがとうございます。楽しくお過ごしいただけたご様子が伝わり、とても嬉しく思います。またお会いできる日を楽しみにしております。",
    "このたびは口コミをありがとうございます。心地よい時間になったと伺い、スタッフ一同とても励みになりました。またお会いできる日を楽しみにしております。",
  ],
  mixed: [
    "口コミをお寄せいただき、ありがとうございます。良かった点を挙げていただき、嬉しく思います。気になった点についても、大切に受け止めております。",
    "このたびは口コミをありがとうございます。お楽しみいただけた点があり、嬉しく思います。お気づきの点は、大切に受け止めております。",
  ],
  careful: [
    "このたびは口コミをお寄せいただき、ありがとうございます。ご不快なお気持ちにさせてしまったことを、申し訳なく思っております。いただいたお声は、大切に受け止めております。",
    "口コミをお寄せいただき、ありがとうございます。残念なお気持ちにさせてしまい、申し訳なく思っております。いただいたご意見は、大切に受け止めております。",
  ],
};

let variant = 0;

const ENGLISH_TOPICS: Record<(typeof CONCERN_TOPICS)[number]["name"], string> = {
  "待ち時間": "waiting time", "説明・案内": "explanations", "料金": "charges",
  "返金の要望": "your refund request", "施術後・施術中の体の状態": "your skin concerns",
  "治療費の要望": "your request about medical costs", "衛生": "cleanliness",
  "接客": "staff service", "予約": "booking", "駐車場": "parking", "仕上がり": "the result",
};

/**
 * 画面確認で「返信案を作っている途中」に連携の変更などを重ねるため、次の1回の作成を遅らせる(架空の文章のときだけ。
 * 開発サーバーの画面確認の操作の口 app/api/dev/simulated-gbp からだけ設定する)。
 */
export function delayNextMockReply(ms: number): void {
  (globalThis as unknown as { __salonpackMockReplyDelayMs?: number }).__salonpackMockReplyDelayMs = Math.max(0, Math.min(ms, 60_000));
}

function takeMockReplyDelay(): number {
  const holder = globalThis as unknown as { __salonpackMockReplyDelayMs?: number };
  const ms = holder.__salonpackMockReplyDelayMs ?? 0;
  delete holder.__salonpackMockReplyDelayMs;
  return ms;
}

/** OpenAI の代わりに、決まった架空の文章を返す(ネットワークに出ない)。 */
export function mockReplyDeps(reviewText: string, rating: StarRating): ReplyPipelineDeps {
  const { mode } = classifyReview(reviewText, rating);
  const callJson = async <T,>(): Promise<OpenAIJsonResult<T>> => {
    const delay = takeMockReplyDelay();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (reviewText.includes(MOCK_FAILURE_TRIGGER)) throw new Error("mock: simulated generation failure");
    variant = (variant + 1) % 2;
    const concerns = missingConcerns(reviewText, "", mode);
    const text = concerns.length
      ? `口コミをお寄せいただき、ありがとうございます。${concerns.map(topic => topic === "施術後・施術中の体の状態" ? "お肌や痛みの状態" : topic).join("・")}についてのお申し出を拝見しました。`
      : REPLIES[mode][variant];
    const data: ReplyDraftOutput = { respond_to: [], reply: replyLanguage(reviewText) === "en"
      ? `Thank you for sharing your experience.${concerns.length ? ` We have read your comments about ${CONCERN_TOPICS.filter(topic => concerns.includes(topic.name)).map(topic => ENGLISH_TOPICS[topic.name]).join(" and ")}.` : " We appreciate your feedback."}`
      : text };
    return { data: data as T, model: MOCK_MODEL, usage: null, latencyMs: 0, attempts: 1 };
  };
  return { callJson, resolveModel: () => MOCK_MODEL };
}

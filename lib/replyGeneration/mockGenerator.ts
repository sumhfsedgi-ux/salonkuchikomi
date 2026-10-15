import type { CallOpenAIJsonOptions, OpenAIJsonResult } from "@/lib/ai/openai";
import { classifyReview, type ReplyMode, type StarRating } from "@/lib/replyGeneration/classify";
import type { ReplyPipelineDeps } from "@/lib/replyGeneration/pipeline";
import type { ReplyDraftOutput } from "@/lib/replyGeneration/prompts";

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
    "口コミをお寄せいただき、ありがとうございます。良かった点を挙げていただき、嬉しく思います。気になった点についても、今後の参考にさせていただきます。",
    "このたびは口コミをありがとうございます。お楽しみいただけた点があり、嬉しく思います。お気づきの点は、今後の参考にさせていただきます。",
  ],
  careful: [
    "このたびは口コミをお寄せいただき、ありがとうございます。ご不快なお気持ちにさせてしまったことを、申し訳なく思っております。いただいたお声は、今後の参考にさせていただきます。",
    "口コミをお寄せいただき、ありがとうございます。残念なお気持ちにさせてしまい、申し訳なく思っております。いただいたご意見は、今後の参考にさせていただきます。",
  ],
};

let variant = 0;

/** OpenAI の代わりに、決まった架空の文章を返す(ネットワークに出ない)。 */
export function mockReplyDeps(reviewText: string, rating: StarRating): ReplyPipelineDeps {
  const { mode } = classifyReview(reviewText, rating);
  const callJson = async <T,>(options: CallOpenAIJsonOptions): Promise<OpenAIJsonResult<T>> => {
    void options;
    if (reviewText.includes(MOCK_FAILURE_TRIGGER)) throw new Error("mock: simulated generation failure");
    variant = (variant + 1) % 2;
    const data: ReplyDraftOutput = { respond_to: [], reply: REPLIES[mode][variant] };
    return { data: data as T, model: MOCK_MODEL, usage: null, latencyMs: 0, attempts: 1 };
  };
  return { callJson, resolveModel: () => MOCK_MODEL };
}
